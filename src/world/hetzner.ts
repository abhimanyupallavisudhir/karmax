import crypto from 'node:crypto';
import type { MachineShape } from '../domain/computer.js';
import type { ComputerLimits } from '../domain/computer-limits.js';
import type { ResolvedWorldProviderConnection } from './connections.js';
import type { ProviderUsageEvent, WorldLifecycleState } from './types.js';
import { runDetached, type VmAllocation, type VmBootKeys, type VmDriver, type VmListing, type VmShape } from './vm/provider.js';
import { cloudInit, VM_ETC, VM_SSH_PORT, VM_USER, vmProvisionScript, vmProvisionStamp, vmProvisionVersion } from './vm/provision.js';
import { generateSshKeyPair, quote, SshTransport } from './vm/ssh.js';
import { FINAL_USAGE_WINDOW_MS, type FinalUsage } from './vm/runs.js';
import { ProviderCapacityFull, ProviderOutage } from '../agent/limits.js';

export { cloudInit };

/**
 * Hetzner Cloud servers as VM worlds (`vm/provider.ts`). The world's files
 * are a Hetzner volume (10 GB to 10 TB, grown in place), mounted as the VM
 * home; the server around it is disposable.
 *
 * Hetzner bills a server for every hour it exists, powered on or off, so
 * parking must delete it — but each started hour is paid in full the moment it
 * starts. Parking therefore powers the server off and leaves it until a few
 * minutes before its paid hour ends (`housekeep`, every lifecycle sweep): a
 * wake inside that hour is a power-on (no new server, nothing more to pay),
 * and only a later one creates a server and attaches the volume.
 *
 * New servers boot from a snapshot of a provisioned machine, built once per
 * Hetzner project and provisioning version (a few minutes, in the background,
 * the first time a world is made); until it exists, a server provisions itself
 * from stock Debian. A snapshot boots only servers whose disk holds the one it
 * was taken of, so it is taken on the smallest disk on offer (pramana#111).
 * A project firewall admits only karmax's SSH port, and a project SSH key
 * whose private half was never kept stops Hetzner generating (and mailing) a
 * root password.
 *
 * Hetzner's failures are ordinary (pramana#59: a power-on failed "Unknown
 * Error" and the same request a second later worked), so nothing here trusts
 * one answer: refusals are asked again, failed actions run again, a server
 * that will not start or stop is replaced (the world is its volume), a sold-out
 * server type gives way to the next, and what still fails is a
 * `ProviderOutage`, which the platform waits out before asking a person.
 */

const API = 'https://api.hetzner.cloud/v1';
/** One public address per server, IPv4: karmax reaches it by SSH over IPv4,
 * and much of what a world fetches (GitHub) has no IPv6. Hetzner counts every
 * primary IP, IPv6 too, against the project's limit, so an IPv6 address
 * each halved how many servers it admitted (pramana#79: five). */
const PUBLIC_NET = { enable_ipv4: true, enable_ipv6: false };
export const HETZNER_DEFAULT_LOCATION = 'fsn1';
export const HETZNER_DEFAULT_IMAGE = 'debian-12';
export const HETZNER_MIN_DISK_GB = 10;
export const HETZNER_MAX_DISK_GB = 10_240;
export const HETZNER_DEFAULT_DISK_GB = 20;
/** Delete a parked server once less than this is left of its paid hour. */
const PARK_DELETE_MARGIN_MS = 6 * 60_000;
const BUILDER_STALE_MS = 60 * 60_000;
/** How often one API request is sent again (waits of 1, 2, 4 and 8 s). */
const API_RETRIES = 4;
/** How many server types a create tries when Hetzner has none of one left. */
const TYPE_FALLBACKS = 3;
/** Refusals that change nothing: any request may be sent again. */
const REFUSED = new Set(['rate_limit_exceeded', 'locked', 'conflict', 'maintenance', 'unavailable']);
/** Failures that pass but may have done something: only a request that
 * means the same the second time (not a POST) is sent again at once. */
const FAILED = new Set(['server_error', 'service_error', 'timeout']);
/** None of the asked-for server type at the location just now. */
const SOLD_OUT = new Set(['resource_unavailable', 'placement_error']);
/** Hetzner prices in euros; usage is booked in dollars. */
const usdPerEur = () => Number(process.env.KARMAX_USD_PER_EUR ?? 1.17);

type Fetch = typeof fetch;

interface ServerType {
  id: number; name: string; cores: number; memory: number; disk: number; cpu_type: string; architecture: string;
  deprecation?: unknown; deprecated?: boolean;
  prices: Array<{ location: string; price_hourly: { net: string; gross: string } }>;
  /** Where the type can be ordered now (a price alone is not enough: CPX11
   * kept its fsn1 price after it stopped being available there, 2026-10). */
  locations?: Array<{ name: string; available?: boolean; deprecation?: unknown }>;
}

/** Whether a server of this type can be created at `location` now. */
function orderable(type: ServerType, location: string): boolean {
  if (type.architecture !== 'x86' || type.deprecation || type.deprecated) return false;
  if (!type.prices.some((price) => price.location === location)) return false;
  if (!type.locations) return true;
  const here = type.locations.find((entry) => entry.name === location);
  return !!here && here.available !== false && !here.deprecation;
}
interface Server {
  id: number; name: string; status: string; created: string; labels: Record<string, string>;
  server_type: ServerType; volumes?: number[]; datacenter?: { location?: { name?: string } };
  public_net?: { ipv4?: { ip?: string } | null; ipv6?: { ip?: string } | null };
}
/** A provisioned snapshot; `disk_size` (GB) is the disk of the server it was taken of. */
interface Snapshot { id: number; status: string; disk_size: number }
interface Volume { id: number; name: string; size: number; created: string; server: number | null; labels: Record<string, string>;
  location: { name: string }; linux_device?: string; status?: string }

