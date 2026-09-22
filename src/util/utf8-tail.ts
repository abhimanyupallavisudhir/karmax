/** Keep a bounded tail without splitting a UTF-8 character. Bounding the input
 * by UTF-16 code units first also bounds temporary encoding allocations. */
export function utf8Tail(text: string, maxBytes: number): string {
  let start = Math.max(0, text.length - maxBytes);
  if (start && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
  const bytes = Buffer.from(text.slice(start), 'utf8');
  let offset = Math.max(0, bytes.length - maxBytes);
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
  return bytes.subarray(offset).toString('utf8');
}
