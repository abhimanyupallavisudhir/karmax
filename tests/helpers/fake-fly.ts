import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { SshEndpoint } from '../../src/world/vm/ssh.js';
import { startLocalSshd, type LocalSshd } from './local-sshd.js';

/**
 * Fly.io's Machines API (api.machines.dev/v1, plus the GraphQL address
 * mutation) as an in-memory fetch, faithful to the shapes karmax uses. A
 * started machine is a real sshd (tests/helpers/local-sshd.ts) booted with the
 * host key and authorized key from the machine's `files`, exactly what the
 * boot script installs on Fly; its volume is a directory, symlinked as the
 * VM home while that machine runs. `socket()` stands in for Fly's TLS edge:
 * it routes `<app>.fly.dev` to the app's running machine, and refuses
 * otherwise.
 */
export class FakeFly {
  apps = new Map<string, { org: string; ips: string[] }>();
  volumes = new Map<string, { id: string; app: string; name: string; region: string; size_gb: number; created_at: string; state: string; dir: string }>();
  machines = new Map<string, { id: string; app: string; region: string; state: string; config: any; events: any[]; sshd?: LocalSshd }>();
  requests: Array<{ method: string; path: string; body?: any }> = [];
  private ids = 0;
  /** An organization with no payment method: Fly's free trial. */
  trial = false;
  /** Fly's eventual consistency: this many GETs of a just-created machine answer 404. */
  notFoundAfterCreate = 0;
  private unseen = new Map<string, number>();
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-fly-'));
  /** The VM home every machine sees: a symlink to its volume while it runs. */
  readonly home = path.join(this.root, 'home');

