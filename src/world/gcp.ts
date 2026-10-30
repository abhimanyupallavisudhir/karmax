import crypto from 'node:crypto';
import type { MachineShape } from '../domain/computer.js';
import type { ComputerLimits } from '../domain/computer-limits.js';
import type { ResolvedWorldProviderConnection } from './connections.js';
import type { ProviderUsageEvent, WorldLifecycleState } from './types.js';
import { runDetached, type VmAllocation, type VmBootKeys, type VmDriver, type VmListing, type VmShape } from './vm/provider.js';
import { startupScript, VM_ETC, VM_SSH_PORT, VM_USER, vmProvisionScript, vmProvisionStamp, vmProvisionVersion } from './vm/provision.js';
import { decodeRun, diskHours, encodeRun, FINAL_USAGE_WINDOW_MS, runSlices, type FinalUsage, type MachineRun } from './vm/runs.js';
import { generateSshKeyPair, quote, SshTransport } from './vm/ssh.js';
import { ProviderCapacityFull, ProviderOutage } from '../agent/limits.js';

/**
 * Google Compute Engine instances as VM worlds (`vm/provider.ts`). The
 * world's files are a zonal persistent disk (pd-balanced, up to 64 TB, grown
 * in place) mounted as the VM home; the instance boots from karmax's
 * provisioned image.
 *
 * Compute Engine bills an instance per second while it runs and a stopped
 * one nothing but its disks, so a park stops it: its boot disk, and so the
 * project's setup, survive, and a wake is a start. Machines are E2 custom
 * types of exactly the Computer's size (no CPU credits; per vCPU and GB).
 * Debian's Compute Engine images run a metadata startup script at every boot
 * instead of cloud-init, so the boot files arrive as one (`startupScript`).
 * Instances get no service account: nothing on the machine can act on the
 * project. Mutating requests carry a request id, so any may be sent again.
 */

const API = 'https://compute.googleapis.com/compute/v1';
const BILLING = 'https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus';
export const GCP_DEFAULT_ZONE = 'europe-west3-a';
export const GCP_MAX_DISK_GB = 65_536;
export const GCP_DEFAULT_DISK_GB = 20;
/** E2's limits: 2–32 vCPUs, 0.5–8 GB per vCPU, at most 128 GB. */
export const E2_MAX_CPU = 32;
export const E2_MAX_MEMORY_MB = 131_072;
const ROOT_DISK_GB = 20;
const DEBIAN_IMAGE = 'projects/debian-cloud/global/images/family/debian-12';
const HOME_DEVICE = 'karmax-home';
const NETWORK_TAG = 'karmax-vm';
const FIREWALL = 'karmax-vm-ssh';
/** us-central1 list prices, for when the Cloud Billing catalog cannot be read. */
const FALLBACK_PRICES = { core: 0.021811, ramGb: 0.002923, diskGbMonth: 0.1 };
/** An external IPv4 address on a VM, per hour. */
const IPV4_HOURLY = 0.005;
const BUILDER_STALE_MS = 60 * 60_000;
const API_RETRIES = 4;
const RETRIED = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError', 'RESOURCE_OPERATION_RATE_EXCEEDED']);
const NO_CAPACITY = new Set(['ZONE_RESOURCE_POOL_EXHAUSTED', 'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS', 'RESOURCE_POOL_EXHAUSTED']);
const QUOTA = new Set(['QUOTA_EXCEEDED', 'quotaExceeded']);

type Fetch = typeof fetch;

export interface GcpServiceAccount { client_email: string; private_key: string; project_id: string; token_uri?: string }

/** A service account key as Google downloads it (JSON). */
export function gcpServiceAccount(apiKey: string): GcpServiceAccount {
  let value: Partial<GcpServiceAccount> & { type?: string };
  try { value = JSON.parse(apiKey.trim()); }
  catch { throw new Error('a Google Cloud key is a service account key file (JSON)'); }
  if (!value.client_email || !value.private_key || !value.project_id)
    throw new Error('a Google Cloud key is a service account key file (JSON) with client_email, private_key and project_id');
  return value as GcpServiceAccount;
}

/** The E2 custom machine of exactly a shape, or the nearest larger one E2 allows. */
export function e2Machine(want: { cpu: number; memoryMb: number }): { name: string; cpu: number; memoryMb: number } {
  let cpu = Math.max(2, Math.ceil(want.cpu / 2) * 2);
  const memory = Math.ceil(Math.max(want.memoryMb, 512) / 256) * 256;
  while (memory > cpu * 8192) cpu += 2;
  const memoryMb = Math.max(memory, cpu * 512);
  if (cpu > E2_MAX_CPU || memoryMb > E2_MAX_MEMORY_MB)
    throw new Error(`Google Cloud E2 machines have at most ${E2_MAX_CPU} CPUs and ${E2_MAX_MEMORY_MB / 1024} GB of memory, `
      + `not ${want.cpu} CPU · ${Math.round(want.memoryMb / 1024)} GB`);
  return { name: `e2-custom-${cpu}-${memoryMb}`, cpu, memoryMb };
}

/** karmax's label names as Compute Engine allows them (lowercase, dashes). */
const LABELS: Record<string, string> = { karmaxHome: 'karmax-home', karmaxTaskId: 'karmax-task', karmaxGeneration: 'karmax-generation',
  karmaxOrganizationId: 'karmax-org', karmaxWorld: 'karmax-world', karmaxRole: 'karmax-role', karmaxLastRun: 'karmax-last-run',
  karmaxImage: 'karmax-image', karmaxImageBuilder: 'karmax-image-builder' };
