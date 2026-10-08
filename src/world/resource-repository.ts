import crypto from 'node:crypto';
import type http from 'node:http';
import fs from 'node:fs';
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../autonomy/vault-keys.js';
import type { ResourceAttachment } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { verifiesChecksums, type ObjectStore } from '../store/objects.js';
import { organizationKey } from './chunk-store.js';
import { RESTIC_VERSION, worldResticBinary } from './restic.js';

/**
 * Project resources are restic repositories, one per resource, and this is
 * the server restic talks to: its REST protocol
 * (https://restic.readthedocs.io/en/stable/REST_backend.html) over the
 * resource's object store, the way rest-server serves a directory.
 *
 * A task world runs restic itself, so its bytes go straight to (and, on
 * restore, straight from) storage instead of through a chain of calls driven by
 * the worker. What the world may do is fixed by its token:
 *
 * - `read`: restore. Object reads are redirected to presigned URLs, so they
 *   never pass through this server.
 * - `append`: back up. It may add files, never delete or replace one (only its
 *   own locks), like rest-server's `--append-only`: a world can neither erase
 *   the resource's history nor corrupt it, since every file must hash to its
 *   name, as restic names them.
 * - `admin`: everything, for the worker alone (init, forget, prune).
 *
 * The database is the repository's listing (`resource_repository_files`): it
 * is consistent where an object listing is not (deletes are deferred 30 days,
 * see store/deferred-delete.ts), it counts storage for quotas, and it holds the
 * tiny lock files, which come and go every few minutes.
 */

export type RepositoryAccess = 'read' | 'append' | 'admin';
export interface RepositoryGrant {
  /** The repository ({@link repositoryName}). */
  repository: string;
  access: RepositoryAccess;
  /** Refuse new data over the organization's storage quota. Work in progress
   * (a parked task's private copy) is counted but never refused. */
  quota: boolean;
  expiresAt: number;
}

const KINDS = new Set(['data', 'keys', 'locks', 'snapshots', 'index']);
const NAME = /^[0-9a-f]{64}$/;
/** restic writes packs of about 16 MiB (`--pack-size`, at most 128). */
const MAX_UPLOAD_BYTES = 160 * 1024 * 1024;
/** Uploads held in memory at once, across every repository. */
const UPLOAD_SLOTS = 24;
const REDIRECT_SECONDS = 15 * 60;
/** The edge starts its upload as soon as it has the URL. */
const UPLOAD_URL_SECONDS = 15 * 60;
const TOKEN_KEY_HANDLE = 'resource-repositories:token-key';
export const REPOSITORY_ROUTE = '/resource-repositories/';
/** Requests one grant may make a minute. A save makes about two per 16 MiB
 * pack through the edge (one through the relay), a restore one per pack: the
 * fastest measured save, ~85 MiB/s, is ~650 a minute. */
export const GRANT_REQUESTS_PER_MINUTE = 3_000;

/**
 * Each grant's own request budget, in one-minute windows.
 *
 * Remote worlds reach this server through the edge, so their peer is one of a
 * few Cloudflare addresses that every customer shares, and a budget per address
 * would make them refuse each other. Anyone can send a header claiming to be
 * the edge, or run a Worker of their own from those addresses. The grant is the
 * one thing a request proves, so it is what is metered, after its signature is
 * checked: a request without a valid grant is refused before it costs more than
 * that check, and makes no entry here.
 */
export class GrantLimits {
  private windows = new Map<string, { count: number; until: number }>();
  private sweepAt = 0;
  constructor(private perMinute = GRANT_REQUESTS_PER_MINUTE) {}

  get size(): number { return this.windows.size; }

  /** 0 when the request may proceed, else the milliseconds until the grant may ask again. */
  take(grant: string, now = Date.now()): number {
    if (now >= this.sweepAt) {
      for (const [key, window] of this.windows) if (window.until <= now) this.windows.delete(key);
      this.sweepAt = now + 60_000;
    }
    let window = this.windows.get(grant);
    if (!window || window.until <= now) this.windows.set(grant, window = { count: 0, until: now + 60_000 });
    return ++window.count > this.perMinute ? window.until - now : 0;
  }
}

/** A repository is a resource's in one storage location: a resource moved to
 * another location starts a repository there, and its earlier versions stay
 * readable where they were saved. */
