import type { WorldReferenceKeys } from './reference-keys.js';
import { isMissingSandbox } from './provider-errors.js';
import { timed } from '../timing/index.js';
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
  ProviderUsageEvent,
  WorldProcess,
  WorldProcessSpec,
  WorldProvider,
  WorldDiagnosis,
  WorldPty,
  WorldPtySpec,
  WorldPtyTermination,
  WorldSpec,
} from './types.js';
import { diagnoseMetrics } from './health.js';
import { withTimeout } from '../util/timeout.js';
import { worldRelativePath, worldWorkingDirectory, WorldCheckoutSpec } from './types.js';
import { addCheckoutViaExec } from './checkout.js';
import { boundedResponseBody } from './http.js';
import { serviceHomeLabel } from './services.js';
import type { ResolvedWorldProviderConnection } from './connections.js';
import { provisionGitCredentials, provisionGitRepos, runOrThrow as provisionRun, type ProvisionTarget } from './provision-git.js';

const HOME = '/home/user';
const ROOT = '/home/user/karmax';
const DEFAULT_IDLE_MS = 10 * 60_000;
// Public, package-only browser/runtime build; usable with each organization's
// own E2B key. Keep this release default aligned with environments/browser.
export const DEFAULT_E2B_TEMPLATE = 'uj125w982t7wflqad4ig';
// `createWorld` has a five-minute Temporal boundary that also includes Git
// provisioning. Give E2B twice its SDK default without consuming the entire
// activity budget; an indeterminate timeout is reconciled by metadata below.
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60_000;
// Long enough to see the memory spike that froze a sandbox before a retry.
const DIAGNOSIS_WINDOW_MS = 30 * 60_000;
// Resuming a paused sandbox takes seconds; a frozen one never answers.
const REATTACH_REQUEST_MS = 60_000;
// A stream reattached right after E2B resumes may drop once more (live-tested);
// one that keeps dropping is not a pause.
const REATTACH_LIMIT = 3;
const REATTACH_WINDOW_MS = 10 * 60_000;

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
    /** Follow a running PTY again after its stream dropped. */
    connect?(pid: number, options: { onData: (data: unknown) => void; timeoutMs: number; requestTimeoutMs: number }): Promise<any>;
  };
  /** Resume this sandbox if paused (a no-op while it runs). */
  connect?(options: { timeoutMs: number; requestTimeoutMs: number }): Promise<unknown>;
  pause(): Promise<unknown>;
  kill(): Promise<unknown>;
  updateNetwork(network: { allowInternetAccess?: boolean; allowOut?: string[]; denyOut?: string[] }): Promise<unknown>;
  setTimeout?(timeoutMs: number): Promise<unknown>;
  getInfo?(): Promise<{ state?: string }>;
  /** Control-plane resource samples; served even while the sandbox is frozen. */
  getMetrics?(options: { start?: Date; end?: Date }): Promise<Array<{ timestamp: Date | string; memUsed: number; memTotal: number }>>;
  stream?: {
    start(options?: { requireAuth?: boolean }): Promise<void>;
    getAuthKey(): string;
    getUrl(options?: { authKey?: string; autoConnect?: boolean; resize?: 'off' | 'scale' | 'remote' }): string;
  };
}

