import crypto from 'node:crypto';
import { Duplex } from 'node:stream';
import { Client, type ClientChannel } from 'ssh2';
import { WebSocket, createWebSocketStream } from 'ws';
import type { MachineShape } from '../domain/computer.js';
import type { ComputerLimits } from '../domain/computer-limits.js';
import type { ResolvedWorldProviderConnection } from './connections.js';
import type { ProviderUsageEvent, WorldLifecycleState } from './types.js';
import type { VmAllocation, VmBootKeys, VmDriver, VmListing, VmShape } from './vm/provider.js';
import { VM_BOOT_SCRIPT, VM_HOME, VM_SSH_PORT, VM_USER, bootFilesScript } from './vm/provision.js';
import { sshKeyPairFromSeed, type SshKeyPair } from './vm/ssh.js';
import { FINAL_USAGE_WINDOW_MS, type FinalUsage } from './vm/runs.js';
import { ProviderCapacityFull } from '../agent/limits.js';

/**
 * Agent37 (agent37.com) VMs as VM worlds (`vm/provider.ts`). An instance of
 * type `vm` is a whole machine with its own kernel (Cloud Hypervisor), its
 * billed disk mounted as the VM home (`mount_path`), so a park (stop) keeps
 * every file and bills the disk alone. It has no address of its own: the only
 * way in is Agent37's SSH tunnel, a WebSocket to `<id>-22022.agent37.app`
 * authenticated by the workspace API key, to an sshd Agent37 injects (root,
 * any workspace-registered key, a host key that changes when the instance
 * moves). karmax keeps its own trust model through it: one key per workspace,
 * derived from the API key, opens the tunnel; through it a direct-tcpip
 * channel reaches karmax's own sshd inside the VM (`vm/provision.ts`), pinned
 * to the world's host key and accepting only the world's client key, as on
 * every other VM provider.
 *
 * Agent37 has no init system in a VM: nothing runs karmax's boot script when
 * the machine boots, so every start runs it over the tunnel, and a tunnel
 * that finds karmax's sshd down (the platform moved or rebooted the machine)
 * runs it again before giving up.
 *
 * Resizing a running instance reboots it, so a disk grows at the next start
 * (`diskGrowsAtStart` in computer-limits.ts), never under a working agent.
 */

const API = 'https://api.agent37.com/v1';
const TUNNEL_PORT = 22022;
export const AGENT37_TEMPLATE = 'agent37-ubuntu';
export const AGENT37_DEFAULT_REGION = 'eu';
export const AGENT37_REGIONS = ['us', 'eu', 'ap-south'] as const;
export const AGENT37_DEFAULT_DISK_GB = 20;
export const AGENT37_MAX_DISK_GB = 100;
/** The four shapes every instance type offers (docs: instance-sizing), memory in GB. */
export const AGENT37_SHAPES = [{ cpu: 2, memory: 4 }, { cpu: 4, memory: 8 }, { cpu: 4, memory: 16 }, { cpu: 4, memory: 32 }] as const;
/** docs: billing (checked 2026-11-16): per month (730 h) at the default type's
 * rate; a `vm` meters compute at 2.5×, disk unchanged. */
const MONTH_HOURS = 730;
const VM_MULTIPLIER = 2.5;
export const AGENT37_PRICE = { cpuMonth: 0.8 * VM_MULTIPLIER, gbMonth: 0.7 * VM_MULTIPLIER, diskGbMonth: 0.09 } as const;
/** Docker's data on the world's disk: `agent37-ubuntu` keeps it in the
 * image user's home, here the overlay root, where a pull cannot even unpack. */
export const AGENT37_DOCKER_DATA = `${VM_HOME}/.karmax-docker`;

/**
 * karmax's boot (`vm/provision.ts`) as Agent37 runs it, over its own sshd as
 * root: the world's keys and boot script, then the boot script itself, which
 * leaves karmax's sshd running (a second run, while it already does, too).
 * The VM user may use the machine's Docker.
 */