export function gcpLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).map(([key, value]) =>
    [LABELS[key] ?? key.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63), value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63)]));
}
function label(labels: Record<string, string> | undefined, key: keyof typeof LABELS): string | undefined { return labels?.[LABELS[key]!]; }
/** A Compute Engine list filter on labels: every `key = value` (a value of `*`: the label exists). */
export function labelFilter(terms: Partial<Record<keyof typeof LABELS, string>>): string {
  return Object.entries(terms).map(([key, value]) => value === '*' ? `(labels.${LABELS[key]}:*)` : `(labels.${LABELS[key]} = "${value}")`).join(' AND ');
}

interface Instance { name: string; zone: string; status: string; machineType: string; labels?: Record<string, string>; labelFingerprint?: string;
  creationTimestamp: string; lastStartTimestamp?: string; lastStopTimestamp?: string;
  networkInterfaces?: Array<{ accessConfigs?: Array<{ natIP?: string }> }>; disks?: Array<{ source: string; deviceName: string; boot?: boolean }> }
interface Disk { name: string; zone: string; sizeGb: string; creationTimestamp: string; status: string; labels?: Record<string, string>; users?: string[]; type: string }
interface Operation { name: string; status: string; selfLink: string; zone?: string; targetLink?: string;
  error?: { errors?: Array<{ code?: string; message?: string }> } }

export class GcpDriver implements VmDriver {
  readonly kind = 'gcp';
  readonly name = 'Google Cloud';
  private tokens = new Map<string, { token: string; expires: number }>();
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private building = new Map<string, Promise<void>>();

  /** `pollMs` is the driver's second: every wait is a multiple of it (tests shrink it). */
  constructor(private fetchImpl: Fetch = fetch, private pollMs = 1_000,
    /** Test seam: how the image builder reaches its instance over SSH. */
    private builderTransport?: (host: string, keys: { privateKey: string; hostKey: string }) => SshTransport) {}

  shape(resources: MachineShape | undefined): VmShape {
    const diskGb = Math.max(10, resources?.diskGb ?? GCP_DEFAULT_DISK_GB);
    if (diskGb > GCP_MAX_DISK_GB) throw new Error(`A Google Cloud disk holds at most ${GCP_MAX_DISK_GB} GB, not ${diskGb} GB`);
    const machine = e2Machine({ cpu: resources?.cpu ?? 2, memoryMb: resources?.memoryMb ?? 2048 });
    return { cpu: machine.cpu, memoryMb: machine.memoryMb, diskGb };
  }

  async allocate(connection: ResolvedWorldProviderConnection, request: { labels: Record<string, string>; shape: VmShape;
    keys: VmBootKeys; signal?: AbortSignal }): Promise<VmAllocation> {
    const world = worldName(request.labels);
    const labels = gcpLabels({ ...request.labels, karmaxWorld: world });
    const [image] = await Promise.all([this.image(connection), this.firewall(connection)]);
    if (!image.karmax) this.buildImage(connection);
    const project = this.project(connection);
    let refused: unknown;
    // The configured zone first, then the rest of its region: the disk is made where the machine can be.
    for (const zone of await this.zones(connection)) {
      request.signal?.throwIfAborted();
      const ref = { disk: world, zone, project, world };
      try {
        // The disk must exist before an instance may name it ("resource … is not ready").
        await this.operation(connection, await this.call(connection, 'POST', `/zones/${zone}/disks`, { name: world, sizeGb: String(request.shape.diskGb),
          type: `zones/${zone}/diskTypes/pd-balanced`, labels: { ...labels, [LABELS.karmaxRole!]: 'home' } }));
        await this.insertInstance(connection, zone, world, image.source, request.shape, request.keys, labels);
        return { ref };
      } catch (error) {
        await this.destroy(connection, ref).catch(() => undefined);
        if (!(error instanceof GcpNoCapacity)) throw error;
        refused = error;
      }
    }
    throw new ProviderCapacityFull(`Google Cloud has no ${e2Machine(request.shape).name} machine free in ${this.region(connection)} just now. `
      + 'tavya waits until one is free; to start sooner, give this task another size.', { cause: refused });
  }

  async endpoint(connection: ResolvedWorldProviderConnection, ref: Record<string, string>) {
    const instance = await this.instance(connection, ref);
    const host = instance?.status === 'RUNNING' ? instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP : undefined;
    if (!host) throw Object.assign(new Error('the Google Cloud machine of this world is not running'), { code: 'ECONNREFUSED' });
    return { host, port: VM_SSH_PORT };
  }

