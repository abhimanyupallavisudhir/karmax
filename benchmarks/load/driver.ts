/** Synthetic tenants for the control-plane load test (benchmarks/load/README.md).
 *
 *  Drives a hosted installation through its public edge only: people sign up,
 *  team organizations get a plan and members, projects and a resource are
 *  created, and then every person keeps browsing the console, creating tasks
 *  (the mock agent, running scripted turns in the installation's E2B — here
 *  the local stand-in), following them up, approving or cancelling them at
 *  Review, saving resource revisions, and keeping event websockets open.
 *
 *  Tenants are added in steps (--steps); each step first sets up its new
 *  tenants, then holds the whole population for --hold seconds. Every step
 *  writes one summary line to <out>/steps.jsonl. After a step that breaks a
 *  limit (see `broken()`) the driver stops: that step is the first wall.
 *
 *    node --experimental-strip-types benchmarks/load/driver.ts \
 *      --base https://loadtest.invalid --admin-email E --admin-password P --out DIR \
 *      [--steps 4,8,16,...] [--hold 300] [--fake-e2b http://127.0.0.1:13000]
 *
 *  It needs NODE_EXTRA_CA_CERTS for the edge's self-signed certificate and the
 *  edge's name in /etc/hosts; benchmarks/load/world-setup.sh arranges both.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------- options

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}
const base = new URL(option('base'));
// The origin the browser would send; the same as --base except when testing the
// driver against an app that is not behind its edge.
const origin = option('origin', base.origin);
const out = option('out');
const adminEmail = option('admin-email');
const adminPassword = option('admin-password');
const steps = option('steps', '4,8,16,32,64,96,128,192,256,384,512').split(',').map(Number);
const holdMs = Number(option('hold', '300')) * 1000;
const thinkMs = Number(option('think', '20')) * 1000;
const teamEvery = Number(option('team-every', '4'));
const teamSize = Number(option('team-size', '3'));
const socketsPerUser = Number(option('sockets', '2'));
const maxActivePerUser = Number(option('active-tasks', '2'));
const abandonRate = Number(option('abandon', '0.2'));
const turnSeconds = option('turn', '10-40').split('-').map(Number) as [number, number];
const setupConcurrency = Number(option('setup-concurrency', '8'));
const fakeE2b = option('fake-e2b', 'http://127.0.0.1:13000');
const requestTimeoutMs = Number(option('timeout', '30')) * 1000;
fs.mkdirSync(out, { recursive: true });

// Break criteria: the first step that crosses any of these is the wall.
const LIMITS = {
  errorRate: Number(option('max-error-rate', '0.01')),
  apiP95Ms: Number(option('max-api-p95', '2000')),
  eventLagP95Ms: Number(option('max-event-lag-p95', '5000')),
  turnOverheadP50Ms: Number(option('max-turn-overhead-p50', '60000')),
  taskFailureRate: Number(option('max-task-failure-rate', '0.02')),
  socketFailureRate: Number(option('max-socket-failure-rate', '0.01')),
  setupFailureRate: Number(option('max-setup-failure-rate', '0.05')),
};

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exp = (mean: number) => -Math.log(1 - Math.random()) * mean;
const pick = <T>(items: T[]): T | undefined => items[Math.floor(Math.random() * items.length)];
const between = ([low, high]: [number, number]) => low + Math.random() * (high - low);
type Json = any;

// ---------------------------------------------------------------- measurement

/** Raw samples per metric for the current window; percentiles at the step's end. */
class Window {
  readonly started = Date.now();
  samples = new Map<string, number[]>();
  counts = new Map<string, number>();
  errors: Array<{ route: string; status: number; detail: string }> = [];
  add(metric: string, value: number) {
    let list = this.samples.get(metric);
    if (!list) this.samples.set(metric, list = []);
    list.push(value);
  }
  count(name: string, by = 1) { this.counts.set(name, (this.counts.get(name) ?? 0) + by); }
}
let setupWindow = new Window();
let steadyWindow: Window | undefined;
/** Setup traffic and steady-state traffic are judged separately. */
let phase: 'setup' | 'steady' = 'setup';
const current = () => phase === 'steady' && steadyWindow ? steadyWindow : setupWindow;
function record(metric: string, value: number) { current().add(metric, value); }
function count(name: string, by = 1) { current().count(name, by); }