export function agent37BootScript(keys: VmBootKeys, sshPort = VM_SSH_PORT): string {
  return `#!/bin/sh
# karmax on Agent37 (src/world/agent37.ts)
set -e
${bootFilesScript(keys)}
set +e
sh ${VM_BOOT_SCRIPT}
getent group docker > /dev/null && usermod -aG docker ${VM_USER}
for i in $(seq 1 50); do ss -ltn 2> /dev/null | grep -q ':${sshPort} ' && exit 0; sleep 0.2; done
echo "karmax's sshd is not listening on port ${sshPort}" >&2
exit 1
`;
}

export function agent37Shape(resources: { cpu?: number; memoryMb?: number } | undefined): { cpu: number; memory: number } {
  const cpu = resources?.cpu ?? 2;
  const memoryMb = resources?.memoryMb ?? 4096;
  const shape = AGENT37_SHAPES.find((candidate) => candidate.cpu >= cpu && candidate.memory * 1024 >= memoryMb);
  if (!shape) throw new Error(`Agent37 machines have at most 4 CPUs and 32 GB of memory, not ${cpu} CPU · ${Math.round(memoryMb / 1024)} GB`);
  return { cpu: shape.cpu, memory: shape.memory };
}

/** US dollars per hour for a running `vm` of this shape. */
export function agent37ComputeDollarsPerHour(shape: { cpu: number; memoryMb: number }): number {
  return (shape.cpu * AGENT37_PRICE.cpuMonth + shape.memoryMb / 1024 * AGENT37_PRICE.gbMonth) / MONTH_HOURS;
}

export function agent37DiskDollarsPerHour(diskGb: number): number { return diskGb * AGENT37_PRICE.diskGbMonth / MONTH_HOURS; }

/**
 * The workspace's tunnel key: one ed25519 key derived from the API key, so
 * every process (and every deployment holding the key) has the same one with
 * nothing stored. A workspace holds at most 20 SSH keys, so a key per world
 * is not an option; the world's own key is checked by karmax's sshd behind it.
 */
export function agent37AccessKey(apiKey: string): SshKeyPair {
  return sshKeyPairFromSeed(crypto.createHmac('sha256', apiKey.trim()).update('tavya agent37 tunnel key v1').digest(), 'tavya');
}

type Fetch = typeof fetch;

export interface Agent37Options {
  fetch?: Fetch;
  pollMs?: number;
  /** The tunnel's WebSocket address for an instance (tests: a local relay). */
  tunnelUrl?: (instanceId: string) => string;
  /** Who the tunnel logs in as (root on Agent37). */
  tunnelUser?: string;
  /** Where karmax's sshd listens inside the machine. */
  sshPort?: number;
  /** The root script that makes a machine reachable (tests: an unprivileged sshd). */
  bootScript?: (keys: VmBootKeys) => string;
  /** What restarts karmax's sshd on a machine that booted without it. */
  rebootCommand?: string;
}

export class Agent37Driver implements VmDriver {
  readonly kind = 'agent37';
  readonly name = 'Agent37';
  private fetchImpl: Fetch;
  private pollMs: number;
  /** Tunnel keys registered with a workspace, by key fingerprint. */
  private registered = new Map<string, Promise<void>>();

  constructor(private options: Agent37Options = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.pollMs = options.pollMs ?? 2_000;
  }

  shape(resources: MachineShape | undefined): VmShape {
    const diskGb = resources?.diskGb ?? AGENT37_DEFAULT_DISK_GB;
    if (diskGb > AGENT37_MAX_DISK_GB) throw new Error(`An Agent37 disk holds at most ${AGENT37_MAX_DISK_GB} GB, not ${diskGb} GB`);
    const shape = agent37Shape(resources);
    return { cpu: shape.cpu, memoryMb: shape.memory * 1024, diskGb: Math.max(2, Math.ceil(diskGb)) };
  }

