import type { World } from '../world/types.js';

export interface CardFillDetails {
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
}

export interface CardFillSelectors {
  number: string;
  cvc: string;
  expiry?: string;
  expMonth?: string;
  expYear?: string;
}

/**
 * Fill a card inside a container/remote world's own loopback browser. Secrets
 * travel only in the provider process environment, never argv/stdout/stderr.
 */
export async function fillCardInWorld(world: World, args: {
  cdpUrl: string;
  domain: string;
  selectors: CardFillSelectors;
  details: CardFillDetails;
}): Promise<{ origin: string }> {
  const result = await world.exec('node', ['-e', REMOTE_CARD_FILL], {
    timeoutMs: 30_000,
    env: {
      KARMAX_CARD_CDP: args.cdpUrl,
      KARMAX_CARD_DOMAIN: args.domain,
      KARMAX_CARD_SELECTORS: JSON.stringify(args.selectors),
      KARMAX_CARD_NUMBER: args.details.number,
      KARMAX_CARD_CVC: args.details.cvc,
      KARMAX_CARD_MONTH: String(args.details.expMonth).padStart(2, '0'),
      KARMAX_CARD_YEAR: String(args.details.expYear),
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
await type(selectors.number, process.env.KARMAX_CARD_NUMBER);
if (selectors.expiry) await type(selectors.expiry, process.env.KARMAX_CARD_MONTH + '/' + process.env.KARMAX_CARD_YEAR.slice(-2));
else {
  await type(selectors.expMonth, process.env.KARMAX_CARD_MONTH);
  await type(selectors.expYear, process.env.KARMAX_CARD_YEAR);
}
await type(selectors.cvc, process.env.KARMAX_CARD_CVC);
ws.close();
process.stdout.write(JSON.stringify({ origin }));
`;
