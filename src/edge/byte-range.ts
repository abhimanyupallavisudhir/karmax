/** A run of bytes, both ends inclusive. */
export interface ByteRange { start: number; end: number }

/** The single range a `Range` header asks for: `undefined` serves the whole
 * representation (no header, another unit, several ranges or a malformed one,
 * all of which RFC 9110 lets a server ignore), `null` is unsatisfiable.
 * Web-standard: the gateway and the artifact edge Worker both use it. */
export function requestedRange(header: string | null | undefined, size: number): ByteRange | null | undefined {
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
