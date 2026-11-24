import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { agent37AccessKey, type Agent37Options } from '../../src/world/agent37.js';
import type { VmBootKeys } from '../../src/world/vm/provider.js';
import { SSHD, startLocalSshd, type LocalSshd } from './local-sshd.js';

/**
 * Agent37's Sandbox API (api.agent37.com/v1) as an in-memory fetch, faithful
 * to the shapes karmax uses, and its SSH tunnel for real: a WebSocket relay
 * that checks the workspace key, then carries the stream to a real sshd
 * (Agent37's own, which accepts only workspace-registered keys). The machine
 * behind it is this one: the driver's boot script starts a second, real sshd
 * on `sshPort` with the world's keys — karmax's own — and a stopped instance
 * has that sshd killed and its tunnel refused, as a stopped VM would.
 */
export class FakeAgent37 {
  instances = new Map<string, Instance>();
  keys = new Map<string, { id: string; public_key: string; name?: string }>();
  requests: Array<{ method: string; path: string; body?: any }> = [];
  balance = 10;
  /** Usage rows `GET /v1/usage?from=D&to=D` answers for day D. */
  usage = new Map<string, Array<{ id: string; compute_micros: number; awake_minutes: number }>>();
  /** What POST /instances answers instead of a machine (no capacity, a memory limit). */
  refuseCreate: { status: number; code: string; message: string } | undefined;
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agent37-'));
  /** The VM home: the instance's disk, a directory. */
  readonly home = path.join(this.root, 'home');
  readonly machine = path.join(this.root, 'machine');
  private ids = 0;
  private tunnelSshd!: LocalSshd;
  private relay!: http.Server;
  private relayPort = 0;
  sshPort = 0;
  tunnels = 0;

  constructor(readonly token = 'sk_live_fake') {
    fs.mkdirSync(this.home);
    fs.mkdirSync(this.machine);
  }

