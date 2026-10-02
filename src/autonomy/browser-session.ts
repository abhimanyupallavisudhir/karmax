import { getDomain } from 'tldts';
import type { CdpSession } from './cdp.js';
import { domainMatches } from './vault-items.js';

/**
 * Saved browser sessions: what "being signed in" to a site is, kept as a
 * vault item so another task's browser can start signed in. A site that is
 * reached through "Sign in with Google/GitHub" ends in the same place as a
 * password login: cookies (and, for some apps, localStorage) on the site's own
 * domain. Capturing those, and only those, lets a person sign in once, by
 * whatever method the site offers, without handing a task the identity
 * provider's password, which would open every site federated through it.
 *
 * The gateway drives both directions over CDP on the task's own browser, so
 * the values never pass through the model. The page must be on one of the
 * item's domains (origin-verified by the caller), and localStorage is read
 * and written in an isolated world whose script re-checks the live origin, so
 * a navigation between check and write cannot redirect it (as in fill.ts).
 */

export interface SessionCookie {
  name: string;
  value: string;
  /** As CDP reports it: a leading dot marks a domain cookie, none a host-only one. */
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Seconds since the epoch; absent for a cookie that ends with the browser. */
  expires?: number;
}

export interface SavedSession {
  version: 1;
  capturedAt: number;
  cookies: SessionCookie[];
  /** localStorage of the origin the session was captured on. */
  storage: Array<{ origin: string; localStorage: Array<[string, string]> }>;
}

/** The vault's per-item ceiling is 64 KiB; leave room for the item's metadata. */
const MAX_SESSION_BYTES = 48 * 1024;

/** Why `domain` cannot scope a session, if it cannot. A public suffix such as
 *  `com` or `github.io` would sweep up every site under it. */
export function sessionDomainError(domain: string): string | undefined {
  const d = domain.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!d || !/^[a-z0-9.-]+$/.test(d)) return `"${domain}" is not a host name`;
  if (!getDomain(d, { allowPrivateDomains: true })) return `"${domain}" is a public suffix; name the site itself`;
  return undefined;
}

/** Is a cookie stored for `cookieDomain` sent to any host under `domains`?
 *  A domain cookie for a parent (`.example.com` for `app.example.com`) is; a
 *  cookie of an unrelated site, such as the identity provider's, is not. */
export function cookieBelongs(cookieDomain: string, domains: string[]): boolean {
  const host = cookieDomain.replace(/^\./, '');
  return domains.some((d) => domainMatches(host, d) || (cookieDomain.startsWith('.') && domainMatches(d, host)));
}

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

/** Parse and validate a stored session; anything else is refused, so a
 *  malformed value cannot reach `Network.setCookies`. */
export function parseSavedSession(raw: string): SavedSession {
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new Error('a saved session must be JSON'); }
  const str = (v: unknown) => typeof v === 'string';
  if (!value || value.version !== 1 || typeof value.capturedAt !== 'number' || !Array.isArray(value.cookies) || !Array.isArray(value.storage))
    throw new Error('not a saved browser session');
  for (const c of value.cookies) {
    if (!c || !str(c.name) || !str(c.value) || !str(c.domain) || !c.domain || !str(c.path) || typeof c.secure !== 'boolean' || typeof c.httpOnly !== 'boolean'
      || (c.sameSite !== undefined && !SAME_SITE.has(c.sameSite)) || (c.expires !== undefined && typeof c.expires !== 'number'))
      throw new Error('a saved session holds a malformed cookie');
  }
  for (const s of value.storage) {
    if (!s || !str(s.origin) || !Array.isArray(s.localStorage) || !s.localStorage.every((e: unknown) => Array.isArray(e) && e.length === 2 && e.every(str)))
      throw new Error('a saved session holds malformed storage');
  }
  return value as SavedSession;
}

// Runs in an isolated world: the page's realm cannot redefine what it uses.
// `entries === null` reads the origin's localStorage; otherwise it writes the
// entries, but only into `origin`, the one they were captured on.
const STORAGE_IN_PAGE = `(domains, origin, entries) => {
  const host = location.hostname.toLowerCase().replace(/\\.$/, '');
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  if (location.protocol !== 'https:' && !(location.protocol === 'http:' && loopback))
    return { error: 'refusing: ' + (location.origin === 'null' ? location.href : location.origin) + ' is not a secure page' };
  const matches = domains.some((domain) => {
    const d = String(domain).toLowerCase().replace(/^\\*\\./, '').replace(/\\.$/, '');
    return host === d || host.endsWith('.' + d);
  });
  if (!matches) return { error: 'refusing: the page origin (' + location.origin + ') does not match the expected domains (' + domains.join(', ') + ')' };
  if (entries === null) {
    const read = [];
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); read.push([key, localStorage.getItem(key)]); }
    return { origin: location.origin, entries: read };
  }
  if (location.origin !== origin) return { origin: location.origin, skipped: true };
  for (const [key, value] of entries) localStorage.setItem(key, value);
  return { origin: location.origin };
}`;

