import crypto from 'node:crypto';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { WorldReferenceKeys } from '../reference-keys.js';
import type { ResolvedWorldProviderConnection } from '../connections.js';
import type { MachineShape } from '../../domain/computer.js';
import { providerFeatures } from '../../domain/computer-limits.js';
import type { ProviderSandboxRef, ProviderUsagePage, ProviderUsageEvent, World, WorldDiagnosis, WorldHandle,
  WorldLifecycleState, WorldProvider, WorldSpec } from '../types.js';
import { serviceHomeLabel } from '../services.js';
import { provisionGitCredentials, provisionGitRepos, runOrThrow, provisionTimeoutMs, type ProvisionTarget } from '../provision-git.js';
import { taskBranch } from '../../domain/brand.js';
import { timed } from '../../timing/index.js';
import { ProviderOutage } from '../../agent/limits.js';
import { generateSshKeyPair, quote, SshTransport, VmTransportError, type SshEndpoint } from './ssh.js';
import { VmWorld } from './world.js';
import { VM_HOME, VM_USER, vmProvisionFailure, vmProvisionScript, vmProvisionStamp } from './provision.js';

/** What a VM world's machine is: CPU, memory, and the size of its volume. */
export interface VmShape { cpu: number; memoryMb: number; diskGb: number }

/** What karmax delivers to a machine at every boot (`vm/provision.ts`). */
export interface VmBootKeys {
  /** OpenSSH private key the machine presents as its host key. */
  hostPrivateKey: string;
  /** The world's client key, the only one sshd accepts. */
  authorizedKey: string;
}

export interface VmAllocation {
  /** Driver-owned identity of the machine and its volume, sealed into the handle. */
  ref: Record<string, string>;
  warnings?: string[];
}

export interface VmListing {
  id: string;
  taskId?: string;
  generation?: string;
  ref: Record<string, string>;
  destroy(): Promise<void>;
}

/**
 * A cloud's control plane for VM worlds: machines and their volumes. The
 * generic `VmWorldProvider` owns keys, SSH, provisioning, Git, and the World;
 * a driver only creates, starts, stops and deletes things, and reports them.
 */
