const OUTPUT_BYTES = 64 * 1024;
const FILE_BYTES = 64 * 1024;
const FILE_COUNT = 1000;

/** Keep diagnostics at the end without putting command-sized blobs in history. */
export function scriptOutput(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= OUTPUT_BYTES) return text;
  const marker = '[output truncated; showing the final diagnostics]\n';
  const tail = bytes.subarray(bytes.length - (OUTPUT_BYTES - Buffer.byteLength(marker)));
  // Start on a UTF-8 boundary, so decoding cannot enlarge the byte budget.
  let start = 0;
  while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
  return marker + tail.subarray(start).toString('utf8');
}

export function reviewFiles(files: string[]): { changedFiles: string[]; truncated: boolean } {
  const changedFiles: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (changedFiles.length >= FILE_COUNT || bytes + size > FILE_BYTES) break;
    changedFiles.push(file);
    bytes += size;
  }
  return { changedFiles, truncated: changedFiles.length !== files.length };
}
