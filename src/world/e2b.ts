import path from 'node:path';
import crypto from 'node:crypto';
import type {
  ExecOptions,
  ExecResult,
  ProviderSandboxRef,
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
  WorldSpec,
} from './types.js';
import { worldRelativePath, worldWorkingDirectory, WorldCheckoutSpec } from './types.js';
import { addCheckoutViaExec } from './checkout.js';
import { boundedResponseBody } from './http.js';
import { serviceHomeLabel } from './services.js';
import type { ResolvedWorldProviderConnection } from './connections.js';
import { provisionGitCredentials, provisionGitRepos, runOrThrow as provisionRun, type ProvisionTarget } from './provision-git.js';

const HOME = '/home/user';
const ROOT = '/home/user/karmax';
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_TEMPLATE = 'codex';

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
  updateNetwork(network: { allowInternetAccess?: boolean; allowOut?: string[]; denyOut?: string[] }): Promise<unknown>;
  setTimeout?(timeoutMs: number): Promise<unknown>;
  getInfo?(): Promise<{ state?: string }>;
  stream?: {
    start(options?: { requireAuth?: boolean }): Promise<void>;
    getAuthKey(): string;
    getUrl(options?: { authKey?: string; autoConnect?: boolean; resize?: 'off' | 'scale' | 'remote' }): string;
  };
}

