/** A local stand-in for E2B's control plane, used by scripts/rehearse-upgrade.sh.
 *
 *  Every hosted task runs in an E2B (or Daytona) sandbox, and a rehearsal must
 *  neither spend sandbox credit nor depend on a provider. The E2B SDK reads its
 *  API and sandbox URLs from E2B_API_URL and E2B_SANDBOX_URL, so the rehearsal
 *  points the app here. This process answers the REST calls karmax makes
 *  (create, connect, pause, timeout, info, list, kill, network) and forwards
 *  each sandbox's envd traffic, chosen by the SDK's E2b-Sandbox-Id header, to a
 *  container running E2B's real envd (scripts/rehearsal/sandbox.Dockerfile).
 *  A sandbox is its container: its facts live in the container's labels and
 *  state, so this process can be restarted without losing any. Timeouts are
 *  recorded but never enforced.
 *
 *    node --experimental-strip-types scripts/rehearsal/fake-e2b.ts \
 *      --host 0.0.0.0 --api-port 13000 --envd-port 13001 \
 *      --image karmax-rehearsal-sandbox --network karmax-rehearsal-sandboxes
 *
 *  It needs the Docker socket and must be on --network, where it reaches each
 *  sandbox's envd; scripts/rehearse-upgrade.sh runs it in a container.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const ENVD_VERSION = '0.9.0';
const ENVD_PORT = 49983;
const LABEL = 'karmax.rehearsal.sandbox';

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}
const host = option('host');
const apiPort = Number(option('api-port'));
const envdPort = Number(option('envd-port'));
const image = option('image');
const network = option('network');

function log(message: string) { console.log(`${new Date().toISOString()} ${message}`); }

interface DockerReply { status: number; body: unknown }
function docker(method: string, path: string, body?: unknown): Promise<DockerReply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ socketPath: '/var/run/docker.sock', path, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
    (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = text;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { /* plain text */ }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

interface Sandbox {
  sandboxID: string; templateID: string; metadata: Record<string, string>;
  startedAt: string; state: 'running' | 'paused'; address: string;
}

const endAt = new Map<string, string>();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

async function inspect(id: string): Promise<Sandbox | undefined> {
  if (!/^[a-z0-9]+$/.test(id)) return undefined;
  const reply = await docker('GET', `/containers/rehearsal-sandbox-${id}/json`);
  if (reply.status !== 200) return undefined;
  const container = record(reply.body);
  const labels = record(record(container.Config).Labels);
  const state = record(container.State);
  const networks = record(record(container.NetworkSettings).Networks);
  const address = String(record(networks[network]).IPAddress ?? '');
  if (labels[LABEL] !== id || !state.Running) return undefined;
  return {
    sandboxID: id,
    templateID: String(labels['karmax.rehearsal.template'] ?? ''),
    metadata: JSON.parse(String(labels['karmax.rehearsal.metadata'] ?? '{}')) as Record<string, string>,
    startedAt: String(labels['karmax.rehearsal.started'] ?? ''),
    state: state.Paused ? 'paused' : 'running',
    address,
  };
}

async function all(): Promise<Sandbox[]> {
  const reply = await docker('GET', `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: [LABEL] }))}`);
  const ids = (Array.isArray(reply.body) ? reply.body : [])
    .map((container) => String(record(record(container).Labels)[LABEL] ?? ''));
  return (await Promise.all(ids.map(inspect))).filter((sandbox): sandbox is Sandbox => !!sandbox);
}

function describe(sandbox: Sandbox) {
  return {
    sandboxID: sandbox.sandboxID, templateID: sandbox.templateID, clientID: 'rehearsal', alias: sandbox.templateID,
    metadata: sandbox.metadata, startedAt: sandbox.startedAt,
    endAt: endAt.get(sandbox.sandboxID) ?? new Date(Date.parse(sandbox.startedAt) + 3_600_000).toISOString(),
    state: sandbox.state, cpuCount: 2, memoryMB: 512, diskSizeMB: 10_240, envdVersion: ENVD_VERSION, volumeMounts: [],
  };
}

function connection(sandbox: Sandbox) {
  // No envdAccessToken: this envd is unsecured, like E2B's `secure: false`.
  return { sandboxID: sandbox.sandboxID, templateID: sandbox.templateID, clientID: 'rehearsal', envdVersion: ENVD_VERSION };
}

function envd(address: string, method: string, path: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ host: address, port: ENVD_PORT, path, method, timeout: 2_000,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
    (response) => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(payload);
  });
}

