import crypto from 'node:crypto';
import path from 'node:path';
import type { ExecOptions, ExecResult, World, WorldHandle, WorldHttpRequest, WorldHttpResponse, WorldLifecycleState,
  WorldProcess, WorldProcessSpec, WorldProvider, WorldPty, WorldPtySpec, WorldRepo, WorldSpec } from './types.js';
import { worldRelativePath } from './types.js';
import { boundedResponseBody } from './http.js';
import type { ResolvedWorldProviderConnection } from './connections.js';

const DEFAULT_IDLE_MS = 10 * 60_000;

/** Structural SDK boundary: production uses @daytona/sdk, tests use an in-memory
 * double. Provider SDK objects and sandbox IDs never cross this module. */
export interface DaytonaSandboxLike {
  id: string;
  state?: string;
  process: {
    executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeoutSeconds?: number): Promise<any>;
    createSession?(id: string): Promise<void>;
    executeSessionCommand?(id: string, request: { command: string; async?: boolean; runAsync?: boolean }): Promise<any>;
    getSessionCommand?(id: string, commandId: string): Promise<any>;
    getSessionCommandLogs?(id: string, commandId: string, onStdout?: (chunk: string) => void,
      onStderr?: (chunk: string) => void): Promise<any>;
    deleteSession?(id: string): Promise<void>;
    createPty(options: Record<string, unknown>): Promise<any>;
  };
  fs: {
    downloadFile(remotePath: string): Promise<Buffer>;
    uploadFile(value: Buffer, remotePath: string): Promise<void>;
  };
  getUserHomeDir(): Promise<string>;
  getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<{ url: string; token?: string }>;
  refreshData?(): Promise<void>;
  start(timeoutSeconds?: number): Promise<void>;
  stop(timeoutSeconds?: number, force?: boolean): Promise<void>;
  archive(): Promise<void>;
  delete(timeoutSeconds?: number): Promise<void>;
}

export interface DaytonaFactory {
  create(options: Record<string, unknown>): Promise<DaytonaSandboxLike>;
  get(id: string): Promise<DaytonaSandboxLike>;
}

/** Daytona is the portability/BYOC adapter. It implements exactly the same
 * World contract as E2B: opaque handles, SSH-only trusted provisioning,
 * provider-owned processes/PTys/previews, explicit archive, and cold resume. */
export class DaytonaWorldProvider implements WorldProvider {
  readonly kind = 'daytona';
  readonly parkable = true;
  readonly capabilities = { remote: true, pty: true, snapshots: true, ports: true, networkPolicy: true } as const;
  private sandboxes = new Map<string, DaytonaSandboxLike>();
  private states = new Map<string, WorldLifecycleState>();
  private refKey: Buffer;

  private factories = new Map<string, DaytonaFactory>();

  constructor(private factory?: DaytonaFactory,
    private idleMs = positiveInt(process.env.KARMAX_DAYTONA_IDLE_MS, DEFAULT_IDLE_MS),
    private snapshot = process.env.KARMAX_DAYTONA_SNAPSHOT,
    private image = process.env.KARMAX_DAYTONA_IMAGE,
    private resolveConnection?: (organizationId: string | undefined, provider: string) => ResolvedWorldProviderConnection) {
    this.refKey = crypto.createHash('sha256').update(
      process.env.KARMAX_WORLD_REF_KEY ?? process.env.DAYTONA_API_KEY ?? 'karmax-development-world-ref',
    ).digest();
  }

