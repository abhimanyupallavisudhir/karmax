import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ObjectStore {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

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

/** Small S3-compatible SigV4 client used by hosted cells. It deliberately has
 * only the three operations Karmax needs, keeping cloud-vendor SDKs out of the
 * workflow/control-plane bundle. */
export class S3ObjectStore implements ObjectStore {
  private fetcher: typeof fetch;
  constructor(private options: S3ObjectStoreOptions) { this.fetcher = options.fetch ?? fetch; }

  async put(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await this.request('PUT', key, data, contentType);
  }
  async get(key: string): Promise<Buffer> {
    const response = await this.request('GET', key);
    return Buffer.from(await response.arrayBuffer());
  }
  async delete(key: string): Promise<void> { await this.request('DELETE', key); }

  private async request(method: string, key: string, body: Buffer = Buffer.alloc(0), contentType?: string): Promise<Response> {
    if (!key || key.includes('..')) throw new Error('invalid object key');
    const base = new URL(this.options.endpoint.replace(/\/$/, '') + '/');
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const prefix = base.pathname.replace(/\/$/, '');
    base.pathname = `${prefix}/${encodeURIComponent(this.options.bucket)}/${encodedKey}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const headers: Record<string, string> = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (contentType) headers['content-type'] = contentType;
    if (this.options.sessionToken) headers['x-amz-security-token'] = this.options.sessionToken;
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join('');
    const canonicalRequest = [method, base.pathname, base.searchParams.toString(), canonicalHeaders, names.join(';'), payloadHash].join('\n');
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(Buffer.from(canonicalRequest))].join('\n');
    const dateKey = hmac(Buffer.from(`AWS4${this.options.secretAccessKey}`), date);
    const regionKey = hmac(dateKey, this.options.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = hmac(signingKey, stringToSign).toString('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    const response = await this.fetcher(base, { method, headers, ...(method === 'PUT' ? { body: body as any } : {}) });
    if (!response.ok) throw new Error(`object store ${method} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    return response;
  }
}

function sha256(value: Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key: Buffer, value: string): Buffer { return crypto.createHmac('sha256', key).update(value).digest(); }
