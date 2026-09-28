import { openPage } from './cdp.js';

/**
 * Broker-side browser fill (wiki plans/PLAN-passwords §5B): the gateway — not the
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
  text?: string;
  /**
   * Preferred host-side resolver. It is called only after both the live page
   * origin and selector have been verified, so a rejected phishing target
   * does not even resolve/audit the vault value.
   */
  resolveText?: () => string | Promise<string>;
  /** The page origin must suffix-match one of these (from the vault item). */
  expectDomains?: string[];
  timeoutMs?: number;
}

/**
 * The in-page half of a fill, as source for `Runtime.evaluate`: in one task it
 * checks the page's own origin (https, or http on loopback), finds the field
 * and, given a value, writes it through the field's native setter with the
 * `input` and `change` events typing would fire. Checking and typing in separate
 * CDP calls let a navigation, or a frame that took focus in between, receive
 * the secret (AU-38). A frame is never a target. `selector` null checks only the
 * page; `value` null checks without writing. It runs in an isolated world: in the
 * page's own realm a phishing page could redefine the builtins it compares
 * with. Identical in cdp-fill.mjs, which runs inside remote worlds (pinned by
 * tests/fill-origin.browser.test.ts).
 */
export const WRITE_IN_PAGE = `(selector, domains, value) => {
  const host = location.hostname.toLowerCase().replace(/\\.$/, '');
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  if (location.protocol !== 'https:' && !(location.protocol === 'http:' && loopback))
    return { error: 'refusing: ' + (location.origin === 'null' ? location.href : location.origin) + ' is not a secure page' };
  const matches = domains.some((domain) => {
    const d = String(domain).toLowerCase().replace(/^\\*\\./, '').replace(/\\.$/, '');
    return host === d || host.endsWith('.' + d);
  });
  if (!matches) return { error: 'refusing: the page origin (' + location.origin + ') does not match the expected domains (' + domains.join(', ') + ')' };
  if (selector === null) return { origin: location.origin };
  let target = selector === '@focused' ? document.activeElement : document.querySelector(selector);
  while (selector === '@focused' && target && target.shadowRoot && target.shadowRoot.activeElement) target = target.shadowRoot.activeElement;
  if (!target || (selector === '@focused' && target === document.body)) return { error: 'no element matches selector ' + selector };
  if (target.tagName === 'IFRAME' || target.tagName === 'FRAME') return { error: 'refusing: the field is in another frame' };
  const input = target instanceof HTMLInputElement && ['text', 'password', 'email', 'tel', 'url', 'search', 'number'].includes(target.type);
  if (!input && !(target instanceof HTMLTextAreaElement) && !target.isContentEditable)
    return { error: 'refusing: ' + selector + ' is not a text field' };
  if (value === null) return { origin: location.origin };
  target.focus();
  if (target.isContentEditable) target.textContent = value;
  else Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value').set.call(target, value);
  target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return { origin: location.origin };
}`;

type InPage = { origin: string } | { error: string };

export async function fillViaCdp(args: CdpFillArgs): Promise<{ origin: string }> {
  if (!args.expectDomains?.length) throw new Error('browser fill requires credential domains');
  const domains = args.expectDomains;
  const { session } = await openPage(args.cdpUrl, { expectDomains: domains, timeoutMs: args.timeoutMs });
  try {
    // One isolated world for the current document: a navigation destroys it,
    // so a write can never land in the page that replaced the checked one.
    const frameId = (await session.call('Page.getFrameTree'))?.frameTree?.frame?.id;
    const contextId = (await session.call('Page.createIsolatedWorld', { frameId, worldName: 'karmax-fill' }))?.executionContextId;
    if (!frameId || !contextId) throw new Error('could not open an isolated world in the page');
    const inPage = async (selector: string | null, value: string | null): Promise<{ origin: string }> => {
      const result = await session.call('Runtime.evaluate', { returnByValue: true, contextId,
        expression: `(${WRITE_IN_PAGE})(${JSON.stringify(selector)}, ${JSON.stringify(domains)}, ${JSON.stringify(value)})` });
      const outcome = result?.result?.value as InPage | undefined;
      if (!outcome || typeof outcome !== 'object' || 'error' in outcome) throw new Error(outcome && typeof outcome === 'object' && 'error' in outcome ? outcome.error : 'the page did not answer the fill');
      return outcome;
    };
    if (args.selector === '@tab') {
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
    }
    const selector = args.selector === '@tab' ? '@focused' : args.selector;
    // Verify the field before resolving the secret, so a refused target never
    // even reads (or audits) the vault value; the write checks again.
    await inPage(selector, null);
    const text = (await args.resolveText?.()) ?? args.text;
    if (text === undefined) throw new Error('credential fill has no value resolver');
    return await inPage(selector, text);
  } finally {
    (await session.close());
  }
}
