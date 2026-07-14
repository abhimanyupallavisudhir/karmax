import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config/paths.js';
import { ImageRef } from '../domain/types.js';

/**
 * Content-addressed store for user-attached images (image prompts;
 * PLAN_IMAGE_PROMPTS.md). Bytes live on disk under `$KARMAX_HOME/attachments/`,
 * keyed by sha256 — the ONLY place in karmax that touches raw image bytes.
 * Everything downstream (domain types, Temporal signals/history) carries only
 * the lightweight {@link ImageRef} handle; the adapter re-hydrates bytes here.
 *
 * Storing out-of-band (not in Temporal input/signals) is deliberate: the initial
 * prompt is workflow input and follow-ups are signals, both of which persist in
 * workflow history and are replayed forever. Inline base64 would blow past
 * Temporal's payload limits and bloat replay. Content-addressing also dedupes
 * repeated pastes for free.
 */

/** Media types every target provider (Claude + OpenAI/Codex) accepts. */
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Per-image byte cap. Providers reject very large images; keep memory bounded. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB
/** Max images per message — providers reject long image lists. */
export const MAX_IMAGES_PER_MESSAGE = 8;

/** Sniff the media type from magic bytes; returns undefined if not a known image. */
export function sniffImageType(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  const head6 = buf.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  return undefined;
}

export interface AttachmentStoreOpts {
  home?: string;
  maxBytes?: number;
}

export class AttachmentStore {
  private dir: string;
  private maxBytes: number;

  constructor(opts: AttachmentStoreOpts = {}) {
    this.dir = paths(opts.home).attachments;
    this.maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Validate + persist raw image bytes, returning a reference. `declaredType` is
   * a hint (e.g. the browser's clipboard MIME); the actual type is confirmed by
   * magic-number sniffing and must be in the allowlist. Throws on any violation.
   */
  put(buf: Buffer, declaredType?: string): ImageRef {
    if (!buf.length) throw new AttachmentError('empty image');
    if (buf.length > this.maxBytes)
      throw new AttachmentError(`image too large (${buf.length} > ${this.maxBytes} bytes)`);
    const sniffed = sniffImageType(buf);
    if (!sniffed) throw new AttachmentError('unrecognized image format');
    // Trust the sniffed type over the declared one, but both must be allowed.
    if (declaredType && !ALLOWED_IMAGE_TYPES[declaredType])
      throw new AttachmentError(`unsupported media type: ${declaredType}`);
    if (!ALLOWED_IMAGE_TYPES[sniffed]) throw new AttachmentError(`unsupported media type: ${sniffed}`);

    const id = crypto.createHash('sha256').update(buf).digest('hex');
    const file = this.pathFor(id, sniffed);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf); // content-addressed ⇒ idempotent
    return { id, mediaType: sniffed, bytes: buf.length };
  }

  /** Accept a `data:` URL (what the browser produces from a pasted image). */
  putDataUrl(dataUrl: string): ImageRef {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
    if (!m) throw new AttachmentError('malformed data URL');
    const declaredType = m[1] || undefined;
    const isB64 = !!m[2];
    const buf = isB64 ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
    return this.put(buf, declaredType);
  }

  /** Resolve an id to its on-disk path, or undefined if absent. */
  resolve(id: string): { path: string; mediaType: string } | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) return undefined; // guard against path traversal
    for (const [mediaType, ext] of Object.entries(ALLOWED_IMAGE_TYPES)) {
      const p = this.pathFor(id, mediaType, ext);
      if (fs.existsSync(p)) return { path: p, mediaType };
    }
    return undefined;
  }

  /** Read raw bytes for an id (for serving thumbnails / base64 encoding). */
  read(id: string): { buf: Buffer; mediaType: string } | undefined {
    const r = this.resolve(id);
    if (!r) return undefined;
    return { buf: fs.readFileSync(r.path), mediaType: r.mediaType };
  }

  /** Base64-encode an id's bytes (Claude / OpenAI content blocks). */
  readBase64(id: string): { base64: string; mediaType: string } | undefined {
    const r = this.read(id);
    if (!r) return undefined;
    return { base64: r.buf.toString('base64'), mediaType: r.mediaType };
  }

  /** Remove a content-addressed attachment once no project scope references it. */
  delete(id: string): boolean {
    const resolved = this.resolve(id);
    if (!resolved) return false;
    fs.rmSync(resolved.path, { force: true });
    return true;
  }

  private pathFor(id: string, mediaType: string, ext = ALLOWED_IMAGE_TYPES[mediaType]!): string {
    return path.join(this.dir, `${id}.${ext}`);
  }
}

export class AttachmentError extends Error {}
