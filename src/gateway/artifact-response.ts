import crypto from 'node:crypto';
import type http from 'node:http';
import type { ByteRange } from '../store/objects.js';

/** Bytes to serve: their size, a reader for the whole or a range, and the
 * SHA-256 recorded when they were saved, if they were. */
export interface ArtifactSource {
  bytes: number;
  read(range?: ByteRange): AsyncIterable<Buffer> | Promise<AsyncIterable<Buffer>>;
  sha256?: string;
}

/** The single range a `Range` header asks for: `undefined` serves the whole
 * representation (no header, another unit, several ranges or a malformed one,
 * all of which RFC 9110 lets a server ignore), `null` is unsatisfiable. */
export function requestedRange(header: string | undefined, size: number): ByteRange | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 && size > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (match[2] && Number(match[2]) < start) return undefined;
  return start < size ? { start, end } : null;
}

/**
 * Stream `source` as the response, honouring `Range` and `HEAD`, without ever
 * holding more than a chunk in memory. When the response carries the whole
 * object and its saved SHA-256 is known, the bytes are hashed as they pass and
 * the last chunk is held back until the hash matches: a corrupt object fails
 * the download rather than completing with wrong bytes. A partial response is
 * checked only against the saved size (by the caller, before any byte is sent).
 */
export async function sendArtifact(req: http.IncomingMessage, res: http.ServerResponse, source: ArtifactSource,
  headers: Record<string, string>): Promise<void> {
  const size = source.bytes;
  const ifRange = req.headers['if-range'];
  const etag = source.sha256 ? `"${source.sha256}"` : undefined;
  // A range is only meaningful against the representation the client already has.
  const range = ifRange !== undefined && ifRange !== etag ? undefined : requestedRange(req.headers.range, size);
  const common = { ...headers, 'accept-ranges': 'bytes', ...(etag ? { etag } : {}) };
  if (range === null) {
    res.writeHead(416, { ...common, 'content-range': `bytes */${size}`, 'content-length': '0' });
    return void res.end();
  }
  const length = range ? range.end - range.start + 1 : size;
  // Opened before the status is sent, so a source that cannot be read (or is
  // not what was saved) is still an error response, not a cut connection.
  const body = req.method === 'HEAD' || length === 0 ? undefined : await source.read(range);
  res.writeHead(range ? 206 : 200, { ...common, 'content-length': String(length),
    ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${size}` } : {}) });
  if (!body) return void res.end();
  const whole = !range || (range.start === 0 && range.end === size - 1);
  const hash = whole && source.sha256 ? crypto.createHash('sha256') : undefined;
  let sent = 0;
  let held: Buffer | undefined;
  const write = async (chunk: Buffer) => {
    if (!res.write(chunk)) await new Promise<void>((resolve) => {
      const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
      res.on('drain', done); res.on('close', done);
    });
  };
  try {
    for await (const chunk of body) {
      // A viewer that seeks or closes drops its request: stop reading the source.
      if (res.destroyed) return;
      sent += chunk.length;
      if (sent > length) throw new Error('artifact is longer than its recorded size');
      if (!hash) { await write(chunk); continue; }
      hash.update(chunk);
      if (held) await write(held);
      held = chunk;
    }
    if (res.destroyed) return;
    if (sent !== length) throw new Error('artifact is shorter than its recorded size');
    if (hash && hash.digest('hex') !== source.sha256) throw new Error('artifact integrity check failed');
    if (held) await write(held);
    res.end();
  } catch (error) {
    // The status is sent: cutting the connection is the only way left to say so.
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

/** A whole buffer as a source, for a store or world that cannot stream. */
export function bufferSource(data: Buffer, sha256?: string): ArtifactSource {
  return { bytes: data.length, sha256, read: async function* (range) {
    yield range ? data.subarray(range.start, range.end + 1) : data;
  } };
}
