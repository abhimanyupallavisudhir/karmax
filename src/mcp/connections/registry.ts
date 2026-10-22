import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { karmaxHome } from '../../config/paths.js';
import { publicFetch, publicSlowFetch } from './http.js';
import { validateTransport, type McpTransport } from './store.js';
const ORIGIN = 'https://registry.modelcontextprotocol.io';
const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const PAGE = 20;
const SNAPSHOT_VERSION = 1;
type Fetch = (url: string) => Promise<Response>;
type Entry = ReturnType<typeof registryEntry>;
/** One server as the index holds it: its entry as JSON (parsed only when
 * returned, which keeps ~46k servers in a few tens of MiB) and the lowercase
 * name, title and description it is searched by. */
interface Indexed { json: string; text: string; nameEnd: number; titleEnd: number; remote: boolean }
export interface RegistryPage { servers: Entry[]; nextCursor?: string }
/** A page of the registry's own list, before validation. */
interface RawPage { servers?: any[]; metadata?: { nextCursor?: unknown } }

const active = (item: any) => item?._meta?.[OFFICIAL]?.status === 'active';
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function indexed(entry: Entry): Indexed {
  const name = entry.name.toLowerCase(), title = entry.title === entry.name ? '' : entry.title.toLowerCase();
  return { json: JSON.stringify(entry), text: `${name}\n${title}\n${entry.description.toLowerCase()}`, nameEnd: name.length,
    titleEnd: name.length + 1 + title.length, remote: entry.options.some((o) => o.transport.type !== 'stdio') };
}
/** Whether a server is published by the vendor a word names: `com.stripe/mcp`
 * by stripe, `io.github.acme/tool` by acme. A vendor's own server is the best
 * match. A domain is proof, so a longer label of it counts too
 * (`com.googleapis.run/mcp` for "google"); a GitHub handle is not. */
function publishedBy(name: string, term: string): boolean {
  const labels = name.slice(0, name.indexOf('/')).split('.').slice(1);
  if (labels[0] === 'github') return labels.slice(1).includes(term);
  return labels.some((label) => label === term || (term.length >= 3 && label.startsWith(term)));
}
/** Higher is better; undefined when some word of the query is missing. */
function score(item: Indexed, terms: string[], query: string): number | undefined {
  if (terms.some((term) => !item.text.includes(term))) return undefined;
  const name = item.text.slice(0, item.nameEnd), heading = ` ${words(item.text.slice(0, item.titleEnd)).join(' ')} `;
  let description: string | undefined, total = 0;
  for (const term of terms) {
    const at = item.text.indexOf(term);
    if (publishedBy(name, term)) total += 6;
    if (at < item.titleEnd) total += heading.includes(` ${term} `) ? 4 : heading.includes(` ${term}`) ? 3 : 2;
    else total += (description ??= ` ${words(item.text.slice(item.titleEnd)).join(' ')} `).includes(` ${term} `) ? 1 : 0.5;
  }
  if (terms.length && words(name.slice(name.indexOf('/') + 1)).join(' ') === terms.join(' ')) total += 2;
  if (terms.length > 1 && heading.includes(` ${terms.join(' ')} `)) total += 2;
  if (name === query) total += 100;
  return total;
}

/**
 * Search over the Official MCP Registry. The registry's own `search` is a
 * substring scan of server names: it can take 8–30 s (past our request timeout)
 * and finds nothing for "google cloud", while its plain pages take ~0.2 s.
 * So, as the registry expects of the services built on it, tavya keeps an
 * index: one full read (~470 pages of 100), then `updated_since` deltas,
 * searched locally by every word of name, title and description. A gzipped
 * snapshot under $KARMAX_HOME/cache is a disposable cache that spares a
 * restart the full read. Until the first read finishes, the registry's own
 * search answers. Exact names resolve live (`registryServer`), so a server
 * deleted upstream since the last full read is never connected.
 */
export class RegistryIndex {
  private entries?: Map<string, Indexed>;
  private syncedAt = 0;
  private fullAt = 0;
  private retryAt = 0;
  private loading?: Promise<void>;
  private syncing?: Promise<void>;
  private live = 0;
  private readonly cache = new Map<string, { expires: number; value: RegistryPage }>();
  private readonly fetch: Fetch; private readonly file?: string; private readonly now: () => number;
  constructor(options: { fetch?: Fetch; file?: string; now?: () => number } = {}) {
    this.fetch = options.fetch ?? publicFetch; this.file = options.file; this.now = options.now ?? Date.now;
  }