export interface E2BFactory {
  create(options: { template?: string; desktop?: boolean; apiKey?: string; timeoutMs: number; requestTimeoutMs: number; lifecycle: { onTimeout: 'pause'; autoResume: true };
    metadata: Record<string, string>; allowInternetAccess?: boolean;
    network?: { allowOut?: string[]; denyOut?: string[]; allowPublicTraffic: false }; signal?: AbortSignal }): Promise<E2BSandboxLike>;
  connect(id: string, options: { timeoutMs: number; requestTimeoutMs?: number; apiKey?: string; desktop?: boolean; signal?: AbortSignal }): Promise<E2BSandboxLike>;
  /** Control-plane state lookup that must not resume a paused sandbox; absent
   * (or undefined result) means the provider cannot answer cheaply. */
  info?(id: string, options: { apiKey?: string }): Promise<{ state?: string } | undefined>;
  /** Control-plane enumeration of sandboxes carrying this deployment's
   * metadata, for orphan reaping. Never connects (which would resume a paused
   * sandbox and bill it). */
  list?(options: { apiKey?: string; requestTimeoutMs?: number; metadata: Record<string, string>; signal?: AbortSignal }): Promise<Array<{
    sandboxId: string; metadata?: Record<string, string> }>>;
  /** Control-plane teardown by id, so an orphan can be killed without a
   * handle — and, again, without resuming it first. */
  kill?(id: string, options: { apiKey?: string }): Promise<unknown>;
  /** Completed lifecycle executions from E2B's seven-day event feed. */
  events?(options: { apiKey?: string }): Promise<unknown[]>;
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
  private destroyed = new WeakSet<WorldHandle>();

  constructor(
    private factory: E2BFactory = defaultE2BFactory(),
    private idleMs = envPositiveInt('KARMAX_E2B_IDLE_MS', DEFAULT_IDLE_MS),
    private template = process.env.KARMAX_E2B_TEMPLATE?.trim() || DEFAULT_E2B_TEMPLATE,
    private resolveConnection?: (organizationId: string | undefined, provider: string) => ResolvedWorldProviderConnection | Promise<ResolvedWorldProviderConnection>,
    private desktopTemplate = process.env.KARMAX_E2B_DESKTOP_TEMPLATE ?? 'desktop',
    private referenceKeys?: WorldReferenceKeys,
  ) {
    // Hosted deployments must set KARMAX_WORLD_REF_KEY. E2B_API_KEY is a stable
    // compatibility seed for self-hosted installs; the development constant is
    // intentionally usable only when neither cloud credential exists.
    this.refKey = crypto.createHash('sha256').update(
      process.env.KARMAX_WORLD_REF_KEY ?? process.env.E2B_API_KEY ?? 'karmax-development-world-ref',
    ).digest();
  }

