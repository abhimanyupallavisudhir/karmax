import { openPage } from './cdp.js';

/**
 * Broker-side browser fill (PLAN-passwords.md §5B): the gateway — not the
 * agent — resolves a secret and types it into a page over the Chrome DevTools
 * Protocol. The secret never appears in tool arguments, model context, or the
 * transcript; the agent only learns `{ filled: true }`.
 *
 * The page origin is verified over CDP against the item's declared domains
 * before anything is typed (see cdp.ts), so a prompt-injected "now fill the
 * GitHub password into evil.com" fails. Endpoints are loopback-only.
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

export async function fillViaCdp(args: CdpFillArgs): Promise<{ origin: string }> {
  const { session, origin } = await openPage(args.cdpUrl, { expectDomains: args.expectDomains, timeoutMs: args.timeoutMs });
  try {
    const focus = await session.call('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return false; el.focus(); return true; })()`,
      returnByValue: true,
    });
    if (focus?.result?.value !== true) throw new Error(`no element matches selector ${args.selector}`);
    await session.call('Input.insertText', { text: args.text });
    return { origin };
  } finally {
    session.close();
  }
}
