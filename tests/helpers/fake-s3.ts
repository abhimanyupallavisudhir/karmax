import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3ObjectStore } from '../../src/store/objects.js';

const SECRET = 'fake-s3-secret';

/**
 * An S3 endpoint in memory for tests that move bytes through presigned URLs:
 * it checks a presigned request's SigV4 signature, including the headers it
 * signed, and, like S3 and R2, refuses a body that does not match a signed
 * `x-amz-checksum-sha256` (unless `verifiesChecksums: false`, as some
 * S3-compatible stores do). Requests signed in headers are trusted. GET honours
 * a byte Range. `presignedBytes` counts bytes stored through presigned PUTs
 * (not a store check's probe).
 */
export async function fakeS3(options: { verifiesChecksums?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const counters = { presignedBytes: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const key = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/');
    const presigned = url.searchParams.has('X-Amz-Signature');
    if (presigned ? !validPresign(req, url) : !req.headers.authorization) return void res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
    if (req.method === 'PUT') {
      const checksum = req.headers['x-amz-checksum-sha256'];
      if (checksum && options.verifiesChecksums !== false && checksum !== crypto.createHash('sha256').update(body).digest('base64'))
        return void res.writeHead(400).end('<Error><Code>BadDigest</Code></Error>');
      objects.set(key, body);
      if (presigned && !key.startsWith('.karmax-connection-test/')) counters.presignedBytes += body.length;
      return void res.writeHead(200, { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` }).end();
    }
    if (req.method === 'DELETE') { objects.delete(key); return void res.writeHead(204).end(); }
    const data = objects.get(key);
    if (!data) return void res.writeHead(404).end();
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && req.method === 'GET') {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, { 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${data.length}` });
      return void res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new S3ObjectStore({ endpoint, bucket: 'bucket', region: 'auto', accessKeyId: 'id', secretAccessKey: SECRET });
  return { objects, counters, client, endpoint,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** SigV4 query authentication as a server checks it, with an unsigned payload. */
function validPresign(req: http.IncomingMessage, url: URL): boolean {
  const params = Object.fromEntries(url.searchParams);
  const date = params['X-Amz-Date'] ?? '';
  const expires = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15))
    + Number(params['X-Amz-Expires']) * 1000;
  if (!(expires > Date.now())) return false;
  const signed = (params['X-Amz-SignedHeaders'] ?? '').split(';');
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = [...url.searchParams].filter(([name]) => name !== 'X-Amz-Signature').map(([n, v]) => [encode(n), encode(v)] as const)
    .sort(([a], [b]) => a < b ? -1 : 1).map(([n, v]) => `${n}=${v}`).join('&');
  const headers = signed.map((name) => `${name}:${String(req.headers[name] ?? '').trim()}\n`).join('');
  const canonical = [req.method, url.pathname, query, headers, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = (params['X-Amz-Credential'] ?? '').split('/').slice(1).join('/');
  const [day = '', region = ''] = scope.split('/');
  const hmac = (key: crypto.BinaryLike, value: string) => crypto.createHmac('sha256', key).update(value).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, day), region), 's3'), 'aws4_request');
  const expected = hmac(key, ['AWS4-HMAC-SHA256', date, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n')).toString('hex');
  return expected === params['X-Amz-Signature'];
}