  async create(spec: WorldSpec): Promise<World> {
    const connection = this.connection(spec.organizationId);
    const factory = this.factoryFor(connection);
    const environment = spec.environment ?? {};
    const network = daytonaNetwork(spec);
    const sandbox = await factory.create({
      ...(environment.snapshot ?? connection?.config.snapshot ?? this.snapshot
        ? { snapshot: environment.snapshot ?? connection?.config.snapshot ?? this.snapshot } : {}),
      ...(environment.image ?? connection?.config.image ?? this.image
        ? { image: environment.image ?? connection?.config.image ?? this.image } : {}),
      labels: { karmaxTaskId: spec.taskId }, public: false,
      autoStopInterval: Math.max(1, Math.ceil(this.idleMs / 60_000)), autoArchiveInterval: 24 * 60,
      autoDeleteInterval: -1, ...network,
      ...(spec.resources ? { resources: { cpu: spec.resources.cpu,
        memory: spec.resources.memoryMb ? spec.resources.memoryMb / 1024 : undefined, gpu: spec.resources.gpu } } : {}),
    });
    this.sandboxes.set(sandbox.id, sandbox);
    this.states.set(sandbox.id, 'ready');
    try {
      const home = await sandbox.getUserHomeDir();
      const root = path.posix.join(home, 'karmax');
      await provisionCredentials(sandbox, spec, home);
      const provisioned = await provisionRepos(sandbox, spec, root, home);
      await commandOrThrow(sandbox, `rm -f ${quote(path.posix.join(home, '.ssh'))}/karmax-auth-*`);
      const handle: WorldHandle = {
        version: 2, kind: this.kind, provider: this.kind, id: spec.taskId, root, workspaceRoot: root,
        branch: spec.branch ?? `karmax/${spec.taskId}`, base: provisioned.repos[0]?.base ?? spec.base,
        target: provisioned.repos[0]?.target ?? spec.target,
        repo: provisioned.repos[0]?.repo, repos: provisioned.repos,
        sealedProviderRef: this.seal({ sandboxId: sandbox.id, ...(spec.organizationId ? { organizationId: spec.organizationId } : {}) }),
        meta: { releaseOnCompletion: true },
        ...(provisioned.warnings.length ? { warnings: provisioned.warnings } : {}),
      };
      return new DaytonaWorld(handle, sandbox);
    } catch (error) {
      await sandbox.delete(60).catch(() => undefined);
      this.states.set(sandbox.id, 'missing');
      this.sandboxes.delete(sandbox.id);
      throw error;
    }
  }

  async open(handle: WorldHandle): Promise<World> {
    const reference = this.reference(handle);
    const id = reference.sandboxId;
    const sandbox = this.sandboxes.get(id) ?? await this.factoryFor(this.connection(reference.organizationId)).get(id);
    await sandbox.refreshData?.();
    if (!['started', 'starting'].includes(String(sandbox.state ?? '').toLowerCase())) await sandbox.start(90);
    this.sandboxes.set(id, sandbox);
    this.states.set(id, 'ready');
    return new DaytonaWorld(handle, sandbox);
  }

  async park(handle: WorldHandle): Promise<WorldHandle> {
    const reference = this.reference(handle);
    const id = reference.sandboxId;
    if (this.states.get(id) === 'parked') return handle;
    const sandbox = this.sandboxes.get(id) ?? await this.factoryFor(this.connection(reference.organizationId)).get(id);
    await sandbox.archive();
    this.sandboxes.set(id, sandbox);
    this.states.set(id, 'parked');
    return handle;
  }

  async status(handle: WorldHandle): Promise<WorldLifecycleState> {
    return this.states.get(this.sandboxId(handle)) ?? 'ready';
  }

