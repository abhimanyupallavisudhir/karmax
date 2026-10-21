import crypto from 'node:crypto';
import type { MachineShape } from '../domain/computer.js';
import type { ResolvedWorldProviderConnection } from './connections.js';
import type { ProviderUsageEvent, WorldDiagnosis, WorldLifecycleState } from './types.js';
import type { VmAllocation, VmBootKeys, VmDriver, VmListing, VmShape } from './vm/provider.js';
import { VM_ETC, VM_HOME, VM_SSH_PORT, vmBootScript } from './vm/provision.js';
import { PublishedVmImage } from './vm/image.js';
import { diskHours, FINAL_USAGE_WINDOW_MS, type FinalUsage } from './vm/runs.js';

/**
 * Fly.io Machines as VM worlds (`vm/provider.ts`). One Fly app per world: the
 * app's `<name>.fly.dev` is the world's address, and sshd is reached through
 * Fly's proxy as a `tls` service on the shared IPv4 (free; routed by SNI, so
 * the hostname must be the world's own — a second machine in the app would
 * share it). TLS from karmax to Fly's edge, then SSH pinned to the host key
 * karmax generated. The world's files are one volume mounted as the VM home:
 * up to 500 GB, extended in place, billed per GB-month whatever the machine's
 * state; the machine itself is billed per second only while started.
 */

const API = 'https://api.machines.dev/v1';
const GRAPHQL = 'https://api.fly.io/graphql';
/** Fly's own limits: a volume is at most 500 GB; a machine at most 16 performance CPUs / 128 GB. */
export const FLY_MAX_DISK_GB = 500;
export const FLY_DEFAULT_DISK_GB = 20;
export const FLY_DEFAULT_REGION = 'fra';
/** A world boots karmax's published VM image (src/world/vm/image.ts) when it
 * exists for this provisioning version; until then stock Debian, which
 * provisions itself once (minutes) and keeps its root filesystem. */
const publishedImage = new PublishedVmImage();

/** docs.fly.io/about/pricing (checked 2026-10-10): per second, before the region's multiplier. */
const PRICE_PER_VCPU_SECOND = { shared: 0.0000008465, performance: 0.000012732 } as const;
const INCLUDED_RAM_GB_PER_VCPU = { shared: 0.25, performance: 2 } as const;
const RAM_PRICE_PER_GB_SECOND = 0.000002316;
const VOLUME_PRICE_PER_GB_SECOND = 0.15 / (30 * 86_400);
const REGION_MULTIPLIER: Record<string, number> = {
  iad: 1, ewr: 1, ams: 1.038461538, arn: 1.038461538, fra: 1.153846154, lhr: 1.134615385, cdg: 1.134615385,
};

export interface FlyGuest { cpu_kind: 'shared' | 'performance'; cpus: number; memory_mb: number }

/** The smallest Fly guest that covers a shape: shared CPUs carry up to 2 GB
 * each, performance CPUs 2–8 GB each; memory comes in 256 MB steps. */
export function flyGuest(shape: { cpu: number; memoryMb: number }): FlyGuest {
  const steps = [1, 2, 4, 8, 16];
  const memory = Math.ceil(shape.memoryMb / 256) * 256;
  for (const cpus of steps.filter((value) => value <= 8 && value >= shape.cpu))
    if (memory <= cpus * 2048) return { cpu_kind: 'shared', cpus, memory_mb: Math.max(memory, cpus * 256) };
  for (const cpus of steps.filter((value) => value >= shape.cpu))
    if (memory <= cpus * 8192) return { cpu_kind: 'performance', cpus, memory_mb: Math.max(Math.ceil(memory / 1024) * 1024, cpus * 2048) };
  throw new Error(`Fly machines have at most 16 CPUs and 128 GB of memory, not ${shape.cpu} CPU · ${Math.round(shape.memoryMb / 1024)} GB`);
}

