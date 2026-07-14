const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Buffer a provider preview response with a hard ceiling. A task-controlled
 * service must not be able to exhaust control-plane memory with one response. */
export async function boundedResponseBody(
  response: Response,
  maxBytes = positiveBytes(process.env.KARMAX_MAX_PREVIEW_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES),
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel('preview response too large').catch(() => undefined);
        throw new Error(`preview response exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function positiveBytes(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