  async search(search = '', cursor = ''): Promise<RegistryPage> {
    if (search.length > 160 || cursor.length > 1024) throw new RangeError('Registry query is too long');
    await (this.loading ??= this.load());
    if (this.now() - this.syncedAt > 10 * 60_000 && this.now() >= this.retryAt) void this.refresh().catch((e) => {
      this.retryAt = this.now() + 60_000;
      console.warn(`MCP Registry index refresh failed: ${e instanceof Error ? e.message : e}`);
    });
    if (!this.entries || (cursor && !/^\d+$/.test(cursor))) return this.liveSearch(search, cursor);
    const terms = words(search), query = search.trim().toLowerCase();
    const found: { name: string; item: Indexed; score: number }[] = [];
    for (const [name, item] of this.entries) {
      const value = score(item, terms, query);
      if (value !== undefined) found.push({ name, item, score: value });
    }
    found.sort((a, b) => b.score - a.score || Number(b.item.remote) - Number(a.item.remote) || a.name.localeCompare(b.name));
    const offset = Number(cursor || 0);
    return { servers: found.slice(offset, offset + PAGE).map(({ item }) => JSON.parse(item.json) as Entry),
      ...(offset + PAGE < found.length ? { nextCursor: String(offset + PAGE) } : {}) };
  }

  /** Brings the index up to date now: a full read when it has none or the last
   * is a day old (that is also how deletions leave it), else the changes since
   * the last read, with ten minutes of overlap for clock skew. */
  refresh(): Promise<void> {
    return this.syncing ??= (async () => {
      const started = this.now(), full = !this.entries || started - this.fullAt > 24 * 60 * 60_000;
      const next = new Map(full ? [] : this.entries);
      const since = full ? undefined : new Date(this.syncedAt - 10 * 60_000).toISOString();
      for (let page = 0, cursor = ''; page < 2_000; page++) {
        const url = new URL('/v0.1/servers', ORIGIN);
        url.searchParams.set('limit', '100'); url.searchParams.set('version', 'latest');
        if (since) url.searchParams.set('updated_since', since);
        if (cursor) url.searchParams.set('cursor', cursor);
        const raw = await this.page(url.href);
        for (const item of raw.servers) {
          const entry = registryEntry(item?.server);
          if (!entry.name || !entry.version) continue;
          if (active(item)) next.set(entry.name, indexed(entry)); else next.delete(entry.name);
        }
        cursor = raw.nextCursor;
        if (!cursor) break;
      }
      this.entries = next; this.syncedAt = started; if (full) this.fullAt = started;
      await this.save().catch((e) => console.warn(`MCP Registry snapshot not saved: ${e instanceof Error ? e.message : e}`));
    })().finally(() => { this.syncing = undefined; });
  }

  /** Waits for a snapshot load and any read in progress (tests, shutdown). */
  async idle(): Promise<void> { await this.loading; await this.syncing?.catch(() => {}); }