export function repositoryName(attachmentId: string, storageLocationId?: string): string {
  return `${attachmentId}@${storageLocationId ?? 'default'}`;
}
export function parseRepositoryName(name: string): { attachmentId: string; storageLocationId?: string } | undefined {
  const match = /^([A-Za-z0-9_-]+)@([A-Za-z0-9_-]+)$/.exec(name);
  return match ? { attachmentId: match[1]!, ...(match[2] === 'default' ? {} : { storageLocationId: match[2]! }) } : undefined;
}

export function repositoryObjectKey(repository: string, kind: string, name?: string): string {
  const parsed = parseRepositoryName(repository);
  if (!parsed) throw new Error('invalid resource repository');
  return `resource-repositories/${parsed.attachmentId}/${parsed.storageLocationId ?? 'default'}/${kind === 'config' ? 'config' : `${kind}/${name}`}`;
}

/** The repository password: derived from the organization's resource key, so
 * deleting that key (organization deletion) makes every repository unreadable. */
export async function repositoryPassword(broker: CredentialBroker, attachment: Pick<ResourceAttachment, 'id' | 'organizationId'>,
  create = false): Promise<string> {
  // Only creating a repository may create the key: a key made to read one
  // would derive a password that opens nothing, and hide that the key is gone.
  const key = await organizationKey(broker, attachment.organizationId, create);
  return crypto.createHmac('sha256', key).update(`restic-repository\0${attachment.id}`).digest('base64url');
}

async function tokenKey(broker: CredentialBroker): Promise<Buffer> {
  if (!await broker.hasHandle(TOKEN_KEY_HANDLE))
    await broker.ensureHandle(TOKEN_KEY_HANDLE, crypto.randomBytes(32).toString('base64'), INSTALLATION_SCOPE);
  return Buffer.from(await broker.resolve(TOKEN_KEY_HANDLE, { caps: [`use-credential:${TOKEN_KEY_HANDLE}`] }), 'base64');
}

/** Stateless signed grants: a world holds one only for the work it was given. */
export class RepositoryTokens {
  private key?: Promise<Buffer>;
  constructor(private broker: CredentialBroker) {}

  async mint(grant: RepositoryGrant): Promise<string> {
    // Each grant is its own (two minted alike in one millisecond would
    // otherwise be one token), since each has its own request budget.
    const body = Buffer.from(JSON.stringify({ ...grant, nonce: crypto.randomBytes(12).toString('base64url') })).toString('base64url');
    return `${body}.${this.sign(await this.secret(), body)}`;
  }

  async verify(token: string, now = Date.now()): Promise<RepositoryGrant | undefined> {
    const [body, signature] = token.split('.');
    if (!body || !signature) return undefined;
    const expected = this.sign(await this.secret(), body);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
    let grant: RepositoryGrant;
    try { grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return undefined; }
    if (typeof grant?.repository !== 'string' || !['read', 'append', 'admin'].includes(grant.access)
      || typeof grant.expiresAt !== 'number' || grant.expiresAt <= now) return undefined;
    return grant;
  }

  private sign(key: Buffer, body: string): string {
    return crypto.createHmac('sha256', key).update(`resource-repository\0${body}`).digest('base64url');
  }
  private secret(): Promise<Buffer> { return this.key ??= tokenKey(this.broker); }
}

export interface RepositoryServerDeps {
  store: Store;
  tokens: RepositoryTokens;
  /** The object store of an attachment's storage location (its own organization's only). */
  objects(attachment: ResourceAttachment, storageLocationId: string | undefined): Promise<ObjectStore>;
  /** Serve reads itself instead of redirecting to the store: for a store that
   * restic (in a world, or on this host) cannot reach, such as a private endpoint. */
  proxyReads?: boolean;
  /** Whether an edge is deployed (src/edge/resource-repository-worker.ts): it
   * may then upload files straight into stores that verify checksums. */
  edge?: () => boolean;
  /** Requests one grant may make a minute ({@link GRANT_REQUESTS_PER_MINUTE}). */
  grantRequestsPerMinute?: number;
}

interface RepositoryPlace { attachment: ResourceAttachment; repository: string; storageLocationId?: string; objects(): Promise<ObjectStore> }

class HttpError extends Error { constructor(readonly status: number, message: string, readonly retryAfter?: number) { super(message); } }