export interface E2BFactory {
  create(options: { template?: string; desktop?: boolean; apiKey?: string; timeoutMs: number; lifecycle: { onTimeout: 'pause'; autoResume: true };
    metadata: Record<string, string>; allowInternetAccess?: boolean;
    network?: { allowOut?: string[]; denyOut?: string[]; allowPublicTraffic: false } }): Promise<E2BSandboxLike>;
  connect(id: string, options: { timeoutMs: number; apiKey?: string; desktop?: boolean }): Promise<E2BSandboxLike>;
  /** Control-plane state lookup that must not resume a paused sandbox; absent
   * (or undefined result) means the provider cannot answer cheaply. */
  info?(id: string, options: { apiKey?: string }): Promise<{ state?: string } | undefined>;
  /** Control-plane enumeration of sandboxes carrying this deployment's
   * metadata, for orphan reaping. Never connects (which would resume a paused
   * sandbox and bill it). */
  list?(options: { apiKey?: string; metadata: Record<string, string> }): Promise<Array<{
    sandboxId: string; metadata?: Record<string, string> }>>;
  /** Control-plane teardown by id, so an orphan can be killed without a
   * handle — and, again, without resuming it first. */
  kill?(id: string, options: { apiKey?: string }): Promise<unknown>;
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
    private template = process.env.KARMAX_E2B_TEMPLATE?.trim() || DEFAULT_TEMPLATE,
    private resolveConnection?: (organizationId: string | undefined, provider: string) => ResolvedWorldProviderConnection,
    private desktopTemplate = process.env.KARMAX_E2B_DESKTOP_TEMPLATE ?? 'desktop',
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
    const flavor = spec.environment?.flavor ?? 'headless';
    const selectedTemplate = flavor === 'desktop'
      ? spec.environment?.template ?? spec.environment?.snapshot ?? connection?.config.desktopTemplate ?? this.desktopTemplate
      : spec.environment?.template ?? spec.environment?.snapshot ?? spec.environment?.image ?? connection?.config.template ?? this.template;
    const taskNetwork = e2bNetwork(spec);
    const sandbox = await this.factory.create({
      ...(selectedTemplate ? { template: selectedTemplate } : {}),
      ...(flavor === 'desktop' ? { desktop: true } : {}),
      ...(connection?.apiKey ? { apiKey: connection.apiKey } : {}),
      timeoutMs: this.idleMs,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      // `karmaxHome` scopes orphan reaping to sandboxes THIS deployment
      // created: several karmax instances (dev, prod, a colleague's) can share
      // one E2B account, and reaping by task id alone would kill theirs.
      metadata: { karmaxTaskId: spec.taskId, karmaxHome: serviceHomeLabel() },
      // Git provisioning is trusted host work and may require protocols (most
      // notably GitHub SSH) that E2B's domain allowlist proxy resets even when
      // the host is explicitly allowed. No task code runs in this phase. The
      // final task policy is installed atomically below before the World escapes.
      allowInternetAccess: true,
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    this.states.set(sandbox.sandboxId, 'ready');
    try {
      const provisioner = provisionTarget(sandbox);
      await provisionGitCredentials(provisioner, spec, HOME);
      const { repos, root, warnings, workdir, ephemeralPaths } = await provisionGitRepos(provisioner, spec, {
        root: ROOT, home: HOME,
        sshUrlError: 'E2B worlds require repositories as SSH Git URLs (for example git@github.com:org/repo.git), not local paths or HTTPS URLs',
        copyGlobsWarning: 'copyGlobs are host-local and were not copied into the remote E2B world',
      });
      // Clone credentials exist only during trusted provisioning. The agent's
      // execution environment gets a read/write checkout but no reusable secret;
      // pushes and merges go through the host-side Git broker.
      await provisionRun(provisioner, 'rm -f /home/user/.ssh/karmax-auth*');
      if (taskNetwork.network) {
        // `allowInternetAccess` is deliberately NOT sent here, and that does not
        // weaken the policy: the SDK defines `allowInternetAccess: false` as
        // *exactly* `denyOut: ['0.0.0.0/0']` (see SandboxNetworkUpdate in
        // node_modules/e2b), which this call already sends. It is a shorthand
        // for the catch-all deny rule, not a master override of the CIDR lists,
        // so the create-time `allowInternetAccess: true` above cannot resurrect
        // egress once these rules are installed. The update endpoint replaces
        // the egress configuration atomically, so this is the whole task policy.
        await sandbox.updateNetwork({
          allowOut: taskNetwork.network.allowOut,
          denyOut: taskNetwork.network.denyOut,
        });
      }
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
        ...(workdir ? { workdir } : {}),
        sealedProviderRef: this.sealRef({ sandboxId: sandbox.sandboxId, ...(spec.organizationId ? { organizationId: spec.organizationId } : {}) }),
        meta: { releaseOnCompletion: true, environmentFlavor: flavor,
          ...(ephemeralPaths.length ? { ephemeralPaths } : {}),
          ...(selectedTemplate ? { environmentArtifact: selectedTemplate } : {}) },
        ...(warnings.length ? { warnings } : {}),
      };
      return new E2BWorld(handle, sandbox, this.idleMs);
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
        ...(handle.meta?.environmentFlavor === 'desktop' ? { desktop: true } : {}),
        ...(connection?.apiKey ? { apiKey: connection.apiKey } : {}) });
      this.sandboxes.set(sandboxId, sandbox);
    }
    this.states.set(sandboxId, 'ready');
    return new E2BWorld(handle, sandbox, this.idleMs);
  }

  async park(handle: WorldHandle): Promise<WorldHandle> {
    const reference = this.refOf(handle);
    const sandboxId = reference.sandboxId;
    if (this.states.get(sandboxId) === 'parked') return handle;
    const connection = this.connection(reference.organizationId);
    const sandbox = this.sandboxes.get(sandboxId) ?? await this.factory.connect(sandboxId, { timeoutMs: this.idleMs,
      ...(handle.meta?.environmentFlavor === 'desktop' ? { desktop: true } : {}),
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

  /** Reconciliation probe: asks the control plane, never connect() — connecting
   * to an auto-resume sandbox would silently resume (and bill) a paused world. */
  async probe(handle: WorldHandle): Promise<WorldLifecycleState | undefined> {
    if (!this.factory.info) return undefined;
    const reference = this.refOf(handle);
    const connection = this.connection(reference.organizationId);
    try {
      const info = await this.factory.info(reference.sandboxId, connection?.apiKey ? { apiKey: connection.apiKey } : {});
      const state = String(info?.state ?? '').toLowerCase();
      if (!state) return undefined;
      if (['paused', 'pausing', 'stopped', 'stopping'].includes(state)) return 'parked';
      if (['running', 'starting', 'resuming', 'ready'].includes(state)) return 'ready';
      return 'missing';
    } catch (error) {
      return looksLikeMissingSandbox(error) ? 'missing' : undefined;
    }
  }

  /** Every live sandbox this deployment created, for the lifecycle sweep's
   * orphan reaper. Filtered server-side on the `karmaxHome` metadata so a
   * shared E2B account's other tenants are never even enumerated. */
  async listSandboxes(organizationId?: string): Promise<ProviderSandboxRef[]> {
    if (!this.factory.list) return [];
    const connection = this.connection(organizationId);
    const apiKey = connection?.apiKey ? { apiKey: connection.apiKey } : {};
    const listed = await this.factory.list({ ...apiKey, metadata: { karmaxHome: serviceHomeLabel() } });
    return listed.map((sandbox) => ({
      sandboxId: sandbox.sandboxId,
      ...(sandbox.metadata?.karmaxTaskId ? { taskId: sandbox.metadata.karmaxTaskId } : {}),
      destroy: async () => {
        if (this.factory.kill) await this.factory.kill(sandbox.sandboxId, apiKey);
        else await (await this.factory.connect(sandbox.sandboxId, { timeoutMs: this.idleMs, ...apiKey })).kill();
        this.sandboxes.delete(sandbox.sandboxId);
        this.states.set(sandbox.sandboxId, 'missing');
      },
    }));
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
      config: { template: this.template, desktopTemplate: this.desktopTemplate } } : undefined;
  }
}

class E2BWorld implements World {
  constructor(public handle: WorldHandle, private sandbox: E2BSandboxLike, private idleMs: number) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const line = [cmd, ...args].map(shellQuote).join(' ');
    const runOpts = { cwd: this.cwd(opts.cwd), envs: this.remoteEnv(opts.env), timeoutMs: opts.timeoutMs ?? 120_000 };
    // STDIN path (a secret fed to an in-world helper, kept out of argv/env/files
    // where the co-resident agent could read it): start in the background with
    // stdin open, push the input, signal EOF, then await completion.
    if (opts.input !== undefined) {
      try {
        const handle: any = await (this.sandbox.commands.run as any)(line, { ...runOpts, background: true, stdin: true });
        await handle.sendStdin(opts.input);
        await handle.closeStdin();
        const result: any = await handle.wait();
        return { stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? ''),
          code: Number(result?.exitCode ?? 0) };
      } catch (error: any) {
        return { stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? error?.message ?? error),
          code: Number(error?.exitCode ?? error?.code ?? 1) };
      }
    }
    try {
      const result = await this.sandbox.commands.run(line, runOpts);
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
    const listed = await this.exec('bash', ['-lc', "find . -type f -not -path '*/.git/*' -print | sed 's#^./##'"],
      { cwd: this.handle.root, timeoutMs: 120_000 });
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
      // A background process is long-lived by definition — a review dev server
      // stays up for as long as the human is clicking around. The SDK's
      // CommandStartOpts.timeoutMs defaults to 60s and would kill it mid-review
      // with a spurious exit; 0 disables that bound, as openPty already does.
      // (keepAlive() below refreshes the *sandbox* lease, not this timeout.)
      timeoutMs: 0,
      onStdout: emit,
      onStderr: emit,
    });
    let exited = false;
    let exitCode: number | null = null;
    const stopKeepAlive = this.keepAlive();
    void Promise.resolve(command?.wait?.()).then((result) => {
      stopKeepAlive();
      exited = true;
      exitCode = Number(result?.exitCode ?? result?.code ?? 0);
      for (const listener of exits) listener(exitCode);
    }).catch((error) => {
      stopKeepAlive();
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
      async kill() { stopKeepAlive(); await command?.kill?.(); },
    };
  }

  async openPty(spec: WorldPtySpec = {}): Promise<WorldPty> {
    const sandbox = this.sandbox;
    const outputs = new Set<(chunk: string) => void>();
    const exits = new Set<(code: number | null) => void>();
    const pending: string[] = [];
    let attached = false;
    let exited = false;
    let exitCode: number | null = null;
    const terminal = await this.sandbox.pty.create({
      cols: spec.cols ?? 80,
      rows: spec.rows ?? 24,
      cwd: this.cwd(spec.cwd),
      envs: this.remoteEnv(spec.env),
      timeoutMs: 0,
      onData: (data: unknown) => {
        const chunk = sdkText(data);
        if (!attached) pending.push(chunk);
        for (const listener of outputs) listener(chunk);
      },
    });
    const remotePid = Number(terminal.pid);
    const stopKeepAlive = this.keepAlive();
    if (spec.command) await sandbox.pty.sendInput(remotePid, new TextEncoder().encode(`${spec.command}\n`));
    void Promise.resolve(terminal.wait?.()).then((result) => {
      stopKeepAlive();
      const code = Number(result?.exitCode ?? result?.code ?? 0);
      exited = true;
      exitCode = code;
      for (const listener of exits) listener(code);
    }).catch(() => {
      stopKeepAlive();
      exited = true;
      exitCode = -1;
      for (const listener of exits) listener(-1);
    });
    return {
      onData(listener) {
        outputs.add(listener);
        if (!attached) { attached = true; for (const chunk of pending.splice(0)) listener(chunk); }
        return () => outputs.delete(listener);
      },
      onExit(listener) {
        if (exited) queueMicrotask(() => listener(exitCode));
        else exits.add(listener);
        return () => exits.delete(listener);
      },
      async write(data) { await sandbox.pty.sendInput(remotePid, new TextEncoder().encode(data)); },
      async resize(cols, rows) { await sandbox.pty.resize(remotePid, { cols, rows }); },
      async close() {
        stopKeepAlive();
        if (typeof terminal.kill === 'function') await terminal.kill();
        else await sandbox.pty.kill(remotePid);
      },
    };
  }

  /** Another branch of a repo in this sandbox (SPEC §11.1, multi-PR). The repos
   *  here are real clones, so this is one `git worktree add` run in place. */
  async addCheckout(spec: WorldCheckoutSpec): Promise<WorldHandle> {
    return addCheckoutViaExec(this, spec);
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

  async desktopSession() {
    if (this.handle.meta?.environmentFlavor !== 'desktop') throw new Error('this is a headless world');
    if (!this.sandbox.stream) throw new Error('the selected E2B template does not expose E2B Desktop streaming');
    await this.sandbox.stream.start({ requireAuth: true });
    const authKey = this.sandbox.stream.getAuthKey();
    return { provider: 'e2b', url: this.sandbox.stream.getUrl({ authKey, autoConnect: true, resize: 'scale' }) };
  }

  private filePath(relPath: string): string {
    const safe = worldRelativePath(relPath);
    if (safe === '.') throw new Error('path is a directory');
    return path.posix.join(this.handle.root, safe);
  }

  private cwd(value?: string): string {
    if (!value) return worldWorkingDirectory(this.handle);
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

  /** E2B's timeout is a renewable sandbox lease, not process-idle detection.
   * Refresh it while a PTY/background process is active so a long model turn or
   * review server cannot be paused underneath its runner lease. */
  private keepAlive(): () => void {
    if (!this.sandbox.setTimeout) return () => {};
    let stopped = false;
    const refresh = () => { if (!stopped) void this.sandbox.setTimeout!(this.idleMs).catch(() => undefined); };
    refresh();
    const timer = setInterval(refresh, Math.max(30_000, Math.min(60_000, Math.floor(this.idleMs / 3))));
    timer.unref();
    return () => { if (!stopped) { stopped = true; clearInterval(timer); } };
  }
}

/** Trusted-provisioning adapter over the sandbox SDK. Never catches: real SDK
 * errors (including nonzero-exit throws) must reach the caller unchanged. */
function provisionTarget(sandbox: E2BSandboxLike): ProvisionTarget {
  return {
    async run(command, timeoutMs) {
      try {
        const result = await sandbox.commands.run(command, { timeoutMs });
        return { stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? ''),
          code: Number(result?.exitCode ?? result?.code ?? 0) };
      } catch (error) {
        // E2B throws CommandExitError for ordinary non-zero exits. Its generic
        // Error.message is only "exit status N", while the useful Git/compiler
        // diagnosis remains on stdout/stderr. Normalize that expected shape so
        // runOrThrow can surface the captured output just like every other world.
        const failed = error as { exitCode?: unknown; code?: unknown; stdout?: unknown; stderr?: unknown };
        const code = Number(failed.exitCode ?? failed.code);
        if (Number.isFinite(code)) return {
          stdout: String(failed.stdout ?? ''),
          stderr: String(failed.stderr ?? ''),
          code,
        };
        throw error;
      }
    },
    async writeFile(remotePath, content) { await sandbox.files.write(remotePath, content); },
  };
}

