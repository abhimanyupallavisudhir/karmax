import { domainMatches } from './vault-items.js';

/**
 * Broker-side browser fill (PLAN-passwords.md §5B): the gateway — not the
 * agent — resolves a secret and types it into a page over the Chrome DevTools
 * Protocol. The secret never appears in tool arguments, model context, or the
 * transcript; the agent only learns `{ filled: true }`.
 *
 * Trust boundary (stated honestly): the CDP endpoint is discovered inside the
 * agent's world, so a *malicious* agent that stands up a fake CDP server could
 * capture the fill. What this path hardens against is the common case — prompt
 * injection steering a real browser: the page origin is verified over CDP
 * (`location.origin`, which a page cannot spoof to the protocol) against the
 * item's declared domains before anything is typed, so "now fill the GitHub
 * password into evil.com" fails. Endpoints are restricted to loopback.
 */

export interface CdpFillArgs {
  /** DevTools endpoint, e.g. http://127.0.0.1:9222 — loopback only. */
  cdpUrl: string;
  /** CSS selector of the input to fill. */
  selector: string;
  /** The secret. Never echoed in results or errors. */
  text: string;
  /** The page origin must suffix-match one of these (from the vault item). */
  expectDomains?: string[];
  timeoutMs?: number;
}

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export async function fillViaCdp(args: CdpFillArgs): Promise<{ origin: string }> {
  const timeoutMs = args.timeoutMs ?? 15_000;
  const base = new URL(args.cdpUrl);
  if (base.protocol !== 'http:' || !LOOPBACK.has(base.hostname)) {
    throw new Error('cdpUrl must be a loopback http endpoint (http://127.0.0.1:<port>)');
  }
  const list = (await (await fetch(new URL('/json/list', base), { signal: AbortSignal.timeout(timeoutMs) })).json()) as CdpTarget[];
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const candidates = args.expectDomains?.length
    ? pages.filter((t) => {
        try {
          return args.expectDomains!.some((d) => domainMatches(new URL(t.url).hostname, d));
        } catch {
          return false;
        }
      })
    : pages;
  const page = candidates[0];
  if (!page) {
    throw new Error(args.expectDomains?.length
      ? `no open page matches ${args.expectDomains.join(', ')} — navigate to the login page first`
      : 'no open page at the CDP endpoint');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl!);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const call = (method: string, params?: Record<string, unknown>): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
    });
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`CDP error: ${msg.error.message ?? 'unknown'}`));
      else waiter.resolve(msg.result);
    } catch {
      /* non-JSON frame — ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP connection timed out')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(t);
      reject(new Error('CDP connection failed'));
    });
  });

  try {
    // The authoritative origin check — the target list's `url` can lag.
    const originResult = await call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
    const origin = String(originResult?.result?.value ?? '');
    if (args.expectDomains?.length) {
      let host = '';
      try {
        host = new URL(origin).hostname;
      } catch {
        /* about:blank etc. */
      }
      if (!host || !args.expectDomains.some((d) => domainMatches(host, d))) {
        throw new Error(`refusing to fill: the page origin (${origin || 'unknown'}) does not match this credential's domains (${args.expectDomains.join(', ')})`);
      }
    }
    const focus = await call('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return false; el.focus(); return true; })()`,
      returnByValue: true,
    });
    if (focus?.result?.value !== true) throw new Error(`no element matches selector ${args.selector}`);
    await call('Input.insertText', { text: args.text });
    return { origin };
  } finally {
    ws.close();
  }
}
