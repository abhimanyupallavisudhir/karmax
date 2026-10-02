import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3ObjectStore, managedS3Options } from '../src/store/objects.js';

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

interface Recorded { method: string; url: URL; headers: Record<string, string>; body: Buffer }

/**
 * What an S3 server does with a request: rebuild the SigV4 canonical request
 * from the bytes on the wire and check the signature. Written from the
 * specification, separately from the client, so a client that signs one string
 * and sends another (path or query encoding, query order) fails here.
 */
function verifySignature(request: Recorded, secret = SECRET): { region: string; signedHeaders: string[] } {
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/
    .exec(request.headers.authorization ?? '');
  if (!match) throw new Error(`malformed authorization: ${request.headers.authorization}`);
  const [, , date, region, signed, signature] = match;
  const signedHeaders = signed!.split(';');
  expect(signedHeaders).toEqual([...signedHeaders].sort());
  expect(signedHeaders).toContain('host');
  expect(signedHeaders).toContain('x-amz-date');
  expect(signedHeaders).toContain('x-amz-content-sha256');
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = request.url.search.slice(1).split('&').filter(Boolean).map((pair) => {
    const [name, value = ''] = pair.split('=');
    return [encode(decodeURIComponent(name!)), encode(decodeURIComponent(value))] as const;
  }).sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0).map(([n, v]) => `${n}=${v}`).join('&');
  const headers: Record<string, string> = { ...request.headers, host: request.url.host };
  const canonical = [request.method, request.url.pathname, query,
    signedHeaders.map((name) => `${name}:${String(headers[name]).trim()}\n`).join(''), signed, headers['x-amz-content-sha256']].join('\n');
  expect(headers['x-amz-content-sha256']).toBe(crypto.createHash('sha256').update(request.body).digest('hex'));
  const hmac = (key: crypto.BinaryLike, value: string) => crypto.createHmac('sha256', key).update(value).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date!), region!), 's3'), 'aws4_request');
  const stringToSign = ['AWS4-HMAC-SHA256', headers['x-amz-date'], `${date}/${region}/s3/aws4_request`,
    crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  expect(hmac(key, stringToSign).toString('hex')).toBe(signature);
  return { region: region!, signedHeaders };
}

function stubS3(respond: (request: Recorded) => Response | Promise<Response>) {
  const requests: Recorded[] = [];
  const fetcher = (async (input: URL | string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers as Record<string, string>)) headers[name.toLowerCase()] = value;
    const request = { method: init.method ?? 'GET', url: new URL(String(input)), headers,
      body: init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0) };
    requests.push(request);
    return respond(request);
  }) as typeof globalThis.fetch;
  return { requests, fetch: fetcher };
}

const r2 = (fetch: typeof globalThis.fetch) => new S3ObjectStore({
  endpoint: 'https://0123456789abcdef.eu.r2.cloudflarestorage.com', bucket: 'tavya-objects', region: 'auto',
  accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET, fetch,
});

