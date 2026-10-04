import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ObjectStore {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string, options?: ObjectRequestOptions): Promise<void>;
  /** A URL that lets whoever holds it PUT or GET exactly this object for
   * `seconds`, so a sandbox can move bytes without them passing through
   * Karmax. Absent when the store has no URL of its own (local disk). */
  presign?(method: 'PUT' | 'GET', key: string, seconds: number): Promise<string>;
  head?(key: string, options?: ObjectRequestOptions): Promise<ObjectInfo | undefined>;
}

export interface ObjectRequestOptions {
  /** Abort the request after this long. A purge holds a database transaction
   *  open around its delete, so it must not wait on a stalled connection. */
  timeoutMs?: number;
}

/** What `head` and `list` report: the stored size and the ETag without quotes. */
export interface ObjectInfo { bytes: number; etag: string }

export class LocalObjectStore implements ObjectStore {
  constructor(private root: string) { fs.mkdirSync(root, { recursive: true }); }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.file(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(temp, data, { mode: 0o600 });
    await fs.promises.rename(temp, file);
  }

  async get(key: string): Promise<Buffer> { return fs.promises.readFile(this.file(key)); }
  async delete(key: string): Promise<void> { await fs.promises.rm(this.file(key), { force: true }); }

  async head(key: string): Promise<ObjectInfo | undefined> {
    const data = await fs.promises.readFile(this.file(key)).catch(() => undefined);
    return data && { bytes: data.length, etag: crypto.createHash('md5').update(data).digest('hex') };
  }

  private file(key: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes('..')) throw new Error('invalid object key');
    const file = path.resolve(this.root, key);
    if (file !== path.resolve(this.root) && !file.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new Error('object key escapes store');
    return file;
  }
}

export interface S3ObjectStoreOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  fetch?: typeof fetch;
}

/** Small S3-compatible SigV4 client used by hosted cells, with only the
 * operations Karmax needs, keeping cloud-vendor SDKs out of the
 * workflow/control-plane bundle. Requests are path-style, which every
 * S3-compatible store accepts. For Cloudflare R2 use region `auto` (it also
 * accepts `us-east-1`) and, for a bucket in the EU jurisdiction, the endpoint
 * `https://<account-id>.eu.r2.cloudflarestorage.com`. */
export class S3ObjectStore implements ObjectStore {
  private fetcher: typeof fetch;
  constructor(private options: S3ObjectStoreOptions) { this.fetcher = options.fetch ?? fetch; }

  /** Sends Content-MD5, so the store rejects a body corrupted in transit. */
  async put(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await this.request('PUT', key, { body: data, contentType });
  }
  async get(key: string): Promise<Buffer> {
    const response = await this.request('GET', key);
    return Buffer.from(await response.arrayBuffer());
  }
  async delete(key: string, options: ObjectRequestOptions = {}): Promise<void> {
    await this.request('DELETE', key, options);
  }

  /** Size and ETag of a stored object, or undefined when there is none. For a
   * single-part PUT without SSE-KMS (and always on R2) the ETag is the MD5. */
  async head(key: string, options: ObjectRequestOptions = {}): Promise<ObjectInfo | undefined> {
    const response = await this.request('HEAD', key, { ...options, allowMissing: true });
    if (response.status === 404) return undefined;
    return { bytes: Number(response.headers.get('content-length') ?? 0), etag: unquote(response.headers.get('etag') ?? '') };
  }