function percentiles(values: number[] | undefined) {
  if (!values?.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), p99: Math.round(at(0.99)), max: Math.round(sorted[sorted.length - 1]!) };
}

/** /api/tasks/task_abc/signal → /api/tasks/:id/signal */
const route = (method: string, pathname: string) =>
  `${method} ${pathname.split('?')[0]!.split('/').map((part) => /^[a-z]+_[a-z0-9]{6,}$/i.test(part) || /^[0-9a-f-]{16,}$/i.test(part) ? ':id' : part).join('/')}`;

// ---------------------------------------------------------------- HTTP

interface Reply { status: number; body: Json; ms: number }

class Person {
  readonly cookies = new Map<string, string>();
  id = '';
  sockets: Socket[] = [];
  tasks = new Map<string, TaskState>();
  readonly tenant: Tenant; readonly name: string; readonly email: string; readonly password: string;
  constructor(tenant: Tenant, name: string, email: string, password: string) {
    this.tenant = tenant; this.name = name; this.email = email; this.password = password;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json', origin,
      // The edge keys its per-client budgets on this header under load test
      // (sut-setup.sh), as it keys them on each customer's own address.
      'x-load-client': this.tenant.id,
      ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      ...extra,
    };
  }

  async request(method: string, pathname: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    const label = route(method, pathname);
    const started = performance.now();
    let status = 0, parsed: Json = null, detail = '';
    try {
      const response = await fetch(new URL(pathname, base), {
        method, redirect: 'manual', signal: AbortSignal.timeout(requestTimeoutMs),
        headers: this.headers({ ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = response.status;
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = ''] = cookie.split(';');
        const at = pair.indexOf('=');
        if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
      const text = await response.text();
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      if (status >= 400) detail = text.slice(0, 300);
    } catch (error) {
      detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const ms = performance.now() - started;
    record(`api ${label}`, ms);
    record('api *', ms);
    count('requests');
    if (status === 429) count('rateLimited');
    else if (status === 0) count(detail.includes('Timeout') ? 'timeouts' : 'networkErrors');
    else if (status >= 500) count('serverErrors');
    else if (status >= 400) count('clientErrors');
    if (status === 0 || status >= 400) {
      const window = current();
      if (window.errors.length < 200) window.errors.push({ route: label, status, detail });
    }
    return { status, body: parsed, ms };
  }

  /** A call whose failure the caller cannot continue past. */
  async call(method: string, pathname: string, body?: unknown, extra: Record<string, string> = {}): Promise<Json> {
    const reply = await this.request(method, pathname, body, extra);
    if (reply.status < 200 || reply.status >= 300)
      throw new Error(`${method} ${pathname} → ${reply.status} ${typeof reply.body === 'string' ? reply.body.slice(0, 200) : JSON.stringify(reply.body)?.slice(0, 200)}`);
    return reply.body;
  }
}

// ---------------------------------------------------------------- websockets

class Socket {
  ws?: WebSocket;
  closed = false;
  readonly person: Person; readonly watch?: { projectId: string };
  constructor(person: Person, watch?: { projectId: string }) { this.person = person; this.watch = watch; }

  open() {
    if (this.closed) return;
    const started = performance.now();
    const url = new URL('/ws', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let opened = false;
    const ws = new WebSocket(url, { headers: this.person.headers() } as any);
    this.ws = ws;
    count('socketOpens');
    ws.onopen = () => {
      opened = true;
      record('ws connect', performance.now() - started);
      if (this.watch) ws.send(JSON.stringify({ type: 'watch', projectId: this.watch.projectId, taskId: null }));
    };
    ws.onmessage = (message) => {
      const now = Date.now();
      let event: Json;
      try { event = JSON.parse(String(message.data)); } catch { return; }
      if (!event || typeof event !== 'object' || !event.type || event.type === 'pong') return;
      count('eventsReceived');
      const at = typeof event.ts === 'number' ? event.ts : Date.parse(event.ts);
      if (Number.isFinite(at)) record('event lag', now - at);
      if (event.type === 'view.updated' && event.taskId) observeView(this.person.tenant, event.taskId, event.payload, now);
    };
    ws.onerror = () => { if (!opened) count('socketFailures'); };
    ws.onclose = (close) => {
      if (this.closed) return;
      count(opened ? `socketClosed ${close.code}` : 'socketRefused');
      if (opened) count('socketDrops');
      // The console reconnects; so does this, after a pause.
      setTimeout(() => this.open(), 5_000 + Math.random() * 5_000);
    };
  }
  close() { this.closed = true; try { this.ws?.close(); } catch { /* already closed */ } }
}

// ---------------------------------------------------------------- tasks

interface TaskState {
  id: string;
  owner: Person;
  phase: 'turn' | 'review' | 'closing' | 'closed';
  /** When the current phase started, and the agent time its turn script takes. */
  since: number;
  scriptedMs: number;
  closingAs?: 'done' | 'cancelled';
  abandoned: boolean;
  turns: number;
  lastSeen: number;
}
const tasksById = new Map<string, TaskState>();

function turnScript(n: number): { text: string; scriptedMs: number } {
  const total = between(turnSeconds);
  const shell = Math.max(1, Math.round(total * 0.2));
  const waiting = Math.round((total - shell) * 1000);
  const words = randomBytes(1024).toString('base64');
  return {
    scriptedMs: shell * 1000 + waiting,
    text: [
      `Load test turn ${n}: look around, write the notes, check them.`,
      `@run sleep ${shell} && ls -la && uname -a`,
      `@write notes/turn-${n}.md :: # Turn ${n}\\n${words}`,
      `@sleep ${waiting}`,
      `@run wc -c notes/turn-${n}.md && git status --short 2>/dev/null | head -5`,
      `@review Load test turn ${n}`,
    ].join('\n'),
  };
}

function observeView(tenant: Tenant, taskId: string, payload: Json, now: number) {
  const task = tasksById.get(taskId);
  if (!task || task.owner.tenant !== tenant || !payload) return;
  task.lastSeen = now;
  advance(task, String(payload.stage ?? ''), String(payload.status ?? ''), now);
}

function advance(task: TaskState, stage: string, status: string, now: number) {
  if (task.phase === 'closed') return;
  if (status === 'failed') {
    count('tasksFailed');
    close(task);
    return;
  }
  if (task.phase === 'turn' && stage === 'review' && status === 'waiting') {
    const took = now - task.since;
    record(task.turns === 1 ? 'turn first total' : 'turn followup total', took);
    record('turn overhead', Math.max(0, took - task.scriptedMs));
    count('turnsCompleted');
    task.phase = 'review';
    task.since = now;
    return;
  }
  if (task.phase === 'closing' && (status === 'done' || status === 'cancelled')) {
    record(task.closingAs === 'done' ? 'approve to done' : 'cancel to cancelled', now - task.since);
    count(task.closingAs === 'done' ? 'tasksDone' : 'tasksCancelled');
    close(task);
  }
}
function close(task: TaskState) {
  task.phase = 'closed';
  task.owner.tasks.delete(task.id);
  tasksById.delete(task.id);
}

async function createTask(person: Person, n: number) {
  const project = person.tenant.taskProject;
  const script = turnScript(n);
  const started = Date.now();
  const reply = await person.request('POST', `/api/projects/${project}/tasks`,
    { title: `Load ${person.tenant.id} #${n}`, prompt: script.text, params: MOCK_AGENT });
  const id = reply.status < 300 ? String(reply.body?.id ?? '') : '';
  if (!id) { count('taskCreateFailed'); return; }
  count('tasksCreated');
  const task: TaskState = { id, owner: person, phase: 'turn', since: started, scriptedMs: script.scriptedMs,
    abandoned: Math.random() < abandonRate, turns: 1, lastSeen: started };
  person.tasks.set(id, task);
  tasksById.set(id, task);
}

async function actOnReview(person: Person, task: TaskState) {
  const roll = Math.random();
  const now = Date.now();
  if (roll < 0.5) {
    const script = turnScript(task.turns + 1);
    const reply = await person.request('POST', `/api/tasks/${task.id}/signal`, { signal: 'followUp', text: script.text, role: 'do' });
    if (reply.status >= 300) return;
    task.turns++; task.phase = 'turn'; task.since = now; task.scriptedMs = script.scriptedMs;
    count('followUps');
  } else {
    const signal = roll < 0.8 ? 'confirm' : 'cancel';
    const reply = await person.request('POST', `/api/tasks/${task.id}/signal`, { signal });
    if (reply.status >= 300) return;
    task.phase = 'closing'; task.since = now; task.closingAs = signal === 'confirm' ? 'done' : 'cancelled';
  }
}

/** Tasks whose events stopped arriving are read directly, as the console's
 *  refresh would; one stuck for ten minutes is counted and dropped. */
async function pollStale() {
  const now = Date.now();
  for (const task of tasksById.values()) {
    if (task.phase === 'review' || task.phase === 'closed') continue;
    const quietFor = now - Math.max(task.lastSeen, task.since);
    const expected = task.phase === 'turn' ? task.scriptedMs + 60_000 : 60_000;
    if (quietFor < expected) continue;
    const reply = await task.owner.request('GET', `/api/tasks/${task.id}`);
    task.lastSeen = Date.now();
    if (reply.status === 200) advance(task, String(reply.body?.stage ?? ''), String(reply.body?.status ?? ''), Date.now());
    if (tasksById.has(task.id) && now - task.since > 600_000) { count('tasksStuck'); close(task); }
  }
}

// ---------------------------------------------------------------- tenants

const MOCK_SPEC = { provider: 'mock', mcpConnections: [] };
const MOCK_AGENT = { 'agent:do': MOCK_SPEC };

class Tenant {
  people: Person[] = [];
  orgId = '';
  taskProject = '';
  dataProject = '';
  resourceId = '';
  ready = false;
  readonly id: string; readonly team: boolean;
  constructor(id: string, team: boolean) { this.id = id; this.team = team; }
}
const tenants: Tenant[] = [];
let policyVersions: Json;
const admin = new Person(new Tenant('admin', false), 'Load Admin', adminEmail, adminPassword);

async function signUp(tenant: Tenant, index: number): Promise<Person> {
  const person = new Person(tenant, `Load ${tenant.id} ${index} ${randomBytes(3).toString('hex')}`,
    `${tenant.id}-${index}-${randomBytes(3).toString('hex')}@load.invalid`, `pw-${randomBytes(12).toString('hex')}`);
  const created = await person.call('POST', '/api/signup',
    { name: person.name, email: person.email, password: person.password, acceptedPolicies: true, policyVersions });
  person.id = String(created?.user?.id ?? '');
  if (!person.cookies.size) await person.call('POST', '/api/login', { email: person.email, password: person.password });
  if (!person.id) person.id = String((await person.call('GET', '/api/session'))?.user?.id ?? '');
  return person;
}

async function setUpTenant(tenant: Tenant) {
  const owner = await signUp(tenant, 0);
  tenant.people.push(owner);
  const organizations = await owner.call('GET', '/api/organizations');
  const list: Json[] = Array.isArray(organizations) ? organizations : organizations?.organizations ?? [];
  tenant.orgId = String(list[0]?.id ?? '');
  if (!tenant.orgId) throw new Error(`no personal organization for ${owner.email}: ${JSON.stringify(organizations).slice(0, 200)}`);
  const org = tenant.orgId;
  if (tenant.team) {
    // Members need seats; the installation grants the plan without a payment provider.
    await admin.call('POST', `/api/organizations/${org}/subscription/gift`, { plan: 'team' }, { 'idempotency-key': `load-${tenant.id}` });
    for (let i = 1; i < teamSize; i++) {
      const member = await signUp(tenant, i);
      await owner.call('POST', `/api/organizations/${org}/members`, { userId: member.id, authorization: { level: 'developer', scope: 'organization' } });
      tenant.people.push(member);
    }
  }
  await owner.call('PUT', `/api/organizations/${org}/world-providers/e2b`, { apiKey: `e2b_${randomBytes(20).toString('hex')}`, name: 'Load-test E2B stand-in' });
  await owner.call('PUT', `/api/profiles?organizationId=${org}`, { role: 'do', ...MOCK_SPEC });
  tenant.taskProject = String((await owner.call('POST', `/api/organizations/${org}/projects`, { name: `App ${tenant.id}` }))?.id ?? '');
  await owner.call('PUT', `/api/settings/project/${tenant.taskProject}/software-dev`, { values: MOCK_AGENT });
  // Resources live in a project of their own: tasks there would restore them
  // into every world, which production does through the resource edge, not
  // through this host.
  tenant.dataProject = String((await owner.call('POST', `/api/organizations/${org}/projects`, { name: `Data ${tenant.id}` }))?.id ?? '');
  const resource = await owner.call('POST', `/api/projects/${tenant.dataProject}/resources`, {
    name: 'dataset', driver: 'volume@1', access: 'write', isolation: 'fork', publish: 'discard',
    files: [{ path: 'README.md', data: `Load-test dataset for ${tenant.id}\n` }],
  });
  tenant.resourceId = String(resource?.id ?? resource?.resource?.id ?? '');
  for (const person of tenant.people) {
    for (let s = 0; s < socketsPerUser; s++) {
      const socket = new Socket(person, s === 0 ? undefined : { projectId: tenant.taskProject });
      person.sockets.push(socket);
      socket.open();
    }
  }
  tenant.ready = true;
}

// ---------------------------------------------------------------- behaviour

let stopping = false;
let taskNumber = 0;

async function browse(person: Person) {
  const tenant = person.tenant;
  await person.request('GET', '/api/session');
  await person.request('GET', '/api/organizations');
  await person.request('GET', `/api/projects/${tenant.taskProject}/tasks`);
  const task = pick([...person.tasks.values()]);
  if (task) {
    await person.request('GET', `/api/tasks/${task.id}`);
    await person.request('GET', `/api/tasks/${task.id}/conversation?role=do`);
    await person.request('GET', `/api/tasks/${task.id}/events?since=0&limit=200`);
  }
}

async function saveResource(person: Person) {
  const tenant = person.tenant;
  // Saving a revision needs project maintainer; members are developers.
  if (!tenant.resourceId || person !== tenant.people[0]) return browse(person);
  const files = Array.from({ length: 3 }, (_, i) => ({ path: `data/${Date.now()}-${i}.bin`, data: randomBytes(48 * 1024).toString('base64'), encoding: 'base64' }));
  const reply = await person.request('POST', `/api/projects/${tenant.dataProject}/resources/${tenant.resourceId}/import`, { files });
  if (reply.status < 300) count('resourceSaves');
}

async function act(person: Person) {
  const roll = Math.random();
  if (roll < 0.4) return browse(person);
  if (roll < 0.9) {
    const working = [...person.tasks.values()].filter((task) => !task.abandoned);
    const atReview = working.filter((task) => task.phase === 'review');
    if (working.length < maxActivePerUser && (!atReview.length || Math.random() < 0.5)) return createTask(person, ++taskNumber);
    const task = pick(atReview);
    return task ? actOnReview(person, task) : browse(person);
  }
  return saveResource(person);
}

async function live(person: Person) {
  // Spread the first actions out, so a step does not start in lockstep.
  await sleep(Math.random() * thinkMs);
  while (!stopping) {
    try { await act(person); } catch (error) { count('driverErrors'); log(`driver error: ${error instanceof Error ? error.message : String(error)}`); }
    await sleep(exp(thinkMs));
  }
}

async function healthLoop() {
  const anonymous = new Person(new Tenant('health', false), 'health', '', '');
  while (!stopping) {
    const reply = await anonymous.request('GET', '/api/health/ready');
    if (reply.status !== 200) count('healthFailures');
    await sleep(10_000);
  }
}
async function pollLoop() {
  while (!stopping) {
    try { await pollStale(); } catch { /* counted per request */ }
    await sleep(15_000);
  }
}

async function sandboxes(): Promise<Record<string, number> | undefined> {
  try {
    const response = await fetch(new URL('/sandboxes', fakeE2b), { signal: AbortSignal.timeout(10_000) });
    const list = await response.json() as Array<{ state: string }>;
    const byState: Record<string, number> = {};
    for (const sandbox of list) byState[sandbox.state] = (byState[sandbox.state] ?? 0) + 1;
    return byState;
  } catch { return undefined; }
}

// ---------------------------------------------------------------- steps

function summarize(window: Window | undefined) {
  if (!window) return undefined;
  const metrics: Record<string, unknown> = {};
  for (const [name, values] of window.samples) metrics[name] = percentiles(values);
  const counts = Object.fromEntries(window.counts);
  const seconds = (Date.now() - window.started) / 1000;
  return { seconds: Math.round(seconds), requestsPerSecond: Math.round(((counts.requests ?? 0) / seconds) * 10) / 10, counts, metrics,
    errors: window.errors.slice(0, 40) };
}

function broken(setup: ReturnType<typeof summarize>, steady: ReturnType<typeof summarize>, newTenants: number, failedSetups: number): string[] {
  const reasons: string[] = [];
  if (newTenants && failedSetups / newTenants > LIMITS.setupFailureRate)
    reasons.push(`${failedSetups} of ${newTenants} new tenants failed to set up`);
  if (!steady) return reasons;
  const c = steady.counts as Record<string, number>;
  const m = steady.metrics as Record<string, ReturnType<typeof percentiles>>;
  const requests = c.requests ?? 0;
  const failed = (c.serverErrors ?? 0) + (c.networkErrors ?? 0) + (c.timeouts ?? 0);
  if (requests && failed / requests > LIMITS.errorRate) reasons.push(`error rate ${(100 * failed / requests).toFixed(2)}% (${failed} of ${requests})`);
  if ((m['api *']?.p95 ?? 0) > LIMITS.apiP95Ms) reasons.push(`API p95 ${m['api *']!.p95} ms`);
  if ((m['event lag']?.p95 ?? 0) > LIMITS.eventLagP95Ms) reasons.push(`event lag p95 ${m['event lag']!.p95} ms`);
  if ((m['turn overhead']?.p50 ?? 0) > LIMITS.turnOverheadP50Ms) reasons.push(`turn overhead p50 ${m['turn overhead']!.p50} ms`);
  const transitions = (c.turnsCompleted ?? 0) + (c.tasksFailed ?? 0) + (c.tasksStuck ?? 0);
  if (transitions && ((c.tasksFailed ?? 0) + (c.tasksStuck ?? 0)) / transitions > LIMITS.taskFailureRate)
    reasons.push(`${c.tasksFailed ?? 0} failed and ${c.tasksStuck ?? 0} stuck tasks of ${transitions}`);
  const opens = c.socketOpens ?? 0;
  const socketBad = (c.socketFailures ?? 0) + (c.socketRefused ?? 0) + (c.socketDrops ?? 0);
  if (opens && socketBad / opens > LIMITS.socketFailureRate) reasons.push(`${socketBad} websocket failures or drops of ${opens} opens`);
  if (c.healthFailures) reasons.push(`${c.healthFailures} failed readiness checks`);
  return reasons;
}

async function main() {
  const anonymous = new Person(new Tenant('anon', false), 'anon', '', '');
  for (let attempt = 0; ; attempt++) {
    const reply = await anonymous.request('GET', '/api/health/ready');
    if (reply.status === 200) break;
    if (attempt > 60) throw new Error(`the installation is not ready: ${reply.status}`);
    await sleep(5_000);
  }
  policyVersions = (await anonymous.call('GET', '/api/launch'))?.acceptance?.signup;
  await admin.call('POST', '/api/login', { email: adminEmail, password: adminPassword });
  void healthLoop();
  void pollLoop();
  const stepsFile = path.join(out, 'steps.jsonl');
  log(`driving ${base.origin}: steps ${steps.join(',')}, hold ${holdMs / 1000}s`);
  for (const [index, target] of steps.entries()) {
    const stepStarted = Date.now();
    phase = 'setup';
    setupWindow = new Window();
    const fresh: Tenant[] = [];
    while (tenants.length + fresh.length < target) {
      const n = tenants.length + fresh.length;
      fresh.push(new Tenant(`t${String(n).padStart(4, '0')}`, teamEvery > 0 && n % teamEvery === teamEvery - 1));
    }
    let failedSetups = 0;
    const queue = [...fresh];
    await Promise.all(Array.from({ length: setupConcurrency }, async () => {
      for (let tenant = queue.shift(); tenant; tenant = queue.shift()) {
        const began = performance.now();
        try {
          await setUpTenant(tenant);
          record('tenant setup', performance.now() - began);
          for (const person of tenant.people) void live(person);
        } catch (error) {
          failedSetups++;
          log(`tenant ${tenant.id} setup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }));
    tenants.push(...fresh);
    const setupSeconds = Math.round((Date.now() - stepStarted) / 1000);
    log(`step ${index + 1}: ${tenants.length} tenants (${fresh.length} new, ${failedSetups} failed) set up in ${setupSeconds}s; holding`);
    phase = 'steady';
    steadyWindow = new Window();
    const setup = summarize(setupWindow);
    await sleep(holdMs);
    const steady = summarize(steadyWindow);
    const settled = tenants.filter((tenant) => tenant.ready);
    const people = settled.flatMap((tenant) => tenant.people);
    const openTasks = [...tasksById.values()];
    const line = {
      step: index + 1, startedAt: new Date(stepStarted).toISOString(), steadyFrom: new Date(steadyWindow.started).toISOString(),
      endedAt: new Date().toISOString(), setupSeconds,
      tenants: settled.length, teams: settled.filter((t) => t.team).length, people: people.length,
      sockets: people.reduce((sum, p) => sum + p.sockets.filter((s) => s.ws?.readyState === WebSocket.OPEN).length, 0),
      trackedTasks: { total: openTasks.length, turn: openTasks.filter((t) => t.phase === 'turn').length,
        review: openTasks.filter((t) => t.phase === 'review').length, abandoned: openTasks.filter((t) => t.abandoned).length },
      sandboxes: await sandboxes(),
      newTenants: fresh.length, failedSetups, setup, steady,
      broken: broken(setup, steady, fresh.length, failedSetups),
    };
    fs.appendFileSync(stepsFile, `${JSON.stringify(line)}\n`);
    const m = (steady?.metrics ?? {}) as Record<string, ReturnType<typeof percentiles>>;
    log(`step ${index + 1} done: ${line.tenants} tenants, ${line.people} people, ${line.sockets} sockets, ${line.trackedTasks.total} open tasks, `
      + `${steady?.requestsPerSecond} req/s, api p95 ${m['api *']?.p95} ms, lag p95 ${m['event lag']?.p95} ms, overhead p50 ${m['turn overhead']?.p50} ms`
      + (line.broken.length ? `; BROKEN: ${line.broken.join('; ')}` : ''));
    if (line.broken.length) break;
  }
  stopping = true;
  for (const person of tenants.flatMap((tenant) => tenant.people)) for (const socket of person.sockets) socket.close();
  fs.writeFileSync(path.join(out, 'tenants.json'), JSON.stringify(tenants.map((t) => ({ id: t.id, team: t.team, orgId: t.orgId, ready: t.ready, people: t.people.length })), null, 1));
  log('done');
  process.exit(0);
}

await main();
