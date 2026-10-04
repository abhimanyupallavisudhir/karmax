/**
 * The resource repositories' edge: a Cloudflare Worker bound to the R2 bucket
 * of tavya's managed storage (wiki features/resource-storage). restic in a
 * task world talks to it instead of to tavya, so a save's bytes go from the
 * sandbox into R2 inside Cloudflare's network, never through tavya's server.
 *
 * It decides nothing itself. Every upload asks tavya first (grant, append-only,
 * quota) and tells it afterwards (tavya checks the stored size and records the
 * file); R2 verifies each object against its name, which restic makes the
 * SHA-256 of its content. Listings, locks and deletes go to tavya unchanged.
 * Reads of a stored object come straight from R2 once the grant is checked.
 *
 * Web-standard code only (no Node APIs): it runs in workerd, and in Node for tests.
 */

export interface EdgeBucket {
  put(key: string, value: ReadableStream | ArrayBuffer | null, options?: { sha256?: string }): Promise<unknown>;
  get(key: string, options?: { range?: Headers }): Promise<EdgeObject | null>;
}
export interface EdgeObject {
  size: number;
  range?: { offset?: number; length?: number; suffix?: number };
  body: ReadableStream;
}
export interface EdgeEnv {
  BUCKET: EdgeBucket;
  /** The repository grant key (vault `resource-repositories:token-key`), base64. */
  TOKEN_KEY: string;
  /** tavya's public URL. */
  ORIGIN: string;
}

const ROUTE = '/resource-repositories/';
const NAME = /^[0-9a-f]{64}$/;
const STORED_KINDS = new Set(['data', 'keys', 'snapshots', 'index', 'config']);
const UPLOADED_KINDS = new Set(['data', 'snapshots', 'index']);

export default {
  async fetch(request: Request, env: EdgeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(ROUTE)) return new Response('not found', { status: 404 });
    const [repository = '', kind = '', name = '', ...extra] = url.pathname.slice(ROUTE.length).split('/');
    const managed = /^[A-Za-z0-9_-]+@storage-managed-[A-Za-z0-9_-]+$/.test(repository);
    const object = managed && !extra.length && STORED_KINDS.has(kind) && (kind === 'config' ? !name : NAME.test(name));
    if (object && (request.method === 'GET' || (request.method === 'POST' && UPLOADED_KINDS.has(kind)))) {
      const grant = await verify(request, env, repository);
      if (!grant) return new Response('unauthorized', { status: 401 });
      const key = `resource-repositories/${repository.replace('@', '/')}/${kind === 'config' ? 'config' : `${kind}/${name}`}`;
      if (request.method === 'GET') return read(env, key, request);
      if (grant.access === 'read') return new Response('not allowed', { status: 403 });
      return upload(request, env, url, key, name);
    }
    // Anything else is tavya's: listings, locks, deletes, other storage locations.
    return fetch(`${env.ORIGIN.replace(/\/+$/, '')}${url.pathname}${url.search}`, { method: request.method,
      headers: request.headers, body: request.body, redirect: 'manual', duplex: 'half' } as RequestInit);
  },
};

async function upload(request: Request, env: EdgeEnv, url: URL, key: string, name: string): Promise<Response> {
  const length = request.headers.get('content-length');
  if (!length || !/^\d+$/.test(length)) return new Response('a content length is required', { status: 411 });
  const ask = (step: 'intent' | 'stored') => fetch(`${env.ORIGIN.replace(/\/+$/, '')}${url.pathname}`, { method: 'POST',
    headers: { authorization: request.headers.get('authorization') ?? '', 'x-tavya-edge': step, 'x-tavya-length': length } });
  const intent = await ask('intent');
  // 200: already stored (a retried upload); anything else but 202 is tavya's answer.
  if (intent.status !== 202) { await request.body?.cancel(); return intent; }
  try {
    await env.BUCKET.put(key, request.body, { sha256: name });
  } catch {
    return new Response('file content does not match its name', { status: 400 });
  }
  return ask('stored');
}

async function read(env: EdgeEnv, key: string, request: Request): Promise<Response> {
  const ranged = request.headers.has('range');
  const object = await env.BUCKET.get(key, ranged ? { range: request.headers } : {});
  if (!object) return new Response('not found', { status: 404 });
  if (!ranged || !object.range) return new Response(object.body, { headers: { 'content-length': String(object.size) } });
  const { offset = 0, length = object.size - offset, suffix } = object.range;
  const start = suffix !== undefined ? object.size - suffix : offset;
  const count = suffix !== undefined ? suffix : length;
  return new Response(object.body, { status: 206, headers: { 'content-length': String(count),
    'content-range': `bytes ${start}-${start + count - 1}/${object.size}` } });
}

/** The same signed grant tavya mints (world/resource-repository.ts RepositoryTokens). */
async function verify(request: Request, env: EdgeEnv, repository: string): Promise<{ access: string } | undefined> {
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!basic) return undefined;
  const token = atob(basic).split(':').slice(1).join(':');
  const [body, signature] = token.split('.');
  if (!body || !signature) return undefined;
  const key = await crypto.subtle.importKey('raw', bytes(atob(env.TOKEN_KEY)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, fromBase64url(signature), new TextEncoder().encode(`resource-repository\0${body}`));
  if (!valid) return undefined;
  let grant: { repository?: string; access?: string; expiresAt?: number };
  try { grant = JSON.parse(new TextDecoder().decode(fromBase64url(body))); } catch { return undefined; }
  if (grant.repository !== repository || !['read', 'append', 'admin'].includes(grant.access ?? '')
    || typeof grant.expiresAt !== 'number' || grant.expiresAt <= Date.now()) return undefined;
  return { access: grant.access! };
}

function bytes(binary: string): Uint8Array { return Uint8Array.from(binary, (c) => c.charCodeAt(0)); }
function fromBase64url(value: string): Uint8Array {
  return bytes(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)));
}