  private reference(handle: WorldHandle): { sandboxId: string; organizationId?: string } {
    if (handle.sealedProviderRef) {
      const blob = Buffer.from(handle.sealedProviderRef, 'base64url');
      if (blob.subarray(0, 4).toString() !== 'KWR1') throw new Error('invalid sealed provider reference');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.refKey, blob.subarray(4, 16));
      decipher.setAuthTag(blob.subarray(16, 32));
      const value = JSON.parse(Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]).toString('utf8'));
      if (typeof value.sandboxId === 'string') return { sandboxId: value.sandboxId,
        organizationId: typeof value.organizationId === 'string' ? value.organizationId : undefined };
    }
    const legacy = handle.meta?.sandboxId;
    if (typeof legacy === 'string') return { sandboxId: legacy,
      organizationId: typeof handle.meta?.organizationId === 'string' ? handle.meta.organizationId : undefined };
    throw new Error('invalid Daytona world handle');
  }

  private sandboxId(handle: WorldHandle): string { return this.reference(handle).sandboxId; }

  private connection(organizationId: string | undefined): ResolvedWorldProviderConnection | undefined {
    if (this.resolveConnection) return this.resolveConnection(organizationId, this.kind);
    return process.env.DAYTONA_API_KEY ? { organizationId, provider: this.kind, apiKey: process.env.DAYTONA_API_KEY,
      config: { snapshot: this.snapshot, image: this.image, apiUrl: process.env.DAYTONA_API_URL,
        target: process.env.DAYTONA_TARGET } } : undefined;
  }

  private factoryFor(connection: ResolvedWorldProviderConnection | undefined): DaytonaFactory {
    if (this.factory) return this.factory;
    const key = `${connection?.organizationId ?? 'environment'}:${connection?.apiKey.slice(-8) ?? ''}`;
    let factory = this.factories.get(key);
    if (!factory) {
      factory = defaultDaytonaFactory(connection);
      this.factories.set(key, factory);
    }
    return factory;
  }

  private seal(value: Record<string, string>): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.refKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([Buffer.from('KWR1'), iv, cipher.getAuthTag(), body]).toString('base64url');
  }
}

