import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { SshEndpoint } from '../../src/world/vm/ssh.js';
import { startLocalSshd, type LocalSshd } from './local-sshd.js';

type Labels = Record<string, string>;
interface FakeInstance { name: string; zone: string; status: string; machineType: string; labels: Labels; labelFingerprint: string;
  creationTimestamp: string; lastStartTimestamp?: string; lastStopTimestamp?: string; ip: string; body: any; startup: string;
  serviceAccounts?: unknown; sshd?: LocalSshd; starts: number }
interface FakeDisk { name: string; zone: string; sizeGb: number; creationTimestamp: string; labels: Labels; users: string[]; type: string; dir: string; image?: string }

/**
 * Google Compute Engine's API (and its OAuth token endpoint and the Cloud
 * Billing catalog) as an in-memory fetch: instances, disks, operations
 * (finished at once, failing as Google does), images, firewalls, label
 * filters. The token endpoint checks the service account's signed JWT. A
 * running instance is a real sshd booted from its startup script — the keys
 * karmax delivered — with its home disk as the VM home.
 */
export class FakeGcp {
  instances = new Map<string, FakeInstance>();
  disks = new Map<string, FakeDisk>();
  firewalls: any[] = [];
  images: Array<{ name: string; status: string; labels: Labels; creationTimestamp: string; sourceDisk?: string }> = [];
  operations = new Map<string, any>();
  requests: Array<{ method: string; path: string; body?: any }> = [];
  /** `machineType@zone` with no capacity just now. */
  noCapacity = new Set<string>();
  cpuQuota?: number;
  defaultNetwork = true;
  billingDown = false;
  tokensIssued = 0;
  private ids = 100;
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gcp-'));
  readonly home = path.join(this.root, 'home');
  readonly project = 'tavya-test';
  private readonly keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  /** The service account key file, as Google downloads it. */
  get key(): string {
    return JSON.stringify({ type: 'service_account', project_id: this.project, client_email: `tavya@${this.project}.iam.gserviceaccount.com`,
      private_key: this.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.host === 'oauth2.googleapis.com') return this.token(String(init.body));
    if (new Headers(init.headers).get('authorization') !== 'Bearer fake-token') return json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    if (url.host === 'cloudbilling.googleapis.com') return this.billing();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const rest = url.pathname.replace(`/compute/v1/projects/${this.project}/`, '');
    this.requests.push({ method, path: rest + url.search, body });
    return this.route(method, rest.split('/'), url.searchParams, body);
  };

  private token(form: string): Response {
    const assertion = new URLSearchParams(form).get('assertion') ?? '';
    const [header, claims, signature] = assertion.split('.');
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), this.keys.publicKey, Buffer.from(signature ?? '', 'base64url'));
    const payload = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString() || '{}');
    if (!valid || payload.aud !== 'https://oauth2.googleapis.com/token' || !String(payload.scope).includes('cloud-platform'))
      return json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    this.tokensIssued++;
    return json(200, { access_token: 'fake-token', expires_in: 3599, token_type: 'Bearer' });
  }

  private billing(): Response {
    if (this.billingDown) return json(403, { error: { code: 403, message: 'Cloud Billing API has not been used in project', status: 'PERMISSION_DENIED' } });
    const sku = (description: string, units: string, nanos: number) => ({ description, serviceRegions: ['europe-west3'], category: { usageType: 'OnDemand' },
      pricingInfo: [{ pricingExpression: { tieredRates: [{ unitPrice: { units, nanos } }] } }] });
    return json(200, { skus: [sku('E2 Instance Core running in Frankfurt', '0', 28_350_000), sku('E2 Instance Ram running in Frankfurt', '0', 3_800_000),
      sku('Balanced PD Capacity in Frankfurt', '0', 130_000_000), { ...sku('E2 Instance Core running in Americas', '0', 21_811_000), serviceRegions: ['us-central1'] }] });
  }

  private op(target: string, error?: { code: string; message: string }) {
    const name = `operation-${++this.ids}`;
    const operation = { name, status: 'DONE', targetLink: `https://compute.googleapis.com/compute/v1/projects/${this.project}/${target}`,
      selfLink: `https://compute.googleapis.com/compute/v1/projects/${this.project}/global/operations/${name}`, ...(error ? { error: { errors: [error] } } : {}) };
    this.operations.set(name, operation);
    return json(200, { ...operation, status: 'RUNNING' });
  }

  private async route(method: string, parts: string[], query: URLSearchParams, body: any): Promise<Response> {
    const notFound = () => json(404, { error: { code: 404, message: `The resource '${parts.join('/')}' was not found`, errors: [{ reason: 'notFound' }] } });
    if (parts[0] === 'global' && parts[1] === 'operations') return this.operations.has(parts[2]!) ? json(200, this.operations.get(parts[2]!)) : notFound();
    if (parts[0] === 'regions') return json(200, { name: parts[1], zones: ['a', 'b', 'c'].map((letter) => `https://x/zones/${parts[1]}-${letter}`),
      quotas: this.cpuQuota !== undefined ? [{ metric: 'CPUS', limit: this.cpuQuota, usage: 0 }] : [] });
    if (parts[0] === 'global' && parts[1] === 'networks') return this.defaultNetwork && parts[2] === 'default' ? json(200, { name: 'default' }) : notFound();
    if (parts[0] === 'global' && parts[1] === 'firewalls') {
      if (method === 'POST') { this.firewalls.push(body); return this.op(`global/firewalls/${body.name}`); }
      const rule = this.firewalls.find((entry) => entry.name === parts[2]);
      return rule ? json(200, rule) : notFound();
    }
    if (parts[0] === 'global' && parts[1] === 'images') {
      if (method === 'POST') {
        this.images.push({ name: body.name, status: 'READY', labels: body.labels ?? {}, creationTimestamp: new Date().toISOString(), sourceDisk: body.sourceDisk });
        return this.op(`global/images/${body.name}`);
      }
      if (method === 'DELETE') { this.images = this.images.filter((image) => image.name !== parts[2]); return this.op(`global/images/${parts[2]}`); }
      return json(200, { items: this.images.filter((image) => matches(image.labels, query.get('filter'))) });
    }
    if (parts[0] === 'aggregated') {
      const kind = parts[1] as 'instances' | 'disks';
      const items = kind === 'instances' ? [...this.instances.values()].map((instance) => this.instanceView(instance)) : [...this.disks.values()].map(diskView);
      const byZone: Record<string, Record<string, unknown[]>> = {};
      for (const item of items.filter((entry: any) => matches(entry.labels ?? {}, query.get('filter'))))
        (byZone[`zones/${(item as any).zone.split('/').pop()}`] ??= { [kind]: [] })[kind]!.push(item);
      return json(200, { items: byZone });
    }
    if (parts[0] !== 'zones') return notFound();
    const zone = parts[1]!;
    if (parts.length === 2) return json(200, { name: zone });
    if (parts[2] === 'disks') {
      if (method === 'POST' && parts.length === 3) {
        const disk: FakeDisk = { name: body.name, zone, sizeGb: Number(body.sizeGb), creationTimestamp: new Date().toISOString(), labels: body.labels ?? {},
          users: [], type: body.type, dir: path.join(this.root, `disk_${++this.ids}`) };
        fs.mkdirSync(disk.dir);
        this.disks.set(`${zone}/${disk.name}`, disk);
        return this.op(`zones/${zone}/disks/${disk.name}`);
      }
      const disk = this.disks.get(`${zone}/${parts[3]}`);
      if (!disk) return notFound();
      if (method === 'DELETE') {
        if (disk.users.length) return json(400, { error: { code: 400, message: `The disk resource '${disk.name}' is already being used by '${disk.users[0]}'`,
          errors: [{ reason: 'resourceInUseByAnotherResource' }] } });
        this.disks.delete(`${zone}/${disk.name}`);
        fs.rmSync(disk.dir, { recursive: true, force: true });
        return this.op(`zones/${zone}/disks/${disk.name}`);
      }
      if (parts[4] === 'resize') { disk.sizeGb = Number(body.sizeGb); return this.op(`zones/${zone}/disks/${disk.name}`); }
      return json(200, diskView(disk));
    }
    if (parts[2] === 'instances') {
      if (method === 'POST' && parts.length === 3) return this.insert(zone, body);
      const instance = this.instances.get(`${zone}/${parts[3]}`);
      if (!instance) return notFound();
      const target = `zones/${zone}/instances/${instance.name}`;
      if (method === 'DELETE') {
        await this.halt(instance);
        this.instances.delete(`${zone}/${instance.name}`);
        for (const disk of this.disks.values()) {
          disk.users = disk.users.filter((user) => !user.endsWith(`/instances/${instance.name}`));
          if (disk.name === `${instance.name}-root`) this.disks.delete(`${zone}/${disk.name}`);
        }
        return this.op(target);
      }
      switch (parts[4]) {
        case 'stop': await this.halt(instance); return this.op(target);
        case 'start':
          if (this.noCapacity.has(`${instance.machineType.split('/').pop()}@${zone}`))
            return this.op(target, { code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: `The zone '${zone}' does not have enough resources available to fulfill the request.` });
          await this.boot(instance); return this.op(target);
        case 'setMachineType':
          if (instance.status !== 'TERMINATED') return json(400, { error: { code: 400, message: 'Instance must be stopped', errors: [{ reason: 'resourceNotReady' }] } });
          instance.machineType = body.machineType; return this.op(target);
        case 'setLabels':
          if (body.labelFingerprint !== instance.labelFingerprint) return json(412, { error: { code: 412, message: 'Labels fingerprint either invalid or resource labels have changed', errors: [{ reason: 'conditionNotMet' }] } });
          instance.labels = body.labels; instance.labelFingerprint = String(++this.ids); return this.op(target);
      }
      return json(200, this.instanceView(instance));
    }
    return notFound();
  }

  private async insert(zone: string, body: any): Promise<Response> {
    const type = body.machineType.split('/').pop();
    const target = `zones/${zone}/instances/${body.name}`;
    if (this.instances.has(`${zone}/${body.name}`)) return json(409, { error: { code: 409, message: 'already exists', errors: [{ reason: 'alreadyExists' }] } });
    if (this.noCapacity.has(`${type}@${zone}`))
      return this.op(target, { code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: `The zone '${zone}' does not have enough resources available to fulfill the request.` });
    const cpu = Number(type.match(/e2-custom-(\d+)-/)?.[1] ?? 2);
    const used = [...this.instances.values()].filter((entry) => entry.status === 'RUNNING').reduce((sum, entry) => sum + Number(entry.machineType.match(/e2-custom-(\d+)-/)?.[1] ?? 2), 0);
    if (this.cpuQuota !== undefined && used + cpu > this.cpuQuota)
      return this.op(target, { code: 'QUOTA_EXCEEDED', message: `Quota 'CPUS' exceeded.  Limit: ${this.cpuQuota}.0 in region europe-west3.` });
    const startup = body.metadata.items.find((item: any) => item.key === 'startup-script').value;
    const instance: FakeInstance = { name: body.name, zone, status: 'PROVISIONING', machineType: `zones/${zone}/machineTypes/${type}`, labels: body.labels ?? {},
      labelFingerprint: String(++this.ids), creationTimestamp: new Date().toISOString(), ip: `10.2.0.${this.ids % 250}`, body, startup,
      serviceAccounts: body.serviceAccounts, starts: 0 };
    for (const disk of body.disks) {
      if (disk.initializeParams) {
        const root: FakeDisk = { name: disk.initializeParams.diskName, zone, sizeGb: Number(disk.initializeParams.diskSizeGb), creationTimestamp: instance.creationTimestamp,
          labels: disk.initializeParams.labels ?? {}, users: [target], type: disk.initializeParams.diskType, dir: path.join(this.root, `root_${this.ids}`),
          image: disk.initializeParams.sourceImage };
        fs.mkdirSync(root.dir);
        this.disks.set(`${zone}/${root.name}`, root);
      } else {
        const home = this.disks.get(`${zone}/${disk.source.split('/').pop()}`);
        if (!home) return json(400, { error: { code: 400, message: `The resource '${disk.source}' was not found`, errors: [{ reason: 'notFound' }] } });
        if (home.users.length) return json(400, { error: { code: 400, message: 'disk in use', errors: [{ reason: 'resourceInUseByAnotherResource' }] } });
        home.users.push(target);
      }
    }
    this.instances.set(`${zone}/${instance.name}`, instance);
    await this.boot(instance);
    return this.op(target);
  }

  private instanceView(instance: FakeInstance) {
    const { sshd: _s, body: _b, startup, ip, starts: _n, ...rest } = instance;
    return { ...rest, zone: `https://x/zones/${instance.zone}`, metadata: { items: [{ key: 'startup-script', value: startup }] },
      networkInterfaces: [{ accessConfigs: [instance.status === 'RUNNING' ? { natIP: ip } : {}] }] };
  }

  /** What the guest agent and the startup script do: sshd with the delivered keys, the home disk as home. */
  private async boot(instance: FakeInstance): Promise<void> {
    const files = new Map<string, string>();
    for (const match of instance.startup.matchAll(/printf %s '([^']+)' \| base64 -d > '([^']+)'/g))
      files.set(match[2]!, Buffer.from(match[1]!, 'base64').toString());
    const hostPrivate = files.get('/etc/karmax/ssh_host_ed25519_key')!;
    const { utils } = await import('ssh2');
    const parsed = utils.parseKey(hostPrivate) as any;
    const home = [...this.disks.values()].find((disk) => disk.users.includes(`zones/${instance.zone}/instances/${instance.name}`) && !disk.name.endsWith('-root'));
    if (home && files.get('/etc/karmax/volume-device') === '/dev/disk/by-id/google-karmax-home') {
      fs.rmSync(this.home, { force: true });
      fs.symlinkSync(home.dir, this.home);
    }
    instance.sshd = await startLocalSshd({ hostKey: { privateKey: hostPrivate, publicKey: `${parsed.type} ${parsed.getPublicSSH().toString('base64')}` },
      clientKey: { privateKey: '', publicKey: files.get('/etc/karmax/authorized_keys')!.trim() } });
    instance.status = 'RUNNING';
    instance.lastStartTimestamp = new Date().toISOString();
    instance.starts++;
  }

  private async halt(instance: FakeInstance): Promise<void> {
    if (instance.status === 'TERMINATED') return;
    await instance.sshd?.stop();
    instance.sshd = undefined;
    instance.status = 'TERMINATED';
    instance.lastStopTimestamp = new Date().toISOString();
  }

  /** The network: `<instance ip>:2222` reaches that instance's sshd. */
  socket = async (endpoint: Pick<SshEndpoint, 'host' | 'port'>): Promise<Duplex> => {
    const instance = [...this.instances.values()].find((value) => value.ip === endpoint.host && value.sshd);
    if (!instance || endpoint.port !== 2222) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    return new Promise((resolve, reject) => {
      const socket = net.connect(instance.sshd!.endpoint.port, '127.0.0.1', () => resolve(socket));
      socket.on('error', reject);
    });
  };

  async close(): Promise<void> {
    for (const instance of this.instances.values()) await instance.sshd?.stop();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

function diskView(disk: FakeDisk) {
  const { dir: _d, ...rest } = disk;
  return { ...rest, sizeGb: String(disk.sizeGb), zone: `https://x/zones/${disk.zone}`, status: 'READY' };
}

/** Compute Engine's filter: `labels.a=b AND labels.c=d`, `labels.a:*`. */
function matches(labels: Labels, filter: string | null): boolean {
  if (!filter) return true;
  return filter.split(' AND ').every((term) => {
    const exists = term.match(/^labels\.([\w-]+):\*$/);
    if (exists) return exists[1]! in labels;
    const equal = term.match(/^labels\.([\w-]+)=(.*)$/);
    return equal ? labels[equal[1]!] === equal[2] : true;
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