  async start(): Promise<this> {
    // Agent37's sshd: it trusts exactly the keys registered with the workspace.
    const access = agent37AccessKey(this.token);
    this.tunnelSshd = await startLocalSshd({ clientKey: access });
    this.tunnelSshd.authorize('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOnlyRegisteredKeysAreAuthorizedHereXXXXXXX none');
    this.sshPort = await freePort();
    const wss = new WebSocketServer({ noServer: true });
    this.relay = http.createServer((_request, response) => { response.writeHead(404).end(); });
    this.relay.on('upgrade', (request, socket, head) => {
      const id = (request.url ?? '').replace(/^\//, '');
      const instance = this.instances.get(id);
      const refuse = (status: number) => { socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`); };
      if (request.headers['x-agent37-key'] !== this.token) return refuse(401);
      if (!instance || instance.status !== 'running') return refuse(502);
      wss.handleUpgrade(request, socket, head, (ws) => {
        this.tunnels++;
        const stream = createWebSocketStream(ws);
        const sshd = net.connect(this.tunnelSshd.endpoint.port, '127.0.0.1');
        stream.pipe(sshd).pipe(stream);
        const close = () => { stream.destroy(); sshd.destroy(); };
        stream.on('error', close); sshd.on('error', close); sshd.on('close', close); stream.on('close', close);
        instance.sockets.add(sshd);
        sshd.once('close', () => instance.sockets.delete(sshd));
      });
    });
    await new Promise<void>((resolve) => this.relay.listen(0, '127.0.0.1', resolve));
    this.relayPort = (this.relay.address() as net.AddressInfo).port;
    return this;
  }

  /** The driver's options for this fake: its API, its tunnel, the machine's sshd. */
  options(): Agent37Options {
    return {
      fetch: this.fetch, pollMs: 10, tunnelUrl: (id) => `ws://127.0.0.1:${this.relayPort}/${id}`, tunnelUser: os.userInfo().username,
      sshPort: this.sshPort, bootScript: (keys) => this.bootScript(keys), rebootCommand: `bash ${this.machine}/restart.sh`,
    };
  }

  /** karmax's sshd on the "machine", unprivileged: the world's keys, as the real boot installs them. */
  private bootScript(keys: VmBootKeys): string {
    const d = this.machine;
    const b64 = (value: string) => Buffer.from(value).toString('base64');
    return `set -e
printf %s '${b64(keys.hostPrivateKey)}' | base64 -d > ${d}/host && chmod 600 ${d}/host
printf %s '${b64(`${keys.authorizedKey}\n`)}' | base64 -d > ${d}/authorized_keys
cat > ${d}/sshd_config << 'EOF'
Port ${this.sshPort}
ListenAddress 127.0.0.1
HostKey ${d}/host
AuthorizedKeysFile ${d}/authorized_keys
PidFile ${d}/sshd.pid
UsePAM no
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxSessions 256
Subsystem sftp internal-sftp
AllowTcpForwarding yes
EOF
cat > ${d}/restart.sh << 'EOF'
[ -f ${d}/sshd.pid ] && kill $(cat ${d}/sshd.pid) 2> /dev/null && sleep 0.3
${SSHD} -f ${d}/sshd_config -E ${d}/sshd.log
for i in $(seq 1 50); do (echo > /dev/tcp/127.0.0.1/${this.sshPort}) 2> /dev/null && exit 0; sleep 0.1; done
exit 1
EOF
echo booted >> ${d}/boots
bash ${d}/restart.sh
`;
  }

  /** The machine's sshd stops (Agent37 moved or rebooted it): the tunnel still answers. */
  killMachineSshd(): void {
    try { process.kill(Number(fs.readFileSync(path.join(this.machine, 'sshd.pid'), 'utf8')), 'SIGTERM'); } catch {}
  }

  /** The WebSocket tunnels drop (Cloudflare's edge, a network blip); the machine runs on. */
  dropTunnels(): void {
    for (const instance of this.instances.values()) for (const socket of instance.sockets) socket.destroy();
  }

  boots(): number {
    try { return fs.readFileSync(path.join(this.machine, 'boots'), 'utf8').trim().split('\n').length; } catch { return 0; }
  }

  async close(): Promise<void> {
    this.killMachineSshd();
    for (const instance of this.instances.values()) for (const socket of instance.sockets) socket.destroy();
    await new Promise((resolve) => this.relay?.close(resolve));
    await this.tunnelSshd?.stop();
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    if (new Headers(init.headers).get('authorization') !== `Bearer ${this.token}`) return error(401, 'unauthorized', 'invalid API key');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const route = url.pathname.replace(/^\/v1/, '');
    this.requests.push({ method, path: route + url.search, body });
    if (route === '/billing') return json(200, { balance_usd: this.balance, tier: 1, memory_limit_gb: 40, auto_top_up: null, past_due: false });
    if (route === '/ssh-keys' && method === 'POST') {
      if ([...this.keys.values()].some((key) => key.public_key === body.public_key)) return error(409, 'ssh_key_exists', 'already registered');
      const key = { id: `key${++this.ids}`, public_key: body.public_key, name: body.name };
      this.keys.set(key.id, key);
      this.tunnelSshd.authorize(body.public_key);
      return json(201, { id: key.id, name: key.name, type: 'ssh-ed25519' });
    }
    if (route === '/usage') {
      const day = url.searchParams.get('from')!;
      return json(200, { from: day, to: url.searchParams.get('to'), instances: this.usage.get(day) ?? [] });
    }
    if (route === '/instances' && method === 'POST') {
      if (this.refuseCreate) return error(this.refuseCreate.status, this.refuseCreate.code, this.refuseCreate.message);
      if (this.balance <= 0) return error(402, 'insufficient_balance', 'top up');
      const refused = diskRefusal(body.type, body.resources);
      if (refused) return error(400, 'invalid_request', refused);
      const id = `i${String(++this.ids).padStart(9, '0')}`;
      const instance: Instance = { id, status: 'running', type: body.type, region: body.region ?? 'us', template: body.template,
        name: body.name ?? null, metadata: body.metadata ?? null, mount_path: body.mount_path, env: body.env,
        resources: { cpu: body.resources.cpu, memory: body.resources.memory, disk: body.resources.disk }, sockets: new Set() };
      this.instances.set(id, instance);
      return json(201, view(instance));
    }
    if (route === '/instances' && method === 'GET') return json(200, { data: [...this.instances.values()].map(view) });
    const match = /^\/instances\/([^/]+)(?:\/(\w+))?$/.exec(route);
    const instance = match && this.instances.get(match[1]!);
    if (!match || !instance || instance.status === 'deleted') return error(404, 'not_found', 'no such instance');
    const action = match[2];
    if (!action && method === 'GET') return json(200, view(instance));
    if (!action && method === 'DELETE') {
      this.halt(instance);
      instance.status = 'deleted';
      return json(200, { id: instance.id, deleted: true });
    }
    if (action === 'stop') {
      if (instance.status === 'stopped') return error(400, 'invalid_request', 'already stopped');
      this.halt(instance);
      instance.status = 'stopped';
      return json(200, { id: instance.id, status: 'stopped' });
    }
    if (action === 'start') {
      // A cold boot: nothing of karmax's runs until its boot script does.
      instance.status = 'running';
      return json(200, { id: instance.id, status: 'running' });
    }
    if (action === 'resize') {
      if (instance.status !== 'running') return error(400, 'invalid_request', 'resize a running instance');
      if (body.disk !== undefined && body.disk < instance.resources.disk) return error(400, 'invalid_request', 'disk cannot shrink');
      const refused = diskRefusal(instance.type, { cpu: body.cpu ?? instance.resources.cpu, memory: body.memory ?? instance.resources.memory,
        disk: body.disk ?? instance.resources.disk });
      if (refused) return error(400, 'invalid_request', refused);
      this.halt(instance); // recreated with the new limits: a cold boot
      instance.resources = { cpu: body.cpu ?? instance.resources.cpu, memory: body.memory ?? instance.resources.memory, disk: body.disk ?? instance.resources.disk };
      instance.status = 'running';
      return json(200, { id: instance.id, status: 'running', resources: instance.resources });
    }
    return error(404, 'not_found', `no route ${method} ${route}`);
  };

  /** Everything running on the machine stops: karmax's sshd and every tunnel. */
  private halt(instance: Instance): void {
    this.killMachineSshd();
    for (const socket of instance.sockets) socket.destroy();
  }
}

interface Instance {
  id: string; status: string; type: string; region: string; template: string; name: string | null;
  metadata: Record<string, string> | null; mount_path: string; env?: Record<string, string>;
  resources: { cpu: number; memory: number; disk: number }; sockets: Set<net.Socket>;
}

function view(instance: Instance) {
  const { sockets: _sockets, env: _env, ...rest } = instance;
  return { ...rest, url: `https://${instance.id}.agent37.app`, status_reason: null };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** Agent37's disk range per shape (docs, instance-sizing, enforced from
 * 2026-11-24): a `vm` takes 2–60 GB on 2 vCPU / 4 GB and 2–100 GB on every
 * larger shape, in whole GB. Its message, word for word as production saw it. */
function diskRefusal(type: string, resources: { cpu: number; memory: number; disk: number }): string | undefined {
  const max = type === 'vm' && resources.cpu === 2 && resources.memory === 4 ? 60 : 100;
  if (Number.isInteger(resources.disk) && resources.disk >= 2 && resources.disk <= max) return undefined;
  return `Disk for the ${resources.cpu} vCPU / ${resources.memory} GB shape must be a whole number between 2 and ${max} GB.`;
}
