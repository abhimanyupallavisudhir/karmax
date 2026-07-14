import path from 'node:path';
import crypto from 'node:crypto';
import type {
  ExecOptions,
  ExecResult,
  World,
  WorldHandle,
  WorldHttpResponse,
  WorldHttpRequest,
  WorldLifecycleState,
  WorldProcess,
  WorldProcessSpec,
  WorldProvider,
  WorldPty,
  WorldPtySpec,
  WorldRepo,
  WorldSpec,
} from './types.js';
import { worldRelativePath } from './types.js';
import { boundedResponseBody } from './http.js';
import type { ResolvedWorldProviderConnection } from './connections.js';

const ROOT = '/home/user/karmax';
const DEFAULT_IDLE_MS = 10 * 60_000;

/** Minimal SDK surface kept structural so the provider can be unit-tested with
 * no E2B account and upgraded independently from Temporal workflow contracts. */
export interface E2BSandboxLike {
  sandboxId: string;
  trafficAccessToken?: string;
  getHost?(port: number): string;
  commands: {
    run(command: string, options?: Record<string, unknown>): Promise<any>;
  };
  files: {
    read(path: string, options?: Record<string, unknown>): Promise<string | Uint8Array | ArrayBuffer>;
    write(path: string, data: string | Uint8Array): Promise<unknown>;
    list?(path: string, options?: Record<string, unknown>): Promise<Array<{ path?: string; name?: string; type?: string }>>;
  };
  pty: {
    create(options: Record<string, unknown>): Promise<any>;
    sendInput(pid: number, data: Uint8Array): Promise<unknown>;
    resize(pid: number, size: { cols: number; rows: number }): Promise<unknown>;
    kill(pid: number): Promise<unknown>;
  };
  pause(): Promise<unknown>;
  kill(): Promise<unknown>;
  getInfo?(): Promise<{ state?: string }>;
}

export interface E2BFactory {
  create(options: { template?: string; apiKey?: string; timeoutMs: number; lifecycle: { onTimeout: 'pause'; autoResume: true };
    metadata: Record<string, string>; allowInternetAccess?: boolean;
    network?: { allowOut: string[]; denyOut: string[]; allowPublicTraffic: false } }): Promise<E2BSandboxLike>;
  connect(id: string, options: { timeoutMs: number; apiKey?: string }): Promise<E2BSandboxLike>;
}

/** E2B cloud worlds: one isolated sandbox per task attempt, automatically paused
 * after inactivity and transparently resumed on the next provider operation. */
export class E2BWorldProvider implements WorldProvider {
  readonly kind = 'e2b' as const;
  readonly parkable = true;
  readonly capabilities = { remote: true, pty: true, snapshots: true, ports: true, networkPolicy: true } as const;
  private sandboxes = new Map<string, E2BSandboxLike>();
  private states = new Map<string, WorldLifecycleState>();
  private refKey: Buffer;

  constructor(
    private factory: E2BFactory = defaultE2BFactory(),
    private idleMs = envPositiveInt('KARMAX_E2B_IDLE_MS', DEFAULT_IDLE_MS),
    private template = process.env.KARMAX_E2B_TEMPLATE,
    private resolveConnection?: (organizationId: string | undefined, provider: string) => ResolvedWorldProviderConnection,
  ) {
    // Hosted deployments must set KARMAX_WORLD_REF_KEY. E2B_API_KEY is a stable
    // compatibility seed for self-hosted installs; the development constant is
    // intentionally usable only when neither cloud credential exists.
    this.refKey = crypto.createHash('sha256').update(
      process.env.KARMAX_WORLD_REF_KEY ?? process.env.E2B_API_KEY ?? 'karmax-development-world-ref',
    ).digest();
  }