async function create(body: Record<string, unknown>): Promise<Sandbox> {
  const id = `rh${randomBytes(9).toString('hex')}`;
  const timeout = Number(body.timeout ?? 300);
  const created = await docker('POST', `/containers/create?name=rehearsal-sandbox-${id}`, {
    Image: image,
    Labels: {
      [LABEL]: id,
      'karmax.rehearsal.template': String(body.templateID ?? ''),
      'karmax.rehearsal.metadata': JSON.stringify(record(body.metadata)),
      'karmax.rehearsal.started': new Date().toISOString(),
    },
    HostConfig: { NetworkMode: network, Memory: 512 * 1024 * 1024 },
  });
  if (created.status !== 201) throw new Error(`docker create: ${created.status} ${JSON.stringify(created.body)}`);
  const started = await docker('POST', `/containers/rehearsal-sandbox-${id}/start`);
  if (started.status !== 204) throw new Error(`docker start: ${started.status} ${JSON.stringify(started.body)}`);
  endAt.set(id, new Date(Date.now() + timeout * 1000).toISOString());
  const sandbox = await inspect(id);
  if (!sandbox) throw new Error(`sandbox ${id} did not start`);
  for (let attempt = 0; ; attempt++) {
    if ((await envd(sandbox.address, 'GET', '/health').catch(() => 0)) === 204) break;
    if (attempt > 100) throw new Error(`envd in ${id} did not become healthy`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // What E2B's orchestrator does for a new sandbox: hand envd its environment
  // and the template's user (karmax's template runs as `user`).
  await envd(sandbox.address, 'POST', '/init', { envVars: record(body.envVars), timestamp: new Date().toISOString(),
    defaultUser: 'user', defaultWorkdir: '/home/user' });
  return sandbox;
}

function send(response: http.ServerResponse, status: number, body?: unknown) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, payload ? { 'content-type': 'application/json' } : {});
  response.end(payload);
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? record(JSON.parse(text)) : {};
}

async function api(request: http.IncomingMessage, response: http.ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://fake-e2b');
  const method = request.method ?? 'GET';
  const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(request);
  // Newer SDKs call /v2/ for create and connect (2.51 does; 2.33 did not).
  const one = /^(?:\/v2)?\/sandboxes\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
  const collection = url.pathname === '/sandboxes' || url.pathname === '/v2/sandboxes';
  log(`api ${method} ${url.pathname}${url.search}`);
  const missing = (id: string) => send(response, 404, { code: 404, message: `sandbox ${id} not found` });

  if (method === 'POST' && collection) {
    const sandbox = await create(body);
    log(`created ${sandbox.sandboxID} from template ${sandbox.templateID}`);
    return send(response, 201, connection(sandbox));
  }
  if (method === 'GET' && collection) {
    const wanted = new URLSearchParams(url.searchParams.get('metadata') ?? '');
    const states = url.searchParams.getAll('state').flatMap((state) => state.split(','));
    const found = (await all()).filter((sandbox) =>
      [...wanted].every(([key, value]) => sandbox.metadata[key] === value)
      && (!states.length || states.includes(sandbox.state)));
    return send(response, 200, found.map(describe));
  }
  if (!one) return send(response, 404, { code: 404, message: `no route ${method} ${url.pathname}` });
  const id = decodeURIComponent(one[1] ?? '');
  const action = one[2];
  const sandbox = await inspect(id);
  if (!sandbox) return missing(id);
  const container = `/containers/rehearsal-sandbox-${id}`;

  if (method === 'GET' && !action) return send(response, 200, describe(sandbox));
  if (method === 'DELETE' && !action) {
    await docker('DELETE', `${container}?force=1`);
    log(`killed ${id}`);
    return send(response, 204);
  }
  if (method === 'POST' && action === 'connect') {
    if (sandbox.state === 'paused') { await docker('POST', `${container}/unpause`); log(`resumed ${id}`); }
    endAt.set(id, new Date(Date.now() + Number(body.timeout ?? 300) * 1000).toISOString());
    return send(response, sandbox.state === 'paused' ? 201 : 200, connection(sandbox));
  }
  if (method === 'POST' && action === 'pause') {
    if (sandbox.state === 'paused') return send(response, 409, { code: 409, message: 'sandbox is already paused' });
    await docker('POST', `${container}/pause`);
    log(`paused ${id}`);
    return send(response, 204);
  }
  if (method === 'POST' && action === 'timeout') {
    endAt.set(id, new Date(Date.now() + Number(body.timeout ?? 0) * 1000).toISOString());
    return send(response, 204);
  }
  if (method === 'PUT' && action === 'network') return send(response, 204);
  return send(response, 404, { code: 404, message: `no route ${method} ${url.pathname}` });
}

/** envd traffic: the SDK sends every sandbox's to one E2B_SANDBOX_URL and
 *  names the sandbox in a header, as it does through E2B's own proxy. */
async function forward(request: http.IncomingMessage, response: http.ServerResponse) {
  const id = String(request.headers['e2b-sandbox-id'] ?? '');
  const sandbox = await inspect(id);
  if (!sandbox) return send(response, 502, { code: 502, message: `sandbox ${id} not found` });
  if (sandbox.state === 'paused') return send(response, 502, { code: 502, message: `sandbox ${id} is paused` });
  const upstream = http.request({ host: sandbox.address, port: ENVD_PORT, path: request.url, method: request.method,
    headers: request.headers }, (reply) => {
    response.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(response);
  });
  upstream.on('error', (error) => {
    if (!response.headersSent) send(response, 502, { code: 502, message: error.message });
    else response.destroy(error);
  });
  request.pipe(upstream);
}

function serve(port: number, handler: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>) {
  http.createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      log(`error ${request.method} ${request.url}: ${error instanceof Error ? error.stack : String(error)}`);
      if (!response.headersSent) send(response, 500, { code: 500, message: error instanceof Error ? error.message : String(error) });
      else response.destroy();
    });
  }).listen(port, host, () => log(`listening on ${host}:${port}`));
}

serve(apiPort, api);
serve(envdPort, forward);
