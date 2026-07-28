import crypto from 'node:crypto';
import path from 'node:path';
import type { ExecOptions, ExecResult, ProviderSandboxRef, World, WorldHandle, WorldHttpRequest, WorldHttpResponse,
  WorldLifecycleState, WorldProcess, WorldProcessSpec, WorldProvider, WorldPty, WorldPtySpec, WorldSpec } from './types.js';
import { worldRelativePath, worldWorkingDirectory } from './types.js';
import { boundedResponseBody } from './http.js';
import { serviceHomeLabel } from './services.js';
import type { ResolvedWorldProviderConnection } from './connections.js';
import { provisionGitCredentials, provisionGitRepos, runOrThrow as provisionRun, type ProvisionTarget } from './provision-git.js';

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
  computerUse?: { start(): Promise<unknown>; getStatus?(): Promise<unknown> };
  refreshData?(): Promise<void>;
  labels?: Record<string, string>;
  /** Re-arm the auto-stop countdown. Present in current SDKs; when absent the
   * keep-alive falls back to a no-op command (which is sandbox activity). */
  setAutostopInterval?(minutes: number): Promise<unknown>;
  start(timeoutSeconds?: number): Promise<void>;
  stop(timeoutSeconds?: number, force?: boolean): Promise<void>;
  archive(): Promise<void>;
  delete(timeoutSeconds?: number): Promise<void>;
}