  async create(spec: WorldSpec): Promise<World> {
    const connection = this.connection(spec.organizationId);
    const sandbox = await this.factory.create({
      ...(spec.environment?.snapshot ?? spec.environment?.image ?? connection?.config.template ?? this.template
        ? { template: spec.environment?.snapshot ?? spec.environment?.image ?? connection?.config.template ?? this.template }
        : {}),
      ...(connection?.apiKey ? { apiKey: connection.apiKey } : {}),
      timeoutMs: this.idleMs,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      metadata: { karmaxTaskId: spec.taskId },
      ...e2bNetwork(spec),
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    this.states.set(sandbox.sandboxId, 'ready');
    try {
      await provisionCredentials(sandbox, spec);
      const { repos, root, warnings } = await provisionRepos(sandbox, spec);
      // Clone credentials exist only during trusted provisioning. The agent's
      // execution environment gets a read/write checkout but no reusable secret;
      // pushes and merges go through the host-side Git broker.
      await runOrThrow(sandbox, 'rm -f /home/user/.ssh/karmax-auth*');
      const handle: WorldHandle = {
        version: 2,
        kind: 'e2b',
        provider: 'e2b',
        id: spec.taskId,
        root,
        workspaceRoot: root,
        branch: spec.branch ?? `karmax/${spec.taskId}`,
        base: repos[0]?.base ?? spec.base,
        target: repos[0]?.target ?? spec.target,
        repo: repos[0]?.repo,
        repos,
        sealedProviderRef: this.sealRef({ sandboxId: sandbox.sandboxId, ...(spec.organizationId ? { organizationId: spec.organizationId } : {}) }),
        meta: { releaseOnCompletion: true },
        ...(warnings.length ? { warnings } : {}),
      };
      return new E2BWorld(handle, sandbox);
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      this.sandboxes.delete(sandbox.sandboxId);
      this.states.set(sandbox.sandboxId, 'missing');
      throw error;
    }
  }

  async open(handle: WorldHandle): Promise<World> {
    const reference = this.refOf(handle);
    const sandboxId = reference.sandboxId;
    let sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox || this.states.get(sandboxId) === 'parked') {
      const connection = this.connection(reference.organizationId);
      sandbox = await this.factory.connect(sandboxId, { timeoutMs: this.idleMs,
        ...(connection?.apiKey ? { apiKey: connection.apiKey } : {}) });
      this.sandboxes.set(sandboxId, sandbox);
    }
    this.states.set(sandboxId, 'ready');
    return new E2BWorld(handle, sandbox);
  }

  async park(handle: WorldHandle): Promise<WorldHandle> {
    const reference = this.refOf(handle);
    const sandboxId = reference.sandboxId;
    if (this.states.get(sandboxId) === 'parked') return handle;
    const connection = this.connection(reference.organizationId);
    const sandbox = this.sandboxes.get(sandboxId) ?? await this.factory.connect(sandboxId, { timeoutMs: this.idleMs,
      ...(connection?.apiKey ? { apiKey: connection.apiKey } : {}) });
    await sandbox.pause();
    this.sandboxes.set(sandboxId, sandbox);
    this.states.set(sandboxId, 'parked');
    return handle;
  }

  async status(handle: WorldHandle): Promise<WorldLifecycleState> {
    const id = this.sandboxIdOf(handle);
    if (this.states.has(id)) return this.states.get(id)!;
    return 'ready'; // after a process restart the durable provider is authoritative on connect
  }

  private sealRef(value: Record<string, string>): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.refKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from('KWR1'), iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  private openRef(value: string): Record<string, string> {
    const blob = Buffer.from(value, 'base64url');
    if (blob.subarray(0, 4).toString() !== 'KWR1') throw new Error('invalid sealed provider reference');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.refKey, blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(16, 32));
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]).toString('utf8'));
  }

  private refOf(handle: WorldHandle): { sandboxId: string; organizationId?: string } {
    if (handle.sealedProviderRef) {
      const value = this.openRef(handle.sealedProviderRef);
      if (value.sandboxId) return { sandboxId: value.sandboxId, organizationId: value.organizationId };
    }
    // V1 replay compatibility only. Newly created handles never take this path.
    const legacy = handle.meta?.sandboxId;
    if (typeof legacy === 'string' && legacy) return { sandboxId: legacy,
      organizationId: typeof handle.meta?.organizationId === 'string' ? handle.meta.organizationId : undefined };
    throw new Error('invalid E2B world handle');
  }

  private sandboxIdOf(handle: WorldHandle): string { return this.refOf(handle).sandboxId; }

  private connection(organizationId: string | undefined): ResolvedWorldProviderConnection | undefined {
    if (this.resolveConnection) return this.resolveConnection(organizationId, this.kind);
    return process.env.E2B_API_KEY ? { organizationId, provider: this.kind, apiKey: process.env.E2B_API_KEY,
      config: { template: this.template } } : undefined;
  }
}