function looksLikeMissingSandbox(error: unknown): boolean {
  return /not\s*found|does not exist|404/i.test(String((error as Error)?.message ?? error));
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
      const { template, desktop, ...opts } = options;
      if (desktop) {
        const { Sandbox } = await import('@e2b/desktop');
        return Sandbox.create(template ?? 'desktop', opts);
      }
      const { Sandbox } = await sdk();
      return template ? Sandbox.create(template, opts) : Sandbox.create(opts);
    },
    async connect(id, options) {
      const { desktop, ...opts } = options;
      if (desktop) {
        const { Sandbox } = await import('@e2b/desktop');
        return Sandbox.connect(id, opts);
      }
      const { Sandbox } = await sdk();
      return Sandbox.connect(id, opts);
    },
    async info(id, options) {
      const { Sandbox } = await sdk();
      // Older SDKs have no control-plane lookup; report "cannot say" rather
      // than connect(), which would resume (and bill) a paused sandbox.
      if (typeof Sandbox.getInfo !== 'function') return undefined;
      return Sandbox.getInfo(id, options);
    },
    async list(options) {
      const { Sandbox } = await sdk();
      if (typeof Sandbox.list !== 'function') return [];
      const { metadata, ...opts } = options;
      // Both the paginator (current SDK) and the flat-array (older) shapes:
      // reaping is best-effort infrastructure and must not depend on which.
      const paginator = Sandbox.list({ ...opts, query: { metadata, state: ['running', 'paused'] } });
      if (Array.isArray(paginator)) return paginator;
      const items: any[] = [];
      for (let page = 0; page < 50 && paginator?.hasNext; page++) items.push(...await paginator.nextItems(opts));
      return items;
    },
    async kill(id, options) {
      const { Sandbox } = await sdk();
      return Sandbox.kill(id, options);
    },
  };
}