  private async page(href: string): Promise<{ servers: any[]; nextCursor: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetch(href);
        if (!response.ok) throw new Error(`Official MCP Registry answered ${response.status}`);
        const raw = await response.json() as RawPage;
        if (!Array.isArray(raw?.servers)) throw new Error('Unexpected registry response');
        return { servers: raw.servers, nextCursor: typeof raw.metadata?.nextCursor === 'string' ? raw.metadata.nextCursor : '' };
      } catch (e) {
        if (attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
      }
    }
  }

  private async liveSearch(search: string, cursor: string): Promise<RegistryPage> {
    const url = new URL('/v0.1/servers', ORIGIN);
    url.searchParams.set('limit', String(PAGE)); url.searchParams.set('version', 'latest');
    if (search) url.searchParams.set('search', search);
    if (cursor) url.searchParams.set('cursor', cursor);
    const key = url.href;
    const prior = this.cache.get(key); if (prior && prior.expires > this.now()) return prior.value;
    if (this.live >= 8) throw new Error('Registry search is busy. Retry shortly.');
    this.live++;
    try {
      const response = await this.fetch(key);
      if (!response.ok) throw new Error('Official MCP Registry is unavailable. Try again or add a custom server.');
      const raw = await response.json() as RawPage;
      if (!Array.isArray(raw.servers)) throw new Error('Unexpected registry response');
      const value = { servers: raw.servers.slice(0, PAGE).filter(active).map((item: any) => registryEntry(item.server)).filter((entry: Entry) => entry.name && entry.version),
        nextCursor: typeof raw.metadata?.nextCursor === 'string' ? raw.metadata.nextCursor.slice(0, 1024) : undefined };
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { value, expires: this.now() + 300_000 });
      return value;
    } finally { this.live--; }
  }

  private async load(): Promise<void> {
    if (!this.file) return;
    try {
      const snapshot = JSON.parse((await promisify(zlib.gunzip)(await fs.readFile(this.file))).toString('utf8'));
      if (snapshot?.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.entries)) return;
      this.entries = new Map(snapshot.entries.map((entry: Entry) => [entry.name, indexed(entry)]));
      this.syncedAt = Number(snapshot.syncedAt) || 0; this.fullAt = Number(snapshot.fullAt) || 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`MCP Registry snapshot ignored: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async save(): Promise<void> {
    if (!this.file || !this.entries) return;
    // The entries are kept as JSON already: join them rather than re-encode.
    const head = JSON.stringify({ version: SNAPSHOT_VERSION, syncedAt: this.syncedAt, fullAt: this.fullAt }).slice(0, -1);
    const data = await promisify(zlib.gzip)(`${head},"entries":[${[...this.entries.values()].map((item) => item.json).join(',')}]}`);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, data); await fs.rename(temporary, this.file);
  }
}

let shared: RegistryIndex | undefined;
/** Registry discovery for the gateway: one index per process. */
export function registrySearch(search = '', cursor = ''): Promise<RegistryPage> {
  shared ??= new RegistryIndex({ fetch: publicSlowFetch, file: path.join(karmaxHome(), 'cache', 'mcp-registry.json.gz') });
  return shared.search(search, cursor);
}
/** Registry descriptions are display-only, never prompts. Return declarative
 * candidates; importing always passes through the same custom-server validator. */
export function registryEntry(server: any) {
  server = server && typeof server === 'object' && !Array.isArray(server) ? server : {};
  const records = (value: unknown, limit: number): any[] => Array.isArray(value) ? value.slice(0, limit).filter((v) => v && typeof v === 'object' && !Array.isArray(v)) : [];
  const options: { label: string; transport: McpTransport; fields: any[] }[] = [];
  for (const remote of records(server.remotes, 10)) {
    if (!['streamable-http', 'sse'].includes(remote.type) || typeof remote.url !== 'string' || /[{}]/.test(remote.url)) continue;
    try { options.push({ label: remote.url, transport: validateTransport({ type: remote.type === 'sse' ? 'sse' : 'http', url: remote.url }), fields: records(remote.headers, 40) }); } catch {}
  }
  for (const pkg of records(server.packages, 10)) {
    // Registry metadata must never choose a package manager's alternate registry
    // or smuggle switches into the package identifier/version.
    if (pkg.transport?.type !== 'stdio' || typeof pkg.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(pkg.version) || pkg.version === 'latest') continue;
    let command: string, args: string[];
    if (pkg.registryType === 'npm' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+_-]+)?$/.test(pkg.version) && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.identifier)
      && (!pkg.registryBaseUrl || /^https:\/\/registry.npmjs.org\/?$/.test(pkg.registryBaseUrl))) {
      command = 'npx'; args = ['--yes', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', `${pkg.identifier}@${pkg.version}`];
    } else if (pkg.registryType === 'pypi' && /^\d/.test(pkg.version) && (!pkg.runtimeHint || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg.runtimeHint)) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg.identifier)
      && (!pkg.registryBaseUrl || /^https:\/\/pypi.org\/?$/.test(pkg.registryBaseUrl))) {
      command = 'uvx'; args = ['--index-url', 'https://pypi.org/simple', '--from', `${pkg.identifier}==${pkg.version}`, pkg.runtimeHint || pkg.identifier];
    } else continue;
    // Runtime arguments customize the package manager itself: do not import
    // these implicitly. A user can explicitly configure a custom command.
    if (pkg.runtimeArguments?.length) continue;
    const fields = [...records(pkg.environmentVariables, 40).map((f: any) => ({ ...f, target: 'env' })),
      ...records(pkg.packageArguments, 80).map((f: any) => ({ ...f, target: 'argument' }))];
    options.push({ label: `${pkg.identifier} ${pkg.version}`, transport: { type: 'stdio', command, args }, fields });
  }
  return { name: String(server.name ?? '').slice(0, 256), version: String(server.version ?? '').slice(0, 128),
    title: String(server.title ?? server.name ?? '').slice(0, 256), description: String(server.description ?? '').slice(0, 1000), options };
}
/** The exact registry server named by an agent request, or undefined: one
 * live lookup, so it is never stale. Only active servers count. */
export async function registryServer(name: string, fetch: Fetch = publicFetch): Promise<Entry | undefined> {
  if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(name) || name.length > 160) throw new Error('Use an MCP Registry name such as com.example/server');
  const response = await fetch(new URL(`/v0.1/servers/${encodeURIComponent(name)}/versions/latest`, ORIGIN).href);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error('Official MCP Registry is unavailable. Try again shortly.');
  const raw = await response.json() as any;
  const entry = registryEntry(raw?.server);
  return active(raw) && entry.name === name && entry.version ? entry : undefined;
}