describe('S3 client for Cloudflare R2', () => {
  it('signs with region auto and addresses the bucket path-style on the EU endpoint', async () => {
    const s3 = stubS3(() => new Response('data'));
    const store = r2(s3.fetch);
    await store.get("checkpoints/org/proj/world/it's (a) test!.bin");
    const [request] = s3.requests;
    expect(request!.url.host).toBe('0123456789abcdef.eu.r2.cloudflarestorage.com');
    expect(request!.url.pathname).toBe('/tavya-objects/checkpoints/org/proj/world/it%27s%20%28a%29%20test%21.bin');
    expect(verifySignature(request!).region).toBe('auto');
  });

  // R2 rejects a corrupted upload only when it is told what to expect.
  it('sends Content-MD5 with every PUT, inside the signature', async () => {
    const s3 = stubS3(() => new Response(null, { headers: { etag: '"x"' } }));
    const data = Buffer.from('chunk bytes');
    await r2(s3.fetch).put('resources/org/chunks/a.bin', data);
    const [request] = s3.requests;
    expect(request!.method).toBe('PUT');
    expect(request!.body.equals(data)).toBe(true);
    expect(request!.headers['content-md5']).toBe(crypto.createHash('md5').update(data).digest('base64'));
    expect(verifySignature(request!).signedHeaders).toContain('content-md5');
  });

  it('heads an object for its size and ETag, and reports a missing one as undefined', async () => {
    const s3 = stubS3((request) => request.url.pathname.endsWith('/missing')
      ? new Response(null, { status: 404 })
      : new Response(null, { headers: { 'content-length': '11', etag: '"9e107d9d372bb6826bd81d3542a419d6"' } }));
    const store = r2(s3.fetch);
    expect(await store.head('present')).toEqual({ bytes: 11, etag: '9e107d9d372bb6826bd81d3542a419d6' });
    expect(await store.head('missing')).toBeUndefined();
    expect(s3.requests.map((r) => r.method)).toEqual(['HEAD', 'HEAD']);
    for (const request of s3.requests) verifySignature(request);
  });

  it('still fails a HEAD the server refuses', async () => {
    const s3 = stubS3(() => new Response(null, { status: 403 }));
    await expect(r2(s3.fetch).head('k')).rejects.toThrow('object store HEAD failed (403)');
  });

  it('lists a prefix across pages, signing the query string canonically', async () => {
    const page = (keys: Array<[string, number]>, next?: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>tavya-objects</Name>
${keys.map(([key, size]) => `<Contents><Key>${key}</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>&quot;e&quot;</ETag><Size>${size}</Size></Contents>`).join('')}
<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`);
    const s3 = stubS3((request) => request.url.searchParams.get('continuation-token') === 'next/token=='
      ? page([['a b/3&amp;4.bin', 7]])
      : page([['a b/1.bin', 1], ['a b/2.bin', 2]], 'next/token=='));
    const listed = [];
    for await (const entry of r2(s3.fetch).list('a b/')) listed.push(entry);
    expect(listed).toEqual([
      { key: 'a b/1.bin', bytes: 1, etag: 'e' }, { key: 'a b/2.bin', bytes: 2, etag: 'e' }, { key: 'a b/3&4.bin', bytes: 7, etag: 'e' },
    ]);
    expect(s3.requests).toHaveLength(2);
    for (const request of s3.requests) {
      expect(request.url.pathname).toBe('/tavya-objects/');
      expect(request.url.searchParams.get('list-type')).toBe('2');
      expect(request.url.searchParams.get('prefix')).toBe('a b/');
      verifySignature(request);
    }
    // Spaces are %20 in a SigV4 query, never `+`.
    expect(s3.requests[1]!.url.search).toContain('continuation-token=next%2Ftoken%3D%3D');
    expect(s3.requests[0]!.url.search).not.toContain('+');
  });

  it('aborts a request after its timeout', async () => {
    const fetch = ((_: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof globalThis.fetch;
    await expect(r2(fetch).delete('k', { timeoutMs: 20 })).rejects.toThrow(/timeout|abort/i);
  });
});

describe('managed S3 settings', () => {
  it('reads the managed store from the environment, defaulting the region R2 aliases to auto', () => {
    expect(managedS3Options({ KARMAX_S3_ENDPOINT: 'https://a.eu.r2.cloudflarestorage.com', KARMAX_S3_BUCKET: 'b',
      KARMAX_S3_ACCESS_KEY_ID: 'id', KARMAX_S3_SECRET_ACCESS_KEY: 'secret' }))
      .toEqual({ endpoint: 'https://a.eu.r2.cloudflarestorage.com', bucket: 'b', region: 'us-east-1',
        accessKeyId: 'id', secretAccessKey: 'secret', sessionToken: undefined });
    expect(managedS3Options({ KARMAX_S3_ENDPOINT: 'e', KARMAX_S3_BUCKET: 'b', KARMAX_S3_REGION: 'auto',
      KARMAX_S3_ACCESS_KEY_ID: 'id', KARMAX_S3_SECRET_ACCESS_KEY: 's' }).region).toBe('auto');
    // An empty .turnkey.env value counts as unset.
    expect(managedS3Options({ KARMAX_S3_ENDPOINT: 'e', KARMAX_S3_BUCKET: 'b', KARMAX_S3_REGION: '',
      KARMAX_S3_ACCESS_KEY_ID: 'id', KARMAX_S3_SECRET_ACCESS_KEY: 's' }).region).toBe('us-east-1');
    expect(() => managedS3Options({ KARMAX_S3_BUCKET: 'b' })).toThrow('KARMAX_S3_ENDPOINT is required');
  });
});