function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  const allowOut = [...new Set(['github.com', 'api.github.com', 'ssh.github.com', 'registry.npmjs.org',
    'cdn.playwright.dev', 'playwright.download.prss.microsoft.com',
    'storage.googleapis.com', 'chrome-for-testing-public.storage.googleapis.com',
    'googlechromelabs.github.io', 'edgedl.me.gvt1.com', 'redirector.gvt1.com',
    'deb.debian.org', 'security.debian.org', 'archive.ubuntu.com', 'security.ubuntu.com', 'dl.google.com',
    'api.anthropic.com', 'claude.ai', 'api.openai.com', 'chatgpt.com', 'auth.openai.com',
    ...publicGatewayDomains(),
    ...(spec.network?.allowDomains ?? []), ...(spec.network?.allowCidrs ?? [])])];
  // E2B requires the explicit all-traffic CIDR deny sentinel when an allowlist
  // is supplied; without it the control plane rejects sandbox creation. The SDK
  // exports this value as ALL_TRAFFIC (`0.0.0.0/0`). Explicit allowOut entries
  // take precedence over the catch-all deny.
  return { network: { allowOut, denyOut: ['0.0.0.0/0'], allowPublicTraffic: false } };
}

function publicGatewayDomains(): string[] {
  try {
    const value = process.env.KARMAX_REMOTE_GATEWAY_URL ?? process.env.KARMAX_PUBLIC_URL;
    return value ? [new URL(value).hostname] : [];
  }
  catch { return []; }
}
