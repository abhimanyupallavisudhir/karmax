/**
 * The resource repositories' edge: a Cloudflare Worker that restic in a task
 * world talks to instead of tavya (wiki features/resource-storage), so a save's
 * bytes go from the sandbox into its storage without passing through tavya's
 * server. It holds no secret and decides nothing.
 *
 * An upload asks tavya first (`x-tavya-edge: intent`, with the world's grant):
 * tavya checks the grant, append-only and quota, and answers with a presigned
 * PUT for exactly that file, signed with its SHA-256 (which restic makes its
 * name), so the store refuses any other content. The Worker streams the body
 * there and tells tavya (`stored`), which records the file once the store holds
 * it. When tavya answers 409 (a store that does not verify checksums) the
 * upload goes through tavya instead. Everything else is passed to tavya
 * unchanged; reads come back as redirects to the store.
 *
 * Web-standard code only (no Node APIs): it runs in workerd, and in Node for tests.
 */

export interface EdgeEnv {
  /** tavya's public URL. */
  ORIGIN: string;
}

const ROUTE = '/resource-repositories/';
/** What `/` answers: tells a deploy this Worker is live, not Cloudflare's 404 for a route still propagating. */
export const EDGE_MARKER = 'tavya resource repositories edge';
const UPLOAD = /^\/resource-repositories\/[A-Za-z0-9_-]+@[A-Za-z0-9_-]+\/(?:data|index|snapshots)\/([0-9a-f]{64})$/;

export default {
  async fetch(request: Request, env: EdgeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response(`${EDGE_MARKER}\n`);
    if (!url.pathname.startsWith(ROUTE)) return new Response('not found', { status: 404 });
    const origin = `${env.ORIGIN.replace(/\/+$/, '')}${url.pathname}${url.search}`;
    const upload = request.method === 'POST' && !url.search ? UPLOAD.exec(url.pathname) : null;
    if (upload) return uploadFile(request, origin, upload[1]!);
    return pass(request, origin);
  },
};

/** To tavya as it came; redirects (reads from the store) go back to restic. */
function pass(request: Request, origin: string): Promise<Response> {
  return fetch(origin, { method: request.method, headers: request.headers, body: request.body, redirect: 'manual', duplex: 'half' } as RequestInit);
}

async function uploadFile(request: Request, origin: string, sha256: string): Promise<Response> {
  const length = request.headers.get('content-length');
  if (!length || !/^\d+$/.test(length)) return new Response('a content length is required', { status: 411 });
  const ask = (step: 'intent' | 'stored') => fetch(origin, { method: 'POST',
    headers: { authorization: request.headers.get('authorization') ?? '', 'x-tavya-edge': step, 'x-tavya-length': length } });
  const intent = await ask('intent');
  // A store that does not verify checksums: tavya takes the upload itself.
  if (intent.status === 409) return pass(request, origin);
  const target = intent.headers.get('x-tavya-upload-url');
  // 200: already stored (a retried upload); anything else but 202 is tavya's answer.
  if (intent.status !== 202 || !target) { await request.body?.cancel(); return intent; }
  const stored = await fetch(target, { method: 'PUT', body: fixedLength(request.body, Number(length)),
    headers: { 'content-length': length, 'x-amz-checksum-sha256': base64(sha256) }, duplex: 'half' } as RequestInit);
  const reply = await stored.text();
  if (stored.status === 400 && reply.includes('BadDigest')) return new Response('file content does not match its name', { status: 400 });
  if (!stored.ok) return new Response(`the store refused the upload (${stored.status})`, { status: 502 });
  return ask('stored');
}

/** workerd sends a stream of known length with a Content-Length, which a store's PUT requires. */
function fixedLength(body: ReadableStream | null, length: number): ReadableStream | null {
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream }).FixedLengthStream;
  if (!body || !Fixed) return body;
  const stream = new Fixed(length);
  void body.pipeTo(stream.writable).catch(() => undefined);
  return stream.readable;
}

function base64(hex: string): string {
  return btoa(String.fromCharCode(...(hex.match(/../g) ?? []).map((byte) => parseInt(byte, 16))));
}