  constructor(readonly token = 'FlyV1 fm2_test', readonly org = 'personal') {}

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    if (new Headers(init.headers).get('authorization') !== this.token) return json(401, { error: 'unauthorized' });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path: url.pathname + url.search, body });
    if (url.hostname === 'api.fly.io' && body.query.includes('billingStatus'))
      return json(200, { data: { organization: this.trial ? { billingStatus: 'TRIAL_ACTIVE', isCreditCardSaved: false }
        : { billingStatus: 'CURRENT', isCreditCardSaved: true } } });
    if (url.hostname === 'api.fly.io') {
      const app = this.apps.get(body.variables.input.appId);
      if (!app) return json(200, { errors: [{ message: 'Could not find App' }] });
      app.ips.push(body.variables.input.type);
      return json(200, { data: { allocateIpAddress: { app: { name: body.variables.input.appId } } } });
    }
    const parts = url.pathname.replace(/^\/v1\//, '').split('/');
    try {
      return await this.route(method, parts, url.searchParams, body);
    } catch (error) {
      return json(500, { error: String(error) });
    }
  };

  private async route(method: string, parts: string[], query: URLSearchParams, body: any): Promise<Response> {
    const [apps, appName, kind, id, action] = parts;
    if (apps !== 'apps') return json(404, { error: 'not found' });
    if (!appName) {
      if (method === 'POST') {
        if (this.apps.has(body.app_name)) return json(422, { error: 'Name has already been taken' });
        if (body.org_slug !== this.org) return json(404, { error: 'organization not found' });
        this.apps.set(body.app_name, { org: body.org_slug, ips: [] });
        return json(201, {});
      }
      if (query.get('org_slug') !== this.org) return json(404, { error: 'organization not found' });
      return json(200, { total_apps: this.apps.size, apps: [...this.apps.keys()].map((name) => ({ name, machine_count: 1 })) });
    }
    const app = this.apps.get(appName);
    if (!app) return json(404, { error: 'app not found' });
    if (!kind) {
      if (method !== 'DELETE') return json(200, { name: appName });
      for (const machine of [...this.machines.values()].filter((value) => value.app === appName)) {
        await this.halt(machine);
        this.machines.delete(machine.id);
      }
      for (const volume of [...this.volumes.values()].filter((value) => value.app === appName)) {
        fs.rmSync(volume.dir, { recursive: true, force: true });
        this.volumes.delete(volume.id);
      }
      this.apps.delete(appName);
      return json(202, {});
    }
    // No ip_assignments endpoint on this API version: karmax falls back to GraphQL.
    if (kind === 'ip_assignments') return json(404, { error: 'not found' });
    if (kind === 'volumes') {
      if (method === 'POST' && !id) {
        const volume = { id: `vol_${++this.ids}`, app: appName, name: body.name, region: body.region, size_gb: body.size_gb,
          created_at: new Date().toISOString(), state: 'created', dir: path.join(this.root, `vol_${this.ids}`) };
        fs.mkdirSync(volume.dir);
        this.volumes.set(volume.id, volume);
        return json(200, strip(volume));
      }
      if (!id) return json(200, [...this.volumes.values()].filter((value) => value.app === appName).map(strip));
      const volume = this.volumes.get(id);
      if (!volume || volume.app !== appName) return json(404, { error: 'volume not found' });
      if (method === 'PUT' && action === 'extend') {
        if (body.size_gb < volume.size_gb) return json(400, { error: 'size must be larger' });
        volume.size_gb = body.size_gb;
        return json(200, { volume: strip(volume), needs_restart: false });
      }
      return json(200, strip(volume));
    }
    if (kind !== 'machines') return json(404, { error: 'not found' });
    if (method === 'POST' && !id) {
      const machine = { id: `m_${++this.ids}`, app: appName, region: body.region, state: 'created', config: body.config, events: [] as any[] };
      this.machines.set(machine.id, machine);
      if (this.notFoundAfterCreate) this.unseen.set(machine.id, this.notFoundAfterCreate);
      if (!body.skip_launch) await this.boot(machine);
      return json(200, machine);
    }
    if (!id) return json(200, [...this.machines.values()].filter((value) => value.app === appName).map(view));
    const unseen = this.unseen.get(id) ?? 0;
    if (method === 'GET' && unseen > 0) { this.unseen.set(id, unseen - 1); return json(404, { error: 'machine not found' }); }
    const machine = this.machines.get(id);
    if (!machine || machine.app !== appName) return json(404, { error: 'machine not found' });
    if (method === 'GET' && !action) return json(200, view(machine));
    if (method === 'POST' && !action) {
      if (machine.state === 'started') { await this.halt(machine); machine.config = body.config; if (!body.skip_launch) await this.boot(machine); }
      else machine.config = body.config;
      machine.events.push({ type: 'update', status: machine.state, timestamp: Date.now() });
      return json(200, view(machine));
    }
    if (method === 'POST' && action === 'start') {
      if (machine.state === 'started') return json(412, { error: 'machine already started' });
      await this.boot(machine);
      return json(200, { ok: true });
    }
    if (method === 'POST' && action === 'stop') {
      if (machine.state !== 'started') return json(412, { error: 'machine not started' });
      await this.halt(machine);
      return json(200, { ok: true });
    }
    return json(404, { error: 'not found' });
  }

  /** What the boot script does on Fly: sshd with the delivered keys, the volume as home. */
  private async boot(machine: { id: string; state: string; config: any; events: any[]; sshd?: LocalSshd }): Promise<void> {
    const file = (suffix: string) => Buffer.from(machine.config.files.find((value: any) => value.guest_path.endsWith(suffix)).raw_value, 'base64').toString();
    const hostPrivate = file('/ssh_host_ed25519_key');
    const authorized = file('/authorized_keys').trim();
    const { utils } = await import('ssh2');
    const parsed = utils.parseKey(hostPrivate) as any;
    const hostPublic = `${parsed.type} ${parsed.getPublicSSH().toString('base64')}`;
    const volume = this.volumes.get(machine.config.mounts[0].volume)!;
    fs.rmSync(this.home, { force: true });
    fs.symlinkSync(volume.dir, this.home);
    machine.sshd = await startLocalSshd({ hostKey: { privateKey: hostPrivate, publicKey: hostPublic },
      clientKey: { privateKey: '', publicKey: authorized } });
    machine.state = 'started';
    machine.events.push({ type: 'start', status: 'started', timestamp: Date.now() });
  }

  private async halt(machine: { state: string; events: any[]; sshd?: LocalSshd }): Promise<void> {
    await machine.sshd?.stop();
    machine.sshd = undefined;
    if (machine.state === 'started') machine.events.push({ type: 'exit', status: 'stopped', timestamp: Date.now() });
    machine.state = 'stopped';
  }

  /** Fly's TLS edge: `<app>.fly.dev:443` reaches that app's running machine. */
  socket = async (endpoint: Pick<SshEndpoint, 'host' | 'port' | 'tls'>): Promise<Duplex> => {
    const app = endpoint.host.replace(/\.fly\.dev$/, '');
    if (endpoint.port !== 443 || endpoint.tls?.servername !== endpoint.host) throw new Error('not through the TLS edge');
    if (!this.apps.get(app)?.ips.includes('shared_v4')) throw new Error(`${endpoint.host} has no address`);
    const machine = [...this.machines.values()].find((value) => value.app === app && value.sshd);
    if (!machine) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    return new Promise((resolve, reject) => {
      const socket = net.connect(machine.sshd!.endpoint.port, '127.0.0.1', () => resolve(socket));
      socket.on('error', reject);
    });
  };

  async close(): Promise<void> {
    for (const machine of this.machines.values()) await this.halt(machine);
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

function view(machine: { id: string; app: string; region: string; state: string; config: any; events: any[] }) {
  return { id: machine.id, region: machine.region, state: machine.state, config: machine.config, events: [...machine.events].reverse() };
}
function strip(volume: Record<string, unknown>) { const { dir: _dir, app: _app, ...rest } = volume; return rest; }
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