  async allocate(connection: ResolvedWorldProviderConnection, request: { labels: Record<string, string>; shape: VmShape;
    keys: VmBootKeys; signal?: AbortSignal }): Promise<VmAllocation> {
    await this.registerAccessKey(connection);
    request.signal?.throwIfAborted();
    const region = connection.config.region ?? AGENT37_DEFAULT_REGION;
    const world = worldName(request.labels);
    let instance: Agent37Instance;
    try {
      // Answers once the machine is running (a VM boots a kernel: tens of seconds).
      instance = await this.api(connection)('POST', '/instances', {
        template: connection.config.image ?? AGENT37_TEMPLATE, type: 'vm', region, name: world, metadata: request.labels,
        resources: { cpu: request.shape.cpu, memory: request.shape.memoryMb / 1024, disk: request.shape.diskGb },
        mount_path: VM_HOME, auto_sleep: false, network: 'allow-all', env: { AGENT37_DOCKER_DATA },
      }, 15 * 60_000) as Agent37Instance;
    } catch (error) {
      throw agent37Full(error) ?? error;
    }
    const ref = { instance: instance.id, world, region };
    try {
      if (instance.status !== 'running') await this.waitFor(connection, instance.id, 'running');
      request.signal?.throwIfAborted();
      await this.boot(connection, instance.id, request.keys);
      return { ref };
    } catch (error) {
      await this.destroy(connection, ref).catch(() => undefined);
      throw error;
    }
  }

  async endpoint(_connection: ResolvedWorldProviderConnection, ref: Record<string, string>) {
    return { host: `${ref.instance}.agent37.app`, port: this.options.sshPort ?? VM_SSH_PORT };
  }

