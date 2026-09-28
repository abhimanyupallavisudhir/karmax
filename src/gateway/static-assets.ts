import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type http from 'node:http';
import { MIME } from '../store/artifact-mime.js';

/**
 * The console has no build step, so the gateway itself is its asset server:
 * validators, compression and framing protection live here.
 */

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

type Encoding = 'br' | 'gzip';

/** Text formats worth compressing; fonts and images are compressed already. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.cjs', '.css', '.svg', '.json', '.txt', '.webmanifest', '.map', '.md']);
/** Below this, compression costs more than the bytes it saves. */
const MIN_COMPRESS_BYTES = 1024;
/** The console's own test suites live beside it (`web/*.test.cjs`) but are not part of it. */
const UNPUBLISHED = /\.test\.cjs$/;

/** The one third-party script source: the pinned MathJax release, whose every
 *  file web/markdown.js also integrity-checks. */
export const MATHJAX_SCRIPT_SOURCE = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/';

/** The console shell's policy. Script runs only from this origin and the pinned
 *  MathJax path: no inline script, no eval. Agent-authored documents (review
 *  HTML, HTML artifacts) are separate responses with their own sandbox policy,
 *  because a srcdoc or blob: document would inherit this one. */
export const CONSOLE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${MATHJAX_SCRIPT_SOURCE}`,
  // The console and MathJax style elements directly; styles cannot run script.
  "style-src 'self' 'unsafe-inline'",
  // Profile pictures come from the sign-in provider; previews are blob: URLs.
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  // A PDF artifact opens as a blob: document, which inherits this policy.
  'object-src blob:',
  // qr-scanner decodes in a worker built from a blob.
  "worker-src 'self' blob:",
  "base-uri 'none'",
  // Creating the shared GitHub App posts its manifest to GitHub.
  "form-action 'self' https://github.com",
  // The console is a surface of one-click approvals (Review, spending,
  // credential grants): another site must never frame it (clickjacking).
  "frame-ancestors 'self'",
].join('; ');

export function staticAssetHeaders(file: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    // The console has no build step or content-hashed asset names, so a cached
    // app.js can keep running old UI code after a deploy. Force revalidation of
    // the SPA shell and its assets (cheap: every response carries an ETag); the
    // service worker deliberately follows the network response instead of
    // maintaining a second application cache.
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (path.extname(file) === '.html') {
    headers['content-security-policy'] = path.basename(file) === 'paddle-checkout.html'
      ? "default-src 'none'; script-src 'self' https://cdn.paddle.com; connect-src 'self' https://*.paddle.com; frame-src https://*.paddle.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.paddle.com; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      : CONSOLE_CONTENT_SECURITY_POLICY;
    headers['x-frame-options'] = 'SAMEORIGIN';
  }
  return headers;
}

/** The best encoding the client accepts, by its `Accept-Encoding` q-values. */
export function preferredEncoding(acceptEncoding: string | undefined): Encoding | undefined {
  const quality = new Map<string, number>();
  for (const part of (acceptEncoding ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((token) => token.trim());
    if (!name) continue;
    const q = params.find((param) => param.startsWith('q='));
    quality.set(name, q ? Number(q.slice(2)) : 1);
  }
  const accepts = (name: Encoding) => (quality.get(name) ?? quality.get('*') ?? 0) > 0;
  return accepts('br') ? 'br' : accepts('gzip') ? 'gzip' : undefined;
}

interface StaticFile { mtimeMs: number; size: number; data: Buffer; revision: string }
const files = new Map<string, StaticFile>();
const encoded = new Map<string, Promise<Buffer>>();
/** A deploy restarts the process; this only bounds `npm run dev` edit churn. */
const MAX_ENCODED = 400;

function revisionOf(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function readFile(file: string): Promise<StaticFile> {
  const stat = await fs.promises.stat(file);
  const cached = files.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const data = await fs.promises.readFile(file);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, data, revision: revisionOf(data) };
  files.set(file, entry);
  return entry;
}

function encode(data: Buffer, revision: string, encoding: Encoding): Promise<Buffer> {
  const key = `${revision}:${encoding}`;
  let pending = encoded.get(key);
  if (!pending) {
    if (encoded.size >= MAX_ENCODED) encoded.clear();
    pending = encoding === 'br'
      ? brotli(data, { params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      } })
      : gzip(data, { level: 9 });
    // A failed compression is retried on the next request, not cached.
    pending.catch(() => encoded.delete(key));
    encoded.set(key, pending);
  }
  return pending;
}

/** A content revision for the no-build console, used by already-open tabs to
 * notice that a deploy replaced the JavaScript they are currently executing. */
export function staticAssetRevision(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    const cached = files.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.revision;
    const data = fs.readFileSync(file);
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, data, revision: revisionOf(data) };
    files.set(file, entry);
    return entry.revision;
  } catch {
    // Minimal/test gateways may intentionally have no console static directory.
    return undefined;
  }
}

/** Whether `file` is a real file inside `root` (anything else gets the SPA shell). */
export async function assetExists(root: string, file: string): Promise<boolean> {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return fs.promises.stat(file).then((stat) => stat.isFile(), () => false);
}

/** Files under the console directory that are not part of the console. */
export function unpublishedAsset(file: string): boolean {
  return UNPUBLISHED.test(file);
}

/**
 * Serve one console asset. `transform` rewrites the body per request (the
 * installation's name in the HTML shell); validators always describe the bytes
 * actually sent, and each encoding has its own (RFC 9110 §8.8.3).
 */
export async function serveStaticAsset(
  req: http.IncomingMessage | undefined,
  res: http.ServerResponse,
  file: string,
  transform?: (data: Buffer) => Buffer | Promise<Buffer>,
): Promise<void> {
  const source = await readFile(file);
  const data = transform ? await transform(source.data) : source.data;
  const revision = transform ? revisionOf(data) : source.revision;
  const headers = staticAssetHeaders(file);
  const compressible = COMPRESSIBLE.has(path.extname(file)) && data.length >= MIN_COMPRESS_BYTES;
  const encoding = compressible ? preferredEncoding(req?.headers['accept-encoding']) : undefined;
  if (compressible) headers.vary = 'accept-encoding';
  const etag = `"${revision.slice(0, 32)}${encoding ? `-${encoding}` : ''}"`;
  headers.etag = etag;
  const matches = String(req?.headers['if-none-match'] ?? '')
    .split(',').map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === etag || tag === '*');
  if (matches) {
    res.writeHead(304, headers);
    return void res.end();
  }
  const body = encoding ? await encode(data, revision, encoding) : data;
  if (encoding) headers['content-encoding'] = encoding;
  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(req?.method === 'HEAD' ? undefined : body);
}