export interface DaytonaFactory {
  create(options: Record<string, unknown>): Promise<DaytonaSandboxLike>;
  get(id: string): Promise<DaytonaSandboxLike>;
  /** Label-filtered enumeration for the lifecycle sweep's orphan reaper.
   * Absent ⇒ this deployment cannot see leaked sandboxes and reaps nothing. */
  list?(labels: Record<string, string>): Promise<DaytonaSandboxLike[]>;
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
    private resolveConnection?: (organizationId: string | undefined, provider: string) => ResolvedWorldProviderConnection,
    private desktopSnapshot = process.env.KARMAX_DAYTONA_DESKTOP_SNAPSHOT,
    private desktopImage = process.env.KARMAX_DAYTONA_DESKTOP_IMAGE) {
    this.refKey = crypto.createHash('sha256').update(
      process.env.KARMAX_WORLD_REF_KEY ?? process.env.DAYTONA_API_KEY ?? 'karmax-development-world-ref',
    ).digest();
  }

  async create(spec: WorldSpec): Promise<World> {
    const connection = this.connection(spec.organizationId);
    const factory = this.factoryFor(connection);
    const environment = spec.environment ?? {};
    const flavor = environment.flavor ?? 'headless';
    const selectedSnapshot = environment.snapshot ?? (flavor === 'desktop'
      ? connection?.config.desktopSnapshot ?? this.desktopSnapshot
      : connection?.config.snapshot ?? this.snapshot);
    // Daytona's create API is a discriminated choice. A pre-built snapshot wins;
    // never forward both snapshot and image as the old settings path did.
    const selectedImage = selectedSnapshot ? undefined : environment.image ?? (flavor === 'desktop'
      ? connection?.config.desktopImage ?? this.desktopImage
      : connection?.config.image ?? this.image);
    const network = daytonaNetwork(spec);
    const sandbox = await factory.create({
      ...(selectedSnapshot ? { snapshot: selectedSnapshot } : {}),
      ...(selectedImage ? { image: selectedImage } : {}),
      // `karmaxHome` scopes orphan reaping to sandboxes THIS deployment
      // created: several karmax instances can share one Daytona account, and
      // reaping by task id alone would delete another instance's live worlds.
      labels: { karmaxTaskId: spec.taskId, karmaxHome: serviceHomeLabel() }, public: false,
      // `autoDeleteInterval: -1` means the provider NEVER reaps this sandbox —
      // it auto-stops, auto-archives at 24h, then bills archived storage
      // indefinitely. karmax owns the teardown: the workflow's destroyWorld
      // plus WorldLifecycleManager's orphan sweep (which finds these by label).
      autoStopInterval: Math.max(1, Math.ceil(this.idleMs / 60_000)), autoArchiveInterval: 24 * 60,
      autoDeleteInterval: -1, ...network,
      ...(spec.resources ? { resources: { cpu: spec.resources.cpu,
        memory: spec.resources.memoryMb ? spec.resources.memoryMb / 1024 : undefined, gpu: spec.resources.gpu } } : {}),
    });
    this.sandboxes.set(sandbox.id, sandbox);
    this.states.set(sandbox.id, 'ready');
    try {
      if (flavor === 'desktop') {
        if (!sandbox.computerUse) throw new Error('the selected Daytona environment does not support Computer Use');
        await sandbox.computerUse.start();
      }
      const home = await sandbox.getUserHomeDir();
      const root = path.posix.join(home, 'karmax');
      const provisioner = provisionTarget(sandbox);
      await provisionGitCredentials(provisioner, spec, home);
      const provisioned = await provisionGitRepos(provisioner, spec, {
        root, home,
        sshUrlError: 'Daytona worlds require repositories as SSH Git URLs, not local paths or HTTPS URLs',
        copyGlobsWarning: 'copyGlobs are host-local and were not copied into the remote Daytona world',
      });
      await provisionRun(provisioner, `rm -f ${quote(path.posix.join(home, '.ssh'))}/karmax-auth-*`);
      const handle: WorldHandle = {
        version: 2, kind: this.kind, provider: this.kind, id: spec.taskId, root, workspaceRoot: root,
        branch: spec.branch ?? `karmax/${spec.taskId}`, base: provisioned.repos[0]?.base ?? spec.base,
        target: provisioned.repos[0]?.target ?? spec.target,
        repo: provisioned.repos[0]?.repo, repos: provisioned.repos,
        ...(provisioned.workdir ? { workdir: provisioned.workdir } : {}),
        sealedProviderRef: this.seal({ sandboxId: sandbox.id, ...(spec.organizationId ? { organizationId: spec.organizationId } : {}) }),
        meta: { releaseOnCompletion: true, environmentFlavor: flavor,
          ...(provisioned.ephemeralPaths.length ? { ephemeralPaths: provisioned.ephemeralPaths } : {}),
          ...((selectedSnapshot ?? selectedImage) ? { environmentArtifact: selectedSnapshot ?? selectedImage } : {}) },
        ...(provisioned.warnings.length ? { warnings: provisioned.warnings } : {}),
      };
      return new DaytonaWorld(handle, sandbox, this.idleMs);
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
    if (handle.meta?.environmentFlavor === 'desktop') {
      if (!sandbox.computerUse) throw new Error('the Daytona world no longer exposes Computer Use');
      await sandbox.computerUse.start();
    }
    this.sandboxes.set(id, sandbox);
    this.states.set(id, 'ready');
    return new DaytonaWorld(handle, sandbox, this.idleMs);
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

  /** Reconciliation probe: `get()` reads the sandbox record without starting
   * it, so probing a stopped/archived world stays free of side effects. */
  async probe(handle: WorldHandle): Promise<WorldLifecycleState | undefined> {
    const reference = this.reference(handle);
    try {
      const sandbox = await this.factoryFor(this.connection(reference.organizationId)).get(reference.sandboxId);
      await sandbox.refreshData?.();
      const state = String(sandbox.state ?? '').toLowerCase();
      if (!state) return undefined;
      if (['destroyed', 'destroying', 'error', 'build_failed'].includes(state)) return 'missing';
      if (['stopped', 'stopping', 'archived', 'archiving'].includes(state)) return 'parked';
      return 'ready';
    } catch (error) {
      return /not\s*found|does not exist|404/i.test(String((error as Error)?.message ?? error)) ? 'missing' : undefined;
    }
  }

  /** Every sandbox this deployment owns, for the lifecycle sweep's orphan
   * reaper. Filtered on the `karmaxHome` label so another karmax instance
   * sharing the same Daytona account is never enumerated, let alone deleted. */
  async listSandboxes(organizationId?: string): Promise<ProviderSandboxRef[]> {
    const factory = this.factoryFor(this.connection(organizationId));
    if (!factory.list) return [];
    const sandboxes = await factory.list({ karmaxHome: serviceHomeLabel() });
    return sandboxes.map((sandbox) => ({
      sandboxId: sandbox.id,
      ...(sandbox.labels?.karmaxTaskId ? { taskId: sandbox.labels.karmaxTaskId } : {}),
      destroy: async () => {
        await sandbox.delete(60);
        this.sandboxes.delete(sandbox.id);
        this.states.set(sandbox.id, 'missing');
      },
    }));
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
      config: { snapshot: this.snapshot, image: this.image, desktopSnapshot: this.desktopSnapshot,
        desktopImage: this.desktopImage, apiUrl: process.env.DAYTONA_API_URL,
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
  constructor(public handle: WorldHandle, private sandbox: DaytonaSandboxLike, private idleMs = DEFAULT_IDLE_MS) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const line = [cmd, ...args].map(quote).join(' ');
    const seconds = Math.max(1, Math.ceil((opts.timeoutMs ?? 120_000) / 1000));
    let stdinPath: string | undefined;
    try {
      let command = line;
      // STDIN path. `ExecOptions.input` exists so a caller can feed a secret to
      // an in-world helper without it landing in argv or env, which every
      // co-resident process can read out of /proc for the command's whole
      // lifetime (the vault's fillInWorld depends on exactly this). Daytona's
      // command API has no stdin channel, so the payload is uploaded over the
      // FILE api — never through a shell command line — chmod-ed 0600,
      // redirected in, and deleted in the same shell whatever the exit status.
      // A narrow same-uid on-disk window is the best this SDK surface allows,
      // and is strictly better than silently dropping the secret.
      if (opts.input !== undefined) {
        stdinPath = path.posix.join('/tmp', `karmax-stdin-${crypto.randomBytes(12).toString('hex')}`);
        await this.sandbox.fs.uploadFile(Buffer.from(opts.input), stdinPath);
        const quoted = quote(stdinPath);
        command = `chmod 600 ${quoted} 2>/dev/null; ${line} < ${quoted}; __karmax_code=$?; rm -f ${quoted}; exit $__karmax_code`;
      }
      const result = await this.sandbox.process.executeCommand(command,
        this.cwd(opts.cwd), remoteEnv(opts.env), seconds);
      stdinPath = undefined; // the command's own `rm -f` already removed it
      return { stdout: String(result?.result ?? result?.stdout ?? result?.artifacts?.stdout ?? ''),
        stderr: String(result?.stderr ?? ''), code: Number(result?.exitCode ?? 0) };
    } catch (error: any) {
      return { stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? error?.message ?? error),
        code: Number(error?.exitCode ?? 1) };
    } finally {
      // A throw (timeout, transport error) skips the in-shell cleanup; never
      // leave a secret sitting in the sandbox's /tmp because of it.
      if (stdinPath) await this.sandbox.process.executeCommand(`rm -f ${quote(stdinPath)}`,
        undefined, undefined, 15).catch(() => undefined);
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
    const result = await this.exec('bash', ['-lc', "find . -type f -not -path '*/.git/*' -print | sed 's#^./##'"],
      { cwd: this.handle.root });
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
    const stopKeepAlive = this.keepAlive();
    void (async () => {
      while (!stopped) {
        const status = await processApi.getSessionCommand!(sessionId, commandId);
        if (status.exitCode != null) { exitCode = Number(status.exitCode); break; }
        await delay(250);
      }
      stopKeepAlive();
      for (const listener of exits) listener(exitCode);
    })().catch(() => { stopKeepAlive(); exitCode = -1; for (const listener of exits) listener(exitCode); });
    return {
      onOutput(listener) { output.add(listener); if (!attached) { attached = true; for (const chunk of pending.splice(0)) listener(chunk); } return () => output.delete(listener); },
      onExit(listener) { if (exitCode != null) queueMicrotask(() => listener(exitCode)); else exits.add(listener); return () => exits.delete(listener); },
      async kill() { stopped = true; stopKeepAlive(); await processApi.deleteSession!(sessionId); if (exitCode == null) { exitCode = -1; for (const listener of exits) listener(exitCode); } },
    };
  }

  async openPty(spec: WorldPtySpec = {}): Promise<WorldPty> {
    const output = new Set<(value: string) => void>();
    const exits = new Set<(code: number | null) => void>();
    const pending: string[] = [];
    let attached = false;
    let exited = false;
    let exitCode: number | null = null;
    const terminal = await this.sandbox.process.createPty({ id: `karmax-${crypto.randomBytes(8).toString('hex')}`,
      cwd: this.cwd(spec.cwd), envs: remoteEnv(spec.env), cols: spec.cols ?? 80, rows: spec.rows ?? 24,
      onData: (data: Uint8Array) => {
        const chunk = new TextDecoder().decode(data);
        if (!attached) pending.push(chunk);
        for (const listener of output) listener(chunk);
      } });
    await terminal.waitForConnection?.();
    const stopKeepAlive = this.keepAlive();
    if (spec.command) await terminal.sendInput(`${spec.command}\n`);
    void Promise.resolve(terminal.wait?.()).then((result) => {
      stopKeepAlive();
      exited = true;
      exitCode = Number(result?.exitCode ?? 0);
      for (const listener of exits) listener(exitCode);
    }).catch(() => {
      stopKeepAlive();
      exited = true;
      exitCode = -1;
      for (const listener of exits) listener(exitCode);
    });
    return {
      onData(listener) {
        output.add(listener);
        if (!attached) { attached = true; for (const chunk of pending.splice(0)) listener(chunk); }
        return () => output.delete(listener);
      },
      onExit(listener) {
        if (exited) queueMicrotask(() => listener(exitCode));
        else exits.add(listener);
        return () => exits.delete(listener);
      },
      async write(data) { await terminal.sendInput(data); },
      async resize(cols, rows) { await terminal.resize(cols, rows); },
      async close() { stopKeepAlive(); if (terminal.kill) await terminal.kill(); else await terminal.disconnect?.(); },
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

  async desktopSession() {
    if (this.handle.meta?.environmentFlavor !== 'desktop') throw new Error('this is a headless world');
    if (!this.sandbox.computerUse) throw new Error('the selected Daytona environment does not support Computer Use');
    await this.sandbox.computerUse.start();
    const port = positiveInt(process.env.KARMAX_DAYTONA_NOVNC_PORT, 6080);
    const signed = await this.sandbox.getSignedPreviewUrl(port, 300);
    return { provider: 'daytona', url: signed.url };
  }

  async destroy(): Promise<void> { await this.sandbox.delete(60); }

  /**
   * Daytona's `autoStopInterval` is a wall-clock idle timer set once at create;
   * unlike E2B's renewable timeout nothing refreshes it, so a long agent turn
   * that merely holds a PTY or session command open can have its sandbox
   * stopped underneath it mid-flight (E2B documents the same hazard and solves
   * it in `keepAlive` — this mirrors it). Re-arm through the control plane when
   * the SDK exposes it; otherwise run a no-op command, which is itself sandbox
   * activity. Harmless if Daytona already counts an open session as activity.
   */
  private keepAlive(): () => void {
    let stopped = false;
    const minutes = Math.max(1, Math.ceil(this.idleMs / 60_000));
    const refresh = () => {
      if (stopped) return;
      void Promise.resolve(this.sandbox.setAutostopInterval
        ? this.sandbox.setAutostopInterval(minutes)
        : this.sandbox.process.executeCommand('true', undefined, undefined, 15)).catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, Math.max(30_000, Math.min(60_000, Math.floor(this.idleMs / 3))));
    timer.unref();
    return () => { if (!stopped) { stopped = true; clearInterval(timer); } };
  }

  private file(relative: string): string {
    const safe = worldRelativePath(relative);
    if (safe === '.') throw new Error('path is a directory');
    return path.posix.join(this.handle.root, safe);
  }
  private cwd(value?: string): string {
    if (!value) return worldWorkingDirectory(this.handle);
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

/** Trusted-provisioning adapter over the sandbox SDK. Never catches: real SDK
 * errors must reach the caller unchanged. */
function provisionTarget(sandbox: DaytonaSandboxLike): ProvisionTarget {
  return {
    async run(command, timeoutMs) {
      const result = await sandbox.process.executeCommand(command, undefined, undefined, Math.max(1, Math.ceil(timeoutMs / 1000)));
      return { stdout: String(result?.result ?? result?.stdout ?? ''), stderr: String(result?.stderr ?? ''),
        code: Number(result?.exitCode ?? 0) };
    },
    async writeFile(remotePath, content) { await sandbox.fs.uploadFile(Buffer.from(content), remotePath); },
  };
}

function daytonaNetwork(spec: WorldSpec): Record<string, unknown> {
  if (spec.network?.unrestricted) return { networkBlockAll: false };
  let gateway: string[] = [];
  try {
    const value = process.env.KARMAX_REMOTE_GATEWAY_URL ?? process.env.KARMAX_PUBLIC_URL;
    if (value) gateway = [new URL(value).hostname];
  } catch { /* invalid hosted config is rejected at boot */ }
  const domains = [...new Set(['github.com', 'api.github.com', 'ssh.github.com', 'registry.npmjs.org',
    'cdn.playwright.dev', 'playwright.download.prss.microsoft.com',
    'deb.debian.org', 'security.debian.org', 'archive.ubuntu.com', 'security.ubuntu.com', 'dl.google.com',
    'api.anthropic.com', 'claude.ai', 'api.openai.com', 'chatgpt.com', 'auth.openai.com',
    ...gateway, ...(spec.network?.allowDomains ?? [])])];
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
    async get(id) { return (await sdk()).get(id); },
    async list(labels) {
      const client = await sdk();
      // Older SDKs have no label-filtered list; reaping is best-effort and must
      // degrade to "cannot enumerate" rather than throwing inside the sweep.
      return typeof client.list === 'function' ? await client.list(labels) : [];
    } };
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
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
