import { getDomain } from 'tldts';
import type { CdpSession } from './cdp.js';
import { domainMatches } from './vault-items.js';

/**
 * Saved browser sessions: what "being signed in" to a site is, kept as a
 * vault item so another task's browser can start signed in. A site that is
 * reached through "Sign in with Google/GitHub" ends in the same place as a
 * password login: cookies and, for some apps, web storage (localStorage,
 * sessionStorage, IndexedDB, where Firebase Auth keeps its tokens) on the
 * site's own domain. Capturing those, and only those, lets a person sign in
 * once, by whatever method the site offers, without handing a task the
 * identity provider's password, which would open every site federated
 * through it.
 *
 * The gateway drives both directions over CDP on the task's own browser, so
 * the values never pass through the model. The page must be on one of the
 * item's domains (origin-verified by the caller), and storage is read and
 * written in an isolated world whose script re-checks the live origin, so a
 * navigation between check and write cannot redirect it (as in fill.ts).
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

/** One IndexedDB database. Keys and values are tagged JSON (see the page codec),
 *  so dates, binary data, maps and sets survive the copy. */
export interface SavedDatabase {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>;
    records: Array<[unknown, unknown]>;
  }>;
}

export interface SavedStorage {
  origin: string;
  localStorage: Array<[string, string]>;
  sessionStorage?: Array<[string, string]>;
  indexedDB?: SavedDatabase[];
}

export interface SavedSession {
  version: 1;
  capturedAt: number;
  cookies: SessionCookie[];
  /** Web storage of the origin the session was captured on. */
  storage: SavedStorage[];
}

/** The vault's per-secret ceiling is 64 KiB; leave room for escaping and metadata. */
const MAX_SESSION_BYTES = 48 * 1024;
const sessionBytes = (saved: SavedSession) => Buffer.byteLength(JSON.stringify(JSON.stringify(saved)));

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

const originBelongs = (origin: string, domains: string[]) => {
  try { return domains.some((d) => domainMatches(new URL(origin).hostname, d)); } catch { return false; }
};

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

/** Parse and validate a stored session; anything else is refused, so a
 *  malformed value cannot reach `Network.setCookies` or a page. */
export function parseSavedSession(raw: string): SavedSession {
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new Error('a saved session must be JSON'); }
  const str = (v: unknown) => typeof v === 'string';
  const pairs = (v: unknown) => Array.isArray(v) && v.every((e) => Array.isArray(e) && e.length === 2 && e.every(str));
  if (!value || value.version !== 1 || typeof value.capturedAt !== 'number' || !Array.isArray(value.cookies) || !Array.isArray(value.storage))
    throw new Error('not a saved browser session');
  for (const c of value.cookies) {
    if (!c || !str(c.name) || !str(c.value) || !str(c.domain) || !c.domain || !str(c.path) || typeof c.secure !== 'boolean' || typeof c.httpOnly !== 'boolean'
      || (c.sameSite !== undefined && !SAME_SITE.has(c.sameSite)) || (c.expires !== undefined && typeof c.expires !== 'number'))
      throw new Error('a saved session holds a malformed cookie');
  }
  for (const s of value.storage) {
    if (!s || !str(s.origin) || !pairs(s.localStorage) || (s.sessionStorage !== undefined && !pairs(s.sessionStorage)))
      throw new Error('a saved session holds malformed storage');
    for (const db of s.indexedDB ?? []) {
      if (!db || !str(db.name) || !Number.isSafeInteger(db.version) || db.version < 1 || !Array.isArray(db.stores)
        || !db.stores.every((st: any) => st && str(st.name) && typeof st.autoIncrement === 'boolean' && Array.isArray(st.indexes) && Array.isArray(st.records)
          && st.records.every((r: unknown) => Array.isArray(r) && r.length === 2)))
        throw new Error('a saved session holds a malformed database');
    }
  }
  return value as SavedSession;
}