export class ResourceRepositoryServer {
  private slots = UPLOAD_SLOTS;
  private limits: GrantLimits;
  private waiting: Array<() => void> = [];
  /** Per storage location: does its store refuse content that does not match a signed checksum? */
  private checksums = new Map<string, { verified: Promise<boolean>; until: number }>();

  constructor(private deps: RepositoryServerDeps) {
    this.limits = new GrantLimits(deps.grantRequestsPerMinute);
  }

  /** Whether the edge uploads this repository's files straight into its store.
   * Only a store that refuses content not matching the checksum signed into
   * its upload URL qualifies: the URL then lets whoever holds it store exactly
   * the file its name hashes, nothing else. Others keep the relay. Checked once
   * a day per storage location (an hour after a store failed the check). A
   * store only this server can reach (`proxyReads`) is out of the edge's reach too. */
  async directUploads(repository: string): Promise<boolean> {
    if (!this.deps.edge?.() || this.deps.proxyReads) return false;
    const parsed = parseRepositoryName(repository);
    const attachment = parsed && await this.deps.store.getResourceAttachment(parsed.attachmentId);
    if (!parsed || !attachment) return false;
    const id = parsed.storageLocationId ?? 'default';
    const known = this.checksums.get(id);
    if (known && known.until > Date.now()) return known.verified;
    const verified = this.deps.objects(attachment, parsed.storageLocationId).then((objects) => verifiesChecksums(objects), () => false);
    this.checksums.set(id, { verified, until: Date.now() + 3_600_000 });
    if (await verified) this.checksums.set(id, { verified, until: Date.now() + 24 * 3_600_000 });
    return verified;
  }

