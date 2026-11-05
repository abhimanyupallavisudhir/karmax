/**
 * The Review artifact edge: a Cloudflare Worker that serves saved Review files
 * (videos above all) straight from the R2 bucket they are saved in, from the
 * Cloudflare location nearest the viewer, instead of relaying every byte
 * through tavya's one server (wiki features/review-artifacts). It holds the
 * bucket binding and the key tavya signs its URLs with, and decides nothing:
 * the URL names the object, its size and SHA-256, the headers to serve it
 * with and its expiry (src/edge/artifact-edge-token.ts).
 *
 * Like the gateway (src/gateway/artifact-response.ts): one `Range` → 206, an
 * unsatisfiable one → 416, several or a malformed one → the whole file; HEAD;
 * the stored size must equal the saved size before a byte is sent (else 502);
 * a whole-file response is hashed as it streams and its last chunk held back
 * until the hash matches, else the stream fails. Its origin is not tavya's, so
 * nothing it serves can reach tavya's cookies or pages; the content-security
 * policy sandboxes it as well.
 *
 * Web-standard code only (no Node APIs): it runs in workerd, and in Node for tests.
 */

import { verifyArtifactEdgeToken, type ArtifactEdgeClaims } from './artifact-edge-token.js';
import { requestedRange, type ByteRange } from './byte-range.js';

/** The parts of an R2 binding the Worker uses. */
export interface ArtifactBucket {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
}

export interface ArtifactEdgeEnv {
  BUCKET: ArtifactBucket;
  /** The signing key, shared with tavya (artifactEdgeKey). */
  URL_KEY: string;
  /** tavya's public URL: the console may read text artifacts from here. */
  ORIGIN: string;
}

/** What `/` answers: tells a deploy this Worker is live, not Cloudflare's 404 for a route still propagating. */
export const ARTIFACT_EDGE_MARKER = 'tavya review artifact edge';

export default {
  async fetch(request: Request, env: ArtifactEdgeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response(`${ARTIFACT_EDGE_MARKER}\n`);
    const cors = { 'access-control-allow-origin': env.ORIGIN.replace(/\/+$/, '') };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors,
      'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'range', 'access-control-max-age': '86400' } });
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed', { ...cors, allow: 'GET, HEAD' });
    const token = /^\/([^/]+)(?:\/[^/]*)?$/.exec(url.pathname)?.[1];
    const claims = token ? await verifyArtifactEdgeToken(token, env.URL_KEY).catch(() => undefined) : undefined;
    if (!claims) return text(403, 'this link has expired; open the artifact again', cors);
    // A bucket that refuses (a range past an object of another size, an outage) is said, not thrown.
    return serve(request, env.BUCKET, claims, url.searchParams.has('download'), cors)
      .catch(() => text(502, 'artifact storage is unavailable', cors));
  },
};

async function serve(request: Request, bucket: ArtifactBucket, claims: ArtifactEdgeClaims, download: boolean,
  cors: Record<string, string>): Promise<Response> {
  const size = claims.bytes;
  const etag = `"${claims.sha256}"`;
  const ifRange = request.headers.get('if-range');
  const range = ifRange !== null && ifRange !== etag ? undefined : requestedRange(request.headers.get('range'), size);
  const headers: Record<string, string> = { ...cors,
    'content-type': claims.type,
    'content-disposition': `${download ? 'attachment' : claims.disposition}; filename="${claims.name.replace(/["\\\r\n]/g, '_')}"`,
    'content-security-policy': claims.csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // The bytes behind a URL never change: the browser keeps them while it lasts.
    'cache-control': `private, max-age=${Math.max(0, Math.floor((claims.expiresAt - Date.now()) / 1000))}, immutable`,
    'accept-ranges': 'bytes', etag,
    'access-control-expose-headers': 'content-length, content-range, content-disposition' };
  if (range === null) return text(416, 'range not satisfiable', { ...headers, 'content-range': `bytes */${size}` });
  if (request.method === 'HEAD') {
    const object = await bucket.head(claims.key);
    if (!object) return text(404, 'artifact not found', cors);
    if (object.size !== size) return text(502, 'artifact integrity check failed', cors);
    return new Response(null, { status: range ? 206 : 200, headers: { ...headers, ...lengthHeaders(range, size) } });
  }
  const object = await bucket.get(claims.key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : {});
  if (!object) return text(404, 'artifact not found', cors);
  if (object.size !== size) {
    await object.body.cancel().catch(() => undefined);
    return text(502, 'artifact integrity check failed', cors);
  }
  return new Response(range ? object.body : verified(object.body, claims.sha256),
    { status: range ? 206 : 200, headers: { ...headers, ...lengthHeaders(range, size) } });
}

function lengthHeaders(range: ByteRange | undefined, size: number): Record<string, string> {
  return range ? { 'content-length': String(range.end - range.start + 1), 'content-range': `bytes ${range.start}-${range.end}/${size}` }
    : { 'content-length': String(size) };
}

/** The bytes as they come, the last chunk held back until their SHA-256 is
 * `sha256`: wrong bytes fail the download instead of completing it. Workers
 * hash a stream with `crypto.DigestStream`; a runtime without it is not
 * checked (the size still is). */
function verified(body: ReadableStream<Uint8Array>, sha256: string): ReadableStream<Uint8Array> {
  const Digest = (crypto as unknown as { DigestStream?: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }).DigestStream;
  if (!Digest) return body;
  const digest = new Digest('SHA-256');
  const writer = digest.getWriter();
  let held: Uint8Array | undefined;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await writer.write(chunk.slice());
      if (held) controller.enqueue(held);
      held = chunk;
    },
    async flush(controller) {
      await writer.close();
      const hex = [...new Uint8Array(await digest.digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (hex !== sha256) throw new Error('artifact integrity check failed');
      if (held) controller.enqueue(held);
    },
  }));
}

function text(status: number, message: string, headers: Record<string, string>): Response {
  return new Response(`${message}\n`, { status, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
}