// Runs in an isolated world: the page's realm cannot redefine what it uses.
// `probe` reports the origin; `read` returns the origin's web storage, each
// IndexedDB database at most `budget` bytes; `write` restores storage, but only
// into `origin`, the one it was captured on. Values are tagged JSON so that
// what IndexedDB holds besides JSON (dates, binary, maps, sets) round-trips;
// a database holding anything else (a CryptoKey, a Blob) is skipped whole.
const STORAGE_IN_PAGE = `async (domains, mode, origin, payload, budget) => {
  const host = location.hostname.toLowerCase().replace(/\\.$/, '');
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  if (location.protocol !== 'https:' && !(location.protocol === 'http:' && loopback))
    return { error: 'refusing: ' + (location.origin === 'null' ? location.href : location.origin) + ' is not a secure page' };
  const matches = domains.some((domain) => {
    const d = String(domain).toLowerCase().replace(/^\\*\\./, '').replace(/\\.$/, '');
    return host === d || host.endsWith('.' + d);
  });
  if (!matches) return { error: 'refusing: the page origin (' + location.origin + ') does not match the expected domains (' + domains.join(', ') + ')' };
  if (mode === 'probe') return { origin: location.origin };
  const UNCOPYABLE = 'holds values that cannot be copied';
  const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return btoa(s); };
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const VIEWS = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray, BigInt64Array, BigUint64Array };
  const enc = (v, depth = 0) => {
    if (depth > 64) throw new Error(UNCOPYABLE);
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $t: 'num', v: String(v) };
    if (v === undefined) return { $t: 'undef' };
    if (typeof v === 'bigint') return { $t: 'big', v: String(v) };
    if (typeof v !== 'object') throw new Error(UNCOPYABLE);
    if (Array.isArray(v)) return v.map((e) => enc(e, depth + 1));
    if (v instanceof Date) return { $t: 'date', v: v.getTime() };
    if (v instanceof ArrayBuffer) return { $t: 'buf', v: b64(new Uint8Array(v)) };
    if (v instanceof DataView) return { $t: 'view', k: 'DataView', v: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (ArrayBuffer.isView(v) && VIEWS[v.constructor.name]) return { $t: 'view', k: v.constructor.name, v: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v instanceof Map) return { $t: 'map', v: [...v].map(([a, b]) => [enc(a, depth + 1), enc(b, depth + 1)]) };
    if (v instanceof Set) return { $t: 'set', v: [...v].map((e) => enc(e, depth + 1)) };
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(UNCOPYABLE);
    const out = {};
    for (const k of Object.keys(v)) out[k] = enc(v[k], depth + 1);
    return Object.prototype.hasOwnProperty.call(v, '$t') ? { $t: 'obj', v: out } : out;
  };
  const dec = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(dec);
    const plain = (o) => { const out = {}; for (const k of Object.keys(o)) out[k] = dec(o[k]); return out; };
    switch (v.$t) {
      case undefined: return plain(v);
      case 'num': return Number(v.v);
      case 'undef': return undefined;
      case 'big': return BigInt(v.v);
      case 'date': return new Date(v.v);
      case 'buf': return unb64(v.v).buffer;
      case 'view': { const bytes = unb64(v.v); if (v.k === 'DataView') return new DataView(bytes.buffer); const View = VIEWS[v.k]; if (!View) throw new Error('unknown view'); return new View(bytes.buffer); }
      case 'map': return new Map(v.v.map(([a, b]) => [dec(a), dec(b)]));
      case 'set': return new Set(v.v.map(dec));
      case 'obj': return plain(v.v);
      default: throw new Error('unknown tag');
    }
  };
  const done = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const finished = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('aborted')); });
  const pairs = (storage) => { const out = []; for (let i = 0; i < storage.length; i++) { const key = storage.key(i); out.push([key, storage.getItem(key)]); } return out; };
  if (mode === 'read') {
    const databases = [], skipped = [];
    for (const info of (indexedDB.databases ? await indexedDB.databases() : [])) {
      if (!info.name) continue;
      let db;
      try {
        db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(info.name);
          request.onupgradeneeded = () => request.transaction.abort();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const names = [...db.objectStoreNames];
        const stores = [];
        if (names.length) {
          const tx = db.transaction(names, 'readonly');
          const reads = names.map((name) => { const store = tx.objectStore(name); return [store, done(store.getAllKeys()), done(store.getAll())]; });
          for (const [store, keys, values] of reads) {
            const k = await keys, v = await values;
            stores.push({ name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
              indexes: [...store.indexNames].map((n) => { const index = store.index(n); return { name: n, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; }),
              records: k.map((key, i) => [enc(key), enc(v[i])]) });
          }
        }
        const entry = { name: info.name, version: db.version, stores };
        if (JSON.stringify(entry).length > budget) skipped.push({ name: info.name, reason: 'too large to save' });
        else databases.push(entry);
      } catch (e) {
        skipped.push({ name: info.name, reason: (e && e.message) || String(e) });
      } finally { try { db && db.close(); } catch {} }
    }
    return { origin: location.origin, localStorage: pairs(localStorage), sessionStorage: pairs(sessionStorage), indexedDB: databases, skipped };
  }
  if (location.origin !== origin) return { origin: location.origin, skipped: true };
  for (const [key, value] of payload.localStorage || []) localStorage.setItem(key, value);
  for (const [key, value] of payload.sessionStorage || []) sessionStorage.setItem(key, value);
  const restored = [], failed = [];
  for (const saved of payload.indexedDB || []) {
    let db;
    try {
      const open = (version) => new Promise((resolve, reject) => {
        const request = version ? indexedDB.open(saved.name, version) : indexedDB.open(saved.name);
        request.onupgradeneeded = () => {
          for (const s of saved.stores) {
            if (request.result.objectStoreNames.contains(s.name)) continue;
            const store = request.result.createObjectStore(s.name, { keyPath: s.keyPath === null ? undefined : s.keyPath, autoIncrement: s.autoIncrement });
            for (const index of s.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      // The page may have reopened the database at a newer version since it was cleared.
      try { db = await open(saved.version); } catch (e) { if (e && e.name === 'VersionError') db = await open(); else throw e; }
      const names = saved.stores.map((s) => s.name).filter((name) => db.objectStoreNames.contains(name));
      if (names.length) {
        const tx = db.transaction(names, 'readwrite');
        const complete = finished(tx);
        for (const s of saved.stores) {
          if (!names.includes(s.name)) continue;
          const store = tx.objectStore(s.name);
          for (const [key, value] of s.records) store.keyPath === null ? store.put(dec(value), dec(key)) : store.put(dec(value));
        }
        await complete;
      }
      restored.push(saved.name);
    } catch (e) {
      failed.push({ name: saved.name, reason: (e && e.message) || String(e) });
    } finally { try { db && db.close(); } catch {} }
  }
  return { origin: location.origin, indexedDB: restored, failed };
}`;