  /** `path` is everything after {@link REPOSITORY_ROUTE}: `<attachment>/<restic path>`.
   * Each grant has its own request budget ({@link GrantLimits}), except for
   * restic run by this process (`unmetered`). */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, options: { unmetered?: boolean } = {}): Promise<void> {
    try {
      await this.serve(req, res, path, !options.unmetered);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.warn(`resource repository: ${req.method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain',
        ...(error instanceof HttpError && error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}) });
      // A store's own errors may name URLs or keys: they stay in the log.
      res.end(status === 500 ? 'internal error' : error instanceof Error ? error.message : String(error));
    }
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse, path: string, metered: boolean): Promise<void> {
    const method = req.method ?? 'GET';
    // The pinned restic for worlds that have none (they check its digest), for
    // any grant: 31 MB must not be free to whoever asks.
    const binary = new RegExp(`^restic/${RESTIC_VERSION.replace(/\./g, '\\.')}/linux-(amd64|arm64)$`).exec(path);
    if (binary && method === 'GET') {
      await this.authorize(req, undefined, metered);
      const file = worldResticBinary(binary[1]!);
      if (!file) throw new HttpError(404, 'not found');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(fs.statSync(file.file).size),
        'cache-control': 'public, max-age=86400, immutable' });
      fs.createReadStream(file.file).pipe(res);
      return;
    }
    const [repository = '', ...rest] = path.split('/');
    const grant = await this.authorize(req, repository, metered);
    const parsed = parseRepositoryName(repository);
    const attachment = parsed && await this.deps.store.getResourceAttachment(parsed.attachmentId);
    if (!parsed || !attachment) throw new HttpError(404, 'no such repository');
    const place = { attachment, repository, storageLocationId: parsed.storageLocationId,
      objects: () => this.deps.objects(attachment, parsed.storageLocationId) };
    const tail = rest.join('/');
    if (tail === '' || tail === '?create=true') {
      // The worker creates a repository; the files restic then saves are its structure.
      if (method === 'POST' && grant.access === 'admin') return void res.writeHead(200).end();
      throw new HttpError(403, 'not allowed');
    }
    const [kind = '', name = '', ...extra] = tail.split('/');
    if (extra.length || !(kind === 'config' ? !name : KINDS.has(kind))) throw new HttpError(404, 'not found');
    if (kind !== 'config' && name === '') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed');
      const files = await this.deps.store.listRepositoryFiles(repository, kind);
      const v2 = (req.headers.accept ?? '').includes('application/vnd.x.restic.rest.v2');
      res.writeHead(200, { 'content-type': v2 ? 'application/vnd.x.restic.rest.v2' : 'application/vnd.x.restic.rest.v1' });
      return void res.end(JSON.stringify(v2 ? files.map(({ name: file, bytes }) => ({ name: file, size: bytes })) : files.map(({ name: file }) => file)));
    }
    if (kind !== 'config' && !NAME.test(name)) throw new HttpError(404, 'not found');
    const fileName = kind === 'config' ? 'config' : name;
    if (method === 'HEAD' || method === 'GET') return this.read(req, res, place, kind, fileName, method);
    if (method === 'POST') return this.write(req, res, place, grant, kind, fileName);
    if (method === 'DELETE') {
      if (grant.access !== 'admin' && !(grant.access === 'append' && kind === 'locks')) throw new HttpError(403, 'this repository is append-only');
      const removed = await this.deps.store.deleteRepositoryFile(repository, kind, fileName);
      if (removed && kind !== 'locks') await (await place.objects()).delete(repositoryObjectKey(repository, kind, fileName));
      return void res.writeHead(200).end();
    }
    throw new HttpError(405, 'method not allowed');
  }

  /** The request's grant, for `repository` (any, when undefined), charged to its budget. */
  private async authorize(req: http.IncomingMessage, repository: string | undefined, metered: boolean): Promise<RepositoryGrant> {
    const header = req.headers.authorization ?? '';
    const basic = /^Basic\s+(.+)$/i.exec(header)?.[1];
    const token = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':').slice(1).join(':') : undefined;
    const grant = token ? await this.deps.tokens.verify(token) : undefined;
    if (!token || !grant || (repository !== undefined && grant.repository !== repository)) throw new HttpError(401, 'unauthorized');
    const wait = metered ? this.limits.take(token) : 0;
    if (wait) { req.resume(); throw new HttpError(429, 'too many requests for this grant', Math.ceil(wait / 1000)); }
    return grant;
  }

  private async read(req: http.IncomingMessage, res: http.ServerResponse, place: RepositoryPlace,
    kind: string, name: string, method: 'HEAD' | 'GET'): Promise<void> {
    const file = await this.deps.store.repositoryFile(place.repository, kind, name);
    if (!file) throw new HttpError(404, 'not found');
    if (method === 'HEAD') return void res.writeHead(200, { 'content-length': String(file.bytes) }).end();
    let body: Buffer;
    if (file.content !== undefined) body = Buffer.from(file.content, 'base64');
    else {
      const objects = await place.objects();
      const key = repositoryObjectKey(place.repository, kind, name);
      if (objects.presign && !this.deps.proxyReads) {
        // The bytes come straight from storage; restic keeps its Range header.
        res.writeHead(307, { location: await objects.presign('GET', key, REDIRECT_SECONDS), 'cache-control': 'no-store' });
        return void res.end();
      }
      try { body = await objects.get(key); }
      catch (error) {
        // Missing for good: restic gives up at once instead of retrying.
        if (missing(error)) throw new HttpError(404, 'not found');
        throw error;
      }
    }
    const range = parseRange(req.headers.range, body.length);
    if (range === 'invalid') throw new HttpError(416, 'range not satisfiable');
    if (range) {
      res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${body.length}` });
      return void res.end(body.subarray(range.start, range.end + 1));
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  }

  private async write(req: http.IncomingMessage, res: http.ServerResponse, place: RepositoryPlace,
    grant: RepositoryGrant, kind: string, name: string): Promise<void> {
    const { attachment, repository, storageLocationId } = place;
    if (grant.access === 'read' || (grant.access !== 'admin' && (kind === 'config' || kind === 'keys')))
      throw new HttpError(403, 'not allowed');
    const edge = req.headers['x-tavya-edge'];
    if (edge === 'intent' || edge === 'stored') return this.edgeWrite(req, res, place, grant, kind, name, edge);
    const declared = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(declared) || declared < 0) throw new HttpError(411, 'a content length is required');
    if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, 'file too large');
    const existing = await this.deps.store.repositoryFile(repository, kind, name);
    if (existing) {
      // A retried upload: a named file can only ever hold the same bytes.
      req.resume();
      if (kind === 'config' || existing.bytes !== declared) throw new HttpError(403, 'this repository is append-only');
      return void res.writeHead(200).end();
    }
    const objects = await place.objects();
    if (grant.quota && kind !== 'locks' && storageLocationId) {
      const usage = await this.deps.store.storageLocationUsage(storageLocationId);
      if (usage.quotaBytes != null && usage.retainedBytes + declared > usage.quotaBytes)
        throw new HttpError(507, `storage quota exceeded (${usage.retainedBytes} of ${usage.quotaBytes} bytes used)`);
    }
    await this.acquire();
    try {
      const body = await readBody(req, declared);
      if (kind !== 'config' && crypto.createHash('sha256').update(body).digest('hex') !== name)
        throw new HttpError(400, 'file content does not match its name');
      if (kind !== 'locks') await objects.put(repositoryObjectKey(repository, kind, name), body);
      await this.deps.store.recordRepositoryFile({ repository, attachmentId: attachment.id, organizationId: attachment.organizationId,
        storageLocationId, kind, name, bytes: body.length, ...(kind === 'locks' ? { content: body.toString('base64') } : {}) });
    } finally { this.release(); }
    res.writeHead(200).end();
  }

  /**
   * An upload through the edge (src/edge/resource-repository-worker.ts), which
   * streams the bytes into the store itself. `intent`: may this file be stored
   * (the same checks as an upload here)? 202 carries a presigned PUT bound to
   * the file's key and checksum; 409 sends the upload through this server.
   * `stored`: it is, so it is recorded once the store holds an object of
   * exactly the announced size (the store checked its content). Both carry the
   * world's own grant; neither carries file bytes.
   */
  private async edgeWrite(req: http.IncomingMessage, res: http.ServerResponse, place: RepositoryPlace,
    grant: RepositoryGrant, kind: string, name: string, step: 'intent' | 'stored'): Promise<void> {
    req.resume();
    const { attachment, repository, storageLocationId } = place;
    if (!['data', 'index', 'snapshots'].includes(kind) || !(await this.directUploads(repository)))
      throw new HttpError(409, 'upload this file here');
    const declared = Number(req.headers['x-tavya-length']);
    if (!Number.isSafeInteger(declared) || declared < 0) throw new HttpError(411, 'a content length is required');
    if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, 'file too large');
    const existing = await this.deps.store.repositoryFile(repository, kind, name);
    if (existing) {
      if (existing.bytes !== declared) throw new HttpError(403, 'this repository is append-only');
      return void res.writeHead(200).end();
    }
    const key = repositoryObjectKey(repository, kind, name);
    const objects = await place.objects();
    if (step === 'intent') {
      if (grant.quota && storageLocationId) {
        const usage = await this.deps.store.storageLocationUsage(storageLocationId);
        if (usage.quotaBytes != null && usage.retainedBytes + declared > usage.quotaBytes)
          throw new HttpError(507, `storage quota exceeded (${usage.retainedBytes} of ${usage.quotaBytes} bytes used)`);
      }
      const url = await objects.presign!('PUT', key, UPLOAD_URL_SECONDS, { sha256: name });
      return void res.writeHead(202, { 'x-tavya-upload-url': url, 'cache-control': 'no-store' }).end();
    }
    // Written past the deferred-delete store, so its put() could not cancel a
    // delete pending for this name (DeferredDeleteObjectStore). Cancel it first:
    // a purge that ran before deleted the new object too, and the check below fails.
    await this.deps.store.transaction(() => this.deps.store.deleteObjectTombstone(key));
    const stored = await objects.head?.(key);
    if (stored?.bytes !== declared) throw new HttpError(409, 'the store does not hold that file');
    await this.deps.store.recordRepositoryFile({ repository, attachmentId: attachment.id, organizationId: attachment.organizationId,
      storageLocationId, kind, name, bytes: declared });
    res.writeHead(200).end();
  }

  private async acquire(): Promise<void> {
    if (this.slots > 0) { this.slots--; return; }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); else this.slots++;
  }
}

async function readBody(req: http.IncomingMessage, declared: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += (chunk as Buffer).length;
    if (received > declared) throw new HttpError(400, 'body longer than its content length');
    chunks.push(chunk as Buffer);
  }
  if (received !== declared) throw new HttpError(400, 'body shorter than its content length');
  return Buffer.concat(chunks, received);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT' || /\(404\)/.test(error instanceof Error ? error.message : '');
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}