  /** karmax's sshd in the machine, through the workspace's tunnel; if it is
   * not listening (the machine booted without karmax), its boot script runs
   * first, once. */
  async socket(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<Duplex> {
    await this.registerAccessKey(connection);
    const tunnel = await this.tunnel(connection, ref.instance!);
    try {
      return await this.forward(tunnel).catch(async (error) => {
        if (!/refused|connect failed|open failed/i.test(String((error as Error).message))) throw error;
        await runOver(tunnel, this.options.rebootCommand ?? `sh ${VM_BOOT_SCRIPT}`, 5 * 60_000);
        return this.forward(tunnel);
      });
    } catch (error) {
      tunnel.end();
      throw error;
    }
  }

  async start(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape, keys: VmBootKeys): Promise<void> {
    const api = this.api(connection);
    let instance = await this.instance(connection, ref.instance!);
    if (instance.status === 'stopping') instance = await this.waitFor(connection, ref.instance!, 'stopped');
    if (instance.status !== 'running') {
      await this.retrying(() => api('POST', `/instances/${ref.instance}/start`, undefined, 15 * 60_000)).catch((error) => { throw agent37Full(error) ?? error; });
      instance = await this.waitFor(connection, ref.instance!, 'running');
    }
    // A new size (or a disk asked for while it ran) is a resize of the running
    // machine: a cold boot, before karmax's sshd starts.
    const wanted = agent37Shape(shape);
    const resources = instance.resources ?? { cpu: wanted.cpu, memory: wanted.memory, disk: shape.diskGb };
    const change = {
      ...(resources.cpu !== wanted.cpu || resources.memory !== wanted.memory ? { cpu: wanted.cpu, memory: wanted.memory } : {}),
      ...(resources.disk < shape.diskGb ? { disk: shape.diskGb } : {}),
    };
    if (Object.keys(change).length) {
      await this.retrying(() => api('POST', `/instances/${ref.instance}/resize`, change, 15 * 60_000)).catch((error) => { throw agent37Full(error) ?? error; });
      await this.waitFor(connection, ref.instance!, 'running');
    }
    await this.boot(connection, ref.instance!, keys);
  }

  async stop(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    const instance = await this.instance(connection, ref.instance!);
    if (instance.status === 'stopped') return;
    await this.retrying(() => this.api(connection)('POST', `/instances/${ref.instance}/stop`, undefined, 5 * 60_000)).catch((error) => {
      // Already stopped (another process got there first).
      if ((error as Agent37Error).status !== 400) throw error;
    });
    await this.waitFor(connection, ref.instance!, 'stopped');
  }

  async destroy(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    await this.api(connection)('DELETE', `/instances/${ref.instance}`).catch((error) => {
      if ((error as Agent37Error).status !== 404) throw error;
    });
  }

  /** Never on a running machine (`diskGrowsAtStart`): `start` applies the disk. */
  async growDisk(): Promise<boolean> { return false; }

  async state(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<WorldLifecycleState | undefined> {
    try {
      const instance = await this.instance(connection, ref.instance!);
      if (['running', 'starting', 'restarting', 'updating', 'provisioning', 'waking'].includes(instance.status)) return 'ready';
      // `failed`: the last lifecycle action failed; a start tries again.
      if (['stopped', 'stopping', 'sleeping', 'failed'].includes(instance.status)) return 'parked';
      if (['deleted', 'deleting'].includes(instance.status)) return 'missing';
      return undefined;
    } catch (error) {
      if ((error as Agent37Error).status === 404) return 'missing';
      throw error;
    }
  }

  async list(connection: ResolvedWorldProviderConnection, home: string): Promise<VmListing[]> {
    return (await this.instances(connection)).filter((instance) => instance.metadata?.karmaxHome === home
      && !['deleted', 'deleting'].includes(instance.status)).map((instance) => {
      const labels = instance.metadata ?? {};
      const ref = { instance: instance.id, ...(instance.name ? { world: instance.name } : {}) };
      return { id: instance.id, ...(labels.karmaxTaskId ? { taskId: labels.karmaxTaskId } : {}),
        ...(labels.karmaxGeneration ? { generation: labels.karmaxGeneration } : {}),
        ref, destroy: () => this.destroy(connection, ref) };
    });
  }

  same(a: Record<string, string>, b: Record<string, string>): boolean { return !!a.instance && a.instance === b.instance; }

  /**
   * What Agent37 charged, from its own ledger (`GET /v1/usage`, which totals
   * each instance over the window asked, so it is asked one UTC day at a
   * time): per instance and day, a compute row and a disk row.
   * Agent37 settles the meter hourly, so a day is reported once it ended two
   * hours ago; `final` (just before an instance is deleted, when it leaves the
   * instance list and its owner with it) reports its days so far, today's too.
   * What Agent37 had not settled by then (measured: up to ~2 h, 43% of a test
   * world's charge) is booked once that day is settled, from `deleted` (the
   * rows `final` read): the day's total less what they booked, as `…:rest` rows.
   */
  async usage(connection: ResolvedWorldProviderConnection, home: string, since?: number, final?: FinalUsage,
    deleted: ProviderUsageEvent[] = []): Promise<ProviderUsageEvent[]> {
    const now = final?.at ?? Date.now();
    const owners = new Map<string, { owner: Pick<ProviderUsageEvent, 'sandboxId' | 'taskId' | 'organizationId'>; resources: Agent37Resources }>();
    for (const instance of await this.instances(connection)) {
      if (instance.metadata?.karmaxHome !== home || (final && instance.id !== final.ref.instance)) continue;
      if (!final && ['deleted', 'deleting'].includes(instance.status)) continue; // its last reading's records own it
      const labels = instance.metadata ?? {};
      owners.set(instance.id, { owner: { sandboxId: instance.id, ...(labels.karmaxTaskId ? { taskId: labels.karmaxTaskId } : {}),
        ...(labels.karmaxOrganizationId ? { organizationId: labels.karmaxOrganizationId } : {}) },
      resources: instance.resources ?? { cpu: 2, memory: 4, disk: AGENT37_DEFAULT_DISK_GB } });
    }
    const last = final ? now : now - 2 * 3_600_000 - 86_400_000;
    let first = final ? now - FINAL_USAGE_WINDOW_MS : Math.max(since !== undefined ? since - 2 * 86_400_000 : 0, now - 7 * 86_400_000);
    // Deleted instances (no longer listed): their owner, shape, the days their
    // last reading covered and what it booked on each.
    const gone = new Map<string, { owner: Pick<ProviderUsageEvent, 'sandboxId' | 'taskId' | 'organizationId'>; resources: Agent37Resources;
      covered: Set<string>; until: number; booked: Map<string, { compute: number; disk: number; awakeMs: number; diskMs: number }> }>();
    if (!final) for (const event of deleted) {
      if (owners.has(event.sandboxId)) continue;
      const entry = gone.get(event.sandboxId) ?? { owner: { sandboxId: event.sandboxId, ...(event.taskId ? { taskId: event.taskId } : {}),
        ...(event.organizationId ? { organizationId: event.organizationId } : {}) },
      resources: { cpu: 2, memory: 4, disk: AGENT37_DEFAULT_DISK_GB }, covered: new Set<string>(), until: 0, booked: new Map() };
      gone.set(event.sandboxId, entry);
      first = Math.min(first, event.startedAt);
      entry.until = Math.max(entry.until, event.endedAt);
      if (event.record === 'owner') {
        entry.resources = { cpu: event.cpu, memory: event.memoryMb / 1024, disk: event.diskGb ?? AGENT37_DEFAULT_DISK_GB };
        for (let start = Date.parse(`${day(event.startedAt)}T00:00:00Z`); start <= event.endedAt; start += 86_400_000) entry.covered.add(day(start));
        continue;
      }
      // Rows kept before owner records existed: the days they name.
      const date = day(event.startedAt);
      entry.covered.add(date);
      const booked = entry.booked.get(date) ?? { compute: 0, disk: 0, awakeMs: 0, diskMs: 0 };
      if (event.kind === 'disk') { booked.disk += event.costMicros ?? 0; booked.diskMs += event.activeMs; }
      else { booked.compute += event.costMicros ?? 0; booked.awakeMs += event.activeMs; }
      entry.booked.set(date, booked);
    }
    if (!owners.size && !gone.size) return [];
    const events: ProviderUsageEvent[] = [];
    for (let start = Date.parse(`${day(first)}T00:00:00Z`); start <= last; start += 86_400_000) {
      const date = day(start);
      const usage = await this.api(connection)('GET', `/usage?from=${date}&to=${date}`) as Agent37Usage;
      for (const row of usage.instances ?? []) {
        const known = owners.get(row.id) ?? gone.get(row.id);
        if (!known || !row.compute_micros) continue;
        const { owner, resources } = known;
        const deletedOne = owners.has(row.id) ? undefined : gone.get(row.id)!;
        const end = Math.min(start + 86_400_000, now, deletedOne?.until ?? now);
        // Agent37's day is one sum. Its running minutes at the published rate
        // are the compute; the rest is the disk it held all day.
        const awakeMs = (row.awake_minutes ?? 0) * 60_000;
        const compute = Math.min(row.compute_micros,
          Math.round(awakeMs / 3_600_000 * agent37ComputeDollarsPerHour({ cpu: resources.cpu, memoryMb: resources.memory * 1024 }) * 1e6));
        // A deleted instance: what its last reading did not see, once the day is
        // settled, on the days that reading covered (earlier ones were booked whole).
        if (deletedOne && !deletedOne.covered.has(date)) continue;
        const booked = deletedOne ? deletedOne.booked.get(date) ?? { compute: 0, disk: 0, awakeMs: 0, diskMs: 0 } : undefined;
        const suffix = booked ? ':rest' : '';
        const restCompute = compute - (booked?.compute ?? 0);
        const restDisk = row.compute_micros - compute - (booked?.disk ?? 0);
        if (restCompute > 0) events.push({ id: `${row.id}:${date}${suffix}`, ...owner, startedAt: start, endedAt: end,
          activeMs: Math.max(0, awakeMs - (booked?.awakeMs ?? 0)), cpu: resources.cpu, memoryMb: resources.memory * 1024, costMicros: restCompute });
        if (restDisk > 0) events.push({ id: `${row.id}:${date}:disk${suffix}`, ...owner, kind: 'disk', startedAt: start, endedAt: end,
          activeMs: Math.max(0, end - start - (booked?.diskMs ?? 0)), cpu: 0, memoryMb: 0, diskGb: resources.disk, costMicros: restDisk });
      }
    }
    // Before a delete, whose it was: the ledger settles later (see above).
    if (final) for (const [id, { owner, resources }] of owners)
      events.push({ id: `${id}:owner`, ...owner, record: 'owner', startedAt: first, endedAt: now, activeMs: 0,
        cpu: resources.cpu, memoryMb: resources.memory * 1024, diskGb: resources.disk, costMicros: 0 });
    return events;
  }

  /**
   * What the workspace allows: Agent37's largest machine and disk, and its
   * budget. Agent37 limits the memory awake at once (it rises with the
   * workspace's top-ups); karmax's budget counts machines, so it is read as
   * machines of the smallest shape (2 CPU / 4 GB). A bigger machine past the
   * real limit is refused by Agent37 itself, and its task waits for room.
   */
  async limits(connection: ResolvedWorldProviderConnection): Promise<ComputerLimits> {
    const billing = await this.api(connection)('GET', '/billing') as { memory_limit_gb?: number };
    const smallest = AGENT37_SHAPES[0].memory;
    return { cpu: 4, memoryMb: 32_768, diskGb: AGENT37_MAX_DISK_GB,
      ...(billing.memory_limit_gb ? { pool: { machines: Math.max(1, Math.floor(billing.memory_limit_gb / smallest)) } } : {}),
      checkedAt: Date.now() };
  }

  async test(connection: ResolvedWorldProviderConnection): Promise<void> {
    const billing = await this.api(connection)('GET', '/billing') as { balance_usd?: number };
    await this.registerAccessKey(connection);
    if (typeof billing.balance_usd === 'number' && billing.balance_usd <= 0)
      throw new Agent37Error('This Agent37 workspace has no balance, so it cannot start a machine. Top up at https://www.agent37.com/dashboard/cloud/billing.', 402);
  }

  /** Run karmax's boot script as root through the tunnel: the world's keys, its user, and sshd. */
  private async boot(connection: ResolvedWorldProviderConnection, instanceId: string, keys: VmBootKeys): Promise<void> {
    const script = this.options.bootScript?.(keys) ?? agent37BootScript(keys, this.options.sshPort);
    const until = Date.now() + 3 * 60_000;
    // Agent37's own sshd can lag the instance's `running` by a few seconds.
    for (let attempt = 0; ; attempt++) {
      let tunnel: Client | undefined;
      try {
        tunnel = await this.tunnel(connection, instanceId);
      } catch (error) {
        if (Date.now() > until) throw new Error(`could not reach the Agent37 machine to boot it: ${(error as Error).message}`, { cause: error });
        await sleep(Math.min(10_000, 1_000 * (attempt + 1)));
        continue;
      }
      try {
        await runOver(tunnel, `sh -s > /tmp/karmax-boot.log 2>&1 || { tail -n 40 /tmp/karmax-boot.log >&2; exit 1; }`, 15 * 60_000, script);
        return;
      } finally {
        tunnel.end();
      }
    }
  }

  /** An SSH session to Agent37's sshd in the machine, over its WebSocket tunnel. */
  private async tunnel(connection: ResolvedWorldProviderConnection, instanceId: string): Promise<Client> {
    const url = this.options.tunnelUrl?.(instanceId) ?? `wss://${instanceId}-${TUNNEL_PORT}.agent37.app/`;
    const ws = new WebSocket(url, { headers: { 'X-Agent37-Key': connection.apiKey.trim() }, handshakeTimeout: 30_000 });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_request, response) => {
        ws.terminate();
        reject(new Agent37Error(`Agent37 refused the SSH tunnel to ${instanceId} (${response.statusCode})`
          + (response.statusCode === 401 ? ': the API key was rejected' : ''), response.statusCode));
      });
      ws.once('error', reject);
    });
    const client = new Client();
    const access = agent37AccessKey(connection.apiKey);
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', (error) => { ws.terminate(); reject(new Error(`Agent37's SSH tunnel to ${instanceId} failed: ${error.message}`, { cause: error })); });
      client.connect({ sock: createWebSocketStream(ws), username: this.options.tunnelUser ?? 'root', privateKey: access.privateKey,
        // Agent37 makes a new host key whenever it moves an instance; the
        // tunnel is TLS to agent37.app with the workspace key, and karmax's
        // own sshd behind it is pinned.
        hostVerifier: () => true, readyTimeout: 30_000, keepaliveInterval: 15_000, keepaliveCountMax: 4 });
    });
    client.on('error', () => undefined);
    // Either side gone ends both: the SSH session over a closed WebSocket, the WebSocket of an ended session.
    client.on('end', () => ws.terminate());
    client.on('close', () => ws.terminate());
    ws.once('close', () => client.end());
    return client;
  }

  private forward(tunnel: Client): Promise<Duplex> {
    const port = this.options.sshPort ?? VM_SSH_PORT;
    return new Promise<Duplex>((resolve, reject) => tunnel.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error, channel) => {
      if (error) { reject(error); return; }
      resolve(closingStream(channel, tunnel));
    }));
  }

  /** The workspace's tunnel key, registered once per process (409: it already is). */
  private registerAccessKey(connection: ResolvedWorldProviderConnection): Promise<void> {
    const access = agent37AccessKey(connection.apiKey);
    const id = access.publicKey.split(' ')[1]!;
    let done = this.registered.get(id);
    if (!done) {
      done = this.api(connection)('POST', '/ssh-keys', { public_key: access.publicKey, name: 'tavya' }).then(() => undefined, (error) => {
        if ((error as Agent37Error).status === 409) return;
        this.registered.delete(id);
        if ((error as Agent37Error).status === 400 && /20|at most|limit/i.test((error as Error).message))
          throw new Agent37Error(`This Agent37 workspace already holds its 20 SSH keys; delete one at https://www.agent37.com/dashboard/cloud/settings#ssh-access so tavya can add its own. ${(error as Error).message}`, 400);
        throw error;
      });
      this.registered.set(id, done);
    }
    return done;
  }

  private async waitFor(connection: ResolvedWorldProviderConnection, id: string, status: 'running' | 'stopped'): Promise<Agent37Instance> {
    const until = Date.now() + 15 * 60_000;
    for (;;) {
      const instance = await this.instance(connection, id);
      if (instance.status === status) return instance;
      if (['failed', 'deleted', 'deleting'].includes(instance.status))
        throw new Agent37Error(`the Agent37 machine is ${instance.status}${instance.status_reason?.message ? `: ${instance.status_reason.message}` : ''}`);
      if (Date.now() > until) throw new Error(`the Agent37 machine did not reach ${status} within 15 minutes (it is ${instance.status})`);
      await sleep(this.pollMs);
    }
  }

  private instance(connection: ResolvedWorldProviderConnection, id: string): Promise<Agent37Instance> {
    return this.api(connection)('GET', `/instances/${id}`) as Promise<Agent37Instance>;
  }

  private async instances(connection: ResolvedWorldProviderConnection): Promise<Agent37Instance[]> {
    return ((await this.api(connection)('GET', '/instances')) as { data?: Agent37Instance[] }).data ?? [];
  }

  /** Agent37 answers `try_again` while a sleep checkpoint is written or a moved instance settles. */
  private async retrying<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await call(); }
      catch (error) {
        if ((error as Agent37Error).code !== 'try_again' || attempt >= 8) throw error;
        await sleep(Math.min(30_000, this.pollMs * 2 ** attempt));
      }
    }
  }

  private api(connection: ResolvedWorldProviderConnection) {
    return async (method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        const response = await this.fetchImpl(`${API}${path}`, {
          method, headers: { authorization: `Bearer ${connection.apiKey.trim()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text().catch(() => '');
        if (response.ok) return text ? JSON.parse(text) : {};
        let error: { code?: string; message?: string } | string | undefined;
        try { error = (JSON.parse(text) as { error?: typeof error }).error; } catch { error = undefined; }
        const code = typeof error === 'string' ? error : error?.code;
        const message = (typeof error === 'object' && error?.message ? error.message : text.slice(0, 500)).split(connection.apiKey.trim()).join('[redacted]');
        // Rate limits and transient 5xx deserve a second chance on reads.
        if ((response.status === 429 || (response.status >= 500 && code !== 'no_capacity')) && attempt < 2 && method === 'GET') {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw new Agent37Error(`Agent37 ${method} ${path.split('?')[0]} failed (${response.status}${code ? ` ${code}` : ''}): ${message}`, response.status, code);
      }
    };
  }
}

/**
 * The forwarded channel as a stream that closes, all of it, when anything
 * under it ends: the channel, the tunnel's SSH session, or its WebSocket. An
 * ssh2 channel whose connection died only ends its readable side (and its
 * `destroy` only asks a dead server to close), and a WebSocket stream does
 * the same, so without this the world's SSH client waits for ever on a
 * tunnel that is gone, never told to reconnect.
 */
function closingStream(channel: ClientChannel, tunnel: Client): Duplex {
  const stream = new Duplex({
    read() { channel.resume(); },
    write(chunk, encoding, callback) { channel.write(chunk, encoding, callback); },
    final(callback) { channel.end(); callback(); },
    destroy(error, callback) { channel.close(); tunnel.end(); callback(error); },
  });
  channel.on('data', (chunk: Buffer) => { if (!stream.push(chunk)) channel.pause(); });
  const gone = (error?: Error) => { if (!stream.destroyed) stream.destroy(error); };
  for (const source of [channel, tunnel] as Array<NodeJS.EventEmitter>) {
    source.once('end', () => gone());
    source.once('close', () => gone());
    source.once('error', (error: Error) => gone(error));
  }
  return stream;
}

/** Run a command over an SSH session, with `input` on its stdin; its stderr in the error. */
function runOver(client: Client, command: string, timeoutMs: number, input?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => client.exec(command, (error, stream: ClientChannel) => {
    if (error) { reject(error); return; }
    let stderr = '';
    const timer = setTimeout(() => { stream.close(); reject(new Error(`the Agent37 machine's boot did not finish within ${Math.round(timeoutMs / 60_000)} minutes`)); }, timeoutMs);
    stream.on('data', () => undefined);
    stream.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    stream.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`booting the Agent37 machine failed (status ${code}): ${stderr.trim().slice(-1500)}`));
    });
    stream.end(input ?? '');
  }));
}