class E2BWorld implements World {
  constructor(public handle: WorldHandle, private sandbox: E2BSandboxLike) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    try {
      const result = await this.sandbox.commands.run([cmd, ...args].map(shellQuote).join(' '), {
        cwd: this.cwd(opts.cwd),
        envs: this.remoteEnv(opts.env),
        timeoutMs: opts.timeoutMs ?? 120_000,
      });
      return {
        stdout: String(result?.stdout ?? ''),
        stderr: String(result?.stderr ?? ''),
        code: Number(result?.exitCode ?? result?.code ?? 0),
      };
    } catch (error: any) {
      return {
        stdout: String(error?.stdout ?? ''),
        stderr: String(error?.stderr ?? error?.message ?? error),
        code: Number(error?.exitCode ?? error?.code ?? 1),
      };
    }
  }

  async readFile(relPath: string): Promise<string> {
    const value = await this.sandbox.files.read(this.filePath(relPath), { format: 'text' });
    return typeof value === 'string' ? value : Buffer.from(toBytes(value)).toString('utf8');
  }

  async readFileBuffer(relPath: string): Promise<Buffer> {
    const value = await this.sandbox.files.read(this.filePath(relPath), { format: 'bytes' });
    return typeof value === 'string' ? Buffer.from(value) : Buffer.from(toBytes(value));
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    await this.sandbox.files.write(this.filePath(relPath), content);
  }

  async writeFileBuffer(relPath: string, content: Buffer): Promise<void> {
    await this.sandbox.files.write(this.filePath(relPath), content);
  }

  async listFiles(): Promise<string[]> {
    const listed = await this.exec('bash', ['-lc', "find . -type f -not -path '*/.git/*' -print | sed 's#^./##'"], { timeoutMs: 120_000 });
    if (listed.code !== 0) throw new Error(listed.stderr || 'failed to list remote world files');
    return listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  async startProcess(spec: WorldProcessSpec): Promise<WorldProcess> {
    const outputs = new Set<(chunk: string) => void>();
    const exits = new Set<(code: number | null) => void>();
    const pending: string[] = [];
    let attached = false;
    const emit = (data: unknown) => {
      const chunk = sdkText(data);
      if (!attached) pending.push(chunk);
      for (const listener of outputs) listener(chunk);
    };
    const command = await this.sandbox.commands.run(spec.command, {
      background: true,
      cwd: this.cwd(spec.cwd),
      envs: this.remoteEnv(spec.env),
      onStdout: emit,
      onStderr: emit,
    });
    let exited = false;
    let exitCode: number | null = null;
    void Promise.resolve(command?.wait?.()).then((result) => {
      exited = true;
      exitCode = Number(result?.exitCode ?? result?.code ?? 0);
      for (const listener of exits) listener(exitCode);
    }).catch((error) => {
      emit(error?.message ?? error);
      exited = true;
      exitCode = -1;
      for (const listener of exits) listener(exitCode);
    });
    return {
      onOutput(listener) {
        outputs.add(listener);
        if (!attached) {
          attached = true;
          for (const chunk of pending.splice(0)) listener(chunk);
        }
        return () => outputs.delete(listener);
      },
      onExit(listener) {
        if (exited) queueMicrotask(() => listener(exitCode));
        else exits.add(listener);
        return () => exits.delete(listener);
      },
      async kill() { await command?.kill?.(); },
    };
  }

  async openPty(spec: WorldPtySpec = {}): Promise<WorldPty> {
    const sandbox = this.sandbox;
    const outputs = new Set<(chunk: string) => void>();
    const exits = new Set<(code: number | null) => void>();
    const terminal = await this.sandbox.pty.create({
      cols: spec.cols ?? 80,
      rows: spec.rows ?? 24,
      cwd: this.cwd(spec.cwd),
      envs: this.remoteEnv(spec.env),
      timeoutMs: 0,
      onData: (data: unknown) => {
        const chunk = sdkText(data);
        for (const listener of outputs) listener(chunk);
      },
    });
    const remotePid = Number(terminal.pid);
    void Promise.resolve(terminal.wait?.()).then((result) => {
      const code = Number(result?.exitCode ?? result?.code ?? 0);
      for (const listener of exits) listener(code);
    }).catch(() => {
      for (const listener of exits) listener(-1);
    });
    return {
      onData(listener) { outputs.add(listener); return () => outputs.delete(listener); },
      onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
      async write(data) { await sandbox.pty.sendInput(remotePid, new TextEncoder().encode(data)); },
      async resize(cols, rows) { await sandbox.pty.resize(remotePid, { cols, rows }); },
      async close() {
        if (typeof terminal.kill === 'function') await terminal.kill();
        else await sandbox.pty.kill(remotePid);
      },
    };
  }

  async destroy(): Promise<void> {
    await this.sandbox.kill();
  }

  async fetchPort(port: number, requestPath: string, request: WorldHttpRequest = { method: 'GET' }): Promise<WorldHttpResponse> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid preview port');
    const host = this.sandbox.getHost?.(port) ?? `${port}-${this.sandbox.sandboxId}.e2b.app`;
    const safePath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    const method = request.method.toUpperCase();
    const response = await fetch(`https://${host}${safePath}`, {
      method,
      headers: {
        ...(request.headers ?? {}),
        ...(this.sandbox.trafficAccessToken ? { 'x-access-token': this.sandbox.trafficAccessToken } : {}),
      },
      ...(!['GET', 'HEAD'].includes(method) && request.body?.length ? { body: request.body } : {}),
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return { status: response.status, headers, body: await boundedResponseBody(response) };
  }

  async previewSocketTarget(port: number, requestPath: string) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid preview port');
    const host = this.sandbox.getHost?.(port) ?? `${port}-${this.sandbox.sandboxId}.e2b.app`;
    const safePath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    return { url: `wss://${host}${safePath}`,
      ...(this.sandbox.trafficAccessToken ? { headers: { 'x-access-token': this.sandbox.trafficAccessToken } } : {}) };
  }

  private filePath(relPath: string): string {
    const safe = worldRelativePath(relPath);
    if (safe === '.') throw new Error('path is a directory');
    return path.posix.join(this.handle.root, safe);
  }

  private cwd(value?: string): string {
    if (!value) return this.handle.root;
    // Existing activity callers sometimes pass the handle's absolute repo roots.
    if (value === this.handle.root || value.startsWith(`${this.handle.root}/`)) return value;
    const safe = worldRelativePath(value);
    return safe === '.' ? this.handle.root : path.posix.join(this.handle.root, safe);
  }

  private remoteEnv(env?: Record<string, string>): Record<string, string> {
    const next = { ...(env ?? {}) };
    // Host credential paths are not meaningful in a remote filesystem, and
    // credentials must not cross into the untrusted task world. Trusted remote
    // writes are performed by the host-side Git broker.
    delete next.GIT_SSH_COMMAND;
    delete next.GIT_ASKPASS;
    delete next.GH_TOKEN;
    return next;
  }
}

