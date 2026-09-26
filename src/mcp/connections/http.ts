import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/** Deliberately accept only globally routable IPv4 and IPv6 unicast. DNS is
 * resolved once, checked in full, and pinned to the actual socket lookup. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  // Excludes mapped IPv4, NAT64, local, multicast, documentation, 6to4 and Teredo.
  if (isIP(address) === 6) {
    const canonical = new URL(`https://[${address}]`).hostname.slice(1, -1);
    return /^[23][0-9a-f]{3}:/i.test(canonical) && !/^2002:/i.test(canonical)
      && !/^2001:(?:[0-9a-f]{1,2}|1[0-9a-f]{2}|db8):/i.test(canonical) && !/^3fff:/i.test(canonical);
  }
  return false;
}
export function publicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || (url.port && url.port !== '443')) throw new Error('Use a public HTTPS URL on port 443, without credentials or a fragment');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !publicAddress(host)))
    throw new Error('Private and local MCP endpoints are not allowed');
  return url;
}

async function publicLookup(host: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([dns.lookup(host, { all: true }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Endpoint DNS lookup timed out')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Shared-host requests are bounded, never follow redirects, and never inherit
 * cookies, proxy settings or platform authorization. Also used for OAuth URLs. */
function guardedFetch(stream: boolean, timeoutMs = stream ? 65_000 : 15_000): typeof fetch { return async (input, init) => {
  const request = new Request(input, init);
  const url = publicUrl(request.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await publicLookup(host);
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new Error('Endpoint resolves to a private or reserved network');
  const selected = addresses[0]!;
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (body && body.length > 256 * 1024) throw new Error('Request is too large');
  return await new Promise<Response>((resolve, reject) => {
    const req = https.request(url, {
      method: request.method, headers: Object.fromEntries(request.headers),
      lookup: ((_host: string, options: any, cb: any) => options.all
        ? cb(null, [selected]) : cb(null, selected.address, selected.family)) as any,
      signal: request.signal,
    }, (res) => {
      const status = res.statusCode ?? 502;
      if (status >= 300 && status < 400) { res.destroy(); reject(new Error('Endpoint redirects are not allowed; use its final HTTPS URL')); return; }
      const headers = Object.fromEntries(Object.entries(res.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v!]));
      if (stream) {
        let bytes = 0;
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) res.destroy(new Error('MCP response exceeds 2 MiB')); });
        resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(res) as ReadableStream, { status, headers }));
        return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) req.destroy(new Error('Endpoint response is too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) return reject(new Error('Endpoint redirects are not allowed; use its final HTTPS URL'));
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
          status, headers: Object.fromEntries(Object.entries(res.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v!])),
        }));
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Endpoint request timed out')), timeoutMs);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject);
    req.end(body);
  });
}; }
export const publicFetch = guardedFetch(false);
export const publicStreamFetch = guardedFetch(true);
/** The same guard for a single model completion, which can take a minute. */
export const publicModelFetch = guardedFetch(false, 90_000);