  async start(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape, keys: VmBootKeys): Promise<void> {
    let instance = await this.instance(connection, ref);
    if (!instance) return this.replace(connection, ref, shape, keys);
    if (['PROVISIONING', 'STAGING', 'RUNNING'].includes(instance.status)) return;
    if (['STOPPING', 'SUSPENDING'].includes(instance.status)) instance = await this.waitStatus(connection, ref, ['TERMINATED', 'SUSPENDED']);
    const path = `/zones/${ref.zone}/instances/${ref.world}`;
    // The run that just ended stays countable until the feed books it (`usage`).
    const ran = runOf(instance);
    if (ran?.end !== undefined) {
      await this.operation(connection, await this.call(connection, 'POST', `${path}/setLabels`,
        { labels: { ...instance.labels, [LABELS.karmaxLastRun!]: encodeRun(ran as { start: number; end: number }) }, labelFingerprint: instance.labelFingerprint }));
    }
    const machine = e2Machine(shape);
    if (!instance.machineType.endsWith(`/${machine.name}`))
      await this.operation(connection, await this.call(connection, 'POST', `${path}/setMachineType`, { machineType: `zones/${ref.zone}/machineTypes/${machine.name}` }));
    try {
      await this.operation(connection, await this.call(connection, 'POST', instance.status === 'SUSPENDED' ? `${path}/resume` : `${path}/start`));
    } catch (error) {
      if (!(error instanceof GcpNoCapacity)) throw error;
      throw new ProviderCapacityFull(`Google Cloud has no ${machine.name} machine free in ${ref.zone}, where this world's disk is, just now. `
        + 'tavya waits until one is free; to start sooner, give this task another size.', { cause: error });
    }
  }

  /** A new instance on the world's disk, in place of any it has. */
  async replace(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape, keys: VmBootKeys): Promise<void> {
    await this.deleteInstance(connection, ref);
    const disk = await this.disk(connection, ref);
    if (!disk) throw Object.assign(new Error('the Google Cloud disk of this world no longer exists'), { status: 404 });
    const labels = Object.fromEntries(Object.entries(disk.labels ?? {}).filter(([key]) => key !== LABELS.karmaxRole));
    try {
      await this.insertInstance(connection, ref.zone!, ref.world!, (await this.image(connection)).source, shape, keys, labels);
    } catch (error) {
      if (!(error instanceof GcpNoCapacity)) throw error;
      throw new ProviderCapacityFull(`Google Cloud has no ${e2Machine(shape).name} machine free in ${ref.zone}, where this world's disk is, `
        + 'just now. tavya waits until one is free; to start sooner, give this task another size.', { cause: error });
    }
  }

  /** Stop the machine. Returns once Google has begun (it says STOPPING): a
   * park that returned while it still said RUNNING read as not parked. */
  async stop(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    const instance = await this.instance(connection, ref);
    if (!instance || !['PROVISIONING', 'STAGING', 'RUNNING'].includes(instance.status)) return;
    await this.call(connection, 'POST', `/zones/${ref.zone}/instances/${ref.world}/stop`);
    await this.waitStatus(connection, ref, ['STOPPING', 'TERMINATED', 'SUSPENDING', 'SUSPENDED']);
  }

  async destroy(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    await this.deleteInstance(connection, ref);
    for (let attempt = 0; ; attempt++) {
      try {
        const deleted = await this.call(connection, 'DELETE', `/zones/${ref.zone}/disks/${ref.disk}`);
        await this.operation(connection, deleted);
        return;
      } catch (error) {
        if ((error as GcpError).status === 404) return;
        // Still held by the instance being deleted.
        if (attempt >= 60 || !/resourceInUseByAnotherResource|RESOURCE_IN_USE|resourceNotReady/i.test(String((error as GcpError).reason ?? (error as Error).message))) throw error;
        await this.sleep(3);
      }
    }
  }

  async growDisk(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, diskGb: number): Promise<boolean> {
    if (diskGb > GCP_MAX_DISK_GB) throw new Error(`A Google Cloud disk holds at most ${GCP_MAX_DISK_GB} GB`);
    const disk = await this.disk(connection, ref);
    if (!disk) throw Object.assign(new Error('the Google Cloud disk of this world no longer exists'), { status: 404 });
    if (Number(disk.sizeGb) >= diskGb) return false;
    await this.operation(connection, await this.call(connection, 'POST', `/zones/${ref.zone}/disks/${ref.disk}/resize`, { sizeGb: String(diskGb) }));
    return true;
  }