async function provisionCredentials(sandbox: E2BSandboxLike, spec: WorldSpec): Promise<void> {
  const credentials = spec.gitCredentials;
  if (!credentials || (!credentials.sshKey && !Object.keys(credentials.repositories ?? {}).length)) return;
  await runOrThrow(sandbox, 'mkdir -p /home/user/.ssh && chmod 700 /home/user/.ssh && ssh-keyscan github.com >> /home/user/.ssh/known_hosts 2>/dev/null || true');
  const values = [credentials.sshKey, ...Object.values(credentials.repositories ?? {})].filter((value): value is string => Boolean(value));
  for (const [index, sshKey] of [...new Set(values)].entries()) {
    const keyPath = credentialPath(index);
    await sandbox.files.write(keyPath, sshKey.endsWith('\n') ? sshKey : `${sshKey}\n`);
    await runOrThrow(sandbox, `chmod 600 ${shellQuote(keyPath)}`);
  }
}

async function provisionRepos(sandbox: E2BSandboxLike, spec: WorldSpec): Promise<{ root: string; repos: WorldRepo[]; warnings: string[] }> {
  const branch = spec.branch ?? `karmax/${spec.taskId}`;
  const sources = (spec.repos?.length ? spec.repos : spec.repo ? [spec.repo] : []).map((value) => value.trim()).filter(Boolean);
  const warnings: string[] = [];
  if (sources.some((source) => !isSshRemote(source))) {
    throw new Error('E2B worlds require repositories as SSH Git URLs (for example git@github.com:org/repo.git), not local paths or HTTPS URLs');
  }
  if (!sources.length) {
    await runOrThrow(sandbox, `mkdir -p ${shellQuote(ROOT)} && cd ${shellQuote(ROOT)} && git init -q -b ${shellQuote(spec.base || 'main')}`);
    await configureRepo(sandbox, ROOT, spec, branch, false);
    return { root: ROOT, repos: [], warnings };
  }
  const multi = sources.length > 1;
  const names = uniqueNames(sources.map(remoteName));
  if (multi) await runOrThrow(sandbox, `mkdir -p ${shellQuote(ROOT)}`);
  const repos: WorldRepo[] = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!;
    const branchPolicy = spec.repositoryBranches?.[source];
    const base = branchPolicy?.base ?? spec.base;
    const target = branchPolicy?.target ?? spec.target;
    const root = multi ? path.posix.join(ROOT, names[i]!) : ROOT;
    const key = spec.gitCredentials?.repositories?.[source] ?? spec.gitCredentials?.sshKey;
    const uniqueKeys = [spec.gitCredentials?.sshKey, ...Object.values(spec.gitCredentials?.repositories ?? {})]
      .filter((value): value is string => Boolean(value));
    const keyIndex = key ? [...new Set(uniqueKeys)].indexOf(key) : -1;
    const ssh = keyIndex >= 0
      ? `GIT_SSH_COMMAND=${shellQuote(`ssh -i ${credentialPath(keyIndex)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`)} `
      : '';
    await runOrThrow(sandbox, `${ssh}git clone -q --origin origin ${shellQuote(source)} ${shellQuote(root)}`);
    const requested = spec.branch ?? base;
    const remoteRef = `refs/remotes/origin/${requested}`;
    const refCheck = await sandbox.commands.run(`git -C ${shellQuote(root)} show-ref --verify --quiet ${shellQuote(remoteRef)}`, { timeoutMs: 120_000 });
    const remoteRefExists = Number(refCheck?.exitCode ?? refCheck?.code ?? 0) === 0;
    if (spec.branch && !remoteRefExists) {
      throw new Error(`repository "${source}" has no remote branch "${spec.branch}" to review`);
    }
    if (!spec.branch && !remoteRefExists) {
      warnings.push(`repo "${names[i]}": base branch "${base}" not found — forked off the remote default branch instead`);
    }
    const baseRef = remoteRefExists ? remoteRef : 'refs/remotes/origin/HEAD';
    const baseShaResult = await sandbox.commands.run(`git -C ${shellQuote(root)} rev-parse ${shellQuote(baseRef)}`, { timeoutMs: 120_000 });
    const baseSha = String(baseShaResult?.stdout ?? '').trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseSha)) throw new Error(`repository "${source}" has no resolvable base commit`);
    await configureRepo(sandbox, root, spec, branch, true, remoteRefExists, base);
    repos.push({ name: names[i]!, repo: source, root, branch, base, target, baseSha });
  }
  if (spec.copyGlobs?.length) warnings.push('copyGlobs are host-local and were not copied into the remote E2B world');
  return { root: ROOT, repos, warnings };
}

