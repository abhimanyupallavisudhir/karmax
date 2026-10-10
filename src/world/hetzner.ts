import crypto from 'node:crypto';
import type { MachineShape } from '../domain/computer.js';
import type { ComputerLimits } from '../domain/computer-limits.js';
import type { ResolvedWorldProviderConnection } from './connections.js';
import type { ProviderUsageEvent, WorldLifecycleState } from './types.js';
import type { VmAllocation, VmBootKeys, VmDriver, VmListing, VmShape } from './vm/provider.js';
import { VM_ETC, VM_SSH_PORT, VM_USER, vmBootScript, vmProvisionScript, vmProvisionStamp, vmProvisionVersion } from './vm/provision.js';
import { generateSshKeyPair, quote, SshTransport } from './vm/ssh.js';

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
 * from stock Debian. A project firewall admits only karmax's SSH port, and a
 * project SSH key whose private half was never kept stops Hetzner generating
 * (and mailing) a root password.
 */

const API = 'https://api.hetzner.cloud/v1';
export const HETZNER_DEFAULT_LOCATION = 'fsn1';
export const HETZNER_DEFAULT_IMAGE = 'debian-12';
export const HETZNER_MIN_DISK_GB = 10;
export const HETZNER_MAX_DISK_GB = 10_240;
export const HETZNER_DEFAULT_DISK_GB = 20;
/** Delete a parked server once less than this is left of its paid hour. */
const PARK_DELETE_MARGIN_MS = 6 * 60_000;
const BUILDER_STALE_MS = 60 * 60_000;
/** Hetzner prices in euros; usage is booked in dollars. */
const usdPerEur = () => Number(process.env.KARMAX_USD_PER_EUR ?? 1.17);

type Fetch = typeof fetch;

interface ServerType {
  id: number; name: string; cores: number; memory: number; cpu_type: string; architecture: string;
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
interface Volume { id: number; name: string; size: number; created: string; server: number | null; labels: Record<string, string>;
  location: { name: string }; linux_device?: string; status?: string }

export class HetznerDriver implements VmDriver {
  readonly kind = 'hetzner';
  readonly name = 'Hetzner Cloud';
  private types = new Map<string, { at: number; types: Promise<ServerType[]> }>();
  private building = new Map<string, Promise<void>>();

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
    const created = await api('POST', '/volumes', { name, size: request.shape.diskGb, location, labels, format: 'ext4', automount: false }) as
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
    const api = this.api(connection);
    const volume = await this.volume(connection, ref);
    const server = volume.server ? await api('GET', `/servers/${volume.server}`).then((value) => (value as { server: Server }).server, () => undefined) : undefined;
    const type = await this.serverType(connection, shape);
    if (server && server.server_type.name === type.name) {
      // Parked within its paid hour: power it back on.
      if (server.status !== 'running') {
        const action = await api('POST', `/servers/${server.id}/actions/poweron`) as { action: { id: number } };
        await this.waitAction(connection, action.action.id);
      }
      await api('PUT', `/servers/${server.id}`, { labels: withoutParked(server.labels) });
      return;
    }
    if (server) await this.deleteServer(connection, server);
    await this.createServer(connection, ref, volume, shape, keys, volume.labels);
  }