class DaytonaWorld implements World {
  constructor(public handle: WorldHandle, private sandbox: DaytonaSandboxLike) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    try {
      const result = await this.sandbox.process.executeCommand([cmd, ...args].map(quote).join(' '),
        this.cwd(opts.cwd), remoteEnv(opts.env), Math.max(1, Math.ceil((opts.timeoutMs ?? 120_000) / 1000)));
      return { stdout: String(result?.result ?? result?.stdout ?? result?.artifacts?.stdout ?? ''),
        stderr: String(result?.stderr ?? ''), code: Number(result?.exitCode ?? 0) };
    } catch (error: any) {
      return { stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? error?.message ?? error),
        code: Number(error?.exitCode ?? 1) };
    }
  }

  async readFile(relPath: string): Promise<string> { return (await this.readFileBuffer(relPath)).toString('utf8'); }
  async readFileBuffer(relPath: string): Promise<Buffer> { return this.sandbox.fs.downloadFile(this.file(relPath)); }
  async writeFile(relPath: string, content: string): Promise<void> { await this.writeFileBuffer(relPath, Buffer.from(content)); }
  async writeFileBuffer(relPath: string, content: Buffer): Promise<void> {
    const target = this.file(relPath);
    const made = await this.exec('mkdir', ['-p', path.posix.dirname(target)]);
    if (made.code !== 0) throw new Error(made.stderr || 'could not create remote directory');
    await this.sandbox.fs.uploadFile(content, target);
  }
  async listFiles(): Promise<string[]> {
    const result = await this.exec('bash', ['-lc', "find . -type f -not -path '*/.git/*' -print | sed 's#^./##'"]);
    if (result.code !== 0) throw new Error(result.stderr || 'failed to list remote files');
    return result.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
  }

  async startProcess(spec: WorldProcessSpec): Promise<WorldProcess> {
    const processApi = this.sandbox.process;
    if (!processApi.createSession || !processApi.executeSessionCommand || !processApi.getSessionCommand
      || !processApi.getSessionCommandLogs || !processApi.deleteSession)
      throw new Error('Daytona SDK does not expose background process sessions');
    const sessionId = `karmax-${crypto.randomBytes(8).toString('hex')}`;
    await processApi.createSession(sessionId);
    const wrapped = `cd ${quote(this.cwd(spec.cwd))} && ${envPrefix(remoteEnv(spec.env))}bash -lc ${quote(spec.command)}`;
    const started = await processApi.executeSessionCommand(sessionId, { command: wrapped, async: true, runAsync: true });
    const commandId = String(started.cmdId);
    const output = new Set<(value: string) => void>();
    const exits = new Set<(code: number | null) => void>();
    const pending: string[] = [];
    let attached = false;
    const emit = (chunk: string) => { if (!attached) pending.push(chunk); for (const listener of output) listener(chunk); };
    void processApi.getSessionCommandLogs(sessionId, commandId, emit, emit).catch((error) => emit(String(error?.message ?? error)));
    let stopped = false;
    let exitCode: number | null = null;
    void (async () => {
      while (!stopped) {
        const status = await processApi.getSessionCommand!(sessionId, commandId);
        if (status.exitCode != null) { exitCode = Number(status.exitCode); break; }
        await delay(250);
      }
      for (const listener of exits) listener(exitCode);
    })().catch(() => { exitCode = -1; for (const listener of exits) listener(exitCode); });
    return {
      onOutput(listener) { output.add(listener); if (!attached) { attached = true; for (const chunk of pending.splice(0)) listener(chunk); } return () => output.delete(listener); },
      onExit(listener) { if (exitCode != null) queueMicrotask(() => listener(exitCode)); else exits.add(listener); return () => exits.delete(listener); },
      async kill() { stopped = true; await processApi.deleteSession!(sessionId); if (exitCode == null) { exitCode = -1; for (const listener of exits) listener(exitCode); } },
    };
  }

  async openPty(spec: WorldPtySpec = {}): Promise<WorldPty> {
    const output = new Set<(value: string) => void>();
    const exits = new Set<(code: number | null) => void>();
    const terminal = await this.sandbox.process.createPty({ id: `karmax-${crypto.randomBytes(8).toString('hex')}`,
      cwd: this.cwd(spec.cwd), envs: remoteEnv(spec.env), cols: spec.cols ?? 80, rows: spec.rows ?? 24,
      onData: (data: Uint8Array) => { const chunk = new TextDecoder().decode(data); for (const listener of output) listener(chunk); } });
    await terminal.waitForConnection?.();
    void Promise.resolve(terminal.wait?.()).then((result) => {
      for (const listener of exits) listener(Number(result?.exitCode ?? 0));
    }).catch(() => { for (const listener of exits) listener(-1); });
    return {
      onData(listener) { output.add(listener); return () => output.delete(listener); },
      onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
      async write(data) { await terminal.sendInput(data); },
      async resize(cols, rows) { await terminal.resize(cols, rows); },
      async close() { if (terminal.kill) await terminal.kill(); else await terminal.disconnect?.(); },
    };
  }

  async fetchPort(port: number, requestPath: string, request: WorldHttpRequest = { method: 'GET' }): Promise<WorldHttpResponse> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid preview port');
    const signed = await this.sandbox.getSignedPreviewUrl(port, 60);
    const base = new URL(signed.url);
    applyPreviewPath(base, requestPath);
    const method = request.method.toUpperCase();
    const response = await fetch(base, { method, headers: request.headers,
      ...(!['GET', 'HEAD'].includes(method) && request.body?.length ? { body: request.body } : {}), redirect: 'manual' });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return { status: response.status, headers, body: await boundedResponseBody(response) };
  }

  async previewSocketTarget(port: number, requestPath: string) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid preview port');
    const signed = await this.sandbox.getSignedPreviewUrl(port, 60);
    const target = new URL(signed.url);
    target.protocol = target.protocol === 'http:' ? 'ws:' : 'wss:';
    applyPreviewPath(target, requestPath);
    return { url: target.toString() };
  }

  async destroy(): Promise<void> { await this.sandbox.delete(60); }

  private file(relative: string): string {
    const safe = worldRelativePath(relative);
    if (safe === '.') throw new Error('path is a directory');
    return path.posix.join(this.handle.root, safe);
  }
  private cwd(value?: string): string {
    if (!value) return this.handle.root;
    if (value === this.handle.root || value.startsWith(`${this.handle.root}/`)) return value;
    const safe = worldRelativePath(value);
    return safe === '.' ? this.handle.root : path.posix.join(this.handle.root, safe);
  }
}

/** Apply a browser path without losing query parameters embedded in Daytona's
 * signed provider URL. Assigning `URL.pathname` directly would percent-encode
 * the request's `?`, breaking applications that rely on query strings. */
