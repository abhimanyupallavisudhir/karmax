import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { SshEndpoint } from '../../src/world/vm/ssh.js';
import { startLocalSshd, type LocalSshd } from './local-sshd.js';

type Labels = Record<string, string>;
interface FakeServer { id: number; name: string; status: string; created: string; labels: Labels; server_type: any;
  volumes: number[]; ip: string; userData: string; sshd?: LocalSshd; datacenter: { location: { name: string } } }
interface FakeVolume { id: number; name: string; size: number; created: string; server: number | null; labels: Labels;
  location: { name: string }; linux_device: string; dir: string }

const TYPES: any[] = [
  { id: 1, name: 'cx11', cores: 1, memory: 2, cpu_type: 'shared', architecture: 'x86', deprecation: { announced: '2024-01-01' },
    prices: [{ location: 'fsn1', price_hourly: { net: '0.0050', gross: '0.0060' } }] },
  { id: 2, name: 'cx22', cores: 2, memory: 4, cpu_type: 'shared', architecture: 'x86', deprecation: null,
    prices: [{ location: 'fsn1', price_hourly: { net: '0.0060', gross: '0.0071' } }] },
  { id: 3, name: 'cax11', cores: 2, memory: 4, cpu_type: 'shared', architecture: 'arm', deprecation: null,
    prices: [{ location: 'fsn1', price_hourly: { net: '0.0050', gross: '0.0060' } }] },
  { id: 4, name: 'cpx31', cores: 4, memory: 8, cpu_type: 'shared', architecture: 'x86', deprecation: null,
    prices: [{ location: 'fsn1', price_hourly: { net: '0.0208', gross: '0.0248' } }] },
  { id: 5, name: 'ccx13', cores: 2, memory: 8, cpu_type: 'dedicated', architecture: 'x86', deprecation: null,
    prices: [{ location: 'fsn1', price_hourly: { net: '0.0230', gross: '0.0274' } }] },
  // Priced at fsn1 but no longer orderable there (as CPX11 was, 2026-10).
  { id: 6, name: 'cpx11', cores: 2, memory: 2, cpu_type: 'shared', architecture: 'x86', deprecation: null,
    prices: [{ location: 'fsn1', price_hourly: { net: '0.0040', gross: '0.0048' } }],
    locations: [{ name: 'fsn1', available: false, deprecation: { announced: '2025-10-16T06:00:00Z' } }] },
];

/**
 * Hetzner Cloud's API (api.hetzner.cloud/v1) as an in-memory fetch, faithful
 * to the shapes karmax uses: servers, volumes, actions (finished at once),
 * labels and label selectors, firewalls, SSH keys, images, pricing. A running
 * server is a real sshd booted from its cloud-init `write_files` — the host
 * key and authorized key karmax delivered — with its volume as the VM home.
 */
export class FakeHetzner {
  servers = new Map<number, FakeServer>();
  volumes = new Map<number, FakeVolume>();
  firewalls: Array<{ id: number; labels: Labels }> = [];
  sshKeys: Array<{ id: number; labels: Labels }> = [];
  images: Array<{ id: number; status: string; labels: Labels }> = [];
  requests: Array<{ method: string; path: string; body?: any }> = [];
  /** The project's limit on shared vCPU across all its servers, on or off
   * (Hetzner Console → Limits); no API reads it. */
  sharedCoresLimit?: number;
  private ids = 100;
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-hetzner-'));
  readonly home = path.join(this.root, 'home');

