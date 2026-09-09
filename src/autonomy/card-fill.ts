import type { World } from '../world/types.js';

/** Billing fields a checkout may ask for alongside the card itself. */
export const BILLING_FIELDS = ['line1', 'city', 'postalCode', 'country'] as const;
export type BillingField = (typeof BILLING_FIELDS)[number];

export interface CardFillDetails {
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  billing?: Partial<Record<BillingField, string>>;
}

export type CardFillSelectors = {
  number: string;
  cvc: string;
  expiry?: string;
  expMonth?: string;
  expYear?: string;
} & Partial<Record<BillingField, string>>;

/**
 * Fill a card inside a container/remote world's own loopback browser.
 *
 * The card number, CVC, expiry and billing address travel on STDIN; only
 * non-secret routing config (CDP endpoint, expected domain, field selectors) goes
 * in the environment. The environment is NOT a safe channel for these:
 *  - `ContainerWorld.exec` turns `opts.env` into `-e KEY=VALUE` argv entries for
 *    `docker exec`, so the full PAN and CVC appeared in the HOST's process argv,
 *    readable by any local user via `ps` / `/proc/<pid>/cmdline`;
 *  - inside any world, a co-resident process (the agent itself, same uid) can read
 *    `/proc/<pid>/environ` of the helper for its whole lifetime.
 * This is the same stdin channel `world-fill.ts` uses for passwords, and the
 * container/E2B/Daytona providers all implement `ExecOptions.input`.
 */
export async function fillCardInWorld(world: World, args: {
  cdpUrl: string;
  domain: string;
  selectors: CardFillSelectors;
  details: CardFillDetails;
}): Promise<{ origin: string }> {
  const result = await world.exec('node', ['--input-type=module', '-e', REMOTE_CARD_FILL], {
    timeoutMs: 30_000,
    input: JSON.stringify({
      number: args.details.number,
      cvc: args.details.cvc,
      month: String(args.details.expMonth).padStart(2, '0'),
      year: String(args.details.expYear),
      billing: args.details.billing ?? {},
    }),
    env: {
      KARMAX_CARD_CDP: args.cdpUrl,
      KARMAX_CARD_DOMAIN: args.domain,
      KARMAX_CARD_SELECTORS: JSON.stringify(args.selectors),
    },
  });
  if (result.code !== 0) throw new Error(`secure card fill failed in the task world: ${result.stderr.trim().slice(0, 500)}`);
  let value: any;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('secure card fill returned an invalid result'); }
  if (typeof value?.origin !== 'string') throw new Error('secure card fill did not verify a browser origin');
  return { origin: value.origin };
}

// Self-contained because a remote World does not have Karmax's source tree.
// Values beginning with @ are focus controls: @focused types into the field the
// browser tool already focused (including a cross-origin iframe); @tab advances
// once before typing, which covers common hosted checkout field sequences.
const REMOTE_CARD_FILL = String.raw`
const card = await new Promise((resolve, reject) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { buf += d; });
  process.stdin.on('end', () => resolve(buf));
  process.stdin.on('error', reject);
}).then(text => {
  // NEVER let a raw JSON parse error escape this process. V8 quotes a fragment of
  // the offending input in SyntaxError.message ("Unexpected token 'b',
  // \"ber\":\"4242\"... is not valid JSON") and prints the whole offending source
  // besides — and fillCardInWorld splices this process's stderr into the error it
  // throws, which karmax logs and shows in the UI. Stdin can arrive truncated or
  // partial (E2B streams sendStdin, Daytona uploads a file), so that fragment is
  // real PAN/CVC digits. The replacement message is fixed and input-independent.
  try { return JSON.parse(text || '{}'); }
  catch { throw new Error('card details on stdin were not valid JSON'); }
});
if (!card.number || !card.cvc) throw new Error('card details were not delivered on stdin');
const cdp = new URL(process.env.KARMAX_CARD_CDP);
if (cdp.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(cdp.hostname))
  throw new Error('CDP endpoint must be loopback inside the task world');
const pages = await fetch(new URL('/json/list', cdp)).then(r => {
  if (!r.ok) throw new Error('browser target discovery failed');
  return r.json();
});
const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
if (!page) throw new Error('no browser page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('browser websocket failed')), { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', event => {
  const msg = JSON.parse(String(event.data));
  if (!msg.id) return;
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(msg.error.message));
  else waiter.resolve(msg.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const originResult = await call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
const origin = originResult?.result?.value;
const host = new URL(origin).hostname.toLowerCase();
const expected = process.env.KARMAX_CARD_DOMAIN.toLowerCase();
if (host !== expected && !host.endsWith('.' + expected)) throw new Error('checkout origin does not match reserved merchant');
const selectors = JSON.parse(process.env.KARMAX_CARD_SELECTORS);
const focus = async selector => {
  if (selector === '@tab') {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
    return;
  }
  if (selector === '@focused') return;
  const result = await call('Runtime.evaluate', {
    expression: '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.focus(); return true; })()',
    returnByValue: true,
  });
  if (result?.result?.value !== true) throw new Error('checkout field selector did not match');
};
const type = async (selector, text) => { await focus(selector); await call('Input.insertText', { text }); };
await type(selectors.number, card.number);
if (selectors.expiry) await type(selectors.expiry, card.month + '/' + card.year.slice(-2));
else {
  await type(selectors.expMonth, card.month);
  await type(selectors.expYear, card.year);
}
await type(selectors.cvc, card.cvc);
const billing = card.billing || {};
for (const field of ['line1', 'city', 'postalCode', 'country'])
  if (selectors[field] && billing[field]) await type(selectors[field], billing[field]);
ws.close();
process.stdout.write(JSON.stringify({ origin }));
`;