  async state(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<WorldLifecycleState | undefined> {
    if (!(await this.disk(connection, ref))) return 'missing';
    const instance = await this.instance(connection, ref);
    return instance && ['PROVISIONING', 'STAGING', 'RUNNING'].includes(instance.status) ? 'ready' : 'parked';
  }

  async list(connection: ResolvedWorldProviderConnection, home: string): Promise<VmListing[]> {
    const disks = await this.aggregated<Disk>(connection, 'disks', labelFilter({ karmaxHome: home, karmaxRole: 'home' }));
    return disks.map((disk) => {
      const zone = disk.zone.split('/').pop()!;
      const ref = { disk: disk.name, zone, project: this.project(connection), world: label(disk.labels, 'karmaxWorld') ?? disk.name };
      const taskId = label(disk.labels, 'karmaxTaskId');
      const generation = label(disk.labels, 'karmaxGeneration');
      return { id: disk.name, ref, ...(taskId ? { taskId } : {}), ...(generation ? { generation } : {}), destroy: () => this.destroy(connection, ref) };
    });
  }

  same(a: Record<string, string>, b: Record<string, string>): boolean { return !!a.disk && a.disk === b.disk && a.zone === b.zone; }

  /**
   * What Compute Engine bills: each instance's runs (per second, its E2 vCPUs
   * and memory plus its external IPv4 address) in five-minute slices, and
   * each disk, boot and home, by the hour whatever the instance does.
   */
  async usage(connection: ResolvedWorldProviderConnection, home: string, since?: number, final?: FinalUsage): Promise<ProviderUsageEvent[]> {
    const now = final?.at ?? Date.now();
    const from = final ? now - FINAL_USAGE_WINDOW_MS : Math.max(since !== undefined ? since - 2 * 3_600_000 : 0, now - 7 * 86_400_000);
    const filter = labelFilter({ karmaxHome: home, ...(final ? { karmaxWorld: gcpLabels({ karmaxWorld: final.ref.world! })['karmax-world']! } : {}) });
    const prices = await this.prices(connection);
    const events: ProviderUsageEvent[] = [];
    for (const instance of await this.aggregated<Instance>(connection, 'instances', filter)) {
      const taskId = label(instance.labels, 'karmaxTaskId');
      if (!taskId) continue;
      const machine = instance.machineType.match(/e2-custom-(\d+)-(\d+)$/);
      const cpu = Number(machine?.[1] ?? 2);
      const memoryMb = Number(machine?.[2] ?? 2048);
      const hourly = cpu * prices.core + memoryMb / 1024 * prices.ramGb + IPV4_HOURLY;
      const runs: MachineRun[] = [];
      const current = runOf(instance);
      if (current) runs.push(final && current.end === undefined ? { ...current, end: final.at } : current);
      const previous = decodeRun(label(instance.labels, 'karmaxLastRun'));
      if (previous) runs.push(previous);
      for (const slice of runSlices(runs, now, from))
        events.push({ id: `instance-${instance.name}-${instance.creationTimestamp}:${slice.id}`, sandboxId: instance.name, taskId,
          ...organization(instance.labels), startedAt: slice.start, endedAt: slice.end, activeMs: slice.end - slice.start, cpu, memoryMb,
          costMicros: Math.round(hourly * (slice.end - slice.start) / 3_600_000 * 1e6) });
    }
    for (const disk of await this.aggregated<Disk>(connection, 'disks', filter)) {
      const taskId = label(disk.labels, 'karmaxTaskId');
      const created = Date.parse(disk.creationTimestamp);
      for (const hour of diskHours(created, now, from, final?.at))
        events.push({ id: `disk-${disk.name}-${created}:${hour.id}`, sandboxId: disk.name, ...(taskId ? { taskId } : {}), ...organization(disk.labels),
          kind: 'disk', startedAt: hour.start, endedAt: hour.end, activeMs: hour.end - hour.start, cpu: 0, memoryMb: 0, diskGb: Number(disk.sizeGb),
          costMicros: Math.round(Number(disk.sizeGb) * prices.diskGbMonth / 730 * (hour.end - hour.start) / 3_600_000 * 1e6) });
    }
    return events;
  }

  /** Builders that died mid-build, and images of provisioning versions no longer made. */
  async housekeep(connection: ResolvedWorldProviderConnection): Promise<void> {
    const now = Date.now();
    for (const builder of await this.aggregated<Instance>(connection, 'instances', labelFilter({ karmaxImageBuilder: '*' }))) {
      if (now - Date.parse(builder.creationTimestamp) < BUILDER_STALE_MS
        || this.building.has(`${this.key(connection)}:${label(builder.labels, 'karmaxImageBuilder')}`)) continue;
      await this.call(connection, 'DELETE', `/zones/${builder.zone.split('/').pop()}/instances/${builder.name}`).catch(() => undefined);
    }
    await this.removeImages(connection, (image) => image.version === vmProvisionVersion() || now - image.created < 86_400_000);
  }

  /** E2's largest machine, within the region's CPU quota, and a 64 TB disk. */
  async limits(connection: ResolvedWorldProviderConnection): Promise<ComputerLimits> {
    type Quotas = { quotas?: Array<{ metric: string; limit: number }> };
    const [region, project] = await Promise.all([
      this.call(connection, 'GET', `/regions/${this.region(connection)}`) as Promise<Quotas>,
      // The project's quotas: CPUS_ALL_REGIONS caps every region together (a new project: 32).
      (this.call(connection, 'GET', '') as Promise<Quotas>).catch(() => ({} as Quotas)),
    ]);
    // An E2 machine counts against the region's E2 quota, its overall one and the
    // project's across regions (a new project: 24, 200 and 32); the lowest binds.
    const quotas = [...(region.quotas ?? []).filter((entry) => entry.metric === 'E2_CPUS' || entry.metric === 'CPUS'),
      ...(project.quotas ?? []).filter((entry) => entry.metric === 'CPUS_ALL_REGIONS')]
      .map((entry) => entry.limit).filter((limit) => Number.isFinite(limit) && limit >= 0);
    const quota = quotas.length ? Math.min(...quotas) : undefined;
    // Machines at once: the region's INSTANCES quota (a new project: 24).
    const instances = (region.quotas ?? []).find((entry) => entry.metric === 'INSTANCES')?.limit;
    const cpu = Math.min(E2_MAX_CPU, quota !== undefined && quota >= 2 ? Math.floor(quota / 2) * 2 : E2_MAX_CPU);
    // The quota is shared by every machine running at once: the account's pool,
    // which the router weighs against the CPUs already running (compute-router.ts).
    return { cpu, memoryMb: Math.min(E2_MAX_MEMORY_MB, cpu * 8192), diskGb: GCP_MAX_DISK_GB,
      ...(quota !== undefined || instances ? { pool: { ...(quota !== undefined ? { cpu: quota } : {}),
        ...(instances && Number.isFinite(instances) ? { machines: instances } : {}) } } : {}), checkedAt: Date.now() };
  }

  /** The key works, Compute Engine is on, and the project has the default network worlds use. */
  async test(connection: ResolvedWorldProviderConnection): Promise<void> {
    await this.call(connection, 'GET', `/zones/${this.zone(connection)}`);
    try { await this.call(connection, 'GET', '/global/networks/default'); }
    catch (error) {
      if ((error as GcpError).status !== 404) throw error;
      throw new Error(`Google Cloud project ${this.project(connection)} has no network named "default", where tavya makes its machines. `
        + 'Create one (VPC network → Create VPC network, name "default", automatic subnets).');
    }
  }

  // ---------------------------------------------------------------------------

  private async insertInstance(connection: ResolvedWorldProviderConnection, zone: string, name: string, image: string,
    shape: Pick<VmShape, 'cpu' | 'memoryMb'>, keys: VmBootKeys, labels: Record<string, string>, home = true): Promise<void> {
    const machine = e2Machine(shape);
    await this.operation(connection, await this.call(connection, 'POST', `/zones/${zone}/instances`, {
      name, machineType: `zones/${zone}/machineTypes/${machine.name}`, labels,
      disks: [
        { boot: true, autoDelete: true, deviceName: 'root', initializeParams: { diskName: `${name}-root`, sourceImage: image,
          diskSizeGb: String(ROOT_DISK_GB), diskType: `zones/${zone}/diskTypes/pd-balanced`, labels: { ...labels, [LABELS.karmaxRole!]: 'root' } } },
        ...(home ? [{ boot: false, autoDelete: false, deviceName: HOME_DEVICE, source: `zones/${zone}/disks/${name}` }] : []),
      ],
      networkInterfaces: [{ network: 'global/networks/default', accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }],
      tags: { items: [NETWORK_TAG] },
      metadata: { items: [{ key: 'startup-script', value: startupScript(keys, home ? `/dev/disk/by-id/google-${HOME_DEVICE}` : undefined) },
        { key: 'block-project-ssh-keys', value: 'TRUE' }] },
      scheduling: { automaticRestart: true, onHostMaintenance: 'MIGRATE' },
    }));
  }

  private async deleteInstance(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    try { await this.operation(connection, await this.call(connection, 'DELETE', `/zones/${ref.zone}/instances/${ref.world}`)); }
    catch (error) { if ((error as GcpError).status !== 404) throw error; }
  }

  private async instance(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<Instance | undefined> {
    try { return await this.call(connection, 'GET', `/zones/${ref.zone}/instances/${ref.world}`) as Instance; }
    catch (error) { if ((error as GcpError).status === 404) return undefined; throw error; }
  }

  private async disk(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<Disk | undefined> {
    try { return await this.call(connection, 'GET', `/zones/${ref.zone}/disks/${ref.disk}`) as Disk; }
    catch (error) { if ((error as GcpError).status === 404) return undefined; throw error; }
  }

  private async waitStatus(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, statuses: string[]): Promise<Instance> {
    const until = Date.now() + 300 * this.pollMs;
    for (;;) {
      const instance = await this.instance(connection, ref);
      if (!instance) throw Object.assign(new Error('the Google Cloud machine of this world vanished'), { status: 404 });
      if (statuses.includes(instance.status)) return instance;
      if (Date.now() > until) throw new GcpOutage(`Google Cloud machine ${ref.world} was not ${statuses.join(' or ')} within 5 minutes`);
      await this.sleep(2);
    }
  }

  /** The configured zone, then the region's other zones. */
  private async zones(connection: ResolvedWorldProviderConnection): Promise<string[]> {
    const first = this.zone(connection);
    const region = await this.cached(connection, 'region', 3_600_000, () =>
      this.call(connection, 'GET', `/regions/${this.region(connection)}`) as Promise<{ zones?: string[] }>);
    return [first, ...(region.zones ?? []).map((zone) => zone.split('/').pop()!).filter((zone) => zone !== first).sort()];
  }

  /** The firewall rule letting the internet reach karmax's SSH port on karmax's machines (by network tag). */
  private firewall(connection: ResolvedWorldProviderConnection): Promise<void> {
    return this.cached(connection, 'firewall', Infinity, async () => {
      try { await this.call(connection, 'GET', `/global/firewalls/${FIREWALL}`); return; }
      catch (error) { if ((error as GcpError).status !== 404) throw error; }
      try {
        await this.operation(connection, await this.call(connection, 'POST', '/global/firewalls', { name: FIREWALL, network: 'global/networks/default',
          direction: 'INGRESS', description: 'tavya VM worlds: SSH to port 2222 only', targetTags: [NETWORK_TAG], sourceRanges: ['0.0.0.0/0'],
          allowed: [{ IPProtocol: 'tcp', ports: [String(VM_SSH_PORT)] }] }));
      } catch (error) { if ((error as GcpError).status !== 409) throw error; }
    });
  }

  /** The image a machine boots: an explicit one, karmax's provisioned one, else stock Debian. */
  private async image(connection: ResolvedWorldProviderConnection): Promise<{ source: string; karmax: boolean }> {
    if (connection.config.image) return { source: connection.config.image, karmax: true };
    const ready = (await this.pages<{ name: string; status: string }>(connection,
      `/global/images?filter=${encodeURIComponent(labelFilter({ karmaxImage: vmProvisionVersion() }))}`))
      .find((image) => image.status === 'READY');
    return ready ? { source: `projects/${this.project(connection)}/global/images/${ready.name}`, karmax: true } : { source: DEBIAN_IMAGE, karmax: false };
  }

  /** Build the provisioned image in the background, once per project and version. */
  private buildImage(connection: ResolvedWorldProviderConnection): void {
    if (process.env.KARMAX_GCP_IMAGES === '0') return;
    this.build(connection).catch((error) => {
      console.warn(`[gcp] building the karmax VM image failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** This process's build of the provisioned image, started if none runs. */
  private build(connection: ResolvedWorldProviderConnection): Promise<void> {
    const version = vmProvisionVersion();
    const key = `${this.key(connection)}:${version}`;
    let build = this.building.get(key);
    if (!build) {
      build = this.runBuild(connection, version).finally(() => this.building.delete(key));
      this.building.set(key, build);
    }
    return build;
  }

  /** The provisioned image, built now if there is none (about ten minutes). */
  async ensureImage(connection: ResolvedWorldProviderConnection): Promise<string> {
    const until = Date.now() + 60 * 60_000;
    for (;;) {
      const image = await this.image(connection);
      if (image.karmax) return image.source;
      // Another process may be building it: wait for its image.
      if ((await this.aggregated<Instance>(connection, 'instances', labelFilter({ karmaxImageBuilder: vmProvisionVersion() }))).length) await this.sleep(15);
      else await this.build(connection);
      if (Date.now() > until) throw new Error('the karmax VM image was not ready within an hour');
    }
  }

  /** Delete karmax's images that `keep` does not keep. */
  async removeImages(connection: ResolvedWorldProviderConnection, keep: (image: { version: string; created: number }) => boolean): Promise<void> {
    const images = await this.pages<{ name: string; labels?: Record<string, string>; creationTimestamp: string }>(connection,
      `/global/images?filter=${encodeURIComponent(labelFilter({ karmaxImage: '*' }))}`);
    for (const image of images) {
      if (keep({ version: label(image.labels, 'karmaxImage') ?? '', created: Date.parse(image.creationTimestamp) })) continue;
      await this.operation(connection, await this.call(connection, 'DELETE', `/global/images/${image.name}`)).catch(() => undefined);
    }
  }

  private async runBuild(connection: ResolvedWorldProviderConnection, version: string): Promise<void> {
    const builders = await this.aggregated<Instance>(connection, 'instances', labelFilter({ karmaxImageBuilder: version }));
    if (builders.length) return; // another process builds it
    await this.firewall(connection);
    const host = generateSshKeyPair('karmax-builder-host');
    const client = generateSshKeyPair('karmax-builder');
    const name = `karmax-image-${version}`;
    let zone: string | undefined;
    for (const candidate of await this.zones(connection)) {
      try {
        await this.insertInstance(connection, candidate, name, DEBIAN_IMAGE, { cpu: 2, memoryMb: 4096 },
          { hostPrivateKey: host.privateKey, authorizedKey: client.publicKey }, gcpLabels({ karmaxImageBuilder: version }), false);
        zone = candidate;
        break;
      } catch (error) {
        await this.deleteInstance(connection, { zone: candidate, world: name }).catch(() => undefined);
        if (!(error instanceof GcpNoCapacity)) throw error;
      }
    }
    if (!zone) throw new Error('Google Cloud had no machine free to build the image on');
    const ref = { zone, world: name };
    try {
      const running = await this.waitStatus(connection, ref, ['RUNNING']);
      const address = running.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
      if (!address) throw new Error('the image builder has no external address');
      const transport = this.builderTransport?.(address, { privateKey: client.privateKey, hostKey: host.publicKey })
        ?? new SshTransport(async () => ({ host: address, port: VM_SSH_PORT, hostKey: host.publicKey, username: VM_USER, privateKey: client.privateKey }));
      try {
        for (let attempt = 0; ; attempt++) {
          try { if ((await transport.exec('true', { timeoutMs: 20_000 })).code === 0) break; } catch { transport.reset(); }
          if (attempt > 60) throw new Error('the image builder never answered SSH');
          await this.sleep(5);
        }
        await runDetached(transport, vmProvisionScript(), true, 30 * 60_000)
          .catch((error) => { throw new Error(`provisioning failed: ${error instanceof Error ? error.message : String(error)}`); });
        // Nothing of this machine's own may reach the worlds made from it.
        await transport.exec(`sudo -n sh -c ${quote(`rm -rf ${VM_ETC} /etc/ssh/sshd_config.d/00-karmax.conf /var/lib/cloud/scripts/per-boot/karmax-boot.sh; `
          + `test -f ${vmProvisionStamp()}; sync`)}`, { timeoutMs: 120_000 });
      } finally {
        transport.close();
      }
      await this.operation(connection, await this.call(connection, 'POST', `/zones/${zone}/instances/${name}/stop`), 10 * 60_000);
      await this.operation(connection, await this.call(connection, 'POST', '/global/images', {
        name: `karmax-vm-${version}-${crypto.randomBytes(3).toString('hex')}`, description: `karmax VM ${version}`, family: 'karmax-vm',
        sourceDisk: `zones/${zone}/disks/${name}-root`, labels: gcpLabels({ karmaxImage: version }) }), 45 * 60_000);
    } finally {
      await this.deleteInstance(connection, ref).catch(() => undefined);
    }
  }

  /** E2 and pd-balanced prices in the region from the Cloud Billing catalog, else us-central1's. */
  private prices(connection: ResolvedWorldProviderConnection): Promise<typeof FALLBACK_PRICES> {
    return this.cached(connection, 'prices', 86_400_000, async () => {
      try {
        const region = this.region(connection);
        const found: Partial<typeof FALLBACK_PRICES> = {};
        let token: string | undefined;
        for (let page = 0; page < 20 && !(found.core && found.ramGb && found.diskGbMonth); page++) {
          const answer = await this.request(connection, 'GET', `${BILLING}?pageSize=5000&currencyCode=USD${token ? `&pageToken=${token}` : ''}`) as
            { skus?: Array<{ description: string; serviceRegions?: string[]; category?: { usageType?: string };
              pricingInfo?: Array<{ pricingExpression?: { tieredRates?: Array<{ unitPrice?: { units?: string; nanos?: number } }> } }> }>; nextPageToken?: string };
          for (const sku of answer.skus ?? []) {
            if (sku.category?.usageType !== 'OnDemand' || !sku.serviceRegions?.includes(region)) continue;
            const rate = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.at(-1)?.unitPrice;
            const usd = Number(rate?.units ?? 0) + (rate?.nanos ?? 0) / 1e9;
            if (!(usd > 0)) continue;
            if (/^E2 Instance Core running in/i.test(sku.description)) found.core = usd;
            else if (/^E2 Instance Ram running in/i.test(sku.description)) found.ramGb = usd;
            else if (/^Balanced PD Capacity in/i.test(sku.description)) found.diskGbMonth = usd;
          }
          token = answer.nextPageToken || undefined;
          if (!token) break;
        }
        return { ...FALLBACK_PRICES, ...found };
      } catch (error) {
        console.warn(`[gcp] the Cloud Billing catalog did not answer (${error instanceof Error ? error.message : String(error)}); us-central1 prices are used`);
        return FALLBACK_PRICES;
      }
    });
  }

  private async aggregated<T>(connection: ResolvedWorldProviderConnection, kind: 'instances' | 'disks', filter: string): Promise<T[]> {
    const items: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < 50; page++) {
      const answer = await this.call(connection, 'GET', `/aggregated/${kind}?filter=${encodeURIComponent(filter)}&maxResults=500${token ? `&pageToken=${token}` : ''}`) as
        { items?: Record<string, Record<string, T[] | undefined>>; nextPageToken?: string };
      for (const scope of Object.values(answer.items ?? {})) items.push(...(scope[kind] ?? []));
      token = answer.nextPageToken || undefined;
      if (!token) break;
    }
    return items;
  }

  private async pages<T>(connection: ResolvedWorldProviderConnection, path: string): Promise<T[]> {
    const items: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < 50; page++) {
      const answer = await this.call(connection, 'GET', `${path}${path.includes('?') ? '&' : '?'}maxResults=500${token ? `&pageToken=${token}` : ''}`) as
        { items?: T[]; nextPageToken?: string };
      items.push(...(answer.items ?? []));
      token = answer.nextPageToken || undefined;
      if (!token) break;
    }
    return items;
  }

  /** Wait for an operation; its error is Google's: no capacity, a quota, or a failure. */
  private async operation(connection: ResolvedWorldProviderConnection, started: unknown, ms = 10 * 60_000): Promise<void> {
    let operation = started as Operation;
    const until = Date.now() + ms;
    for (let poll = 0; operation.status !== 'DONE'; poll++) {
      if (Date.now() > until) throw new GcpOutage(`Google Cloud's ${operation.name} did not finish within ${Math.round(ms / 60_000)} minutes`);
      await this.sleep(Math.min(5, 1 + Math.floor(poll / 5)));
      operation = await this.request(connection, 'GET', operation.selfLink) as Operation;
    }
    const failure = operation.error?.errors?.[0];
    if (!failure) return;
    const message = `Google Cloud ${operation.targetLink?.split('/').slice(-2).join(' ') ?? operation.name} failed: ${failure.message ?? failure.code}`;
    if (NO_CAPACITY.has(failure.code ?? '')) throw new GcpNoCapacity(message);
    if (QUOTA.has(failure.code ?? '')) throw quotaFull(message);
    if (RETRIED.has(failure.code ?? '')) throw new GcpOutage(message);
    throw new GcpError(message, undefined, failure.code);
  }

  /** A Compute Engine request under the project. */
  private call(connection: ResolvedWorldProviderConnection, method: string, path: string, body?: unknown): Promise<unknown> {
    const mutating = method !== 'GET';
    const url = `${API}/projects/${this.project(connection)}${path}`;
    // A request id makes a repeated create or delete the same one.
    return this.request(connection, method, mutating ? `${url}${url.includes('?') ? '&' : '?'}requestId=${crypto.randomUUID()}` : url, body);
  }

  /**
   * One request. Rate limits and Google's own failures are sent again (every
   * mutating request carries a request id, so a repeat does nothing twice);
   * what still fails is a `GcpOutage`. A full quota is `ProviderCapacityFull`;
   * anything else (a 404, a permission, bad input) a `GcpError`.
   */
  private async request(connection: ResolvedWorldProviderConnection, method: string, url: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= API_RETRIES;
      let response: Response;
      let text: string;
      try {
        response = await this.fetchImpl(url, { method, headers: { authorization: `Bearer ${await this.token(connection)}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(120_000) });
        text = await response.text();
      } catch (error) {
        if (!last) { await this.sleep(2 ** attempt); continue; }
        throw new GcpOutage(`Google Cloud ${method} ${new URL(url).pathname} got no answer: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (response.ok) return text ? JSON.parse(text) : {};
      let failure: { message?: string; status?: string; errors?: Array<{ reason?: string }> } | undefined;
      try { failure = (JSON.parse(text) as { error?: typeof failure }).error; } catch {}
      const reason = failure?.errors?.[0]?.reason ?? failure?.status;
      const message = `Google Cloud ${method} ${new URL(url).pathname.replace(/^\/compute\/v1/, '')} failed (${response.status}): ${failure?.message ?? text.slice(0, 300)}`;
      if (response.status === 401) this.tokens.delete(this.key(connection));
      const retried = response.status === 429 || response.status >= 500 || RETRIED.has(reason ?? '') || (response.status === 401 && attempt === 0);
      if (retried && !last) { await this.sleep(Math.min(30, 2 ** attempt + Math.random())); continue; }
      if (QUOTA.has(reason ?? '')) throw quotaFull(message);
      if (retried) throw new GcpOutage(message);
      if (new URL(url).host === 'compute.googleapis.com' && (reason === 'accessNotConfigured' || /has not been used in project|is disabled/i.test(failure?.message ?? '')))
        throw new GcpError(`${message}. Enable the Compute Engine API for project ${this.project(connection)} (APIs & Services → Library).`, response.status, reason);
      throw new GcpError(message, response.status, reason);
    }
  }

  /** An OAuth access token for the service account (a signed JWT exchanged at Google's token endpoint), kept until it nearly expires. */
  private async token(connection: ResolvedWorldProviderConnection): Promise<string> {
    const key = this.key(connection);
    const held = this.tokens.get(key);
    if (held && held.expires > Date.now() + 60_000) return held.token;
    const account = gcpServiceAccount(connection.apiKey);
    const audience = account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: audience, iat: now, exp: now + 3600 })}`;
    const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url')}`;
    const response = await this.fetchImpl(audience, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(), signal: AbortSignal.timeout(60_000) });
    const answer = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!response.ok || !answer.access_token) {
      const message = `Google refused the service account key (${response.status}): ${answer.error_description ?? answer.error ?? 'no reason given'}`;
      if (response.status >= 500) throw new GcpOutage(message);
      throw new GcpError(message, response.status);
    }
    this.tokens.set(key, { token: answer.access_token, expires: Date.now() + (answer.expires_in ?? 3600) * 1000 });
    return answer.access_token;
  }

  private cached<T>(connection: ResolvedWorldProviderConnection, name: string, ms: number, make: () => Promise<T>): Promise<T> {
    const key = `${this.key(connection)}:${this.zone(connection)}:${name}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.value as Promise<T>;
    const value = make();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  private key(connection: ResolvedWorldProviderConnection): string { return crypto.createHash('sha256').update(connection.apiKey).digest('hex'); }
  private project(connection: ResolvedWorldProviderConnection): string { return gcpServiceAccount(connection.apiKey).project_id; }
  private zone(connection: ResolvedWorldProviderConnection): string { return connection.config.region ?? GCP_DEFAULT_ZONE; }
  private region(connection: ResolvedWorldProviderConnection): string { return this.zone(connection).replace(/-[a-z]$/, ''); }

  private sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * this.pollMs));
  }
}

export class GcpError extends Error {
  constructor(message: string, readonly status?: number, readonly reason?: string) { super(message); this.name = 'GcpError'; }
}

/** A Google Cloud failure that passes with time: retried by the platform as infrastructure, never the agent's. */
export class GcpOutage extends ProviderOutage {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'GcpOutage'; }
}

/** The zone has no machine of the type just now (try another zone, or wait). */
class GcpNoCapacity extends GcpOutage {
  constructor(message: string) { super(message); this.name = 'GcpNoCapacity'; }
}

function quotaFull(message: string): ProviderCapacityFull {
  return new ProviderCapacityFull(`${message}. This Google Cloud project's quota is full: tavya waits until there is room; to start sooner, `
    + 'give this task a smaller size, stop another task, or ask Google to raise the quota (IAM & Admin → Quotas).');
}

/** An instance's current run: from its last start to its last stop, or on. */
function runOf(instance: Instance): MachineRun | undefined {
  const start = Date.parse(instance.lastStartTimestamp ?? instance.creationTimestamp);
  if (!Number.isFinite(start)) return undefined;
  if (['PROVISIONING', 'STAGING', 'RUNNING'].includes(instance.status)) return { start };
  const stop = Date.parse(instance.lastStopTimestamp ?? '');
  // A stopped instance whose stop Google does not say is not counted on (never forever).
  return Number.isFinite(stop) && stop >= start ? { start, end: stop } : undefined;
}

function organization(labels: Record<string, string> | undefined) {
  const organizationId = label(labels, 'karmaxOrganizationId');
  return organizationId ? { organizationId } : {};
}

/** `kx-<home>-<world>`: names the world's disk and instance. */
function worldName(labels: Record<string, string>): string {
  const world = crypto.createHash('sha256').update(`${labels.karmaxTaskId}:${labels.karmaxGeneration}`).digest('hex').slice(0, 12);
  return `kx-${labels.karmaxHome!.slice(0, 10)}-${world}`;
}