async function inIsolatedWorld(session: CdpSession, domains: string[], origin: string | null, entries: Array<[string, string]> | null) {
  const frameId = (await session.call('Page.getFrameTree'))?.frameTree?.frame?.id;
  const contextId = frameId && (await session.call('Page.createIsolatedWorld', { frameId, worldName: 'karmax-session' }))?.executionContextId;
  if (!contextId) throw new Error('could not open an isolated world in the page');
  const result = await session.call('Runtime.evaluate', { returnByValue: true, contextId,
    expression: `(${STORAGE_IN_PAGE})(${JSON.stringify(domains)}, ${JSON.stringify(origin)}, ${JSON.stringify(entries)})` });
  const outcome = result?.result?.value;
  if (!outcome || typeof outcome !== 'object' || outcome.error) throw new Error(outcome?.error ?? 'the page did not answer');
  return outcome as { origin: string; entries?: Array<[string, string]>; skipped?: boolean };
}

/**
 * Read the session of the signed-in site open on `session`'s page: its
 * cookies on `domains` and the page origin's localStorage. Storage too large
 * for the vault is left out (`storageOmitted`), as most sites keep their
 * sign-in in cookies.
 */
export async function captureSession(session: CdpSession, domains: string[], now = Date.now()): Promise<{ saved: SavedSession; storageOmitted: boolean }> {
  const { origin, entries } = await inIsolatedWorld(session, domains, null, null);
  const all = ((await session.call('Network.getAllCookies'))?.cookies ?? []) as any[];
  const cookies: SessionCookie[] = all
    .filter((c) => typeof c?.domain === 'string' && !c.partitionKey && cookieBelongs(c.domain, domains))
    .filter((c) => c.session || !(c.expires > 0 && c.expires * 1000 <= now))
    .map((c) => ({
      name: String(c.name), value: String(c.value), domain: c.domain, path: String(c.path || '/'),
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      ...(SAME_SITE.has(c.sameSite) ? { sameSite: c.sameSite } : {}),
      ...(!c.session && c.expires > 0 ? { expires: c.expires } : {}),
    }));
  let saved: SavedSession = { version: 1, capturedAt: now, cookies, storage: entries?.length ? [{ origin, localStorage: entries }] : [] };
  let storageOmitted = false;
  if (Buffer.byteLength(JSON.stringify(saved)) > MAX_SESSION_BYTES && saved.storage.length) {
    saved = { ...saved, storage: [] };
    storageOmitted = true;
  }
  if (Buffer.byteLength(JSON.stringify(saved)) > MAX_SESSION_BYTES) throw new Error('this site\'s cookies are too large to save');
  return { saved, storageOmitted };
}

/**
 * Put a saved session into `session`'s browser and reload the page, which must
 * already be on one of `domains`. Cookies outside `domains` are never set, even
 * if the stored value holds them, and expired ones are dropped.
 */
export async function restoreSession(session: CdpSession, domains: string[], saved: SavedSession, now = Date.now()): Promise<{ cookies: number; expired: number; localStorage: boolean }> {
  const scoped = saved.cookies.filter((c) => cookieBelongs(c.domain, domains));
  const live = scoped.filter((c) => !(c.expires !== undefined && c.expires * 1000 <= now));
  // Check the page before any cookie is set: a restore runs only on the site.
  const storage = saved.storage[0];
  const written = await inIsolatedWorld(session, domains, storage?.origin ?? null, storage?.localStorage ?? []);
  if (live.length) {
    await session.call('Network.setCookies', { cookies: live.map((c) => ({
      name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      ...(c.expires !== undefined ? { expires: c.expires } : {}),
      // A host-only cookie is set by URL; naming its domain would widen it to subdomains.
      ...(c.domain.startsWith('.') ? { domain: c.domain } : { url: `https://${c.domain}${c.path.startsWith('/') ? c.path : '/'}` }),
    })) });
  }
  await session.call('Page.reload', {});
  return { cookies: live.length, expired: scoped.length - live.length, localStorage: !!storage?.localStorage.length && !written.skipped };
}