  async stop(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    const server = await this.serverOf(connection, ref);
    if (!server) return;
    const api = this.api(connection);
    if (server.status !== 'off') {
      // A clean shutdown first; Hetzner's poweroff is pulling the plug.
      const shutdown = await api('POST', `/servers/${server.id}/actions/shutdown`) as { action: { id: number } };
      await this.waitAction(connection, shutdown.action.id);
      if (!(await this.waitStatus(connection, server.id, 'off', 60_000))) {
        const off = await api('POST', `/servers/${server.id}/actions/poweroff`) as { action: { id: number } };
        await this.waitAction(connection, off.action.id);
      }
    }
    if (paidMsLeft(server, Date.now()) < PARK_DELETE_MARGIN_MS || parkGraceDisabled()) await this.deleteServer(connection, server);
    else await api('PUT', `/servers/${server.id}`, { labels: { ...server.labels, karmaxParkedAt: String(Date.now()) } });
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
    const resized = await this.api(connection)('POST', `/volumes/${volume.id}/actions/resize`, { size: diskGb }) as { action: { id: number } };
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
   * starts, since it is then owed in full — and each volume hour at its size.
   */
  async usage(connection: ResolvedWorldProviderConnection, home: string, since?: number): Promise<ProviderUsageEvent[]> {
    const now = Date.now();
    const from = Math.max(since !== undefined ? since - 2 * 3_600_000 : 0, now - 7 * 86_400_000);
    const pricing = await this.pricing(connection);
    const events: ProviderUsageEvent[] = [];
    for (const server of await this.servers(connection, `karmaxHome=${home}`)) {
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
    for (const volume of await this.pages<Volume>(connection, '/volumes', 'volumes', `karmaxHome=${home}`)) {
      const created = Date.parse(volume.created);
      const first = Math.max(0, Math.ceil((from - created) / 3_600_000));
      for (let hour = first; created + (hour + 1) * 3_600_000 <= now; hour++) {
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
    for (const server of await this.servers(connection, `karmaxHome=${home}`)) {
      if (server.labels.karmaxParkedAt && server.status === 'off' && paidMsLeft(server, now) < PARK_DELETE_MARGIN_MS)
        await this.deleteServer(connection, server);
    }
    for (const builder of await this.servers(connection, 'karmaxImageBuilder'))
      if (now - Date.parse(builder.created) > BUILDER_STALE_MS && !this.building.has(builder.labels.karmaxImageBuilder ?? ''))
        await this.deleteServer(connection, builder);
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

  private async createServer(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, volume: Volume,
    shape: VmShape, keys: VmBootKeys, labels: Record<string, string>): Promise<Server> {
    const api = this.api(connection);
    const type = await this.serverType(connection, shape);
    const snapshot = await this.snapshot(connection);
    if (!snapshot) this.buildSnapshot(connection);
    const [firewall, sshKey] = await Promise.all([this.firewall(connection), this.rootKey(connection)]);
    const created = await api('POST', '/servers', {
      name: ref.world, server_type: type.name, location: ref.location, image: snapshot ?? connection.config.image ?? HETZNER_DEFAULT_IMAGE,
      labels: withoutParked(labels), volumes: [volume.id], automount: false, start_after_create: true,
      firewalls: [{ firewall: firewall }], ssh_keys: [sshKey], public_net: { enable_ipv4: true, enable_ipv6: true },
      user_data: cloudInit(keys, volume.linux_device ?? `/dev/disk/by-id/scsi-0HC_Volume_${volume.id}`),
    }) as { server: Server; action: { id: number } };
    await this.waitAction(connection, created.action.id);
    return created.server;
  }

  /** The server type for a shape: cheapest current x86 type at the location that covers it. */
  private async serverType(connection: ResolvedWorldProviderConnection, want: { cpu: number; memoryMb: number }): Promise<ServerType> {
    const location = connection.config.region ?? HETZNER_DEFAULT_LOCATION;
    const key = crypto.createHash('sha256').update(connection.apiKey).digest('hex');
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
    return fits[0];
  }

  private async volume(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<Volume> {
    return ((await this.api(connection)('GET', `/volumes/${ref.volume}`)) as { volume: Volume }).volume;
  }

  private async serverOf(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<Server | undefined> {
    const volume = await this.volume(connection, ref);
    if (!volume.server) return undefined;
    return ((await this.api(connection)('GET', `/servers/${volume.server}`).catch((error) => {
      if ((error as HetznerError).status === 404) return { server: undefined }; throw error;
    })) as { server?: Server }).server;
  }

  private servers(connection: ResolvedWorldProviderConnection, selector: string): Promise<Server[]> {
    return this.pages<Server>(connection, '/servers', 'servers', selector);
  }

  private async deleteServer(connection: ResolvedWorldProviderConnection, server: Server): Promise<void> {
    const deleted = await this.api(connection)('DELETE', `/servers/${server.id}`).catch((error) => {
      if ((error as HetznerError).status === 404) return undefined; throw error;
    }) as { action?: { id: number } } | undefined;
    if (deleted?.action) await this.waitAction(connection, deleted.action.id);
  }

  /** The snapshot of a machine that ran this provisioning version, if built. */
  private async snapshot(connection: ResolvedWorldProviderConnection): Promise<string | undefined> {
    if (connection.config.image) return undefined; // an explicit image is the operator's choice
    const images = await this.pages<{ id: number; status: string }>(connection, '/images', 'images', `karmaxImage=${vmProvisionVersion()}`, 'type=snapshot');
    const ready = images.find((image) => image.status === 'available');
    return ready ? String(ready.id) : undefined;
  }

  /** The provisioned snapshot, built now if there is none (several minutes). */
  async ensureSnapshot(connection: ResolvedWorldProviderConnection): Promise<string> {
    const until = Date.now() + 45 * 60_000;
    for (;;) {
      const ready = await this.snapshot(connection);
      if (ready) return ready;
      const key = `${crypto.createHash('sha256').update(connection.apiKey).digest('hex')}:${vmProvisionVersion()}`;
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
    const key = `${crypto.createHash('sha256').update(connection.apiKey).digest('hex')}:${version}`;
    if (this.building.has(key) || process.env.KARMAX_HETZNER_SNAPSHOTS === '0') return;
    const build = this.runBuild(connection, version).catch((error) => {
      console.warn(`[hetzner] building the karmax VM snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => this.building.delete(key));
    this.building.set(key, build);
  }

  private async runBuild(connection: ResolvedWorldProviderConnection, version: string): Promise<void> {
    const api = this.api(connection);
    if ((await this.servers(connection, `karmaxImageBuilder=${version}`)).length) return; // another process builds it
    const host = generateSshKeyPair('karmax-builder-host');
    const client = generateSshKeyPair('karmax-builder');
    const type = await this.serverType(connection, { cpu: 2, memoryMb: 2048 });
    const [firewall, sshKey] = await Promise.all([this.firewall(connection), this.rootKey(connection)]);
    const created = await api('POST', '/servers', {
      name: `karmax-image-${version}`, server_type: type.name, location: connection.config.region ?? HETZNER_DEFAULT_LOCATION,
      image: HETZNER_DEFAULT_IMAGE, labels: { karmaxImageBuilder: version }, start_after_create: true,
      firewalls: [{ firewall }], ssh_keys: [sshKey], public_net: { enable_ipv4: true, enable_ipv6: true },
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
        await transport.writeFile('/tmp/karmax-provision.sh', Buffer.from(vmProvisionScript()), 0o700);
        const run = await transport.exec('sudo -n bash /tmp/karmax-provision.sh > /tmp/karmax-provision.log 2>&1 || { tail -n 40 /tmp/karmax-provision.log; exit 1; }',
          { timeoutMs: 30 * 60_000 });
        if (run.code !== 0) throw new Error(`provisioning failed: ${run.stdout.toString().slice(-2000)}`);
        // Nothing of this server's own may reach the worlds made from it.
        await transport.exec(`sudo -n sh -c ${quote(`rm -rf ${VM_ETC} /etc/ssh/sshd_config.d/00-karmax.conf /var/lib/cloud/scripts/per-boot/karmax-boot.sh; `
          + `test -f ${vmProvisionStamp()} && cloud-init clean --logs --seed; sync`)}`, { timeoutMs: 120_000 });
      } finally {
        transport.close();
      }
      const shutdown = await api('POST', `/servers/${server.id}/actions/shutdown`) as { action: { id: number } };
      await this.waitAction(connection, shutdown.action.id);
      if (!(await this.waitStatus(connection, server.id, 'off', 120_000))) {
        const off = await api('POST', `/servers/${server.id}/actions/poweroff`) as { action: { id: number } };
        await this.waitAction(connection, off.action.id);
      }
      const image = await api('POST', `/servers/${server.id}/actions/create_image`, {
        type: 'snapshot', description: `karmax VM ${version}`, labels: { karmaxImage: version } }) as { action: { id: number } };
      await this.waitAction(connection, image.action.id, 30 * 60_000);
    } finally {
      await this.deleteServer(connection, created.server).catch(() => undefined);
    }
  }

  /** The project firewall: inbound SSH to karmax's port, and ping. Made once. */
  private async firewall(connection: ResolvedWorldProviderConnection): Promise<number> {
    const existing = await this.pages<{ id: number }>(connection, '/firewalls', 'firewalls', 'karmaxFirewall=vm');
    if (existing[0]) return existing[0].id;
    const anywhere = ['0.0.0.0/0', '::/0'];
    const created = await this.api(connection)('POST', '/firewalls', { name: `karmax-vm-${crypto.randomBytes(3).toString('hex')}`,
      labels: { karmaxFirewall: 'vm' }, rules: [
        { direction: 'in', protocol: 'tcp', port: String(VM_SSH_PORT), source_ips: anywhere },
        { direction: 'in', protocol: 'icmp', source_ips: anywhere },
      ] }) as { firewall: { id: number } };
    return created.firewall.id;
  }

  /** A project SSH key nobody holds: with it Hetzner sets no root password. */
  private async rootKey(connection: ResolvedWorldProviderConnection): Promise<number> {
    const existing = await this.pages<{ id: number }>(connection, '/ssh_keys', 'ssh_keys', 'karmaxSshKey=no-root-login');
    if (existing[0]) return existing[0].id;
    const created = await this.api(connection)('POST', '/ssh_keys', { name: `karmax-no-root-login-${crypto.randomBytes(3).toString('hex')}`,
      public_key: generateSshKeyPair('karmax-no-root-login').publicKey, labels: { karmaxSshKey: 'no-root-login' } }) as { ssh_key: { id: number } };
    return created.ssh_key.id;
  }

  private pricingCache = new Map<string, Promise<{ ipv4Hourly: number; volumeGbMonth: number }>>();
  private pricing(connection: ResolvedWorldProviderConnection): Promise<{ ipv4Hourly: number; volumeGbMonth: number }> {
    const key = crypto.createHash('sha256').update(connection.apiKey).digest('hex');
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

  private async waitAction(connection: ResolvedWorldProviderConnection, id: number, ms = 10 * 60_000): Promise<void> {
    const until = Date.now() + ms;
    for (;;) {
      const { action } = await this.api(connection)('GET', `/actions/${id}`) as { action: { status: string; error?: { message?: string } } };
      if (action.status === 'success') return;
      if (action.status === 'error') throw new HetznerError(`Hetzner action failed: ${action.error?.message ?? 'unknown error'}`);
      if (Date.now() > until) throw new Error('a Hetzner action did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
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

  private api(connection: ResolvedWorldProviderConnection) {
    return async (method: string, path: string, body?: unknown): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        const response = await this.fetchImpl(`${API}${path}`, {
          method, headers: { authorization: `Bearer ${connection.apiKey.trim()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000),
        });
        if (response.ok) {
          const text = await response.text();
          return text ? JSON.parse(text) : {};
        }
        const detail = (await response.text().catch(() => '')).slice(0, 500).split(connection.apiKey).join('[redacted]');
        if ((response.status === 429 || response.status >= 500) && attempt < 2 && method === 'GET') {
          await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
          continue;
        }
        throw new HetznerError(`Hetzner ${method} ${path.split('?')[0]} failed (${response.status}): ${detail}`, response.status);
      }
    };
  }
}

export class HetznerError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'HetznerError'; }
}

/** cloud-init for every server: the boot script (run at every boot), its keys and the volume's device. */
export function cloudInit(keys: VmBootKeys, device?: string): string {
  const file = (path: string, content: string, permissions: string) =>
    `  - path: ${path}\n    permissions: '${permissions}'\n    encoding: b64\n    content: ${Buffer.from(content).toString('base64')}\n`;
  return `#cloud-config\nwrite_files:\n${[
    file(`${VM_ETC}/ssh_host_ed25519_key`, keys.hostPrivateKey, '0600'),
    file(`${VM_ETC}/authorized_keys`, `${keys.authorizedKey}\n`, '0644'),
    ...(device ? [file(`${VM_ETC}/volume-device`, device, '0644')] : []),
    file('/var/lib/cloud/scripts/per-boot/karmax-boot.sh', vmBootScript({ foreground: false }), '0755'),
  ].join('')}`;
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