/** US dollars per second for a started machine of `guest` in `region`. */
export function flyComputeDollarsPerSecond(guest: FlyGuest, region?: string): number {
  const extra = Math.max(0, guest.memory_mb / 1024 - guest.cpus * INCLUDED_RAM_GB_PER_VCPU[guest.cpu_kind]);
  return (guest.cpus * PRICE_PER_VCPU_SECOND[guest.cpu_kind] + extra * RAM_PRICE_PER_GB_SECOND) * (REGION_MULTIPLIER[region ?? ''] ?? 1.2);
}

export function flyVolumeDollarsPerSecond(sizeGb: number): number { return sizeGb * VOLUME_PRICE_PER_GB_SECOND; }

type Fetch = typeof fetch;

export class FlyDriver implements VmDriver {
  readonly kind = 'fly';
  readonly name = 'Fly.io';

  constructor(private fetchImpl: Fetch = fetch, private pollMs = 1_000,
    private images: { image(): Promise<string> } = publishedImage) {}

  shape(resources: MachineShape | undefined): VmShape {
    const diskGb = resources?.diskGb ?? FLY_DEFAULT_DISK_GB;
    if (diskGb > FLY_MAX_DISK_GB) throw new Error(`A Fly.io volume holds at most ${FLY_MAX_DISK_GB} GB, not ${diskGb} GB`);
    const guest = flyGuest({ cpu: resources?.cpu ?? 2, memoryMb: resources?.memoryMb ?? 2048 });
    return { cpu: guest.cpus, memoryMb: guest.memory_mb, diskGb: Math.max(1, diskGb) };
  }

  async allocate(connection: ResolvedWorldProviderConnection, request: { labels: Record<string, string>; shape: VmShape;
    keys: VmBootKeys; signal?: AbortSignal }): Promise<VmAllocation> {
    const api = this.api(connection);
    const region = connection.config.region ?? FLY_DEFAULT_REGION;
    const app = appName(request.labels);
    await this.assertNotTrial(connection);
    await api('POST', '/apps', { app_name: app, org_slug: organization(connection) });
    let created: string | undefined;
    try {
      await this.allocateAddress(connection, app);
      request.signal?.throwIfAborted();
      const volume = await api('POST', `/apps/${app}/volumes`, { name: 'home', region, size_gb: request.shape.diskGb,
        encrypted: true, require_unique_zone: false, snapshot_retention: 1 }) as { id: string };
      request.signal?.throwIfAborted();
      const image = connection.config.image ?? await this.images.image();
      const machine = await api('POST', `/apps/${app}/machines`, { name: 'world', region,
        config: machineConfig(image, request.labels, request.shape, request.keys, volume.id) }) as { id: string };
      created = machine.id;
      await this.waitFor(connection, app, machine.id, 'started');
      return { ref: { app, machine: machine.id, volume: volume.id, region } };
    } catch (error) {
      // What Fly recorded (an image pull failure, an exit) dies with the app: keep it in the error.
      const evidence = created ? await this.evidence(connection, app, created) : '';
      await api('DELETE', `/apps/${app}?force=true`).catch(() => undefined);
      if (evidence && error instanceof Error) error.message = `${error.message} (${evidence})`;
      throw error;
    }
  }

  async endpoint(_connection: ResolvedWorldProviderConnection, ref: Record<string, string>) {
    const host = `${ref.app}.fly.dev`;
    return { host, port: 443, tls: { servername: host } };
  }

  async start(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape): Promise<void> {
    const api = this.api(connection);
    const machine = await this.machine(connection, ref.app!, ref.machine!);
    const guest = flyGuest(shape);
    if (machine.config && !sameGuest(machine.config.guest, guest)) {
      // A new size is a machine update; with skip_launch it stays stopped until started below.
      await api('POST', `/apps/${ref.app}/machines/${ref.machine}`, {
        config: { ...machine.config, guest: { ...machine.config.guest, ...guest } }, skip_launch: true });
      await this.waitFor(connection, ref.app!, ref.machine!, 'stopped').catch(() => undefined);
    }
    if (machine.state !== 'started' && machine.state !== 'starting')
      await api('POST', `/apps/${ref.app}/machines/${ref.machine}/start`).catch((error) => {
        // Fly pins a machine with a volume to that volume's host; a larger size can find it full.
        if (/insufficient|capacity/i.test(String(error))) throw new Error(`Fly.io has no room for this machine on its volume's host: ${String(error)}`);
        throw error;
      });
    await this.waitFor(connection, ref.app!, ref.machine!, 'started');
  }