export class HetznerDriver implements VmDriver {
  readonly kind = 'hetzner';
  readonly name = 'Hetzner Cloud';
  private types = new Map<string, { at: number; types: Promise<ServerType[]> }>();
  private building = new Map<string, Promise<void>>();

  /** `pollMs` is the driver's second: every wait is a multiple of it (tests shrink it). */
  constructor(private fetchImpl: Fetch = fetch, private pollMs = 1_000,
    /** Test seam: how the snapshot builder reaches its server over SSH. */
    private builderTransport?: (server: Server, keys: { privateKey: string; hostKey: string }) => SshTransport) {}

  /** The cheapest current x86 server type at the world's location that covers the Computer. */
  async shape(resources: MachineShape | undefined, connection: ResolvedWorldProviderConnection): Promise<VmShape> {
    const diskGb = Math.max(HETZNER_MIN_DISK_GB, resources?.diskGb ?? HETZNER_DEFAULT_DISK_GB);
    if (diskGb > HETZNER_MAX_DISK_GB) throw new Error(`A Hetzner volume holds at most ${HETZNER_MAX_DISK_GB} GB, not ${diskGb} GB`);
    const type = await this.serverType(connection, { cpu: resources?.cpu ?? 2, memoryMb: resources?.memoryMb ?? 2048 });
    return { cpu: type.cores, memoryMb: Math.round(type.memory * 1024), diskGb };
  }

  async allocate(connection: ResolvedWorldProviderConnection, request: { labels: Record<string, string>; shape: VmShape;
    keys: VmBootKeys; signal?: AbortSignal }): Promise<VmAllocation> {
    const api = this.api(connection);
    const location = connection.config.region ?? HETZNER_DEFAULT_LOCATION;
    const name = worldName(request.labels);
    const labels = { ...request.labels, karmaxWorld: name };
    const created = await api('POST', '/volumes', { name, size: request.shape.diskGb, location, labels, format: 'ext4', automount: false })
      .catch(async (error) => { throw projectLimit(error) ? await this.volumesFull(connection, `a ${request.shape.diskGb} GB disk`, error) : error; }) as
      { volume: Volume; action?: { id: number } };
    const ref = { volume: String(created.volume.id), location, world: name };
    try {
      if (created.action) await this.waitAction(connection, created.action.id);
      request.signal?.throwIfAborted();
      await this.createServer(connection, ref, created.volume, request.shape, request.keys, labels);
      return { ref };
    } catch (error) {
      await this.destroy(connection, ref).catch(() => undefined);
      throw error;
    }
  }

  async endpoint(connection: ResolvedWorldProviderConnection, ref: Record<string, string>) {
    const server = await this.serverOf(connection, ref);
    const host = server?.public_net?.ipv4?.ip;
    if (!server || !host) throw Object.assign(new Error('the Hetzner server of this world is not running'), { code: 'ECONNREFUSED' });
    return { host, port: VM_SSH_PORT };
  }

  async start(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape, keys: VmBootKeys): Promise<void> {
    const volume = await this.volume(connection, ref);
    const server = volume.server ? await this.server(connection, volume.server) : undefined;
    const type = await this.serverType(connection, shape);
    if (server && server.status !== 'deleting' && sameSize(server.server_type, type)) {
      // Parked within its paid hour: power it back on.
      try {
        if (server.status !== 'running') await this.serverAction(connection, server.id, 'poweron');
        await this.api(connection)('PUT', `/servers/${server.id}`, { labels: withoutParked(server.labels) });
        return;
      } catch (error) {
        if (!(error instanceof ProviderOutage)) throw error;
        // pramana#59. The server holds nothing the world needs; its volume does.
        console.warn(`[hetzner] ${ref.world}: Hetzner could not start server ${server.id}, so it is replaced: ${error.message}`);
      }
    }
    await this.replace(connection, ref, shape, keys);
  }

  /** A new server on the world's volume, in place of any it has: for a new
   * size, and for a server that will not start or never answers. */
  async replace(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape, keys: VmBootKeys): Promise<void> {
    const volume = await this.volume(connection, ref);
    const attached = volume.server ? await this.server(connection, volume.server) : undefined;
    // Also a server an interrupted replacement made but never attached: it holds the world's name.
    const stale = await this.servers(connection, `karmaxWorld=${ref.world}`);
    for (const server of [...(attached ? [attached] : []), ...stale.filter((server) => server.id !== attached?.id)])
      await this.deleteServer(connection, server);
    await this.createServer(connection, ref, volume, shape, keys, volume.labels);
  }

  async stop(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    const server = await this.serverOf(connection, ref);
    if (!server) return;
    if (server.status !== 'off') {
      try { await this.halt(connection, server.id, 60); }
      catch (error) {
        if (!(error instanceof ProviderOutage)) throw error;
        // A server that will not stop bills on and holds nothing the world needs (its volume does).
        console.warn(`[hetzner] ${ref.world}: Hetzner could not stop server ${server.id}, so it is deleted: ${error.message}`);
        await this.deleteServer(connection, server);
        return;
      }
    }
    if (paidMsLeft(server, Date.now()) < PARK_DELETE_MARGIN_MS || parkGraceDisabled()) await this.deleteServer(connection, server);
    else await this.api(connection)('PUT', `/servers/${server.id}`, { labels: { ...server.labels, karmaxParkedAt: String(Date.now()) } });
  }