  async create(spec: WorldSpec): Promise<World> {
    const connection = (await this.connection(spec.organizationId));
    const flavor = spec.environment?.flavor ?? 'headless';
    const selectedTemplate = flavor === 'desktop'
      ? spec.environment?.template ?? spec.environment?.snapshot ?? connection?.config.desktopTemplate ?? this.desktopTemplate
      : spec.environment?.template ?? spec.environment?.snapshot ?? spec.environment?.image ?? connection?.config.template ?? this.template;
    const taskNetwork = e2bNetwork(spec);
    const requestTimeoutMs = envPositiveInt('KARMAX_E2B_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
    const generation = String(spec.generation ?? 1);
    const metadata = { karmaxTaskId: spec.taskId, karmaxHome: serviceHomeLabel(), karmaxGeneration: generation };
    const connectionOptions = {
      timeoutMs: this.idleMs,
      requestTimeoutMs,
      ...(spec.signal ? { signal: spec.signal } : {}),
      ...(flavor === 'desktop' ? { desktop: true } : {}),
      ...(connection?.apiKey ? { apiKey: connection.apiKey } : {}),
    };
    let sandbox = await this.findProvisioningSandbox(metadata, connectionOptions);
    let adopted = Boolean(sandbox);
    if (!sandbox) sandbox = await this.factory.create({
      ...(selectedTemplate ? { template: selectedTemplate } : {}),
      ...(flavor === 'desktop' ? { desktop: true } : {}),
      ...(connection?.apiKey ? { apiKey: connection.apiKey } : {}),
      timeoutMs: this.idleMs,
      requestTimeoutMs,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      // `karmaxHome` scopes orphan reaping to sandboxes THIS deployment
      // created: several karmax instances (dev, prod, a colleague's) can share
      // one E2B account, and reaping by task id alone would kill theirs.
      metadata,
      // Git provisioning is trusted host work and may require protocols (most
      // notably GitHub SSH) that E2B's domain allowlist proxy resets even when
      // the host is explicitly allowed. No task code runs in this phase. The
      // final task policy is installed atomically below before the World escapes.
      allowInternetAccess: true,
    }).catch(async (error) => {
      if (spec.signal?.aborted) throw error;
      // E2B may finish allocating after its HTTP response exceeds the client
      // deadline. Reconcile provider truth before allowing Temporal to retry;
      // otherwise every retry can allocate another paid sandbox for one task.
      const recovered = await this.findProvisioningSandbox(metadata, connectionOptions).catch(() => undefined);
      if (recovered) {
        adopted = true;
        return recovered;
      }
      throw error;
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    this.states.set(sandbox.sandboxId, 'ready');
    try {
      spec.signal?.throwIfAborted();
      const provisioner = provisionTarget(sandbox, spec.signal);
      // A recovered sandbox never escaped this create activity, so anything in
      // its workspace is an incomplete provisioning attempt, not user work.
      if (adopted) await provisionRun(provisioner, `rm -rf ${ROOT} && mkdir -p ${ROOT}`);
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
      return new E2BWorld(handle, sandbox, this.idleMs, () => {
        this.sandboxes.delete(sandbox.sandboxId);
        this.states.delete(sandbox.sandboxId);
        this.destroyed.add(handle);
      });
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      this.sandboxes.delete(sandbox.sandboxId);
      this.states.delete(sandbox.sandboxId);
      throw error;
    }
  }

  async open(handle: WorldHandle): Promise<World> {
    const reference = this.refOf(handle);
    const sandboxId = reference.sandboxId;
    let sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox || this.states.get(sandboxId) === 'parked') {
      const connection = await this.connection(reference.organizationId);
      sandbox = await timed('e2b.connect', () => this.factory.connect(sandboxId, { timeoutMs: this.idleMs,
        requestTimeoutMs: envPositiveInt('KARMAX_E2B_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
        ...(handle.meta?.environmentFlavor === 'desktop' ? { desktop: true } : {}),
        ...(connection?.apiKey ? { apiKey: connection.apiKey } : {}) }));
      this.sandboxes.set(sandboxId, sandbox);
    }
    this.states.set(sandboxId, 'ready');
    return new E2BWorld(handle, sandbox, this.idleMs, () => {
        this.sandboxes.delete(sandbox.sandboxId);
        this.states.delete(sandbox.sandboxId);
        this.destroyed.add(handle);
      });
  }

  async park(handle: WorldHandle): Promise<WorldHandle> {
    const reference = this.refOf(handle);
    const sandboxId = reference.sandboxId;
    if (this.states.get(sandboxId) === 'parked') return handle;
    const connection = (await this.connection(reference.organizationId));
    const sandbox = this.sandboxes.get(sandboxId) ?? await this.factory.connect(sandboxId, { timeoutMs: this.idleMs,
      requestTimeoutMs: envPositiveInt('KARMAX_E2B_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
      ...(handle.meta?.environmentFlavor === 'desktop' ? { desktop: true } : {}),
      ...(connection?.apiKey ? { apiKey: connection.apiKey } : {}) });
    await timed('e2b.pause', () => sandbox.pause());
    this.sandboxes.set(sandboxId, sandbox);
    this.states.set(sandboxId, 'parked');
    return handle;
  }

  async status(handle: WorldHandle): Promise<WorldLifecycleState> {
    if (this.destroyed.has(handle)) return 'missing';
    const id = this.sandboxIdOf(handle);
    if (this.states.has(id)) return this.states.get(id)!;
    return 'ready'; // after a process restart the durable provider is authoritative on connect
  }

  /** Reconciliation probe: asks the control plane, never connect() — connecting
   * to an auto-resume sandbox would silently resume (and bill) a paused world. */
  async probe(handle: WorldHandle): Promise<WorldLifecycleState | undefined> {
    if (!this.factory.info) return undefined;
    const reference = this.refOf(handle);
    const connection = (await this.connection(reference.organizationId));
    try {
      const info = await this.factory.info(reference.sandboxId, connection?.apiKey ? { apiKey: connection.apiKey } : {});
      const state = String(info?.state ?? '').toLowerCase();
      if (!state) return undefined;
      if (['paused', 'pausing', 'stopped', 'stopping'].includes(state)) return 'parked';
      if (['running', 'starting', 'resuming', 'ready'].includes(state)) return 'ready';
      return 'missing';
    } catch (error) {
      return isMissingSandbox(error) ? 'missing' : undefined;
    }
  }

  /** Every live sandbox this deployment created, for the lifecycle sweep's
   * orphan reaper. Filtered server-side on the `karmaxHome` metadata so a
   * shared E2B account's other tenants are never even enumerated. */
  async listSandboxes(organizationId?: string): Promise<ProviderSandboxRef[]> {
    if (!this.factory.list) return [];
    const connection = (await this.connection(organizationId));
    const apiKey = connection?.apiKey ? { apiKey: connection.apiKey } : {};
    const listed = await this.factory.list({ ...apiKey, metadata: { karmaxHome: serviceHomeLabel() } });
    return listed.map((sandbox) => ({
      sandboxId: sandbox.sandboxId,
      ...(sandbox.metadata?.karmaxTaskId ? { taskId: sandbox.metadata.karmaxTaskId } : {}),
      matches: (handle) => {
        try { return handle.kind === this.kind && this.sandboxIdOf(handle as WorldHandle) === sandbox.sandboxId; }
        catch { return undefined; }
      },
      destroy: async () => {
        if (this.factory.kill) await this.factory.kill(sandbox.sandboxId, apiKey);
        else await (await this.factory.connect(sandbox.sandboxId, { timeoutMs: this.idleMs, ...apiKey })).kill();
        this.sandboxes.delete(sandbox.sandboxId);
        this.states.delete(sandbox.sandboxId);
      },
    }));
  }

  /** E2B pause/kill events carry the exact execution time and actual template
   * resources. Those are the billable intervals; a karmax runner lease is only
   * admission capacity and can outlive an auto-paused sandbox by days. */
  async listUsageEvents(organizationId: string): Promise<ProviderUsageEvent[]> {
    if (!this.factory.events) return [];
    const connection = (await this.connection(organizationId));
    const events = await this.factory.events(connection?.apiKey ? { apiKey: connection.apiKey } : {});
    const home = serviceHomeLabel();
    const normalized: ProviderUsageEvent[] = [];
    for (const raw of events) {
      const event = raw as any;
      if (!['sandbox.lifecycle.paused', 'sandbox.lifecycle.killed'].includes(String(event.type ?? ''))) continue;
      const data = event.event_data ?? event.eventData;
      const execution = data?.execution;
      const metadata = data?.sandbox_metadata ?? data?.sandboxMetadata;
      if (!execution || metadata?.karmaxHome !== home) continue;
      const id = String(event.sandbox_execution_id ?? event.sandboxExecutionId ?? '');
      const sandboxId = String(event.sandbox_id ?? event.sandboxId ?? '');
      const activeMs = Number(execution.execution_time ?? execution.executionTime);
      const startedAt = Date.parse(String(execution.started_at ?? execution.startedAt ?? ''));
      const eventAt = Date.parse(String(event.timestamp ?? ''));
      const cpu = Number(execution.vcpu_count ?? execution.vcpuCount);
      const memoryMb = Number(execution.memory_mb ?? execution.memoryMb);
      if (!id || !sandboxId || !Number.isFinite(activeMs) || activeMs < 0
        || !Number.isFinite(startedAt) || !Number.isFinite(eventAt)
        || !Number.isFinite(cpu) || cpu <= 0 || !Number.isFinite(memoryMb) || memoryMb < 0) continue;
      normalized.push({ id, sandboxId,
        ...(typeof metadata?.karmaxTaskId === 'string' && metadata.karmaxTaskId
          ? { taskId: metadata.karmaxTaskId } : {}),
        startedAt, endedAt: startedAt + activeMs, activeMs, cpu, memoryMb });
    }
    return normalized;
  }

  private sealRef(value: Record<string, string>): string {
    if (this.referenceKeys) return this.referenceKeys.seal(value);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.refKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from('KWR1'), iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  private openRef(value: string): Record<string, string> {
    if (value.startsWith('KWR2.') && this.referenceKeys) return this.referenceKeys.open(value);
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

  /** Adopt an unregistered sandbox created by an earlier indeterminate request.
   * The generation makes this safe across discard/recreate cycles. A one-time
   * legacy lookup recovers sandboxes created immediately before this metadata
   * key shipped (including in-flight activities during a worker roll). */
  private async findProvisioningSandbox(
    metadata: Record<string, string>,
    options: { timeoutMs: number; requestTimeoutMs: number; apiKey?: string; desktop?: boolean; signal?: AbortSignal },
  ): Promise<E2BSandboxLike | undefined> {
    if (!this.factory.list) return undefined;
    const api = {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      requestTimeoutMs: options.requestTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    let matches = await this.factory.list({ ...api, metadata });
    if (!matches.length) {
      const { karmaxGeneration: _generation, ...legacy } = metadata;
      const candidates = await this.factory.list({ ...api, metadata: legacy });
      matches = candidates.filter((candidate) => !candidate.metadata?.karmaxGeneration
        || candidate.metadata.karmaxGeneration === metadata.karmaxGeneration);
    }
    if (!matches.length) return undefined;
    if (matches.length > 1) {
      // No candidate has been registered yet, so none contains user work. Clear
      // ambiguous duplicates instead of choosing one arbitrarily and leaking the
      // rest; the caller will make one clean replacement on its next retry.
      if (this.factory.kill) await Promise.all(matches.map((candidate) =>
        this.factory.kill!(candidate.sandboxId, options.apiKey ? { apiKey: options.apiKey } : {}).catch(() => undefined)));
      throw new Error(`multiple E2B sandboxes exist for task generation ${metadata.karmaxTaskId}/${metadata.karmaxGeneration}`);
    }
    return this.factory.connect(matches[0]!.sandboxId, options);
  }

  private async connection(organizationId: string | undefined): Promise<ResolvedWorldProviderConnection | undefined> {
    if (this.resolveConnection) return (await this.resolveConnection(organizationId, this.kind));
    return process.env.E2B_API_KEY ? { organizationId, provider: this.kind, apiKey: process.env.E2B_API_KEY,
      config: { template: this.template, desktopTemplate: this.desktopTemplate } } : undefined;
  }
}

class E2BWorld implements World {
  constructor(public handle: WorldHandle, private sandbox: E2BSandboxLike, private idleMs: number, private onDestroy: () => void) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const line = [cmd, ...args].map(shellQuote).join(' ');
    const runOpts = { cwd: this.cwd(opts.cwd), envs: this.remoteEnv(opts.env), timeoutMs: opts.timeoutMs ?? 120_000 };
    // STDIN path (a secret fed to an in-world helper, kept out of argv/env/files
    // where the co-resident agent could read it): start in the background with
    // stdin open, push the input, signal EOF, then await completion.
    if (opts.input !== undefined) {
      try {
        const handle: any = await (this.sandbox.commands.run as any)(line, { ...runOpts, background: true, stdin: true });
        try {
          await handle.sendStdin(opts.input);
          await handle.closeStdin();
        } catch (stdinError) {
          // A command that exits before reading its input (missing file or
          // binary) leaves only a stale pid behind; its own exit explains why.
          if (await handle.kill().catch(() => false)) throw stdinError;
        }
        const result: any = await handle.wait();
        return { stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? ''),
          code: Number(result?.exitCode ?? 0) };
      } catch (error: any) {
        return commandErrorResult(error);
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
      return commandErrorResult(error);
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
      // wait() rejects with CommandExitError for every nonzero exit; its stderr
      // has already streamed. Only a lost stream has no status of its own.
      const code = processExitCode(error);
      if (code === undefined) emit(error?.message ?? error);
      exited = true;
      exitCode = code ?? -1;
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
    const exits = new Set<(code: number | null, termination?: WorldPtyTermination) => void>();
    const pending: string[] = [];
    let attached = false;
    let exited = false;
    let exitCode: number | null = null;
    let termination: WorldPtyTermination | undefined;
    let closed = false;
    const onData = (data: unknown) => {
      const chunk = sdkText(data);
      if (!attached) pending.push(chunk);
      for (const listener of outputs) listener(chunk);
    };
    let terminal = await this.sandbox.pty.create({
      cols: spec.cols ?? 80,
      rows: spec.rows ?? 24,
      cwd: this.cwd(spec.cwd),
      envs: this.remoteEnv(spec.env),
      timeoutMs: 0,
      onData,
    });
    const remotePid = Number(terminal.pid);
    const stopKeepAlive = this.keepAlive();
    if (spec.command) await sandbox.pty.sendInput(remotePid, new TextEncoder().encode(`${spec.command}\n`));
    let reattached: number[] = [];
    const follow = () => void Promise.resolve(terminal.wait?.()).then((result) => {
      stopKeepAlive();
      const code = Number(result?.exitCode ?? result?.code ?? 0);
      exited = true;
      exitCode = code;
      for (const listener of exits) listener(code);
    }).catch(async (error) => {
      const ending = ptyEnding(error);
      reattached = reattached.filter((at) => Date.now() - at < REATTACH_WINDOW_MS);
      if (ending.termination && 'lost' in ending.termination && !closed && reattached.length < REATTACH_LIMIT) {
        reattached.push(Date.now());
        const again = await this.reattachPty(remotePid, onData).catch(() => undefined);
        if (again && !closed) { terminal = again; return follow(); }
        if (again) void again.disconnect?.();
      }
      stopKeepAlive();
      exited = true;
      ({ code: exitCode, termination } = ending);
      for (const listener of exits) listener(exitCode, termination);
    });
    follow();
    return {
      onData(listener) {
        outputs.add(listener);
        if (!attached) { attached = true; for (const chunk of pending.splice(0)) listener(chunk); }
        return () => outputs.delete(listener);
      },
      onExit(listener) {
        if (exited) queueMicrotask(() => listener(exitCode, termination));
        else exits.add(listener);
        return () => exits.delete(listener);
      },
      async write(data) { await sandbox.pty.sendInput(remotePid, new TextEncoder().encode(data)); },
      async resize(cols, rows) { await sandbox.pty.resize(remotePid, { cols, rows }); },
      async close() {
        closed = true;
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
    this.onDestroy();
  }

  /** E2B pauses a sandbox when its plan's continuous-runtime cap expires (one
   * hour on Hobby, whatever timeout karmax requests; task 350). The pause drops
   * every stream into the sandbox but its processes survive it, so resume the
   * sandbox, which starts a new runtime window, and follow the same PTY. A
   * sandbox frozen by memory exhaustion fails these bounded requests instead. */
  private async reattachPty(pid: number, onData: (data: unknown) => void): Promise<any> {
    if (!this.sandbox.pty.connect) return undefined;
    await this.sandbox.connect?.({ timeoutMs: this.idleMs, requestTimeoutMs: REATTACH_REQUEST_MS });
    return this.sandbox.pty.connect(pid, { onData, timeoutMs: 0, requestTimeoutMs: REATTACH_REQUEST_MS });
  }

  /** Reads the sandbox's own metrics from E2B's control plane, which keeps
   * answering while memory exhaustion has frozen envd (tasks 348 and 349). */
  async diagnose({ since, now = Date.now() }: { since: number; now?: number }): Promise<WorldDiagnosis | undefined> {
    if (!this.sandbox.getMetrics) return undefined;
    try {
      const samples = await withTimeout(this.sandbox.getMetrics({ start: new Date(now - DIAGNOSIS_WINDOW_MS), end: new Date(now) }), 10_000);
      return diagnoseMetrics(samples.map((s) => ({ at: new Date(s.timestamp).getTime(), memUsed: s.memUsed, memTotal: s.memTotal })), { since, now });
    } catch {
      return undefined; // diagnosis must never replace the failure it explains
    }
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

/** Go's signal names, as envd reports a signalled process ("signal: killed"). */
const ENVD_SIGNALS: Record<string, NodeJS.Signals> = {
  killed: 'SIGKILL', terminated: 'SIGTERM', interrupt: 'SIGINT', hangup: 'SIGHUP', quit: 'SIGQUIT',
  aborted: 'SIGABRT', 'segmentation fault': 'SIGSEGV', 'bus error': 'SIGBUS', 'broken pipe': 'SIGPIPE',
  'illegal instruction': 'SIGILL', 'floating point exception': 'SIGFPE', 'alarm clock': 'SIGALRM',
};

/** envd ends a signalled PTY with exit -1 and names the signal in `error`; a
 * rejection without an exit status means the stream, not the process, ended. */
function ptyEnding(error: any): { code: number | null; termination?: WorldPtyTermination } {
  if (typeof error?.exitCode !== 'number') return { code: null, termination: { lost: error instanceof Error ? error : new Error(String(error)) } };
  const signal = error.exitCode === -1
    ? ENVD_SIGNALS[/^signal: (.+?)(?: \(core dumped\))?$/.exec(String(error.error ?? error.message ?? ''))?.[1] ?? '']
    : undefined;
  return signal ? { code: null, termination: { signal } } : { code: error.exitCode };
}

/** The status of a background process that exited nonzero; undefined when the
 * stream ended without one or envd reports a signal (-1). */
function processExitCode(error: any): number | undefined {
  const code = error?.exitCode;
  return typeof code === 'number' && Number.isInteger(code) && code >= 0 ? code : undefined;
}

/** E2B uses CommandExitError with a numeric exitCode for ordinary process
 * failures. Timeout/socket/control-plane failures have no numeric process exit;
 * rethrow those intact so the activity boundary can inspect their structured
 * code/cause instead of receiving an invalid `ExecResult.code = NaN`. */
function commandErrorResult(error: any): ExecResult {
  const code = Number(error?.exitCode ?? error?.code);
  if (!Number.isFinite(code)) throw error;
  return {
    stdout: String(error?.stdout ?? ''),
    stderr: String(error?.stderr ?? error?.message ?? error),
    code,
  };
}

/** Trusted-provisioning adapter over the sandbox SDK. Never catches: real SDK
 * errors (including nonzero-exit throws) must reach the caller unchanged. */
function provisionTarget(sandbox: E2BSandboxLike, signal?: AbortSignal): ProvisionTarget {
  return {
    async run(command, timeoutMs) {
      try {
        const result = await sandbox.commands.run(command, { timeoutMs, ...(signal ? { signal } : {}) });
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
    async events(options) {
      const result: unknown[] = [];
      // E2B retains seven days. Drain every page on each sweep; the store's
      // provider-execution key makes overlap/restarts harmless and avoids a
      // fragile offset cursor while new events are arriving at the front.
      for (let offset = 0; offset < 50_000; offset += 100) {
        const query = new URLSearchParams({ limit: '100', offset: String(offset), orderAsc: 'false' });
        query.append('types', 'sandbox.lifecycle.paused');
        query.append('types', 'sandbox.lifecycle.killed');
        const response = await fetch(`https://api.e2b.app/events/sandboxes?${query}`, {
          headers: options.apiKey ? { 'X-API-Key': options.apiKey } : {},
        });
        if (!response.ok) throw new Error(`E2B lifecycle events failed (${response.status})`);
        const body: any = await response.json();
        const page = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [];
        result.push(...page);
        if (page.length < 100) break;
      }
      return result;
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