  async stop(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    const api = this.api(connection);
    await api('POST', `/apps/${ref.app}/machines/${ref.machine}/stop`, { signal: 'SIGTERM', timeout: '20s' }).catch((error) => {
      if ((error as FlyError).status !== 412) throw error; // already stopped
    });
    await this.waitFor(connection, ref.app!, ref.machine!, 'stopped');
  }

  async destroy(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    // Deleting the app deletes its machine, volume and address.
    await this.api(connection)('DELETE', `/apps/${ref.app}?force=true`).catch((error) => {
      if ((error as FlyError).status !== 404) throw error;
    });
  }

  async growDisk(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, diskGb: number): Promise<boolean> {
    if (diskGb > FLY_MAX_DISK_GB) throw new Error(`A Fly.io volume holds at most ${FLY_MAX_DISK_GB} GB`);
    const api = this.api(connection);
    const volume = await api('GET', `/apps/${ref.app}/volumes/${ref.volume}`) as FlyVolume;
    if (volume.size_gb >= diskGb) return false;
    await api('PUT', `/apps/${ref.app}/volumes/${ref.volume}/extend`, { size_gb: diskGb });
    return true;
  }

  async state(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<WorldLifecycleState | undefined> {
    try {
      const machine = await this.machine(connection, ref.app!, ref.machine!);
      if (['started', 'starting', 'replacing', 'updating'].includes(machine.state)) return 'ready';
      if (['stopped', 'stopping', 'suspended', 'suspending', 'created'].includes(machine.state)) return 'parked';
      if (['destroyed', 'destroying'].includes(machine.state)) return 'missing';
      return undefined;
    } catch (error) {
      if ((error as FlyError).status === 404) return 'missing';
      throw error;
    }
  }

  async list(connection: ResolvedWorldProviderConnection, home: string): Promise<VmListing[]> {
    const api = this.api(connection);
    const apps = (await api('GET', `/apps?org_slug=${encodeURIComponent(organization(connection))}`) as { apps?: Array<{ name: string }> }).apps ?? [];
    const listings: VmListing[] = [];
    for (const app of apps.filter((candidate) => candidate.name.startsWith(appPrefix(home)))) {
      const machines = await api('GET', `/apps/${app.name}/machines`).catch(() => []) as FlyMachine[];
      const labels = machines.find((machine) => machine.config?.metadata?.karmaxHome === home)?.config?.metadata ?? {};
      listings.push({ id: app.name, ...(labels.karmaxTaskId ? { taskId: labels.karmaxTaskId } : {}),
        ...(labels.karmaxGeneration ? { generation: labels.karmaxGeneration } : {}),
        ref: { app: app.name, ...(machines[0] ? { machine: machines[0].id } : {}) },
        destroy: () => this.destroy(connection, { app: app.name }) });
    }
    return listings;
  }

  same(a: Record<string, string>, b: Record<string, string>): boolean { return !!a.app && a.app === b.app; }

  /**
   * Billable time, from Fly's own records: each machine's start→stop runs
   * (its event log) at its guest's price, and each volume's whole hours at
   * its size. A run is reported once it ends; volume hours once they pass.
   * `final` (just before the app is deleted, taking everything with it) ends
   * a run still going and the volume's last part-hour then.
   */
  async usage(connection: ResolvedWorldProviderConnection, home: string, since?: number, final?: FinalUsage): Promise<ProviderUsageEvent[]> {
    const api = this.api(connection);
    const apps = final ? [{ name: final.ref.app! }]
      : (await api('GET', `/apps?org_slug=${encodeURIComponent(organization(connection))}`) as { apps?: Array<{ name: string }> }).apps ?? [];
    const events: ProviderUsageEvent[] = [];
    const now = final?.at ?? Date.now();
    const from = final ? now - FINAL_USAGE_WINDOW_MS : Math.max(since !== undefined ? since - 2 * 3_600_000 : 0, now - 7 * 86_400_000);
    for (const app of apps.filter((candidate) => candidate.name.startsWith(appPrefix(home)))) {
      const machines = await api('GET', `/apps/${app.name}/machines`).catch(() => []) as FlyMachine[];
      const labels = machines.find((machine) => machine.config?.metadata?.karmaxHome === home)?.config?.metadata;
      if (!labels) continue;
      const owner = { ...(labels.karmaxTaskId ? { taskId: labels.karmaxTaskId } : {}),
        ...(labels.karmaxOrganizationId ? { organizationId: labels.karmaxOrganizationId } : {}) };
      for (const machine of machines) {
        const guest = machine.config?.guest;
        if (!guest) continue;
        for (const run of machineRuns(machine.events ?? [], final?.at)) {
          if (run.endedAt < from) continue;
          const seconds = (run.endedAt - run.startedAt) / 1000;
          events.push({ id: `${machine.id}:${run.startedAt}`, sandboxId: app.name, ...owner, startedAt: run.startedAt,
            endedAt: run.endedAt, activeMs: run.endedAt - run.startedAt, cpu: guest.cpus, memoryMb: guest.memory_mb,
            costMicros: Math.round(seconds * flyComputeDollarsPerSecond(guest, machine.region) * 1e6) });
        }
      }
      const volumes = await api('GET', `/apps/${app.name}/volumes`).catch(() => []) as FlyVolume[];
      for (const volume of volumes) {
        const created = Date.parse(volume.created_at ?? '');
        if (!Number.isFinite(created) || volume.state === 'destroyed') continue;
        for (const hour of diskHours(created, now, from, final?.at))
          events.push({ id: `${volume.id}:${hour.start}`, sandboxId: app.name, ...owner, kind: 'disk', startedAt: hour.start,
            endedAt: hour.end, activeMs: hour.end - hour.start, cpu: 0, memoryMb: 0, diskGb: volume.size_gb,
            costMicros: Math.round((hour.end - hour.start) / 1000 * flyVolumeDollarsPerSecond(volume.size_gb) * 1e6) });
      }
    }
    return events;
  }

  /** Fly records an OOM kill on the machine's exit event, even when the machine never answers again. */
  async diagnose(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, window: { since: number; now: number }): Promise<WorldDiagnosis | undefined> {
    const machine = await this.machine(connection, ref.app!, ref.machine!);
    const oom = (machine.events ?? []).find((event) => event.timestamp >= window.since
      && event.request?.exit_event?.oom_killed);
    if (!oom) return undefined;
    return { memoryExhausted: true, summary: `the Fly machine ran out of memory and was stopped at ${new Date(oom.timestamp).toISOString().slice(11, 19)} UTC` };
  }

  async test(connection: ResolvedWorldProviderConnection): Promise<void> {
    await this.api(connection)('GET', `/apps?org_slug=${encodeURIComponent(organization(connection))}`);
    await this.assertNotTrial(connection);
  }

  /** On Fly's free trial flyd stops every machine 300 s after it starts, before
   * a world has even provisioned: refuse up front, saying what fixes it. */
  private async assertNotTrial(connection: ResolvedWorldProviderConnection): Promise<void> {
    const slug = organization(connection);
    const status = await this.fetchImpl(GRAPHQL, { method: 'POST', headers: { ...authorization(connection), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query($slug: String!) { organization(slug: $slug) { billingStatus isCreditCardSaved } }', variables: { slug } }),
      signal: AbortSignal.timeout(30_000) }).then((response) => response.json(), () => undefined) as
      { data?: { organization?: { billingStatus?: string; isCreditCardSaved?: boolean } } } | undefined;
    const org = status?.data?.organization;
    // Unknown (an older API, a network failure) is not proof of a trial.
    if (org && org.isCreditCardSaved === false && /TRIAL/i.test(org.billingStatus ?? ''))
      throw new FlyError(`This Fly.io organization is on its free trial, which stops every machine after 5 minutes. `
        + `Add a payment method at https://fly.io/dashboard/${slug}/billing.`, 402);
  }

  private async allocateAddress(connection: ResolvedWorldProviderConnection, app: string): Promise<void> {
    // A shared IPv4 is free and serves the `tls` service by SNI.
    try {
      await this.api(connection)('POST', `/apps/${app}/ip_assignments`, { type: 'shared_v4' });
      return;
    } catch (error) {
      if (![404, 405].includes((error as FlyError).status ?? 0)) throw error;
    }
    const response = await this.fetchImpl(GRAPHQL, { method: 'POST', headers: { ...authorization(connection), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { app { name } } }',
        variables: { input: { appId: app, type: 'shared_v4' } } }), signal: AbortSignal.timeout(60_000) });
    const body = await response.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
    if (!response.ok || body.errors?.length)
      throw new FlyError(`Fly.io could not give the world an address: ${body.errors?.map((e) => e.message).join('; ') ?? response.status}`, response.status);
  }