function applyPreviewPath(target: URL, requestPath: string): void {
  const requested = new URL(requestPath.startsWith('/') ? requestPath : `/${requestPath}`, 'http://preview.invalid');
  target.pathname = requested.pathname;
  requested.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  target.hash = requested.hash;
}

async function provisionCredentials(sandbox: DaytonaSandboxLike, spec: WorldSpec, home: string): Promise<void> {
  const values = [spec.gitCredentials?.sshKey, ...Object.values(spec.gitCredentials?.repositories ?? {})]
    .filter((value): value is string => Boolean(value));
  if (!values.length) return;
  const ssh = path.posix.join(home, '.ssh');
  await commandOrThrow(sandbox, `mkdir -p ${quote(ssh)} && chmod 700 ${quote(ssh)} && ssh-keyscan github.com >> ${quote(path.posix.join(ssh, 'known_hosts'))} 2>/dev/null || true`);
  for (const [index, key] of [...new Set(values)].entries()) {
    const file = keyFile(home, index);
    await sandbox.fs.uploadFile(Buffer.from(key.endsWith('\n') ? key : `${key}\n`), file);
    await commandOrThrow(sandbox, `chmod 600 ${quote(file)}`);
  }
}

async function provisionRepos(sandbox: DaytonaSandboxLike, spec: WorldSpec, root: string, home: string): Promise<{ repos: WorldRepo[]; warnings: string[] }> {
  const sources = (spec.repos?.length ? spec.repos : spec.repo ? [spec.repo] : []).map((value) => value.trim()).filter(Boolean);
  if (sources.some((source) => !/^(?:ssh:\/\/|git@)[^\s]+/.test(source)))
    throw new Error('Daytona worlds require repositories as SSH Git URLs, not local paths or HTTPS URLs');
  const branch = spec.branch ?? `karmax/${spec.taskId}`;
  const warnings: string[] = [];
  if (!sources.length) {
    await commandOrThrow(sandbox, `mkdir -p ${quote(root)} && git -C ${quote(root)} init -q -b ${quote(spec.base || 'main')}`);
    await configureRepo(sandbox, root, spec, branch, false);
    return { repos: [], warnings };
  }
  const multi = sources.length > 1;
  const names = uniqueNames(sources.map(remoteName));
  if (multi) await commandOrThrow(sandbox, `mkdir -p ${quote(root)}`);
  const credentialValues = [spec.gitCredentials?.sshKey, ...Object.values(spec.gitCredentials?.repositories ?? {})]
    .filter((value): value is string => Boolean(value));
  const repos: WorldRepo[] = [];
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]!;
    const branchPolicy = spec.repositoryBranches?.[source];
    const base = branchPolicy?.base ?? spec.base;
    const target = branchPolicy?.target ?? spec.target;
    const repoRoot = multi ? path.posix.join(root, names[index]!) : root;
    const key = spec.gitCredentials?.repositories?.[source] ?? spec.gitCredentials?.sshKey;
    const keyIndex = key ? [...new Set(credentialValues)].indexOf(key) : -1;
    const auth = keyIndex >= 0 ? `GIT_SSH_COMMAND=${quote(`ssh -i ${keyFile(home, keyIndex)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`)} ` : '';
    await commandOrThrow(sandbox, `${auth}git clone -q --origin origin ${quote(source)} ${quote(repoRoot)}`);
    const requested = spec.branch ?? base;
    const ref = `refs/remotes/origin/${requested}`;
    const exists = Number((await sandbox.process.executeCommand(`git -C ${quote(repoRoot)} show-ref --verify --quiet ${quote(ref)}`, undefined, undefined, 120))?.exitCode ?? 0) === 0;
    if (spec.branch && !exists) throw new Error(`repository "${source}" has no remote branch "${spec.branch}" to review`);
    if (!spec.branch && !exists) warnings.push(`repo "${names[index]}": base branch "${base}" not found — forked off the remote default branch instead`);
    const resolved = await commandOrThrow(sandbox, `git -C ${quote(repoRoot)} rev-parse ${quote(exists ? ref : 'refs/remotes/origin/HEAD')}`);
    const baseSha = String(resolved.result ?? resolved.stdout ?? '').trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseSha)) throw new Error(`repository "${source}" has no resolvable base commit`);
    await configureRepo(sandbox, repoRoot, spec, branch, true, exists, base);
    repos.push({ name: names[index]!, repo: source, root: repoRoot, branch, base, target, baseSha });
  }
  if (spec.copyGlobs?.length) warnings.push('copyGlobs are host-local and were not copied into the remote Daytona world');
  return { repos, warnings };
}