/** Agent37 refusing a machine for want of room: the workspace's memory limit
 * (it rises with its top-ups) or a region with no host free. The task waits
 * for a machine, or Any tries the next provider, as for any full one. */
function agent37Full(error: unknown): ProviderCapacityFull | undefined {
  if (!(error instanceof Agent37Error) || !['no_capacity', 'capacity_unavailable', 'instance_limit_reached'].includes(error.code ?? '')) return undefined;
  return new ProviderCapacityFull(error.code === 'instance_limit_reached'
    ? `This Agent37 workspace runs as much memory as its top-ups allow just now: ${error.message}`
    : `Agent37 has no room for this machine just now: ${error.message}`, { cause: error });
}

export class Agent37Error extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = 'Agent37Error'; }
}

interface Agent37Instance {
  id: string;
  status: string;
  status_reason?: { code?: string; message?: string } | null;
  name?: string | null;
  metadata?: Record<string, string> | null;
  resources?: { cpu: number; memory: number; disk: number };
}
type Agent37Resources = { cpu: number; memory: number; disk: number };
interface Agent37Usage { instances?: Array<{ id: string; compute_micros?: number; awake_minutes?: number }> }

/** `kx-<home>-<world>`: recognisably this deployment's in the workspace's list. */
function worldName(labels: Record<string, string>): string {
  const world = crypto.createHash('sha256').update(`${labels.karmaxTaskId}:${labels.karmaxGeneration}`).digest('hex').slice(0, 12);
  return `kx-${labels.karmaxHome!.slice(0, 10)}-${world}`;
}

function day(at: number): string { return new Date(at).toISOString().slice(0, 10); }

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