function credentialPath(index: number): string {
  return `/home/user/.ssh/karmax-auth-${index}`;
}

async function configureRepo(
  sandbox: E2BSandboxLike,
  root: string,
  spec: WorldSpec,
  branch: string,
  hasOrigin: boolean,
  requestedRemoteRefExists = false,
  base = spec.base,
): Promise<void> {
  const identity = spec.gitIdentity;
  if (identity) {
    await runOrThrow(sandbox, `git -C ${shellQuote(root)} config user.name ${shellQuote(identity.name)} && git -C ${shellQuote(root)} config user.email ${shellQuote(identity.email)}`);
  } else {
    await runOrThrow(sandbox, `git -C ${shellQuote(root)} config user.name karmax && git -C ${shellQuote(root)} config user.email karmax@localhost`);
  }
  // Commit signing stays in the trusted Git broker. Leaving a long-lived signing
  // key in an agent-controlled world would make the isolation boundary moot.
  if (!hasOrigin) return;
  const desired = spec.branch;
  const checkout = desired
    ? `git -C ${shellQuote(root)} checkout -q -B ${shellQuote(desired)} ${shellQuote(`origin/${desired}`)}`
    : requestedRemoteRefExists
      ? `git -C ${shellQuote(root)} checkout -q -B ${shellQuote(base)} ${shellQuote(`origin/${base}`)} && git -C ${shellQuote(root)} checkout -q -b ${shellQuote(branch)}`
      : `git -C ${shellQuote(root)} checkout -q -b ${shellQuote(branch)}`;
  await runOrThrow(sandbox, checkout);
}