async function inIsolatedWorld(session: CdpSession, domains: string[], mode: 'probe' | 'read' | 'write', origin?: string, payload?: Partial<SavedStorage>): Promise<any> {
  const frameId = (await session.call('Page.getFrameTree'))?.frameTree?.frame?.id;
  const contextId = frameId && (await session.call('Page.createIsolatedWorld', { frameId, worldName: 'karmax-session' }))?.executionContextId;
  if (!contextId) throw new Error('could not open an isolated world in the page');
  const result = await session.call('Runtime.evaluate', { returnByValue: true, awaitPromise: true, contextId,
    expression: `(${STORAGE_IN_PAGE})(${JSON.stringify(domains)}, ${JSON.stringify(mode)}, ${JSON.stringify(origin ?? null)}, ${JSON.stringify(payload ?? null)}, ${MAX_SESSION_BYTES})` });
  const outcome = result?.result?.value;
  if (!outcome || typeof outcome !== 'object' || outcome.error) throw new Error(outcome?.error ?? result?.exceptionDetails?.text ?? 'the page did not answer');
  return outcome;
}

/** Stay within the vault's ceiling by leaving out the bulkiest storage first:
 *  databases (largest first), then sessionStorage, then localStorage. Most
 *  sites keep their sign-in in cookies or a small store, which survive. */
