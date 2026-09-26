/** Gateway access for the per-turn platform tools. */
export async function turnPlatformRequest(options: {
  token: string; method: string; path: string; body?: unknown; signal?: AbortSignal;
}): Promise<unknown> {
  if (!options.path.startsWith('/api/')) throw new Error('platform path must start with /api/');
  const base = process.env.KARMAX_GATEWAY_URL ?? 'http://127.0.0.1:4505';
  const response = await fetch(`${base}${options.path}`, {
    method: options.method,
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]),
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error('platform response exceeds 2 MiB; narrow or paginate the request');
        chunks.push(chunk.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : text;
  if (!response.ok) throw new Error((value as any)?.error ?? `HTTP ${response.status}`);
  return value;
}
