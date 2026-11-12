/**
 * Repositories tavya hosts itself (wiki features/hosted-repositories), for
 * people with no GitHub account: Git over smart HTTP at
 * `/git/<repository id>/<name>.git`, served by `git http-backend`.
 *
 * The object store is the repository. Its row (`hosted_repositories`) holds
 * the refs, HEAD and an ordered list of packs; a pack is a Git bundle of the
 * objects one push added, sealed with the organization's key and stored in
 * parts. A bare repository under `$KARMAX_HOME/cache/hosted-git` is only a
 * cache: any host rebuilds it from the row (wiki planned/host-local-state).
 *
 * A push runs `receive-pack` on the cache, bundles the objects it added,
 * stores them and then moves the row's refs with a compare-and-swap on its
 * version. Only then is the push answered: a push the client saw succeed is
 * durable, and one that failed leaves the cache's refs as the row has them.
 *
 * Everything that reads or writes one goes through this server: the Git broker
 * (task worlds' checkouts, publishing, landing) with a short signed grant for
 * the repository, and people (`git clone` on a laptop, the tavya CLI) with
 * their own token as the password, checked against the projects using it.
 * Stable URLs are `tavya:<id>/<name>.git`; the broker rewrites them to this
 * server per operation, as it rewrites GitHub's to HTTPS.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type http from 'node:http';
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../autonomy/vault-keys.js';
import type { Repository } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { ObjectStore } from '../store/objects.js';
import { organizationKey } from './chunk-store.js';
import { appendGitConfig } from './git-credential.js';
import type { GitBrokerCredential } from './git-broker.js';
import { git, hostGitEnvironment } from './git.js';
import { HOSTED_GIT_ROUTE, HOSTED_GIT_SCHEME, isHostedRepository, type HostedPack, type HostedRepositoryState } from '../domain/hosted-repository.js';

export { HOSTED_GIT_ROUTE, HOSTED_GIT_SCHEME, hostedCloneUrl, hostedRepositoryUrl, isHostedRepository, isValidHostedName, parseHostedUrl,
  type HostedPack, type HostedRepositoryState } from '../domain/hosted-repository.js';
/** Bytes of a sealed pack part: a part is held in memory while it is moved. */
const PART_BYTES = 32 * 1024 * 1024;
/** A repository with more packs than this is rewritten as one at its next push. */
const MAX_PACKS = 24;
const TOKEN_KEY_HANDLE = 'hosted-git:token-key';
/** Git's empty tree, which every repository has without storing it. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const GRANT_PREFIX = 'tvg_';
/** How long the broker's grant lasts: one clone, publish or landing. */
const BROKER_GRANT_MS = 2 * 60 * 60_000;
export type HostedAccess = 'read' | 'write';
export interface HostedGrant { repository: string; access: HostedAccess; expiresAt: number }

/** Stateless signed grants for one repository, as resource repositories have. */
export class HostedGitTokens {
  private key?: Promise<Buffer>;
  constructor(private broker: CredentialBroker) {}

  async mint(grant: HostedGrant): Promise<string> {
    const body = Buffer.from(JSON.stringify({ ...grant, nonce: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
    return `${GRANT_PREFIX}${body}.${this.sign(await this.secret(), body)}`;
  }

  async verify(token: string, now = Date.now()): Promise<HostedGrant | undefined> {
    if (!token.startsWith(GRANT_PREFIX)) return undefined;
    const [body, signature] = token.slice(GRANT_PREFIX.length).split('.');
    if (!body || !signature) return undefined;
    const expected = this.sign(await this.secret(), body);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
    let grant: HostedGrant;
    try { grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return undefined; }
    if (typeof grant?.repository !== 'string' || !['read', 'write'].includes(grant.access)
      || typeof grant.expiresAt !== 'number' || grant.expiresAt <= now) return undefined;
    return grant;
  }

  private sign(key: Buffer, body: string): string {
    return crypto.createHmac('sha256', key).update(`hosted-git\0${body}`).digest('base64url');
  }
  private secret(): Promise<Buffer> {
    return this.key ??= (async () => {
      if (!await this.broker.hasHandle(TOKEN_KEY_HANDLE))
        await this.broker.ensureHandle(TOKEN_KEY_HANDLE, crypto.randomBytes(32).toString('base64'), INSTALLATION_SCOPE);
      return Buffer.from(await this.broker.resolve(TOKEN_KEY_HANDLE, { caps: [`use-credential:${TOKEN_KEY_HANDLE}`] }), 'base64');
    })();
  }
}

/** A pack part: AES-256-GCM under the organization's key, bound to its object name. */
function seal(key: Buffer, objectKey: string, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(objectKey));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('KRG1'), iv, cipher.getAuthTag(), body]);
}