function fit(saved: SavedSession): { saved: SavedSession; omitted: string[] } {
  const omitted: string[] = [];
  const next: SavedSession = { ...saved, storage: saved.storage.map((s) => ({ ...s, indexedDB: [...(s.indexedDB ?? [])] })) };
  while (sessionBytes(next) > MAX_SESSION_BYTES) {
    const s = next.storage[0];
    if (!s) throw new Error('this site\'s cookies are too large to save');
    const dbs = s.indexedDB ?? [];
    if (dbs.length) {
      const largest = dbs.reduce((a, b) => JSON.stringify(b).length > JSON.stringify(a).length ? b : a);
      s.indexedDB = dbs.filter((db) => db !== largest);
      omitted.push(`IndexedDB "${largest.name}"`);
    } else if (s.sessionStorage?.length) { s.sessionStorage = []; omitted.push('sessionStorage'); }
    else { next.storage = []; omitted.push('localStorage'); }
  }
  for (const s of next.storage) if (!s.indexedDB?.length) delete s.indexedDB;
  return { saved: next, omitted };
}

function liveCookies(all: any[], domains: string[], now: number): SessionCookie[] {
  return all
    .filter((c) => typeof c?.domain === 'string' && !c.partitionKey && cookieBelongs(c.domain, domains))
    .filter((c) => c.session || !(c.expires > 0 && c.expires * 1000 <= now))
    .map((c) => ({
      name: String(c.name), value: String(c.value), domain: c.domain, path: String(c.path || '/'),
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      ...(SAME_SITE.has(c.sameSite) ? { sameSite: c.sameSite } : {}),
      ...(!c.session && c.expires > 0 ? { expires: c.expires } : {}),
    }));
}

function storageOf(read: any): SavedStorage[] {
  const entry: SavedStorage = { origin: read.origin, localStorage: read.localStorage ?? [],
    ...(read.sessionStorage?.length ? { sessionStorage: read.sessionStorage } : {}),
    ...(read.indexedDB?.length ? { indexedDB: read.indexedDB } : {}) };
  return entry.localStorage.length || entry.sessionStorage || entry.indexedDB ? [entry] : [];
}

/**
 * Read the session of the signed-in site open on `session`'s page: its
 * cookies on `domains` and the page origin's web storage. What does not fit
 * the vault, or cannot be copied, is left out and named in `omitted`.
 */
export async function captureSession(session: CdpSession, domains: string[], now = Date.now()): Promise<{ saved: SavedSession; omitted: string[] }> {
  const read = await inIsolatedWorld(session, domains, 'read');
  const cookies = liveCookies((await session.call('Network.getAllCookies'))?.cookies ?? [], domains, now);
  const fitted = fit({ version: 1, capturedAt: now, cookies, storage: storageOf(read) });
  return { saved: fitted.saved, omitted: [...(read.skipped ?? []).map((s: any) => `IndexedDB "${s.name}" (${s.reason})`), ...fitted.omitted] };
}

/** Is there anything left to sign in with? Expired cookies are dropped on
 *  restore; a session with no live cookie and no storage has expired. */
export function sessionState(saved: SavedSession, domains: string[], now = Date.now()) {
  const scoped = saved.cookies.filter((c) => cookieBelongs(c.domain, domains));
  const live = scoped.filter((c) => !(c.expires !== undefined && c.expires * 1000 <= now));
  return { live, expired: scoped.length - live.length, usable: live.length > 0 || saved.storage.length > 0 };
}