export interface VmDriver {
  readonly kind: string;
  readonly name: string;
  /** The machine for a Computer: the provider's nearest size that covers it.
   * Throws (a message for people) when the account cannot provide it. */
  shape(resources: MachineShape | undefined, connection: ResolvedWorldProviderConnection): VmShape | Promise<VmShape>;
  /** Create the volume and the machine, booted with `keys`. Labels name the
   * world (`karmaxHome`, `karmaxTaskId`, `karmaxGeneration`, …). */
  allocate(connection: ResolvedWorldProviderConnection, request: {
    labels: Record<string, string>; shape: VmShape; keys: VmBootKeys; signal?: AbortSignal;
  }): Promise<VmAllocation>;
  /** Where sshd answers for this machine now (an address can change on wake). */
  endpoint(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<Pick<SshEndpoint, 'host' | 'port' | 'tls'>>;
  /** Wake a parked machine at `shape` (CPU and memory may have changed). */
  start(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape, keys: VmBootKeys): Promise<void>;
  /** A new machine on the same volume, for one that started but never answers SSH. */
  replace?(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape, keys: VmBootKeys): Promise<void>;
  /** Stop paying for compute; keep the volume. */
  stop(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void>;
  /** Delete the machine and its volume. A missing one is already gone. */
  destroy(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void>;
  /** Grow the volume to `diskGb`, in place; false when it is already that large. Never shrinks. */
  growDisk(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, diskGb: number): Promise<boolean>;
  state(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<WorldLifecycleState | undefined>;
  /** Machines carrying this deployment's `karmaxHome` label. */
  list(connection: ResolvedWorldProviderConnection, home: string): Promise<VmListing[]>;
  /** Whether two references name the same world (its volume). */
  same(a: Record<string, string>, b: Record<string, string>): boolean;
  usage?(connection: ResolvedWorldProviderConnection, home: string, since?: number): Promise<ProviderUsageEvent[]>;
  /** Periodic upkeep (deferred deletes, stale builders), once per sweep. */
  housekeep?(connection: ResolvedWorldProviderConnection, home: string): Promise<void>;
  diagnose?(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, window: { since: number; now: number }): Promise<WorldDiagnosis | undefined>;
  /** Check the credential without creating anything billable. */
  test(connection: ResolvedWorldProviderConnection): Promise<void>;
}

type Resolver = (organizationId: string | undefined, provider: string) => ResolvedWorldProviderConnection | Promise<ResolvedWorldProviderConnection>;

/** How long a new or woken machine may take to answer SSH (a stock image installs sshd first). */
const REACHABLE_MS = 6 * 60_000;
const PROVISION_MS = 25 * 60_000;

/**
 * A World provider over any cloud that rents Linux VMs with attachable
 * volumes (SPEC §11.1). The world's files live on the volume, mounted as the
 * VM user's home: parking stops the machine (no compute billing) and keeps
 * the volume, so waking needs no checkpoint restore and keeps everything —
 * Git-ignored files, caches, data — and the disk grows in place. Checkpoints
 * remain for forks and recovery, as on every provider.
 */
export class VmWorldProvider implements WorldProvider {
  readonly kind: string;
  readonly parkable = true;
  readonly parkStopsProcesses = true;
  // No network policy: the VM user has root (as on E2B), so an in-VM firewall
  // would be advisory. Restricted networks are refused up front instead.
  readonly capabilities = { remote: true, pty: true, snapshots: true, ports: true, networkPolicy: false } as const;
  private states = new Map<string, WorldLifecycleState>();
  private transports = new Map<string, SshTransport>();
  private destroyed = new WeakSet<WorldHandle>();

  constructor(readonly driver: VmDriver, private resolveConnection: Resolver, private referenceKeys?: WorldReferenceKeys,
    private options: {
      reachableMs?: number;
      /** Test seams: how SSH reaches a machine, and the machine's user, home and provisioning. */
      socket?: (endpoint: SshEndpoint) => Promise<Duplex>;
      user?: string;
      home?: string;
      provision?: { stamp: string; script: string; sudo: boolean };
    } = {}) {
    this.kind = driver.kind;
  }

  async create(spec: WorldSpec): Promise<World> {
    spec.signal?.throwIfAborted();
    const features = providerFeatures(this.kind);
    if (!features.allowlist && spec.network && !spec.network.unrestricted)
      throw new Error(`${this.driver.name} computers have unrestricted outbound network. Choose E2B or Daytona for an allowlist.`);
    if (!features.desktop && spec.environment?.flavor === 'desktop')
      throw new Error(`${this.driver.name} computers are headless. Choose E2B or Daytona for a desktop.`);
    const connection = await this.connection(spec.organizationId);
    const shape = await this.driver.shape(spec.resources, connection);
    const labels = { karmaxHome: serviceHomeLabel(), karmaxTaskId: spec.taskId, karmaxGeneration: String(spec.generation ?? 1),
      ...(spec.organizationId ? { karmaxOrganizationId: spec.organizationId } : {}) };
    // An earlier attempt of this create (a retried activity) may have left a
    // machine. Its keys died with that attempt and it never held user work:
    // delete it rather than adopt it, so one task never bills for two.
    for (const stale of await this.driver.list(connection, labels.karmaxHome))
      if (stale.taskId === spec.taskId && stale.generation === labels.karmaxGeneration) await stale.destroy();
    const host = generateSshKeyPair('karmax-host');
    const client = generateSshKeyPair(`karmax-${spec.taskId}`);
    const keys: VmBootKeys = { hostPrivateKey: host.privateKey, authorizedKey: client.publicKey };
    const allocation = await timed(`${this.kind}.allocate`, () => this.driver.allocate(connection, { labels, shape, keys, signal: spec.signal }));
    const sealed = { ...allocation.ref, generation: labels.karmaxGeneration, sshKey: client.privateKey, clientKey: client.publicKey, hostKey: host.publicKey,
      hostPrivateKey: host.privateKey, ...(spec.organizationId ? { organizationId: spec.organizationId } : {}) };
    try {
      const transport = this.transportFor(spec.taskId, connection, sealed);
      await timed(`${this.kind}.reachable`, () => waitReachable(transport, this.options.reachableMs ?? REACHABLE_MS, spec.signal));
      await this.ensureProvisioned(transport, spec.signal);
      // The platform runs the project's setup and boot hooks on this boot, right after.
      await this.markHooksRan(transport);
      const target = provisionTarget(transport, spec.signal);
      const home = this.home();
      const root = path.posix.join(home, 'karmax');
      await runOrThrow(target, `mkdir -p ${quote(root)}`);
      await provisionGitCredentials(target, spec, home);
      const provisioned = await provisionGitRepos(target, spec, {
        root, home,
        sshUrlError: `${this.driver.name} worlds require repositories as SSH Git URLs, not local paths or HTTPS URLs`,
        copyGlobsWarning: `copyGlobs are host-local and were not copied into the ${this.driver.name} world`,
      });
      await runOrThrow(target, `rm -f ${quote(home)}/.ssh/karmax-auth*`);
      spec.signal?.throwIfAborted();
      const handle: WorldHandle = {
        version: 2, kind: this.kind, provider: this.kind, id: spec.taskId, root: provisioned.root ?? root, workspaceRoot: provisioned.root ?? root,
        branch: spec.branch ?? taskBranch(spec.taskId), base: provisioned.repos[0]?.base ?? spec.base,
        target: provisioned.repos[0]?.target ?? spec.target, repo: provisioned.repos[0]?.repo, repos: provisioned.repos,
        ...(provisioned.workdir ? { workdir: provisioned.workdir } : {}),
        sealedProviderRef: this.seal(sealed),
        meta: { releaseOnCompletion: true, environmentFlavor: 'headless', machine: shape,
          ...(provisioned.ephemeralPaths.length ? { ephemeralPaths: provisioned.ephemeralPaths } : {}) },
        ...([...(allocation.warnings ?? []), ...provisioned.warnings].length
          ? { warnings: [...(allocation.warnings ?? []), ...provisioned.warnings] } : {}),
      };
      this.states.set(spec.taskId, 'ready');
      return this.world(handle, connection, sealed, transport);
    } catch (error) {
      this.dropTransport(spec.taskId);
      await this.driver.destroy(connection, allocation.ref).catch(() => undefined);
      throw error;
    }
  }

  async open(handle: WorldHandle): Promise<World> {
    const sealed = this.reference(handle);
    const connection = await this.connection(sealed.organizationId);
    let transport = this.transports.get(handle.id);
    if (!transport || this.states.get(handle.id) === 'parked') {
      const state = await this.driver.state(connection, sealed);
      if (state === 'missing') throw Object.assign(new Error(`the ${this.driver.name} machine of this world no longer exists`), { status: 404 });
      transport = this.transportFor(handle.id, connection, sealed);
      if (state !== 'ready') {
        const shape = await this.shapeOf(handle, connection);
        try {
          await timed(`${this.kind}.start`, () => this.driver.start(connection, sealed, shape, keysOf(sealed)));
          transport.reset();
          const reachable = () => timed(`${this.kind}.reachable`, () => waitReachable(transport!, this.options.reachableMs ?? REACHABLE_MS));
          try { await reachable(); }
          catch (error) {
            // A machine that never answers is broken, not busy; the world is its volume.
            if (!(error instanceof MachineUnreachable) || !this.driver.replace) throw error;
            console.warn(`[${this.kind}] ${handle.id}: the woken machine never answered SSH, so it is replaced`);
            await timed(`${this.kind}.replace`, () => this.driver.replace!(connection, sealed, shape, keysOf(sealed)));
            transport.reset();
            await reachable();
          }
          await this.ensureProvisioned(transport);
        } catch (error) {
          // A wake that fails leaves the world as it found it, parked: not a
          // machine billing for nothing until someone notices.
          this.dropTransport(handle.id);
          await this.driver.stop(connection, sealed).catch(() => undefined);
          this.states.set(handle.id, 'parked');
          throw error;
        }
      } else {
        // Running, but this process has not reached it yet: another one may
        // have just woken it, and it is still booting. Answers at once if not.
        await timed(`${this.kind}.reachable`, () => waitReachable(transport!, this.options.reachableMs ?? REACHABLE_MS));
      }
      this.states.set(handle.id, 'ready');
      const world = this.world(handle, connection, sealed, transport);
      await this.replayHooks(world, transport);
      return world;
    }
    this.states.set(handle.id, 'ready');
    return this.world(handle, connection, sealed, transport);
  }

  async park(handle: WorldHandle): Promise<WorldHandle> {
    const sealed = this.reference(handle);
    if (this.states.get(handle.id) === 'parked') return handle;
    const connection = await this.connection(sealed.organizationId);
    this.dropTransport(handle.id);
    await timed(`${this.kind}.stop`, () => this.driver.stop(connection, sealed));
    this.states.set(handle.id, 'parked');
    return handle;
  }

  async destroy(handle: WorldHandle): Promise<void> {
    const sealed = this.reference(handle);
    const connection = await this.connection(sealed.organizationId);
    this.dropTransport(handle.id);
    await this.driver.destroy(connection, sealed);
    this.states.delete(handle.id);
    this.destroyed.add(handle);
  }

  async status(handle: WorldHandle): Promise<WorldLifecycleState> {
    if (this.destroyed.has(handle)) return 'missing';
    this.reference(handle); // an unreadable reference must fail here, as on E2B
    return this.states.get(handle.id) ?? 'ready';
  }

  async probe(handle: WorldHandle): Promise<WorldLifecycleState | undefined> {
    const sealed = this.reference(handle);
    try { return await this.driver.state(await this.connection(sealed.organizationId), sealed); }
    catch { return undefined; }
  }

  /**
   * Resize in place. The volume grows now, even under a running agent, and
   * its filesystem with it; CPU and memory take effect at the machine's next
   * start (a park and wake), with nothing lost — everything is on the volume.
   */
  async resize(handle: WorldHandle, to: MachineShape): Promise<{ disk: 'grown' | 'unchanged'; restart: boolean; machine: VmShape }> {
    const sealed = this.reference(handle);
    const connection = await this.connection(sealed.organizationId);
    const made = (handle.meta?.machine as VmShape | undefined) ?? await this.driver.shape(handle.meta?.computer as MachineShape | undefined, connection);
    const next = await this.driver.shape({ cpu: to.cpu ?? made.cpu, memoryMb: to.memoryMb ?? made.memoryMb, diskGb: Math.max(to.diskGb ?? 0, made.diskGb) }, connection);
    // The volume's own size decides: an earlier resize may already have grown it.
    const grown = next.diskGb > made.diskGb && await this.driver.growDisk(connection, sealed, next.diskGb);
    // A running machine grows its filesystem now (the boot script does it on a stopped one).
    if (grown && await this.driver.state(connection, sealed).catch(() => undefined) === 'ready')
      await growFilesystem(this.transportFor(handle.id, connection, sealed), this.home()).catch(() => undefined);
    return { disk: grown ? 'grown' : 'unchanged', restart: next.cpu !== made.cpu || next.memoryMb !== made.memoryMb,
      machine: { cpu: made.cpu, memoryMb: made.memoryMb, diskGb: next.diskGb } };
  }

  async listSandboxes(organizationId?: string): Promise<ProviderSandboxRef[]> {
    const connection = await this.connection(organizationId);
    return (await this.driver.list(connection, serviceHomeLabel())).map((listing) => ({
      sandboxId: listing.id,
      ...(listing.taskId ? { taskId: listing.taskId } : {}),
      matches: (handle) => {
        try { return handle.kind === this.kind && this.driver.same(this.reference(handle as WorldHandle), listing.ref); }
        catch { return undefined; }
      },
      destroy: async () => { await listing.destroy(); if (listing.taskId) this.dropTransport(listing.taskId); },
    }));
  }

  async listUsageEvents(organizationId: string, since?: number): Promise<ProviderUsagePage> {
    if (!this.driver.usage) return { events: [] };
    return { events: await this.driver.usage(await this.connection(organizationId), serviceHomeLabel(), since) };
  }

  async housekeep(organizationId?: string): Promise<void> {
    await this.driver.housekeep?.(await this.connection(organizationId), serviceHomeLabel());
  }

  private world(handle: WorldHandle, connection: ResolvedWorldProviderConnection, sealed: Record<string, string>, transport: SshTransport): World {
    return new VmWorld(handle, transport, this.home(), {
      destroy: async () => {
        this.dropTransport(handle.id);
        await this.driver.destroy(connection, sealed);
        this.states.delete(handle.id);
        this.destroyed.add(handle);
      },
      ...(this.driver.diagnose ? { diagnose: (window) => this.driver.diagnose!(connection, sealed, window) } : {}),
    });
  }

  /** Provision a machine that has not run this exact provisioning yet: a
   * stock image does it once, an image or snapshot built with it never. The
   * script runs detached and is polled: minutes of package installs must not
   * hang on one SSH channel (on Fly a dropped connection killed it). */
  private async ensureProvisioned(transport: SshTransport, signal?: AbortSignal): Promise<void> {
    const provision = this.options.provision ?? { stamp: vmProvisionStamp(), script: vmProvisionScript(), sudo: true };
    if ((await transport.exec(`test -f ${quote(provision.stamp)}`, { timeoutMs: 30_000 })).code === 0) return;
    await timed(`${this.kind}.provision`, () => runDetached(transport, provision.script, provision.sudo, PROVISION_MS, signal)
      .catch((error) => { throw new Error(`provisioning the ${this.driver.name} machine failed: ${error instanceof Error ? error.message : String(error)}`); }));
  }

  /**
   * A VM keeps its files across a park, not its processes, and a Hetzner
   * server parked past its paid hour comes back as a new server: everything
   * outside the volume (the project's apt packages, say) is the snapshot's
   * again. So, as E2B's resume keeps a sandbox as it was, a woken machine
   * replays what the platform ran when the world was made (`machineHooks`,
   * project-runtime.ts): the boot hooks after every restart, and setup too on
   * a root disk that never ran it. A marker on the root disk holds the boot id
   * they last ran under; it is written after they finish, so an interrupted
   * replay runs again at the next open. Failures are warnings, as at create.
   */
  private async replayHooks(world: World, transport: SshTransport): Promise<void> {
    const hooks = world.handle.meta?.machineHooks as { setup?: string[]; boot?: string[] } | undefined;
    const probe = await transport.exec(`cat /proc/sys/kernel/random/boot_id; cat ${quote(this.hooksMark())} 2> /dev/null || true`, { timeoutMs: 30_000 });
    const [boot = '', ran = ''] = probe.stdout.toString().split('\n').map((line) => line.trim());
    if (ran === boot) return;
    const commands = [...(ran ? [] : hooks?.setup ?? []), ...(hooks?.boot ?? [])];
    for (const command of commands) {
      const result = await timed(`${this.kind}.hooks`, () => world.exec('bash', ['-lc', command], { timeoutMs: 30 * 60_000 }));
      if (result.code !== 0)
        console.warn(`[${this.kind}] ${world.handle.id}: environment command "${command}" failed after a restart: ${(result.stderr || result.stdout).slice(-300)}`);
    }
    await this.markHooksRan(transport);
  }

  private async markHooksRan(transport: SshTransport): Promise<void> {
    const mark = this.hooksMark();
    const write = `mkdir -p ${quote(path.posix.dirname(mark))} && cat /proc/sys/kernel/random/boot_id > ${quote(mark)}`;
    const sudo = (this.options.provision ?? { sudo: true }).sudo;
    const result = await transport.exec(sudo ? `sudo -n sh -c ${quote(write)}` : write, { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`could not record the machine's boot: ${result.stderr.toString().slice(-300)}`);
  }

  /** On the root disk, beside the provisioning stamp: a new root disk has none. */
  private hooksMark(): string {
    return path.posix.join(path.posix.dirname((this.options.provision ?? { stamp: vmProvisionStamp() }).stamp), '.world-hooks-boot');
  }

  private async shapeOf(handle: WorldHandle, connection: ResolvedWorldProviderConnection): Promise<VmShape> {
    const made = handle.meta?.machine as VmShape | undefined;
    const wanted = handle.meta?.computer as MachineShape | undefined;
    // Never shrink the disk; CPU and memory follow the Computer.
    const shape = await this.driver.shape(wanted ?? made, connection);
    return made ? { ...shape, diskGb: Math.max(shape.diskGb, made.diskGb) } : shape;
  }

  private transportFor(id: string, connection: ResolvedWorldProviderConnection, sealed: Record<string, string>): SshTransport {
    let transport = this.transports.get(id);
    if (!transport) {
      transport = new SshTransport(async () => ({ ...(await this.driver.endpoint(connection, sealed)),
        hostKey: sealed.hostKey!, username: this.options.user ?? VM_USER, privateKey: sealed.sshKey! }),
      this.options.socket ? { socket: this.options.socket } : {});
      this.transports.set(id, transport);
    }
    return transport;
  }

  private dropTransport(id: string): void {
    this.transports.get(id)?.close();
    this.transports.delete(id);
  }

  private home(): string { return this.options.home ?? VM_HOME; }

  private async connection(organizationId: string | undefined): Promise<ResolvedWorldProviderConnection> {
    return this.resolveConnection(organizationId, this.kind);
  }

  private seal(value: Record<string, string>): string {
    if (!this.referenceKeys) {
      // Tests only: production always boots with the vault's reference key.
      if (process.env.NODE_ENV === 'production') throw new Error('VM world references need the world reference key');
      return `KVMT.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    }
    return this.referenceKeys.seal(value);
  }

  private reference(handle: WorldHandle): Record<string, string> {
    const sealed = handle.sealedProviderRef;
    if (!sealed) throw new Error(`invalid ${this.driver.name} world handle`);
    const value = sealed.startsWith('KVMT.') && !this.referenceKeys
      ? JSON.parse(Buffer.from(sealed.slice(5), 'base64url').toString('utf8')) as Record<string, string>
      : this.referenceKeys?.open(sealed);
    if (!value?.sshKey || !value.hostKey) throw new Error(`invalid ${this.driver.name} world handle`);
    return value;
  }
}

function keysOf(sealed: Record<string, string>): VmBootKeys {
  return { hostPrivateKey: sealed.hostPrivateKey!, authorizedKey: sealed.clientKey! };
}

/** Run a root script detached from the SSH connection and wait for its exit
 * status, riding out dropped connections and an sshd restart. */
export async function runDetached(transport: SshTransport, script: string, sudo: boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const file = `/tmp/karmax-run-${crypto.randomBytes(6).toString('hex')}.sh`;
  await transport.writeFile(file, Buffer.from(script), 0o700);
  const started = await transport.exec(`${sudo ? 'sudo -n ' : ''}setsid sh -c 'bash "$0" > "$0.log" 2>&1; echo $? > "$0.exit"' ${quote(file)} < /dev/null > /dev/null 2>&1 &`,
    { timeoutMs: 60_000 });
  if (started.code !== 0) throw new Error(`could not start (status ${started.code})`);
  const until = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    try {
      const status = await transport.exec(`cat ${quote(`${file}.exit`)} 2>/dev/null`, { timeoutMs: 30_000 });
      const code = status.stdout.toString().trim();
      if (code !== '') {
        if (code === '0') { await transport.exec(`${sudo ? 'sudo -n ' : ''}rm -f ${quote(file)} ${quote(`${file}.log`)} ${quote(`${file}.exit`)}`, { timeoutMs: 30_000 }).catch(() => undefined); return; }
        const log = await transport.exec(`tail -n 400 ${quote(`${file}.log`)}`, { timeoutMs: 30_000 }).catch(() => undefined);
        throw new Error(vmProvisionFailure(log?.stdout.toString() ?? '', code));
      }
    } catch (error) {
      if (!(error instanceof VmTransportError)) throw error;
      transport.reset(); // the machine may be restarting sshd; ask again
    }
    if (Date.now() > until) throw new Error(`still running after ${Math.round(timeoutMs / 60_000)} minutes`);
  }
}

async function growFilesystem(transport: SshTransport, home: string): Promise<void> {
  await transport.exec(`sudo -n resize2fs "$(findmnt -no SOURCE ${quote(home)})"`, { timeoutMs: 120_000 });
}

/** A machine that never answered SSH: retried as infrastructure (a new machine, or a later try). */
export class MachineUnreachable extends ProviderOutage {
  constructor(message: string) { super(message); this.name = 'MachineUnreachable'; }
}

/** Wait for sshd: a booting machine refuses or resets connections for a while. */
async function waitReachable(transport: SshTransport, ms: number, signal?: AbortSignal): Promise<void> {
  const until = Date.now() + ms;
  let last: unknown;
  for (let attempt = 0; Date.now() < until; attempt++) {
    signal?.throwIfAborted();
    try {
      const probe = await transport.exec('true', { timeoutMs: 20_000, retry: false });
      if (probe.code === 0) return;
    } catch (error) { last = error; transport.reset(); }
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 500 * (attempt + 1))));
  }
  throw new MachineUnreachable(`the machine did not answer SSH within ${Math.max(1, Math.round(ms / 60_000))} minute${ms > 90_000 ? 's' : ''}: `
    + `${last instanceof Error ? last.message : String(last)}`);
}

/** Trusted provisioning over the world's own SSH connection. */
function provisionTarget(transport: SshTransport, signal?: AbortSignal): ProvisionTarget {
  return {
    async run(command, timeoutMs) {
      signal?.throwIfAborted();
      const result = await transport.exec(`bash -c ${quote(command)}`, { timeoutMs: timeoutMs ?? provisionTimeoutMs(), ...(signal ? { signal } : {}) });
      return { stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'), code: result.code };
    },
    async writeFile(remotePath, content) {
      signal?.throwIfAborted();
      await transport.writeFile(remotePath, Buffer.isBuffer(content) ? content : Buffer.from(content), 0o600);
    },
  };
}