function open(key: Buffer, objectKey: string, blob: Buffer): Buffer {
  if (blob.subarray(0, 4).toString() !== 'KRG1') throw new Error('invalid repository pack envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
  decipher.setAAD(Buffer.from(objectKey));
  decipher.setAuthTag(blob.subarray(16, 32));
  return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
}

export const packPartKey = (state: Pick<HostedRepositoryState, 'organizationId' | 'repositoryId'>, pack: string, part: number): string =>
  `git/${state.organizationId}/${state.repositoryId}/${pack}/${part}.bin`;

export class HostedGitError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface HostedGitDeps {
  store: Store;
  objects: ObjectStore;
  broker: CredentialBroker;
  /** Bare repositories this host keeps as a cache. */
  cacheDir: string;
  /** Whether a person's or agent's token (not a signed grant) may read or
   * write the repository: the gateway checks it against its projects. */
  authorize?(token: string, repository: Repository, access: HostedAccess): Promise<boolean>;
  /** Whether the organization's storage has room for `bytes` more. */
  storageAvailable?(organizationId: string, bytes: number): Promise<boolean>;
  /** Called after a push moved refs (the Files tab, events). */
  onPushed?(repository: Repository, changed: string[]): void;
}

interface CacheMarker { version: number; packs: string[] }

export class HostedGit {
  readonly tokens: HostedGitTokens;
  private locks = new Map<string, Promise<unknown>>();

  constructor(private deps: HostedGitDeps) {
    this.tokens = new HostedGitTokens(deps.broker);
  }

  /** A new repository: its row, and a first (empty) commit on its default
   * branch, so every clone has a base to branch from and a task world never
   * has to initialize it. A repository that has commits is left as it is.
   * `empty` makes only the row: for a history pushed next (a project wiki's). */
  async create(repository: Repository, options: { empty?: boolean } = {}): Promise<void> {
    if (!isHostedRepository(repository)) throw new Error('not a tavya repository');
    const head = `refs/heads/${repository.defaultBranch || 'main'}`;
    await this.deps.store.createHostedRepository({ repositoryId: repository.id, organizationId: repository.organizationId, head });
    if (options.empty) return;
    await this.exclusive(repository.id, async () => {
      const before = await this.state(repository.id);
      if (Object.keys(before.refs).length) return;
      const dir = await this.current(repository.id, before);
      const commit = await git(dir, ['-c', 'user.name=tavya', '-c', 'user.email=tavya@localhost',
        'commit-tree', EMPTY_TREE, '-m', `Create ${repository.name}`]);
      if (commit.code !== 0) throw new Error(`git commit-tree failed: ${commit.stderr.trim()}`);
      await git(dir, ['update-ref', head, commit.stdout.trim()]);
      try { await this.persist(repository, dir, before); }
      catch (error) { await this.reset(dir, before).catch(() => this.drop(repository.id)); throw error; }
    });
  }

  /** The credential the Git broker uses for one operation on the repository:
   * a write grant as the HTTPS password, and `tavya:` rewritten to this server. */
  async brokerCredentials(repository: Repository): Promise<{ httpsToken: string; env: Record<string, string>; mirrorScope: string }> {
    const base = process.env.KARMAX_GATEWAY_URL?.replace(/\/$/, '');
    if (!base) throw new Error('the tavya Git server address is not known (KARMAX_GATEWAY_URL)');
    const env: Record<string, string> = {};
    appendGitConfig(env, `url.${base}${HOSTED_GIT_ROUTE}.insteadOf`, HOSTED_GIT_SCHEME);
    const httpsToken = await this.tokens.mint({ repository: repository.id, access: 'write', expiresAt: Date.now() + BROKER_GRANT_MS });
    return { httpsToken, env, mirrorScope: repository.id };
  }

  /** `<id>/<name>.git/<service>`: the smart HTTP protocol, nothing else.
   * `authorize` decides people's and agents' tokens (signed grants decide themselves). */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, rest: string,
    authorize: HostedGitDeps['authorize'] = this.deps.authorize): Promise<void> {
    try {
      const url = new URL(rest, 'http://localhost');
      const match = /^\/?(repo_[a-z0-9]+)\/[A-Za-z0-9._-]+?(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (!match) throw new HostedGitError(404, 'not found');
      const [, id, endpoint] = match as unknown as [string, string, string];
      const service = endpoint === 'info/refs' ? url.searchParams.get('service') : endpoint;
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HostedGitError(403, 'only the smart HTTP protocol is served');
      if ((endpoint === 'info/refs') !== (req.method === 'GET' || req.method === 'HEAD')) throw new HostedGitError(405, 'method not allowed');
      const access: HostedAccess = service === 'git-receive-pack' ? 'write' : 'read';
      const repository = await this.deps.store.getRepository(id);
      const token = credentialOf(req);
      if (!token) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="tavya", charset="UTF-8"', 'content-type': 'text/plain' });
        return void res.end('Sign in: use a tavya token as the password\n');
      }
      // Unknown and forbidden look alike, so a token cannot probe for repositories.
      if (!repository || !isHostedRepository(repository) || !await this.allowed(token, repository, access, authorize))
        throw new HostedGitError(404, 'repository not found');
      if (endpoint === 'git-receive-pack') return await this.receive(req, res, repository, url);
      const dir = await this.exclusive(repository.id, () => this.current(repository.id));
      await this.backend(req, res, repository.id, dir, url, endpoint, { stream: true });
    } catch (error) {
      if (res.headersSent) return void res.destroy(error instanceof Error ? error : undefined);
      const status = error instanceof HostedGitError ? error.status : 500;
      if (status === 500) console.error('[hosted-git]', error instanceof Error ? error.message : error);
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(`${error instanceof HostedGitError ? error.message : 'the repository is unavailable; try again'}\n`);
    }
  }

  private async allowed(token: string, repository: Repository, access: HostedAccess, authorize: HostedGitDeps['authorize']): Promise<boolean> {
    const grant = await this.tokens.verify(token);
    if (grant) return grant.repository === repository.id && (grant.access === 'write' || access === 'read');
    if (token.startsWith(GRANT_PREFIX)) return false;
    return (await authorize?.(token, repository, access)) ?? false;
  }

  /** A push: received into the cache, stored, then answered. */
  private async receive(req: http.IncomingMessage, res: http.ServerResponse, repository: Repository, url: URL): Promise<void> {
    await this.exclusive(repository.id, async () => {
      const before = await this.state(repository.id);
      const dir = await this.current(repository.id, before);
      const answer = await this.backend(req, res, repository.id, dir, url, 'git-receive-pack', { stream: false });
      try {
        const changed = await this.persist(repository, dir, before);
        if (changed.length) this.deps.onPushed?.(repository, changed);
      } catch (error) {
        await this.reset(dir, before).catch(() => this.drop(repository.id));
        throw error;
      }
      res.writeHead(answer!.status, answer!.headers);
      res.end(answer!.body);
    });
  }

  /** Store what a push added and move the row to the cache's refs. */
  private async persist(repository: Repository, dir: string, before: HostedRepositoryState): Promise<string[]> {
    const refs = await readRefs(dir);
    const head = (await git(dir, ['symbolic-ref', 'HEAD'])).stdout.trim() || before.head;
    const changed = [...new Set([...Object.keys(refs), ...Object.keys(before.refs)])].filter((ref) => refs[ref] !== before.refs[ref]);
    if (!changed.length && head === before.head) return [];
    const old = [...new Set(Object.values(before.refs))];
    const pack = await this.bundle(dir, repository, before, old);
    const compact = pack && before.packs.length + 1 > MAX_PACKS;
    const packs = compact ? [await this.bundle(dir, repository, before, [])].filter((each): each is HostedPack => !!each)
      : [...before.packs, ...(pack ? [pack] : [])];
    const bytes = packs.reduce((total, each) => total + each.bytes, 0);
    const stored = await this.deps.store.updateHostedRepository(repository.id, before.version, { head, refs, packs, bytes });
    const added = [...(pack ? [pack] : []), ...(compact ? packs : [])];
    if (!stored) {
      await this.deletePacks(before, added);
      throw new HostedGitError(409, 'the repository changed while this push ran; push again');
    }
    if (compact) await this.deletePacks(before, [...before.packs, ...(pack ? [pack] : [])]);
    writeMarker(dir, { version: before.version + 1, packs: packs.map((each) => each.id) });
    return changed;
  }

  /** The objects reachable from the cache's refs but not from `exclude`, as a stored pack; none when there are none. */
  private async bundle(dir: string, repository: Repository, state: HostedRepositoryState, exclude: string[]): Promise<HostedPack | undefined> {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-hosted-'));
    try {
      const file = path.join(scratch, 'pack.bundle');
      const made = await git(dir, ['bundle', 'create', file, '--all', ...(exclude.length ? ['--not', ...exclude] : [])], { timeoutMs: 30 * 60_000 });
      if (made.code !== 0) {
        if (/empty bundle|refusing to create/i.test(made.stderr)) return undefined;
        throw new Error(`git bundle failed: ${made.stderr.trim().slice(0, 300)}`);
      }
      const size = fs.statSync(file).size;
      if (await this.deps.storageAvailable?.(repository.organizationId, size) === false)
        throw new HostedGitError(507, 'storage is full: add storage in Plan & billing, then push again');
      const id = `p${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
      const key = await organizationKey(this.deps.broker, repository.organizationId);
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(file, 'r');
      let parts = 0;
      try {
        const buffer = Buffer.alloc(PART_BYTES);
        for (let offset = 0; offset < size || parts === 0; parts++) {
          const read = fs.readSync(fd, buffer, 0, PART_BYTES, offset);
          const plain = buffer.subarray(0, read);
          hash.update(plain);
          const objectKey = packPartKey(state, id, parts);
          await this.deps.objects.put(objectKey, seal(key, objectKey, Buffer.from(plain)), 'application/octet-stream');
          offset += read;
          if (!read) { parts++; break; }
        }
      } finally { fs.closeSync(fd); }
      return { id, bytes: size, parts, sha256: hash.digest('hex') };
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  private async deletePacks(state: Pick<HostedRepositoryState, 'organizationId' | 'repositoryId'>, packs: HostedPack[]): Promise<void> {
    for (const pack of packs)
      for (let part = 0; part < pack.parts; part++)
        await this.deps.objects.delete(packPartKey(state, pack.id, part)).catch(() => undefined);
  }

  private async state(id: string): Promise<HostedRepositoryState> {
    const state = await this.deps.store.getHostedRepository(id);
    if (!state) throw new HostedGitError(404, 'repository not found');
    return state;
  }

  /** The cache, brought to the row: missing packs fetched, refs set exactly. */
  private async current(id: string, known?: HostedRepositoryState): Promise<string> {
    const state = known ?? await this.state(id);
    const dir = path.join(this.deps.cacheDir, `${id}.git`);
    let marker = readMarker(dir);
    if (marker?.version === state.version) return dir;
    const ids = state.packs.map((pack) => pack.id);
    if (!marker || marker.packs.some((pack, index) => ids[index] !== pack)) {
      fs.rmSync(dir, { recursive: true, force: true });
      marker = undefined;
    }
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
      fs.mkdirSync(dir, { recursive: true });
      for (const args of [['init', '--bare', '--quiet', '--template=', dir], ['-C', dir, 'config', 'http.receivepack', 'true'],
        ['-C', dir, 'config', 'receive.fsckObjects', 'true'], ['-C', dir, 'config', 'gc.auto', '0'],
        ['-C', dir, 'config', 'uploadpack.allowFilter', 'true'], ['-C', dir, 'config', 'receive.denyDeleteCurrent', 'refuse']]) {
        const result = await git(this.deps.cacheDir, args);
        if (result.code !== 0) throw new Error(`git ${args[0] === '-C' ? args[2] : args[0]} failed: ${result.stderr.trim()}`);
      }
    }
    for (const pack of state.packs.slice(marker?.packs.length ?? 0)) await this.apply(dir, state, pack);
    await this.reset(dir, state);
    writeMarker(dir, { version: state.version, packs: ids });
    return dir;
  }

  private async apply(dir: string, state: HostedRepositoryState, pack: HostedPack): Promise<void> {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-hosted-'));
    try {
      const file = path.join(scratch, 'pack.bundle');
      const key = await organizationKey(this.deps.broker, state.organizationId, false);
      const hash = crypto.createHash('sha256');
      for (let part = 0; part < pack.parts; part++) {
        const objectKey = packPartKey(state, pack.id, part);
        const plain = open(key, objectKey, await this.deps.objects.get(objectKey));
        hash.update(plain);
        fs.appendFileSync(file, plain);
      }
      if (hash.digest('hex') !== pack.sha256) throw new Error(`pack ${pack.id} of ${state.repositoryId} does not match its checksum`);
      const result = await git(dir, ['bundle', 'unbundle', file], { timeoutMs: 30 * 60_000 });
      if (result.code !== 0) throw new Error(`pack ${pack.id} of ${state.repositoryId} did not unpack: ${result.stderr.trim().slice(0, 300)}`);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  /** Make the cache's refs and HEAD exactly the row's. */
  private async reset(dir: string, state: Pick<HostedRepositoryState, 'refs' | 'head'>): Promise<void> {
    const existing = await readRefs(dir);
    const commands = [
      ...Object.keys(existing).filter((ref) => !(ref in state.refs)).map((ref) => `delete ${ref}`),
      ...Object.entries(state.refs).filter(([ref, sha]) => existing[ref] !== sha).map(([ref, sha]) => `update ${ref} ${sha}`),
    ];
    if (commands.length) {
      const updated = await runGit(dir, ['update-ref', '--stdin'], `${commands.join('\n')}\n`);
      if (updated.code !== 0) throw new Error(`git update-ref failed: ${updated.stderr.trim().slice(0, 300)}`);
    }
    await git(dir, ['symbolic-ref', 'HEAD', state.head]);
  }

  private drop(id: string): void { fs.rmSync(path.join(this.deps.cacheDir, `${id}.git`), { recursive: true, force: true }); }

  /** Run `git http-backend` (CGI) for one request. Streams its answer, or
   * returns it whole when `stream` is false (a push, answered once stored). */
  private async backend(req: http.IncomingMessage, res: http.ServerResponse, id: string, dir: string, url: URL,
    endpoint: string, options: { stream: boolean }): Promise<{ status: number; headers: Record<string, string>; body: Buffer } | undefined> {
    const env: Record<string, string> = {
      ...hostGitEnvironment(),
      GIT_PROJECT_ROOT: path.dirname(dir), GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'tavya', REMOTE_ADDR: '127.0.0.1',
      REQUEST_METHOD: req.method ?? 'GET', PATH_INFO: `/${id}.git/${endpoint}`,
      QUERY_STRING: url.search.replace(/^\?/, ''), CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
      ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
    };
    appendGitConfig(env, 'core.hooksPath', '/dev/null');
    appendGitConfig(env, 'protocol.ext.allow', 'never');
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    req.pipe(child.stdin);
    req.on('aborted', () => child.kill('SIGKILL'));
    child.stdin.on('error', () => undefined);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
    let header = Buffer.alloc(0);
    let parsed: { status: number; headers: Record<string, string> } | undefined;
    const body: Buffer[] = [];
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      if (parsed) { if (options.stream) res.write(chunk); else body.push(chunk); continue; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n') >= 0 ? header.indexOf('\r\n\r\n') + 4 : header.indexOf('\n\n') >= 0 ? header.indexOf('\n\n') + 2 : -1;
      if (end < 0) continue;
      parsed = cgiHeaders(header.subarray(0, end).toString('latin1'));
      const restOf = header.subarray(end);
      if (options.stream) { res.writeHead(parsed.status, parsed.headers); if (restOf.length) res.write(restOf); }
      else if (restOf.length) body.push(restOf);
    }
    const code = await exited;
    if (!parsed) throw new Error(`git http-backend gave no answer (exit ${code}): ${stderr.trim().slice(0, 300)}`);
    if (options.stream) { res.end(); return undefined; }
    if (code !== 0 || parsed.status >= 400) throw new HostedGitError(parsed.status >= 400 ? parsed.status : 500, stderr.trim() || 'the push failed');
    return { ...parsed, body: Buffer.concat(body) };
  }

  /** One operation at a time on a repository's cache, in this process. */
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const held = run.catch(() => undefined);
    this.locks.set(id, held);
    try { return await run; } finally { if (this.locks.get(id) === held) this.locks.delete(id); }
  }

  /** Every ref and the object ids of the repository's tips, for the Files tab and the CLI. */
  async refs(repository: Repository): Promise<Record<string, string>> {
    return (await this.state(repository.id)).refs;
  }

  /** A local bare repository at the row's state, for host-side reads (the Files tab). */
  async checkout(repository: Repository): Promise<string> {
    return this.exclusive(repository.id, () => this.current(repository.id));
  }

  /** Push every branch and tag to `url` (Move to GitHub), with `env` as its credential. */
  async exportTo(repository: Repository, url: string, env: Record<string, string>): Promise<void> {
    await this.exclusive(repository.id, async () => {
      const dir = await this.current(repository.id);
      const pushed = await git(dir, ['push', '--quiet', url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], { env, timeoutMs: 60 * 60_000 });
      if (pushed.code !== 0) throw new Error(`git push failed: ${(pushed.stderr || pushed.stdout).trim().slice(0, 400)}`);
    });
  }

  /** Delete the repository's data (its packs go with the object store's deferred deletion). */
  async remove(repository: Pick<Repository, 'id' | 'organizationId'>): Promise<void> {
    await this.exclusive(repository.id, async () => {
      const state = await this.deps.store.getHostedRepository(repository.id);
      if (state) await this.deletePacks(state, state.packs);
      await this.deps.store.deleteHostedRepository(repository.id);
      this.drop(repository.id);
    });
  }
}

/** A Basic password (git sends the token as one) or a Bearer token. */
function credentialOf(req: http.IncomingMessage): string | undefined {
  const header = String(req.headers.authorization ?? '');
  if (/^bearer /i.test(header)) return header.slice(7).trim() || undefined;
  if (!/^basic /i.test(header)) return undefined;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return (colon >= 0 ? decoded.slice(colon + 1) : decoded).trim() || undefined;
}

function cgiHeaders(text: string): { status: number; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
    if (name === 'status') status = Number.parseInt(value, 10) || 200;
    else headers[name] = value;
  }
  return { status, headers };
}

async function readRefs(dir: string): Promise<Record<string, string>> {
  const listed = await git(dir, ['for-each-ref', '--format=%(objectname) %(refname)']);
  if (listed.code !== 0) throw new Error(`git for-each-ref failed: ${listed.stderr.trim()}`);
  const refs: Record<string, string> = {};
  for (const line of listed.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(' ');
    if (sha && ref) refs[ref] = sha;
  }
  return refs;
}

function runGit(dir: string, args: string[], input: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...hostGitEnvironment(), GIT_TERMINAL_PROMPT: '0' };
    appendGitConfig(env, 'core.hooksPath', '/dev/null');
    const child = spawn('git', ['-C', dir, ...args], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.end(input);
  });
}

function readMarker(dir: string): CacheMarker | undefined {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'tavya-cache.json'), 'utf8')) as CacheMarker;
    return Number.isSafeInteger(marker.version) && Array.isArray(marker.packs) ? marker : undefined;
  } catch { return undefined; }
}

function writeMarker(dir: string, marker: CacheMarker): void {
  const file = path.join(dir, 'tavya-cache.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(marker));
  fs.renameSync(`${file}.tmp`, file);
}

let registered: HostedGit | undefined;
/** The process's server for repositories tavya hosts (runtime/execution-services.ts). */
export function registerHostedGit(hosted: HostedGit | undefined): void { registered = hosted; }
export function hostedGit(): HostedGit | undefined { return registered; }

/** The Git credential for one trusted operation on `repository`: tavya's own
 * grant for a repository it hosts, else the GitHub App's installation token. */
export async function repositoryBrokerCredentials(repository: Repository,
  githubApp: { brokerCredentials(repository: Repository): Promise<GitBrokerCredential> } | undefined): Promise<GitBrokerCredential> {
  if (isHostedRepository(repository)) {
    if (!registered) throw new Error('this installation does not serve tavya repositories');
    return registered.brokerCredentials(repository);
  }
  if (!githubApp) throw new Error('Connect GitHub in organization settings, then try again.');
  return githubApp.brokerCredentials(repository);
}

/** A short read grant a task world clones a tavya repository with while it is
 * set up (removed before its agent starts), and the public address `tavya:`
 * URLs mean there. */
export async function hostedCloneCredential(repository: Repository): Promise<{ token: string; base: string }> {
  if (!registered) throw new Error('this installation does not serve tavya repositories');
  const base = (process.env.KARMAX_PUBLIC_URL?.trim() || process.env.KARMAX_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('the tavya Git server address is not known (KARMAX_PUBLIC_URL)');
  return { token: await registered.tokens.mint({ repository: repository.id, access: 'read', expiresAt: Date.now() + 60 * 60_000 }),
    base: `${base}${HOSTED_GIT_ROUTE}` };
}
