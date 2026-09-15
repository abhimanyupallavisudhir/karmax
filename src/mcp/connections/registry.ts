import { publicFetch } from './http.js';
import { validateTransport, type McpTransport } from './store.js';
const ORIGIN = 'https://registry.modelcontextprotocol.io';
let active = 0;
const cache = new Map<string, { expires: number; value: unknown }>();
export async function registrySearch(search = '', cursor = ''): Promise<any> {
  if (search.length > 160 || cursor.length > 1024) throw new Error('Registry query is too long');
  const url = new URL('/v0.1/servers', ORIGIN);
  url.searchParams.set('limit', '20'); url.searchParams.set('version', 'latest');
  if (search) url.searchParams.set('search', search);
  if (cursor) url.searchParams.set('cursor', cursor);
  const key = url.href;
  const prior = cache.get(key); if (prior && prior.expires > Date.now()) return prior.value;
  if (active >= 8) throw new Error('Registry search is busy. Retry shortly.');
  active++;
  try {
  const response = await publicFetch(key);
  if (!response.ok) throw new Error('Official MCP Registry is unavailable. Try again or add a custom server.');
  const raw = await response.json() as any;
  if (!Array.isArray(raw.servers)) throw new Error('Unexpected registry response');
  const value = { servers: raw.servers.slice(0, 20).filter((entry: any) => entry._meta?.['io.modelcontextprotocol.registry/official']?.status === 'active')
    .map((entry: any) => registryEntry(entry.server)), nextCursor: typeof raw.metadata?.nextCursor === 'string' ? raw.metadata.nextCursor.slice(0, 1024) : undefined };
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { value, expires: Date.now() + 300_000 });
  return value;
  } finally { active--; }
}
/** Registry descriptions are display-only, never prompts. Return declarative
 * candidates; importing always passes through the same custom-server validator. */
export function registryEntry(server: any) {
  const options: { label: string; transport: McpTransport; fields: any[] }[] = [];
  for (const remote of (server.remotes ?? []).slice(0, 10)) {
    if (!['streamable-http', 'sse'].includes(remote.type) || typeof remote.url !== 'string' || /[{}]/.test(remote.url)) continue;
    try { options.push({ label: remote.url, transport: validateTransport({ type: remote.type === 'sse' ? 'sse' : 'http', url: remote.url }), fields: remote.headers ?? [] }); } catch {}
  }
  for (const pkg of (server.packages ?? []).slice(0, 10)) {
    // Registry metadata must never choose a package manager's alternate registry
    // or smuggle switches into the package identifier/version.
    if (pkg.transport?.type !== 'stdio' || typeof pkg.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(pkg.version) || pkg.version === 'latest') continue;
    let command: string, args: string[];
    if (pkg.registryType === 'npm' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+_-]+)?$/.test(pkg.version) && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.identifier)
      && (!pkg.registryBaseUrl || /^https:\/\/registry.npmjs.org\/?$/.test(pkg.registryBaseUrl))) {
      command = 'npx'; args = ['--yes', '--registry=https://registry.npmjs.org', `${pkg.identifier}@${pkg.version}`];
    } else if (pkg.registryType === 'pypi' && /^\d/.test(pkg.version) && (!pkg.runtimeHint || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg.runtimeHint)) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg.identifier)
      && (!pkg.registryBaseUrl || /^https:\/\/pypi.org\/?$/.test(pkg.registryBaseUrl))) {
      command = 'uvx'; args = ['--index-url', 'https://pypi.org/simple', '--from', `${pkg.identifier}==${pkg.version}`, pkg.runtimeHint || pkg.identifier];
    } else continue;
    // Runtime arguments customize the package manager itself: do not import
    // these implicitly. A user can explicitly configure a custom command.
    if (pkg.runtimeArguments?.length) continue;
    const fields = [...(pkg.environmentVariables ?? []).map((f: any) => ({ ...f, target: 'env' })),
      ...(pkg.packageArguments ?? []).map((f: any) => ({ ...f, target: 'argument' }))];
    options.push({ label: `${pkg.identifier} ${pkg.version}`, transport: { type: 'stdio', command, args }, fields });
  }
  return { name: String(server.name ?? '').slice(0, 256), version: String(server.version ?? '').slice(0, 128),
    title: String(server.title ?? server.name ?? '').slice(0, 256), description: String(server.description ?? '').slice(0, 1000), options };
}