  /** SigV4 query authentication (UNSIGNED-PAYLOAD, only `host` signed). The
   * URL carries a signature: like a credential, it must never be logged. */
  async presign(method: 'PUT' | 'GET', key: string, seconds: number): Promise<string> {
    if (!key || key.includes('..')) throw new Error('invalid object key');
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7 * 24 * 3600) throw new Error('invalid presigned URL lifetime');
    const url = new URL(this.options.endpoint.replace(/\/$/, '') + '/');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${uriEncode(this.options.bucket)}/${key.split('/').map(uriEncode).join('/')}`;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const params: Record<string, string> = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.options.accessKeyId}/${scope}`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(seconds),
      'X-Amz-SignedHeaders': 'host', ...(this.options.sessionToken ? { 'X-Amz-Security-Token': this.options.sessionToken } : {}) };
    const query = Object.entries(params).map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => `${name}=${value}`).join('&');
    const canonicalRequest = [method, url.pathname, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(Buffer.from(canonicalRequest))].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${this.options.secretAccessKey}`), date), this.options.region), 's3'), 'aws4_request');
    url.search = `${query}&X-Amz-Signature=${hmac(signingKey, stringToSign).toString('hex')}`;
    return url.toString();
  }

  /** Every object under `prefix`, a ListObjectsV2 page at a time. */
  async *list(prefix = ''): AsyncGenerator<ObjectInfo & { key: string }> {
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
      const xml = await (await this.request('GET', '', { query })).text();
      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        yield { key: xmlText(entry!, 'Key'), bytes: Number(xmlText(entry!, 'Size')), etag: unquote(xmlText(entry!, 'ETag')) };
      }
      token = xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : undefined;
    } while (token);
  }

  private async request(method: string, key: string, options: ObjectRequestOptions & { body?: Buffer; contentType?: string;
    query?: Record<string, string>; allowMissing?: boolean } = {}): Promise<Response> {
    // An empty key addresses the bucket itself (a listing), never an object.
    if (key.includes('..') || (!key && !options.query)) throw new Error('invalid object key');
    const body = options.body ?? Buffer.alloc(0);
    const base = new URL(this.options.endpoint.replace(/\/$/, '') + '/');
    const encodedKey = key.split('/').map(uriEncode).join('/');
    const prefix = base.pathname.replace(/\/$/, '');
    base.pathname = `${prefix}/${uriEncode(this.options.bucket)}/${encodedKey}`;
    // SigV4 signs the query sorted and RFC 3986-encoded; URLSearchParams would
    // send a space as `+`, which the server decodes differently from what was signed.
    const query = Object.entries(options.query ?? {}).map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
      .sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)
      .map(([name, value]) => `${name}=${value}`).join('&');
    base.search = query;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const headers: Record<string, string> = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (options.contentType) headers['content-type'] = options.contentType;
    if (method === 'PUT') headers['content-md5'] = crypto.createHash('md5').update(body).digest('base64');
    if (this.options.sessionToken) headers['x-amz-security-token'] = this.options.sessionToken;
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join('');
    const canonicalRequest = [method, base.pathname, query, canonicalHeaders, names.join(';'), payloadHash].join('\n');
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(Buffer.from(canonicalRequest))].join('\n');
    const dateKey = hmac(Buffer.from(`AWS4${this.options.secretAccessKey}`), date);
    const regionKey = hmac(dateKey, this.options.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = hmac(signingKey, stringToSign).toString('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    const response = await this.fetcher(base, { method, headers, ...(method === 'PUT' ? { body: body as any } : {}),
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}) });
    if (options.allowMissing && response.status === 404) return response;
    if (!response.ok) throw new Error(`object store ${method} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    return response;
  }
}

/** The managed store's S3 settings (`KARMAX_OBJECT_STORE=s3`). An empty value,
 * which Compose passes for an unset `.turnkey.env` entry, counts as unset. */
export function managedS3Options(env: NodeJS.ProcessEnv = process.env): S3ObjectStoreOptions {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return { endpoint: required('KARMAX_S3_ENDPOINT'), bucket: required('KARMAX_S3_BUCKET'),
    region: env.KARMAX_S3_REGION?.trim() || 'us-east-1', accessKeyId: required('KARMAX_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('KARMAX_S3_SECRET_ACCESS_KEY'), sessionToken: env.KARMAX_S3_SESSION_TOKEN?.trim() || undefined };
}

function unquote(etag: string): string { return etag.replace(/^(?:W\/)?"|"$/g, ''); }

function xmlText(xml: string, tag: string): string {
  const value = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? '';
  return value.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
    return String.fromCodePoint(entity[1]!.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
  });
}

/**
 * RFC 3986 percent-encoding, as SigV4's canonical URI requires.
 *
 * `encodeURIComponent` leaves `!'()*` untouched — they are "mark" characters in
 * the older RFC 2396. AWS builds the string-to-sign from the fully-encoded path,
 * so a key containing any of them was signed one way and sent another, and the
 * request came back `SignatureDoesNotMatch`. Only `A-Za-z0-9-_.~` may stay literal.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256(value: Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key: Buffer, value: string): Buffer { return crypto.createHmac('sha256', key).update(value).digest(); }