  private async waitFor(connection: ResolvedWorldProviderConnection, app: string, machine: string, state: 'started' | 'stopped'): Promise<void> {
    const until = Date.now() + 5 * 60_000;
    for (;;) {
      const current = await this.machine(connection, app, machine);
      if (current.state === state) return;
      if (state === 'started' && ['failed', 'destroyed'].includes(current.state))
        throw new Error(`the Fly machine ${current.state} while starting`);
      if (Date.now() > until) throw new Error(`the Fly machine did not reach ${state} within 5 minutes (it is ${current.state})`);
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /**
   * One machine. Fly's Machines API is eventually consistent: a machine it
   * has just created can answer 404 for a moment (seen live 2026-10-14, right
   * after create). A 404 means gone only once it persists, or its app is gone.
   */
  private async machine(connection: ResolvedWorldProviderConnection, app: string, id: string): Promise<FlyMachine> {
    const api = this.api(connection);
    const until = Date.now() + 30 * this.pollMs;
    for (;;) {
      try {
        return await api('GET', `/apps/${app}/machines/${id}`) as FlyMachine;
      } catch (error) {
        if ((error as FlyError).status !== 404 || Date.now() >= until) throw error;
        const appGone = await api('GET', `/apps/${app}`).then(() => false, (failure) => (failure as FlyError).status === 404);
        if (appGone) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
    }
  }

  /** The machine's state and last events, for an error message. */
  private async evidence(connection: ResolvedWorldProviderConnection, app: string, id: string): Promise<string> {
    const machine = await this.api(connection)('GET', `/apps/${app}/machines/${id}`).catch(() => undefined) as FlyMachine | undefined;
    if (!machine) return '';
    const events = [...machine.events ?? []].sort((a, b) => a.timestamp - b.timestamp).slice(-5).map((event) => {
      const exit = event.request?.exit_event;
      return `${event.type} ${event.status}${exit ? ` exit ${exit.exit_code ?? '?'}${exit.oom_killed ? ' oom' : ''}` : ''}`;
    });
    return `machine ${machine.state}${events.length ? `; events: ${events.join(', ')}` : ''}`;
  }

  private api(connection: ResolvedWorldProviderConnection) {
    return async (method: string, path: string, body?: unknown): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        const response = await this.fetchImpl(`${API}${path}`, {
          method, headers: { ...authorization(connection), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000),
        });
        if (response.ok) {
          const text = await response.text();
          return text ? JSON.parse(text) : {};
        }
        const detail = (await response.text().catch(() => '')).slice(0, 500).split(connection.apiKey).join('[redacted]');
        // Rate limits and Fly's transient 5xx deserve a second chance on reads and idempotent writes.
        if ((response.status === 429 || response.status >= 500) && attempt < 2 && method !== 'POST') {
          await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
          continue;
        }
        throw new FlyError(`Fly.io ${method} ${path.split('?')[0]} failed (${response.status}): ${detail}`, response.status);
      }
    };
  }
}

export class FlyError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'FlyError'; }
}