  async destroy(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    const api = this.api(connection);
    const volume = await this.volume(connection, ref).catch((error) => { if (error.status === 404) return undefined; throw error; });
    const servers = await this.servers(connection, `karmaxWorld=${ref.world}`);
    for (const server of servers) await this.deleteServer(connection, server);
    if (volume?.server && !servers.some((server) => server.id === volume.server))
      await api('GET', `/servers/${volume.server}`).then((value) => this.deleteServer(connection, (value as { server: Server }).server), () => undefined);
    if (!volume) return;
    for (let attempt = 0; ; attempt++) {
      try { await api('DELETE', `/volumes/${volume.id}`); return; }
      catch (error) {
        const status = (error as HetznerError).status;
        if (status === 404) return;
        // Still detaching from the deleted server.
        if (attempt >= 30 || ![409, 423, 422].includes(status ?? 0)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2 * this.pollMs));
      }
    }
  }

  async growDisk(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, diskGb: number): Promise<boolean> {
    if (diskGb > HETZNER_MAX_DISK_GB) throw new Error(`A Hetzner volume holds at most ${HETZNER_MAX_DISK_GB} GB`);
    const volume = await this.volume(connection, ref);
    if (volume.size >= diskGb) return false;
    const resized = await this.api(connection)('POST', `/volumes/${volume.id}/actions/resize`, { size: diskGb })
      .catch(async (error) => { throw projectLimit(error) ? await this.volumesFull(connection, `growing a disk to ${diskGb} GB`, error) : error; }) as
      { action: { id: number } };
    await this.waitAction(connection, resized.action.id);
    return true;
  }

  async state(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<WorldLifecycleState | undefined> {
    let volume: Volume;
    try { volume = await this.volume(connection, ref); }
    catch (error) { if ((error as HetznerError).status === 404) return 'missing'; throw error; }
    if (!volume.server) return 'parked';
    const server = await this.serverOf(connection, ref);
    if (!server || server.labels.karmaxParkedAt || ['off', 'stopping', 'deleting'].includes(server.status)) return 'parked';
    return 'ready';
  }

  async list(connection: ResolvedWorldProviderConnection, home: string): Promise<VmListing[]> {
    const volumes = await this.pages<Volume>(connection, '/volumes', 'volumes', `karmaxHome=${home}`);
    return volumes.map((volume) => {
      const ref = { volume: String(volume.id), location: volume.location.name, world: volume.labels.karmaxWorld ?? volume.name };
      return { id: volume.name, ref, ...(volume.labels.karmaxTaskId ? { taskId: volume.labels.karmaxTaskId } : {}),
        ...(volume.labels.karmaxGeneration ? { generation: volume.labels.karmaxGeneration } : {}),
        destroy: () => this.destroy(connection, ref) };
    });
  }

  same(a: Record<string, string>, b: Record<string, string>): boolean { return !!a.volume && a.volume === b.volume; }

  /**
   * Hetzner's bill, hour by hour: each started hour of each server at its
   * type's hourly price (plus its IPv4 address) — booked as soon as the hour
   * starts, since it is then owed in full — and each volume hour at its size,
   * once it has passed; `final` (just before a world is deleted) also books
   * the volume's hour under way, which Hetzner bills in full too.
   */
  async usage(connection: ResolvedWorldProviderConnection, home: string, since?: number, final?: FinalUsage): Promise<ProviderUsageEvent[]> {
    const now = final?.at ?? Date.now();
    const from = final ? now - FINAL_USAGE_WINDOW_MS : Math.max(since !== undefined ? since - 2 * 3_600_000 : 0, now - 7 * 86_400_000);
    const selector = `karmaxHome=${home}${final ? `,karmaxWorld=${final.ref.world}` : ''}`;
    const pricing = await this.pricing(connection);
    const events: ProviderUsageEvent[] = [];
    for (const server of await this.servers(connection, selector)) {
      if (!server.labels.karmaxTaskId) continue;
      const created = Date.parse(server.created);
      const location = server.datacenter?.location?.name ?? connection.config.region ?? HETZNER_DEFAULT_LOCATION;
      const hourly = Number(server.server_type.prices.find((price) => price.location === location)?.price_hourly.net ?? 0) + pricing.ipv4Hourly;
      const first = Math.max(0, Math.floor((from - created) / 3_600_000));
      for (let hour = first; created + hour * 3_600_000 <= now; hour++) {
        const startedAt = created + hour * 3_600_000;
        events.push({ id: `server-${server.id}:${hour}`, sandboxId: String(server.id), ...owner(server.labels), startedAt,
          endedAt: startedAt + 3_600_000, activeMs: 3_600_000, cpu: server.server_type.cores, memoryMb: Math.round(server.server_type.memory * 1024),
          costMicros: Math.round(hourly * usdPerEur() * 1e6) });
      }
    }
    for (const volume of await this.pages<Volume>(connection, '/volumes', 'volumes', selector)) {
      const created = Date.parse(volume.created);
      const first = Math.max(0, Math.ceil((from - created) / 3_600_000));
      for (let hour = first; final ? created + hour * 3_600_000 < now : created + (hour + 1) * 3_600_000 <= now; hour++) {
        const startedAt = created + hour * 3_600_000;
        events.push({ id: `volume-${volume.id}:${hour}`, sandboxId: volume.name, ...owner(volume.labels), kind: 'disk', startedAt,
          endedAt: startedAt + 3_600_000, activeMs: 3_600_000, cpu: 0, memoryMb: 0, diskGb: volume.size,
          costMicros: Math.round(volume.size * pricing.volumeGbMonth / 730 * usdPerEur() * 1e6) });
      }
    }
    return events;
  }

  /** Delete parked servers as their paid hour runs out, and builders that died mid-build. */
  async housekeep(connection: ResolvedWorldProviderConnection, home: string): Promise<void> {
    const now = Date.now();
    const doomed = [
      ...(await this.servers(connection, `karmaxHome=${home}`)).filter((server) =>
        server.labels.karmaxParkedAt && server.status === 'off' && paidMsLeft(server, now) < PARK_DELETE_MARGIN_MS),
      ...(await this.servers(connection, 'karmaxImageBuilder')).filter((builder) =>
        now - Date.parse(builder.created) > BUILDER_STALE_MS && !this.building.has(builder.labels.karmaxImageBuilder ?? '')),
    ];
    // One server Hetzner will not delete must not keep the rest billing.
    const failures: unknown[] = [];
    for (const server of doomed) await this.deleteServer(connection, server).catch((error) => { failures.push(error); });
    if (failures.length) throw failures[0];
  }

  /** The largest machine the project can have at its location: the biggest
   * current x86 server type offered there, and a volume of 10 TB. */
  async limits(connection: ResolvedWorldProviderConnection): Promise<ComputerLimits> {
    const location = connection.config.region ?? HETZNER_DEFAULT_LOCATION;
    const types = (await this.pages<ServerType>(connection, '/server_types', 'server_types')).filter((type) => orderable(type, location));
    return { ...(types.length ? { cpu: Math.max(...types.map((type) => type.cores)),
      memoryMb: Math.max(...types.map((type) => Math.round(type.memory * 1024))) } : {}), diskGb: HETZNER_MAX_DISK_GB, checkedAt: Date.now() };
  }

  async test(connection: ResolvedWorldProviderConnection): Promise<void> {
    await this.api(connection)('GET', '/servers?per_page=1');
  }

  // ---------------------------------------------------------------------------

  /** A server for the volume: the cheapest type that covers the shape, else,
   * while Hetzner has none of it left at the location, the next ones. */
  private async createServer(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, volume: Volume,
    shape: VmShape, keys: VmBootKeys, labels: Record<string, string>): Promise<Server> {
    const snapshots = connection.config.image ? undefined : await this.snapshots(connection); // an explicit image is the operator's choice
    const [firewall, sshKey] = await Promise.all([this.firewall(connection), this.rootKey(connection)]);
    const types = (await this.serverTypes(connection, shape)).slice(0, TYPE_FALLBACKS);
    // Hetzner refuses a snapshot bigger than the server's disk ("image disk is
    // bigger than server type disk", pramana#111: one taken on an 80 GB CPX22
    // while the 40 GB CX23 was sold out). Such a server provisions from stock
    // Debian, and a snapshot that fits is built for the next.
    const image = (type: ServerType) => connection.config.image
      ?? (snapshots?.[0] && snapshots[0].disk_size <= type.disk ? String(snapshots[0].id) : HETZNER_DEFAULT_IMAGE);
    if (snapshots && image(types[0]!) === HETZNER_DEFAULT_IMAGE) this.buildSnapshot(connection);
    let soldOut: unknown;
    for (const type of types) {
      try { return await this.createServerOf(connection, ref, volume, type, { image: image(type), firewall, sshKey }, keys, labels); }
      catch (error) {
        if (!isSoldOut(error)) throw error;
        soldOut = error;
        this.types.delete(this.key(connection)); // what is orderable changed within the hour types are cached for
      }
    }
    throw new ProviderCapacityFull(`Hetzner has no ${types.map((type) => type.name).join(', ')} server free at ${ref.location} just now. `
      + 'tavya waits until one is free; to start sooner, give this task another size.', { cause: soldOut });
  }

  private async createServerOf(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, volume: Volume, type: ServerType,
    project: { image: string; firewall: number; sshKey: number }, keys: VmBootKeys, labels: Record<string, string>): Promise<Server> {
    const api = this.api(connection);
    const { image, firewall, sshKey } = project;
    const create = () => api('POST', '/servers', {
      name: ref.world, server_type: type.name, location: ref.location, image,
      labels: withoutParked(labels), volumes: [volume.id], automount: false, start_after_create: true,
      firewalls: [{ firewall: firewall }], ssh_keys: [sshKey], public_net: PUBLIC_NET,
      user_data: cloudInit(keys, volume.linux_device ?? `/dev/disk/by-id/scsi-0HC_Volume_${volume.id}`),
    }) as Promise<{ server: Server; action: { id: number } }>;
    let created: { server: Server; action: { id: number } };
    try { created = await create(); }
    catch (error) {
      const limit = projectLimit(error);
      if (!limit) throw error;
      // A parked server waits out its paid hour for a free wake, yet holds its
      // CPUs against the project's limit: give them to a world that runs now.
      const parked = (await this.servers(connection, `karmaxHome=${labels.karmaxHome},karmaxParkedAt`))
        .filter((server) => server.status === 'off');
      for (const server of parked) await this.deleteServer(connection, server);
      try { created = await create(); }
      catch (again) { throw projectLimit(again) ? await this.limitFull(connection, type, projectLimit(again)!, again) : again; }
    }
    try { await this.waitAction(connection, created.action.id); }
    catch (error) {
      // A server Hetzner failed to make is no use, and would hold the world's name and volume.
      await this.deleteServer(connection, created.server).catch(() => undefined);
      throw error;
    }
    return created.server;
  }

  /** What a full volume limit is, what holds it, and what a person can do. */
  private async volumesFull(connection: ResolvedWorldProviderConnection, what: string, cause: unknown): Promise<ProviderCapacityFull> {
    const volumes = await this.pages<Volume>(connection, '/volumes', 'volumes').catch(() => [] as Volume[]);
    const used = volumes.reduce((sum, volume) => sum + volume.size, 0);
    return new ProviderCapacityFull(`Hetzner refused ${what}: this Hetzner project's limit on the total size of its volumes is full, `
      + `with ${used} GB in ${volumes.length} volume${volumes.length === 1 ? '' : 's'}. tavya waits until there is room; `
      + 'to start sooner, give this task a smaller disk, delete another task, or ask Hetzner to raise the limit (Hetzner Console → Limits).', { cause });
  }

  /** What a full project limit is, what holds it, and what a person can do. */
  private async limitFull(connection: ResolvedWorldProviderConnection, type: ServerType, limit: string, cause: unknown): Promise<ProviderCapacityFull> {
    const servers = await this.servers(connection).catch(() => [] as Server[]);
    const raise = 'or ask Hetzner to raise the limit (Hetzner Console → Limits).';
    const cores = limit === 'server_dedicated_cores_limit' ? 'dedicated' : limit === 'server_shared_cores_limit' ? 'shared' : undefined;
    if (cores) {
      const holding = servers.filter((server) => server.server_type.cpu_type === cores);
      const inUse = holding.reduce((sum, server) => sum + server.server_type.cores, 0);
      // Which tasks hold them (pramana#88: "1 other server" named nothing).
      const tasks = [...new Set(holding.map((server) => server.labels?.karmaxTaskId).filter(Boolean))];
      const whose = tasks.length ? ` (task${tasks.length === 1 ? '' : 's'} ${tasks.slice(0, 3).join(', ')}${tasks.length > 3 ? ', …' : ''})` : '';
      // A server's memory comes with its CPUs: fewer CPUs alone still asked
      // for the same server when the memory did not change (pramana#88).
      const memory = `${Math.round(type.memory)} GB`;
      return new ProviderCapacityFull(`Hetzner refused a ${type.cores}-CPU, ${memory} server: this Hetzner project's limit on ${cores} CPUs is full, `
        + `with ${inUse} in use by ${holding.length} other server${holding.length === 1 ? '' : 's'}${whose}. tavya waits until enough are free; `
        + `to start sooner, give this task fewer CPUs and less memory (Hetzner's servers with ${memory} have ${type.cores} CPUs), stop another task, ${raise}`, { cause });
    }
    const counted = `${servers.length} server${servers.length === 1 ? '' : 's'}`;
    const what = limit === 'primary_ip_limit' ? `limit on public IP addresses is full, with ${counted} using them`
      : `${limit.replace(/_/g, ' ')} is reached, with ${counted}`;
    return new ProviderCapacityFull(`Hetzner refused a new server: this Hetzner project's ${what}. tavya waits until one is free; `
      + `to start sooner, stop another task, ${raise}`, { cause });
  }

  /** The server type for a shape: cheapest current x86 type at the location that covers it. */
  private async serverType(connection: ResolvedWorldProviderConnection, want: { cpu: number; memoryMb: number }): Promise<ServerType> {
    return (await this.serverTypes(connection, want))[0]!;
  }

  /** Every current x86 type at the location that covers a shape, cheapest first. */
  private async serverTypes(connection: ResolvedWorldProviderConnection, want: { cpu: number; memoryMb: number }): Promise<ServerType[]> {
    const location = connection.config.region ?? HETZNER_DEFAULT_LOCATION;
    const key = this.key(connection);
    let cached = this.types.get(key);
    if (!cached || Date.now() - cached.at > 3_600_000) {
      cached = { at: Date.now(), types: this.pages<ServerType>(connection, '/server_types', 'server_types') };
      this.types.set(key, cached);
      cached.types.catch(() => this.types.delete(key));
    }
    const price = (type: ServerType) => Number(type.prices.find((entry) => entry.location === location)?.price_hourly.net ?? Infinity);
    const fits = (await cached.types).filter((type) => orderable(type, location)
      && Number.isFinite(price(type)) && type.cores >= want.cpu && type.memory * 1024 >= want.memoryMb)
      .sort((a, b) => price(a) - price(b) || a.cores - b.cores);
    if (!fits[0]) throw new Error(`Hetzner has no server at ${location} with ${want.cpu} CPU and ${Math.round(want.memoryMb / 1024)} GB of memory`);
    return fits;
  }

  private key(connection: ResolvedWorldProviderConnection): string {
    return crypto.createHash('sha256').update(connection.apiKey).digest('hex');
  }

  private async volume(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<Volume> {
    return ((await this.api(connection)('GET', `/volumes/${ref.volume}`)) as { volume: Volume }).volume;
  }

  private async serverOf(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<Server | undefined> {
    const volume = await this.volume(connection, ref);
    return volume.server ? this.server(connection, volume.server) : undefined;
  }

  /** The server, or undefined when it is gone (only a 404 says so). */
  private async server(connection: ResolvedWorldProviderConnection, id: number): Promise<Server | undefined> {
    return ((await this.api(connection)('GET', `/servers/${id}`).catch((error) => {
      if ((error as HetznerError).status === 404) return { server: undefined }; throw error;
    })) as { server?: Server }).server;
  }

  /** Run a server action, again if Hetzner fails it: it fails the odd one
   * (start_server "Unknown Error", pramana#59) and runs it a moment later. */
  private async serverAction(connection: ResolvedWorldProviderConnection, id: number, verb: string, attempts = 3): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const started = await this.api(connection)('POST', `/servers/${id}/actions/${verb}`) as { action: { id: number } };
        await this.waitAction(connection, started.action.id);
        return;
      } catch (error) {
        if (!(error instanceof ProviderOutage) || attempt >= attempts) throw error;
        await this.sleep(2 ** attempt);
      }
    }
  }

  /** Stop a server: a clean shutdown, and pull the plug if it is not off within `seconds`. */
  private async halt(connection: ResolvedWorldProviderConnection, id: number, seconds: number): Promise<void> {
    const asked = await this.serverAction(connection, id, 'shutdown').then(() => true, (error) => {
      if (!(error instanceof ProviderOutage)) throw error;
      return false;
    });
    if (asked && await this.waitStatus(connection, id, 'off', seconds * this.pollMs)) return;
    await this.serverAction(connection, id, 'poweroff');
  }

  private servers(connection: ResolvedWorldProviderConnection, selector?: string): Promise<Server[]> {
    return this.pages<Server>(connection, '/servers', 'servers', selector);
  }

  private async deleteServer(connection: ResolvedWorldProviderConnection, server: Server): Promise<void> {
    const deleted = await this.api(connection)('DELETE', `/servers/${server.id}`).catch((error) => {
      if ((error as HetznerError).status === 404) return undefined; throw error;
    }) as { action?: { id: number } } | undefined;
    if (deleted?.action) await this.waitAction(connection, deleted.action.id);
  }

  /** The snapshots of machines that ran this provisioning version, smallest disk first. */
  private async snapshots(connection: ResolvedWorldProviderConnection): Promise<Snapshot[]> {
    const images = await this.pages<Snapshot>(connection, '/images', 'images', `karmaxImage=${vmProvisionVersion()}`, 'type=snapshot');
    return images.filter((image) => image.status === 'available').sort((a, b) => a.disk_size - b.disk_size);
  }

  /** The provisioned snapshot, built now if there is none (several minutes). */
  async ensureSnapshot(connection: ResolvedWorldProviderConnection): Promise<string> {
    const until = Date.now() + 45 * 60_000;
    for (;;) {
      const [ready] = await this.snapshots(connection);
      if (ready) return String(ready.id);
      const key = `${this.key(connection)}:${vmProvisionVersion()}`;
      const building = this.building.get(key);
      if (building) await building;
      else if (!(await this.servers(connection, `karmaxImageBuilder=${vmProvisionVersion()}`)).length)
        await this.runBuild(connection, vmProvisionVersion());
      else await new Promise((resolve) => setTimeout(resolve, 15 * this.pollMs));
      if (Date.now() > until) throw new Error('the karmax VM snapshot was not ready within 45 minutes');
    }
  }

  /** Build the provisioned snapshot in the background, once per project and version. */
  private buildSnapshot(connection: ResolvedWorldProviderConnection): void {
    const version = vmProvisionVersion();
    const key = `${this.key(connection)}:${version}`;
    if (this.building.has(key) || process.env.KARMAX_HETZNER_SNAPSHOTS === '0') return;
    const build = this.runBuild(connection, version).catch((error) => {
      console.warn(`[hetzner] building the karmax VM snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => this.building.delete(key));
    this.building.set(key, build);
  }

  private async runBuild(connection: ResolvedWorldProviderConnection, version: string): Promise<void> {
    const api = this.api(connection);
    if ((await this.servers(connection, `karmaxImageBuilder=${version}`)).length) return; // another process builds it
    // The smallest disk on offer that can provision, so the snapshot fits every
    // server type; built again only when a smaller one than any built is on offer.
    const type = (await this.serverTypes(connection, { cpu: 2, memoryMb: 2048 })).sort((a, b) => a.disk - b.disk)[0]!;
    const [built] = await this.snapshots(connection);
    if (built && built.disk_size <= type.disk) return;
    const host = generateSshKeyPair('karmax-builder-host');
    const client = generateSshKeyPair('karmax-builder');
    const [firewall, sshKey] = await Promise.all([this.firewall(connection), this.rootKey(connection)]);
    const created = await api('POST', '/servers', {
      name: `karmax-image-${version}`, server_type: type.name, location: connection.config.region ?? HETZNER_DEFAULT_LOCATION,
      image: HETZNER_DEFAULT_IMAGE, labels: { karmaxImageBuilder: version }, start_after_create: true,
      firewalls: [{ firewall }], ssh_keys: [sshKey], public_net: PUBLIC_NET,
      user_data: cloudInit({ hostPrivateKey: host.privateKey, authorizedKey: client.publicKey }),
    }) as { server: Server; action: { id: number } };
    try {
      await this.waitAction(connection, created.action.id);
      const server = ((await api('GET', `/servers/${created.server.id}`)) as { server: Server }).server;
      const transport = this.builderTransport?.(server, { privateKey: client.privateKey, hostKey: host.publicKey })
        ?? new SshTransport(async () => ({ host: server.public_net!.ipv4!.ip!, port: VM_SSH_PORT, hostKey: host.publicKey,
          username: VM_USER, privateKey: client.privateKey }));
      try {
        for (let attempt = 0; ; attempt++) {
          try { if ((await transport.exec('true', { timeoutMs: 20_000 })).code === 0) break; } catch { transport.reset(); }
          if (attempt > 60) throw new Error('the image builder never answered SSH');
          await new Promise((resolve) => setTimeout(resolve, 5 * this.pollMs));
        }
        // Detached and polled, as a world provisions: minutes of installs must not hang on one channel.
        await runDetached(transport, vmProvisionScript(), true, 30 * 60_000)
          .catch((error) => { throw new Error(`provisioning failed: ${error instanceof Error ? error.message : String(error)}`); });
        // Nothing of this server's own may reach the worlds made from it.
        await transport.exec(`sudo -n sh -c ${quote(`rm -rf ${VM_ETC} /etc/ssh/sshd_config.d/00-karmax.conf /var/lib/cloud/scripts/per-boot/karmax-boot.sh; `
          + `test -f ${vmProvisionStamp()} && cloud-init clean --logs --seed; sync`)}`, { timeoutMs: 120_000 });
      } finally {
        transport.close();
      }
      await this.halt(connection, server.id, 120);
      const image = await api('POST', `/servers/${server.id}/actions/create_image`, {
        type: 'snapshot', description: `karmax VM ${version} (${type.disk} GB)`, labels: { karmaxImage: version } }) as { action: { id: number } };
      await this.waitAction(connection, image.action.id, 30 * 60_000);
    } finally {
      await this.deleteServer(connection, created.server).catch(() => undefined);
    }
  }

  /** One lookup-or-create at a time per project resource: a project's first
   * world and its snapshot builder start together, and each made its own. */
  private projectResources = new Map<string, Promise<number>>();
  private once(connection: ResolvedWorldProviderConnection, name: string, make: () => Promise<number>): Promise<number> {
    const key = `${this.key(connection)}:${name}`;
    let pending = this.projectResources.get(key);
    if (!pending) {
      pending = make().finally(() => this.projectResources.delete(key));
      this.projectResources.set(key, pending);
    }
    return pending;
  }

  /** The project firewall: inbound SSH to karmax's port, and ping. Made once. */
  private firewall(connection: ResolvedWorldProviderConnection): Promise<number> {
    return this.once(connection, 'firewall', async () => {
      const existing = await this.pages<{ id: number }>(connection, '/firewalls', 'firewalls', 'karmaxFirewall=vm');
      if (existing[0]) return existing[0].id;
      const anywhere = ['0.0.0.0/0', '::/0'];
      const created = await this.api(connection)('POST', '/firewalls', { name: `karmax-vm-${crypto.randomBytes(3).toString('hex')}`,
        labels: { karmaxFirewall: 'vm' }, rules: [
          { direction: 'in', protocol: 'tcp', port: String(VM_SSH_PORT), source_ips: anywhere },
          { direction: 'in', protocol: 'icmp', source_ips: anywhere },
        ] }) as { firewall: { id: number } };
      return created.firewall.id;
    });
  }

  /** A project SSH key nobody holds: with it Hetzner sets no root password. */
  private rootKey(connection: ResolvedWorldProviderConnection): Promise<number> {
    return this.once(connection, 'root-key', async () => {
      const existing = await this.pages<{ id: number }>(connection, '/ssh_keys', 'ssh_keys', 'karmaxSshKey=no-root-login');
      if (existing[0]) return existing[0].id;
      const created = await this.api(connection)('POST', '/ssh_keys', { name: `karmax-no-root-login-${crypto.randomBytes(3).toString('hex')}`,
        public_key: generateSshKeyPair('karmax-no-root-login').publicKey, labels: { karmaxSshKey: 'no-root-login' } }) as { ssh_key: { id: number } };
      return created.ssh_key.id;
    });
  }

  private pricingCache = new Map<string, Promise<{ ipv4Hourly: number; volumeGbMonth: number }>>();
  private pricing(connection: ResolvedWorldProviderConnection): Promise<{ ipv4Hourly: number; volumeGbMonth: number }> {
    const key = this.key(connection);
    let cached = this.pricingCache.get(key);
    if (!cached) {
      cached = this.api(connection)('GET', '/pricing').then((value) => {
        const pricing = (value as { pricing: any }).pricing ?? {};
        const location = connection.config.region ?? HETZNER_DEFAULT_LOCATION;
        const ipv4 = (pricing.primary_ips ?? []).find((entry: any) => entry.type === 'ipv4')?.prices
          ?.find((entry: any) => entry.location === location)?.price_hourly?.net;
        return { ipv4Hourly: Number(ipv4 ?? 0), volumeGbMonth: Number(pricing.volume?.price_per_gb_month?.net ?? 0.044) };
      });
      this.pricingCache.set(key, cached);
      cached.catch(() => this.pricingCache.delete(key));
    }
    return cached;
  }

  /** Wait for an action. A failed or endless one is an outage: Hetzner says
   * nothing more than "Unknown Error", and the same request later works. */
  private async waitAction(connection: ResolvedWorldProviderConnection, id: number, ms = 10 * 60_000): Promise<void> {
    const until = Date.now() + ms;
    for (let poll = 0; ; poll++) {
      const { action } = await this.api(connection)('GET', `/actions/${id}`) as
        { action: { status: string; command?: string; error?: { code?: string; message?: string } } };
      const what = `Hetzner's ${action.command ?? 'action'} ${id}`;
      if (action.status === 'success') return;
      if (action.status === 'error')
        throw new HetznerOutage(`${what} failed: ${action.error?.message ?? 'no reason given'}${action.error?.code ? ` (${action.error.code})` : ''}`,
          undefined, action.error?.code);
      if (Date.now() > until) throw new HetznerOutage(`${what} did not finish within ${Math.round(ms / 60_000)} minutes`);
      await this.sleep(Math.min(5, 1 + Math.floor(poll / 10)));
    }
  }

  private sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * this.pollMs));
  }

  private async waitStatus(connection: ResolvedWorldProviderConnection, id: number, status: string, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      const { server } = await this.api(connection)('GET', `/servers/${id}`) as { server: Server };
      if (server.status === status) return true;
      if (Date.now() > until) return false;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  private async pages<T>(connection: ResolvedWorldProviderConnection, path: string, field: string, selector?: string, extra?: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: '50' });
      if (selector) query.set('label_selector', selector);
      const body = await this.api(connection)('GET', `${path}?${query}${extra ? `&${extra}` : ''}`) as Record<string, any>;
      items.push(...(body[field] ?? []));
      if (!body.meta?.pagination?.next_page) break;
    }
    return items;
  }

  /**
   * One API request. A refusal (rate limit, a resource locked by a running
   * action, maintenance) changed nothing and is sent again whatever it is; a
   * failure that may have done something (a 5xx, no answer) is sent again
   * only if it means the same the second time — never a POST, which would
   * make a second volume or server. What still fails and passes with time is
   * a `HetznerOutage`; the rest (a 404, a refused limit, bad input) a `HetznerError`.
   */
  private api(connection: ResolvedWorldProviderConnection) {
    return async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const route = `${method} ${path.split('?')[0]}`;
      const resend = method !== 'POST';
      const redact = (text: string) => text.split(connection.apiKey).join('[redacted]');
      for (let attempt = 0; ; attempt++) {
        const last = attempt >= API_RETRIES;
        let response: Response;
        let text: string;
        try {
          response = await this.fetchImpl(`${API}${path}`, {
            method, headers: { authorization: `Bearer ${connection.apiKey.trim()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000),
          });
          text = await response.text();
        } catch (error) {
          if (resend && !last) { await this.sleep(2 ** attempt); continue; }
          throw new HetznerOutage(`Hetzner ${route} got no answer: ${redact(error instanceof Error ? error.message : String(error))}`,
            undefined, undefined, undefined, { cause: error });
        }
        if (response.ok) return text ? JSON.parse(text) : {};
        const detail = redact(text.slice(0, 500));
        const code = errorCode(text);
        const refused = response.status === 429 || REFUSED.has(code ?? '');
        const failed = response.status >= 500 || FAILED.has(code ?? '');
        if (!last && (refused || (failed && resend))) { await this.sleep(retryAfter(response) ?? 2 ** attempt); continue; }
        const message = `Hetzner ${route} failed (${response.status}): ${detail}`;
        if (refused || failed || SOLD_OUT.has(code ?? '')) throw new HetznerOutage(message, response.status, code, detail);
        throw new HetznerError(message, response.status, detail, code);
      }
    };
  }
}

export class HetznerError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string, readonly code?: string) { super(message); this.name = 'HetznerError'; }
}

/** A Hetzner failure that passes with time: retried by the platform as infrastructure, never the agent's. */
export class HetznerOutage extends ProviderOutage {
  constructor(message: string, readonly status?: number, readonly code?: string, readonly body?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HetznerOutage';
  }
}

/** Hetzner's error code (`locked`, `resource_limit_exceeded`…) in a response body. */
function errorCode(body: string): string | undefined {
  try { return (JSON.parse(body) as { error?: { code?: string } }).error?.code; } catch { return undefined; }
}

/** Seconds until Hetzner's rate limit lets requests through again (at most a minute). */
function retryAfter(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const reset = Number(response.headers.get('ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? Math.min(60, Math.max(1, Math.ceil(reset - Date.now() / 1000))) : undefined;
}

/** Hetzner has none of the server type at the location just now, or no longer offers it there. */
function isSoldOut(error: unknown): boolean {
  const code = (error as HetznerError | HetznerOutage | undefined)?.code;
  return SOLD_OUT.has(code ?? '') || (code === 'invalid_input' && /unsupported location for server type/i.test((error as Error).message));
}

/** Whether a server is the size a type is: the same CPUs, memory and kind of CPU. */
function sameSize(a: ServerType, b: ServerType): boolean {
  return a.cores === b.cores && a.memory === b.memory && a.cpu_type === b.cpu_type;
}

/** The project limit a refusal names (`server_shared_cores_limit`…), when
 * Hetzner refused because one is reached. */
function projectLimit(error: unknown): string | undefined {
  if (!(error instanceof HetznerError) || error.status !== 403 || !error.body) return undefined;
  try {
    const refusal = JSON.parse(error.body) as { error?: { code?: string; details?: { limits?: Array<{ name?: string }> } } };
    if (refusal.error?.code !== 'resource_limit_exceeded') return undefined;
    return refusal.error.details?.limits?.[0]?.name ?? 'resource limit';
  } catch { return undefined; }
}

/** Milliseconds left of the server's current paid hour (hours count from its creation). */
export function paidMsLeft(server: { created: string }, now: number): number {
  const age = now - Date.parse(server.created);
  return 3_600_000 - (age % 3_600_000);
}

function parkGraceDisabled(): boolean { return process.env.KARMAX_HETZNER_PARK_GRACE === '0'; }

function withoutParked(labels: Record<string, string>): Record<string, string> {
  const { karmaxParkedAt: _parked, ...rest } = labels;
  return rest;
}

function owner(labels: Record<string, string>) {
  return { ...(labels.karmaxTaskId ? { taskId: labels.karmaxTaskId } : {}),
    ...(labels.karmaxOrganizationId ? { organizationId: labels.karmaxOrganizationId } : {}) };
}

/** `kx-<home>-<world>`: a server and volume name, and the label tying them together. */
function worldName(labels: Record<string, string>): string {
  const world = crypto.createHash('sha256').update(`${labels.karmaxTaskId}:${labels.karmaxGeneration}`).digest('hex').slice(0, 12);
  return `kx-${labels.karmaxHome!.slice(0, 10)}-${world}`;
}
