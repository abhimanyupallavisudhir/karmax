import { domainMatches } from './vault-items.js';

/**
 * Shared Chrome DevTools Protocol plumbing for the host-side credential paths
 * (browser fill §5B, passkey enrollment §8). The gateway — never the agent —
 * drives these, so a secret typed or a passkey enrolled never enters the model.
 *
 * Endpoints are restricted to loopback. The honest trust boundary (see fill.ts):
 * the CDP endpoint is discovered inside the agent's world, so this hardens
 * against prompt injection steering a real browser (the live page origin is
 * verified over CDP before any secret is used), not against a malicious agent
 * standing up a fake CDP server.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpSession {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}

export function assertLoopback(cdpUrl: string): URL {
  const base = new URL(cdpUrl);
  if (base.protocol !== 'http:' || !LOOPBACK.has(base.hostname)) {
    throw new Error('cdpUrl must be a loopback http endpoint (http://127.0.0.1:<port>)');
  }
  return base;
}

export async function listPages(cdpUrl: string, timeoutMs = 15_000): Promise<CdpTarget[]> {
  const base = assertLoopback(cdpUrl);
  const targets = (await (await fetch(new URL('/json/list', base), { signal: AbortSignal.timeout(timeoutMs) })).json()) as CdpTarget[];
  return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

/** Choose the page whose target-list url matches one of `domains` (all if unset). */
export function pickPage(pages: CdpTarget[], domains?: string[]): CdpTarget | undefined {
  if (!domains?.length) return pages[0];
  return pages.find((t) => {
    try {
      return domains.some((d) => domainMatches(new URL(t.url).hostname, d));
    } catch {
      return false;
    }
  });
}

export async function connect(wsUrl: string, timeoutMs = 15_000): Promise<CdpSession> {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
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
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP connection failed')); });
  });
  return {
    call: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
    }),
    close: () => ws.close(),
  };
}

/** Open a session on the page matching `expectDomains`, with the live origin
 *  verified over CDP (the target list's url can lag or lie). */
export async function openPage(cdpUrl: string, opts: { expectDomains?: string[]; timeoutMs?: number } = {}): Promise<{ session: CdpSession; origin: string }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pages = await listPages(cdpUrl, timeoutMs);
  const page = pickPage(pages, opts.expectDomains);
  if (!page) {
    throw new Error(opts.expectDomains?.length
      ? `no open page matches ${opts.expectDomains.join(', ')} — navigate to the login page first`
      : 'no open page at the CDP endpoint');
  }
  const session = await connect(page.webSocketDebuggerUrl!, timeoutMs);
  try {
    const originResult = await session.call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
    const origin = String(originResult?.result?.value ?? '');
    if (opts.expectDomains?.length) {
      let host = '';
      try {
        host = new URL(origin).hostname;
      } catch {
        /* about:blank etc. */
      }
      if (!host || !opts.expectDomains.some((d) => domainMatches(host, d))) {
        throw new Error(`refusing: the page origin (${origin || 'unknown'}) does not match the expected domains (${opts.expectDomains.join(', ')})`);
      }
    }
    return { session, origin };
  } catch (e) {
    session.close();
    throw e;
  }
}