async function runOrThrow(sandbox: E2BSandboxLike, command: string): Promise<any> {
  const result = await sandbox.commands.run(command, { timeoutMs: 10 * 60_000 });
  const code = Number(result?.exitCode ?? result?.code ?? 0);
  if (code !== 0) throw new Error(String(result?.stderr || result?.stdout || `remote command failed (${code})`));
  return result;
}

function defaultE2BFactory(): E2BFactory {
  const sdk = async (): Promise<any> => {
    try {
      // Avoid loading the optional cloud SDK on local-only boots.
      return await (new Function('return import("e2b")')() as Promise<any>);
    } catch (error) {
      throw new Error(`E2B world requested but the e2b SDK is unavailable: ${String(error)}`);
    }
  };
  return {
    async create(options) {
      const { Sandbox } = await sdk();
      const { template, ...opts } = options;
      return template ? Sandbox.create(template, opts) : Sandbox.create(opts);
    },
    async connect(id, options) {
      const { Sandbox } = await sdk();
      return Sandbox.connect(id, options);
    },
  };
}


function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isSshRemote(value: string): boolean {
  return /^(?:ssh:\/\/|git@)[^\s]+/.test(value);
}

function remoteName(remote: string): string {
  const raw = remote.replace(/\/$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') || 'repo';
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  return !safe || /^\.+$/.test(safe) ? 'repo' : safe;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count ? `${name}-${count + 1}` : name;
  });
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function sdkText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value && typeof value === 'object' && 'data' in value) return sdkText((value as { data: unknown }).data);
  return String(value ?? '');
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function e2bNetwork(spec: WorldSpec): Pick<Parameters<E2BFactory['create']>[0], 'allowInternetAccess' | 'network'> {
  if (spec.network?.unrestricted) return { allowInternetAccess: true };
  const allowOut = [...new Set(['github.com', 'api.github.com', 'ssh.github.com',
    ...(spec.network?.allowDomains ?? []), ...(spec.network?.allowCidrs ?? [])])];
  // Supplying allowOut is itself deny-by-default. `allowInternetAccess: false`
  // is equivalent to denyOut=all and would also block these explicit entries.
  return { network: { allowOut, denyOut: [], allowPublicTraffic: false } };
}