interface FlyMachine {
  id: string;
  state: string;
  region?: string;
  config?: { guest: FlyGuest; metadata?: Record<string, string>; [key: string]: unknown };
  events?: FlyEvent[];
}
interface FlyEvent { type: string; status: string; timestamp: number; request?: { exit_event?: { oom_killed?: boolean; exit_code?: number } } }
interface FlyVolume { id: string; size_gb: number; created_at?: string; state?: string }

/** Completed start→stop intervals in a machine's event log. */
export function machineRuns(events: FlyEvent[], endAt?: number): Array<{ startedAt: number; endedAt: number }> {
  const runs: Array<{ startedAt: number; endedAt: number }> = [];
  let started: number | undefined;
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (event.type === 'start' && event.status === 'started') started ??= event.timestamp;
    else if (started !== undefined && (['exit', 'stop', 'destroy'].includes(event.type)) && ['stopped', 'destroyed', 'failed'].includes(event.status)) {
      runs.push({ startedAt: started, endedAt: event.timestamp });
      started = undefined;
    }
  }
  // A run still going when the machine is deleted ends then.
  if (started !== undefined && endAt !== undefined && endAt > started) runs.push({ startedAt: started, endedAt: endAt });
  return runs;
}

function machineConfig(image: string, labels: Record<string, string>, shape: VmShape, keys: VmBootKeys, volume: string) {
  const file = (guest_path: string, value: string) => ({ guest_path, raw_value: Buffer.from(value).toString('base64') });
  return {
    image,
    guest: { ...flyGuest(shape), persist_rootfs: 'always' },
    init: { exec: ['/bin/sh', `${VM_ETC}/boot.sh`] },
    files: [
      file(`${VM_ETC}/boot.sh`, vmBootScript({ foreground: true })),
      file(`${VM_ETC}/ssh_host_ed25519_key`, keys.hostPrivateKey),
      file(`${VM_ETC}/authorized_keys`, `${keys.authorizedKey}\n`),
    ],
    mounts: [{ volume, path: VM_HOME }],
    // TLS terminates at Fly's edge; sshd behind it authenticates both ends.
    services: [{ protocol: 'tcp', internal_port: VM_SSH_PORT, autostop: 'off', autostart: false,
      ports: [{ port: 443, handlers: ['tls'] }] }],
    metadata: labels,
    restart: { policy: 'on-failure', max_retries: 3 },
    auto_destroy: false,
  };
}

function sameGuest(a: FlyGuest | undefined, b: FlyGuest): boolean {
  return !!a && a.cpu_kind === b.cpu_kind && a.cpus === b.cpus && a.memory_mb === b.memory_mb;
}

/** `kx-<home>-<world>`: global on Fly, recognisably this deployment's. */
function appName(labels: Record<string, string>): string {
  const world = crypto.createHash('sha256').update(`${labels.karmaxTaskId}:${labels.karmaxGeneration}`).digest('hex').slice(0, 12);
  return `${appPrefix(labels.karmaxHome!)}${world}`;
}
function appPrefix(home: string): string { return `kx-${home.slice(0, 10)}-`; }

function organization(connection: ResolvedWorldProviderConnection): string {
  return connection.config.organization ?? 'personal';
}

/** Fly org tokens arrive as `FlyV1 fm2_…`; personal access tokens are bearer tokens. */
function authorization(connection: ResolvedWorldProviderConnection): Record<string, string> {
  const token = connection.apiKey.trim();
  return { authorization: /^FlyV1\s/.test(token) ? token : `Bearer ${token}` };
}
