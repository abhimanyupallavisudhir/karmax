import crypto from 'node:crypto';

/**
 * IndexNow: tell search engines which public pages changed, instead of waiting
 * for them to look. Bing and the engines that share its index (which feed
 * ChatGPT's and Copilot's answers) take part; Google does not, and reads the
 * sitemap's <lastmod> instead.
 *
 * The protocol proves the sender owns the host by a key it serves at
 * `/<key>.txt`. After a deploy, a hosted installation submits the pages whose
 * address or last-changed day differs from what it submitted before, so a
 * restart with nothing new sends nothing.
 */

const ENDPOINT = 'https://api.indexnow.org/indexnow';
const KEY = 'indexnow:key';
const SUBMITTED = 'indexnow:submitted';

/** The part of the store this needs. */
export interface IndexNowStore {
  kvGet(key: string): Promise<string | undefined>;
  kvSet(key: string, value: string): Promise<unknown>;
  kvClaim(key: string, value: string): Promise<boolean>;
}

export interface IndexNowEntry { path: string; lastmod?: string }

/** The installation's key, made once: 32 hex characters, as the protocol asks (8 to 128 of a-z, 0-9, -). */
export async function indexNowKey(store: IndexNowStore): Promise<string> {
  const existing = await store.kvGet(KEY);
  if (existing) return existing;
  // Another process may be starting too: whichever claims first names the key.
  await store.kvClaim(KEY, crypto.randomBytes(16).toString('hex'));
  return (await store.kvGet(KEY))!;
}

/** The key if `pathname` is this installation's key file (`/<key>.txt`), which the gateway then serves. */
export async function indexNowKeyFile(store: IndexNowStore, pathname: string): Promise<string | undefined> {
  const named = pathname.match(/^\/([a-f0-9]{32})\.txt$/)?.[1];
  return named && named === (await store.kvGet(KEY)) ? named : undefined;
}

/**
 * Submit the entries that are new or changed since the last submission.
 * Returns the paths submitted. A refusal or an unreachable endpoint leaves the
 * record as it was, so the next start tries again.
 */
export async function announceChangedPages(options: {
  store: IndexNowStore; origin: string; entries: IndexNowEntry[];
  fetch?: typeof fetch; log?: (message: string) => void;
}): Promise<string[]> {
  const { store, origin, entries } = options;
  const host = new URL(origin).host;
  const before = parse(await store.kvGet(SUBMITTED));
  // A page with no last-changed day is announced once, when it first appears.
  const changed = entries.filter((entry) => before[entry.path] !== (entry.lastmod ?? ''));
  if (!changed.length) return [];
  const key = await indexNowKey(store);
  try {
    const response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ host, key, keyLocation: `${origin}/${key}.txt`, urlList: changed.map((entry) => `${origin}${entry.path}`) }),
    });
    // 200: received. 202: received, the key is still to be checked.
    if (response.status !== 200 && response.status !== 202) {
      options.log?.(`IndexNow refused ${changed.length} pages: HTTP ${response.status}`);
      return [];
    }
  } catch (error) {
    options.log?.(`IndexNow unreachable: ${(error as Error).message}`);
    return [];
  }
  await store.kvSet(SUBMITTED, JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.path, entry.lastmod ?? '']))));
  return changed.map((entry) => entry.path);
}

function parse(value: string | undefined): Record<string, string> {
  try { return value ? JSON.parse(value) as Record<string, string> : {}; } catch { return {}; }
}