/**
 * Put a saved session into `session`'s browser and reload the page, which must
 * already be on one of `domains`. Cookies outside `domains` are never set, even
 * if the stored value holds them, and expired ones are dropped. Saved
 * IndexedDB databases replace the origin's own, which the browser closes first
 * so a page holding a connection cannot block the restore.
 */
export async function restoreSession(session: CdpSession, domains: string[], saved: SavedSession, now = Date.now()) {
  const { live, expired } = sessionState(saved, domains, now);
  // Check the page before anything is set: a restore runs only on the site.
  const { origin } = await inIsolatedWorld(session, domains, 'probe');
  const storage = saved.storage.find((s) => s.origin === origin && originBelongs(s.origin, domains));
  let written: any = { indexedDB: [], failed: [] };
  if (storage) {
    if (storage.indexedDB?.length) await session.call('Storage.clearDataForOrigin', { origin: storage.origin, storageTypes: 'indexeddb' });
    written = await inIsolatedWorld(session, domains, 'write', storage.origin, storage);
  }
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
  const restoredStorage = !!storage && !written.skipped;
  return {
    cookies: live.length, expired,
    localStorage: restoredStorage && storage!.localStorage.length > 0,
    sessionStorage: restoredStorage && (storage!.sessionStorage?.length ?? 0) > 0,
    indexedDB: (written.indexedDB ?? []) as string[],
    ...(written.failed?.length ? { failed: (written.failed as Array<{ name: string; reason: string }>).map((f) => `IndexedDB "${f.name}" (${f.reason})`) } : {}),
  };
}

/**
 * The browser's current copy of a session the task holds, merged over the
 * stored one: cookies and storage keys the site set or rotated replace the
 * stored values, and new ones are added. Nothing is removed, so a page that
 * signed out, or a browser that lost its state, cannot overwrite a working
 * session with an empty one. Storage is read only when `session`'s page is on
 * the origin it came from; otherwise the stored storage is kept.
 */
export async function refreshSession(session: CdpSession, domains: string[], stored: SavedSession, now = Date.now()): Promise<{ saved: SavedSession; changed: boolean }> {
  const fresh = liveCookies((await session.call('Network.getAllCookies'))?.cookies ?? [], domains, now);
  const key = (c: SessionCookie) => `${c.name}\0${c.domain}\0${c.path}`;
  const cookies = new Map(stored.cookies.filter((c) => !(c.expires !== undefined && c.expires * 1000 <= now)).map((c) => [key(c), c]));
  for (const c of fresh) cookies.set(key(c), c);
  let storage = stored.storage;
  try {
    const read = await inIsolatedWorld(session, domains, 'read');
    const [current] = storageOf(read);
    const prior = stored.storage.find((s) => s.origin === read.origin);
    if (current && (prior || !stored.storage.length)) {
      const merge = (a: Array<[string, string]> = [], b: Array<[string, string]> = []) => [...new Map([...a, ...b])];
      const databases = new Map((prior?.indexedDB ?? []).map((db) => [db.name, db]));
      for (const db of current.indexedDB ?? []) databases.set(db.name, db);
      const merged: SavedStorage = { origin: current.origin, localStorage: merge(prior?.localStorage, current.localStorage),
        ...(prior?.sessionStorage || current.sessionStorage ? { sessionStorage: merge(prior?.sessionStorage, current.sessionStorage) } : {}),
        ...(databases.size ? { indexedDB: [...databases.values()] } : {}) };
      storage = [merged, ...stored.storage.filter((s) => s.origin !== merged.origin)];
    }
  } catch { /* the page is elsewhere: keep the stored storage */ }
  const candidate = fit({ version: 1, capturedAt: stored.capturedAt, cookies: [...cookies.values()], storage }).saved;
  const changed = JSON.stringify(candidate) !== JSON.stringify(stored);
  return { saved: changed ? { ...candidate, capturedAt: now } : stored, changed };
}