async function configureRepo(sandbox: DaytonaSandboxLike, root: string, spec: WorldSpec, branch: string, hasOrigin: boolean,
  requestedExists = false, base = spec.base): Promise<void> {
  const identity = spec.gitIdentity;
  await commandOrThrow(sandbox, `git -C ${quote(root)} config user.name ${quote(identity?.name ?? 'karmax')} && git -C ${quote(root)} config user.email ${quote(identity?.email ?? 'karmax@localhost')}`);
  if (!hasOrigin) return;
  const checkout = spec.branch
    ? `git -C ${quote(root)} checkout -q -B ${quote(spec.branch)} ${quote(`origin/${spec.branch}`)}`
    : requestedExists
      ? `git -C ${quote(root)} checkout -q -B ${quote(base)} ${quote(`origin/${base}`)} && git -C ${quote(root)} checkout -q -b ${quote(branch)}`
      : `git -C ${quote(root)} checkout -q -b ${quote(branch)}`;
  await commandOrThrow(sandbox, checkout);
}

async function commandOrThrow(sandbox: DaytonaSandboxLike, command: string): Promise<any> {
  const result = await sandbox.process.executeCommand(command, undefined, undefined, 600);
  const code = Number(result?.exitCode ?? 0);
  if (code !== 0) throw new Error(String(result?.stderr ?? result?.result ?? `remote command failed (${code})`));
  return result;
}

function daytonaNetwork(spec: WorldSpec): Record<string, unknown> {
  if (spec.network?.unrestricted) return { networkBlockAll: false };
  const domains = [...new Set(['github.com', 'api.github.com', 'ssh.github.com', ...(spec.network?.allowDomains ?? [])])];
  return { networkBlockAll: true, domainAllowList: domains.join(','),
    ...(spec.network?.allowCidrs?.length ? { networkAllowList: spec.network.allowCidrs.join(',') } : {}) };
}

function defaultDaytonaFactory(connection?: ResolvedWorldProviderConnection): DaytonaFactory {
  let client: any;
  const sdk = async () => {
    if (!client) {
      try {
        const { Daytona } = await import('@daytona/sdk');
        client = new Daytona(connection ? { apiKey: connection.apiKey, apiUrl: connection.config.apiUrl,
          target: connection.config.target } : undefined);
      } catch (error) { throw new Error(`Daytona world requested but the SDK could not start: ${String(error)}`); }
    }
    return client;
  };
  return { async create(options) { return (await sdk()).create(options, { timeout: 120 }); },
    async get(id) { return (await sdk()).get(id); } };
}

function keyFile(home: string, index: number): string { return path.posix.join(home, `.ssh/karmax-auth-${index}`); }
function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function remoteName(remote: string): string {
  const value = remote.replace(/\/$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') || 'repo';
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-');
  return !safe || /^\.+$/.test(safe) ? 'repo' : safe;
}
function uniqueNames(values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value) => { const count = seen.get(value) ?? 0; seen.set(value, count + 1); return count ? `${value}-${count + 1}` : value; });
}
function remoteEnv(env?: Record<string, string>): Record<string, string> {
  const value = { ...(env ?? {}) };
  delete value.GIT_SSH_COMMAND; delete value.GIT_ASKPASS; delete value.GH_TOKEN;
  return value;
}
function envPrefix(env: Record<string, string>): string {
  const values = Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`);
  return values.length ? `env ${values.join(' ')} ` : '';
}
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