  constructor(readonly token = 'hz-test') {}

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    if (new Headers(init.headers).get('authorization') !== `Bearer ${this.token}`) return json(401, { error: { code: 'unauthorized', message: 'unable to authenticate' } });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path: url.pathname + url.search, body });
    const parts = url.pathname.replace(/^\/v1\//, '').split('/');
    return this.route(method, parts, url.searchParams, body);
  };

  private action() { return { id: ++this.ids, status: 'success' }; }

  private async route(method: string, parts: string[], query: URLSearchParams, body: any): Promise<Response> {
    const [kind, idText, sub, verb] = parts;
    const id = Number(idText);
    const list = <T extends { labels: Labels }>(items: T[], field: string) =>
      json(200, { [field]: items.filter((item) => matches(item.labels, query.get('label_selector'))), meta: { pagination: { next_page: null } } });
    switch (kind) {
      case 'actions': return json(200, { action: { id, status: 'success' } });
      case 'server_types': return json(200, { server_types: TYPES, meta: { pagination: { next_page: null } } });
      case 'pricing': return json(200, { pricing: { currency: 'EUR', volume: { price_per_gb_month: { net: '0.0440' } },
        primary_ips: [{ type: 'ipv4', prices: [{ location: 'fsn1', price_hourly: { net: '0.0008' } }] }] } });
      case 'firewalls':
        if (method === 'POST') { const firewall = { id: ++this.ids, labels: body.labels }; this.firewalls.push(firewall); return json(201, { firewall }); }
        return list(this.firewalls, 'firewalls');
      case 'ssh_keys':
        if (method === 'POST') { const key = { id: ++this.ids, labels: body.labels }; this.sshKeys.push(key); return json(201, { ssh_key: key }); }
        return list(this.sshKeys, 'ssh_keys');
      case 'images': return list(this.images, 'images');
      case 'volumes': {
        if (method === 'POST' && !idText) {
          const volume: FakeVolume = { id: ++this.ids, name: body.name, size: body.size, created: new Date().toISOString(), server: null,
            labels: body.labels ?? {}, location: { name: body.location }, linux_device: `/dev/disk/by-id/scsi-0HC_Volume_${this.ids}`,
            dir: path.join(this.root, `vol_${this.ids}`) };
          fs.mkdirSync(volume.dir);
          this.volumes.set(volume.id, volume);
          return json(201, { volume: strip(volume), action: this.action() });
        }
        if (!idText) return list([...this.volumes.values()].map(strip), 'volumes');
        const volume = this.volumes.get(id);
        if (!volume) return json(404, { error: { code: 'not_found', message: 'volume not found' } });
        if (method === 'DELETE') {
          if (volume.server) return json(423, { error: { code: 'locked', message: 'volume is attached' } });
          fs.rmSync(volume.dir, { recursive: true, force: true });
          this.volumes.delete(id);
          return json(204, {});
        }
        if (method === 'POST' && sub === 'actions' && verb === 'resize') {
          if (body.size <= volume.size) return json(422, { error: { code: 'invalid_input', message: 'size must grow' } });
          volume.size = body.size;
          return json(201, { action: this.action() });
        }
        return json(200, { volume: strip(volume) });
      }
      case 'servers': {
        if (method === 'POST' && !idText) {
          if (!TYPES.some((type) => type.name === body.server_type)) return json(422, { error: { code: 'invalid_input', message: 'unknown server type' } });
          const where = TYPES.find((type) => type.name === body.server_type).locations?.find((entry: any) => entry.name === body.location);
          if (where && where.available === false) return json(422, { error: { code: 'invalid_input', message: 'unsupported location for server type' } });
          const type = TYPES.find((entry) => entry.name === body.server_type);
          const sharedInUse = [...this.servers.values()].filter((entry) => entry.server_type.cpu_type === 'shared')
            .reduce((sum, entry) => sum + entry.server_type.cores, 0);
          // Hetzner's answer, verbatim from pramana#58 (2026-10-15).
          if (this.sharedCoresLimit !== undefined && type.cpu_type === 'shared' && sharedInUse + type.cores > this.sharedCoresLimit)
            return json(403, { error: { code: 'resource_limit_exceeded', message: 'shared core limit exceeded',
              details: { limits: [{ name: 'server_shared_cores_limit' }] } } });
          const server: FakeServer = { id: ++this.ids, name: body.name, status: 'initializing', created: new Date().toISOString(),
            labels: body.labels ?? {}, server_type: TYPES.find((type) => type.name === body.server_type), volumes: body.volumes ?? [],
            ip: `10.0.0.${this.ids % 250}`, userData: body.user_data, datacenter: { location: { name: body.location } } };
          for (const volumeId of server.volumes) {
            const volume = this.volumes.get(volumeId)!;
            if (volume.server) return json(422, { error: { code: 'volume_already_attached', message: 'attached' } });
            volume.server = server.id;
          }
          this.servers.set(server.id, server);
          if (body.start_after_create !== false) await this.boot(server);
          return json(201, { server: this.view(server), action: this.action(), root_password: body.ssh_keys?.length ? null : 'secret' });
        }
        if (!idText) return list([...this.servers.values()].map((server) => this.view(server)), 'servers');
        const server = this.servers.get(id);
        if (!server) return json(404, { error: { code: 'not_found', message: 'server not found' } });
        if (method === 'DELETE') {
          await this.halt(server);
          for (const volume of this.volumes.values()) if (volume.server === id) volume.server = null;
          this.servers.delete(id);
          return json(200, { action: this.action() });
        }
        if (method === 'PUT') { server.labels = body.labels ?? server.labels; return json(200, { server: this.view(server) }); }
        if (method === 'POST' && sub === 'actions') {
          if (verb === 'shutdown' || verb === 'poweroff') await this.halt(server);
          else if (verb === 'poweron') await this.boot(server);
          else if (verb === 'create_image') this.images.push({ id: ++this.ids, status: 'available', labels: body.labels ?? {} });
          return json(201, { action: this.action() });
        }
        return json(200, { server: this.view(server) });
      }
    }
    return json(404, { error: { code: 'not_found', message: 'not found' } });
  }

  private view(server: FakeServer) {
    const { sshd: _sshd, userData: _userData, ip, ...rest } = server;
    return { ...rest, public_net: { ipv4: { ip }, ipv6: { ip: '2a01::/64' } } };
  }

  /** What cloud-init and the boot script do: sshd with the delivered keys, the volume as home. */
  private async boot(server: FakeServer): Promise<void> {
    const files = new Map<string, string>();
    for (const match of server.userData.matchAll(/- path: (\S+)\n {4}permissions: '\d+'\n {4}encoding: b64\n {4}content: (\S+)/g))
      files.set(match[1]!, Buffer.from(match[2]!, 'base64').toString());
    const hostPrivate = files.get('/etc/karmax/ssh_host_ed25519_key')!;
    const { utils } = await import('ssh2');
    const parsed = utils.parseKey(hostPrivate) as any;
    if (server.volumes[0]) {
      fs.rmSync(this.home, { force: true });
      fs.symlinkSync(this.volumes.get(server.volumes[0])!.dir, this.home);
    }
    server.sshd = await startLocalSshd({ hostKey: { privateKey: hostPrivate, publicKey: `${parsed.type} ${parsed.getPublicSSH().toString('base64')}` },
      clientKey: { privateKey: '', publicKey: files.get('/etc/karmax/authorized_keys')!.trim() } });
    server.status = 'running';
  }

  private async halt(server: FakeServer): Promise<void> {
    await server.sshd?.stop();
    server.sshd = undefined;
    server.status = 'off';
  }

  /** The network: `<server ip>:2222` reaches that server's sshd. */
  socket = async (endpoint: Pick<SshEndpoint, 'host' | 'port'>): Promise<Duplex> => {
    const server = [...this.servers.values()].find((value) => value.ip === endpoint.host && value.sshd);
    if (!server || endpoint.port !== 2222) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    return new Promise((resolve, reject) => {
      const socket = net.connect(server.sshd!.endpoint.port, '127.0.0.1', () => resolve(socket));
      socket.on('error', reject);
    });
  };

  async close(): Promise<void> {
    for (const server of this.servers.values()) await this.halt(server);
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

function matches(labels: Labels, selector: string | null): boolean {
  if (!selector) return true;
  return selector.split(',').every((term) => {
    const [key, value] = term.split('=');
    return value === undefined ? key! in labels : labels[key!] === value;
  });
}
function strip(volume: FakeVolume) { const { dir: _dir, ...rest } = volume; return rest; }
function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
