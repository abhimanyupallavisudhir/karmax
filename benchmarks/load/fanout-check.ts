/** Isolates the load test's first wall (benchmarks/load/README.md, "Findings"):
 *  how many database commits one task event costs per open websocket, with and
 *  without an authorization-epoch bump between events.
 *
 *  Every socket in the installation is offered every event, and each decides
 *  "may this person read it?" through a cache keyed on one global authorization
 *  epoch. Any authority write moves the epoch, and every agent turn ends with
 *  one (its scoped token is revoked), so under load nearly every event costs a
 *  permission read on every socket, whoever's event it is.
 *
 *    node --experimental-strip-types benchmarks/load/fanout-check.ts --base URL --origin URL \
 *      --admin-email E --pg-url postgres://…/karmax [--users 10,20,40] [--sockets 2] [--events 30]
 *      (LOADTEST_ADMIN_PASSWORD=P)
 *
 *  For each population it reports commits per event in three phases: events
 *  alone, epoch bumps alone (a membership added and removed in an unrelated
 *  organization), and both interleaved. The interleaved cost minus the other
 *  two is what an epoch bump makes the next event cost.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}
const base = new URL(option('base'));
const origin = option('origin', base.origin);
const adminEmail = option('admin-email');
const adminPassword = process.env.LOADTEST_ADMIN_PASSWORD ?? option('admin-password');
const pgUrl = option('pg-url');
const populations = option('users', '10,20,40').split(',').map(Number);
const socketsPerUser = Number(option('sockets', '2'));
const events = Number(option('events', '30'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Person {
  cookies = new Map<string, string>();
  id = '';
  orgId = '';
  projectId = '';
  sockets: WebSocket[] = [];
  received = 0;
  headers(): Record<string, string> {
    return { origin, 'idempotency-key': randomBytes(8).toString('hex'), 'content-type': 'application/json', ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) };
  }
  async call(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(new URL(path, base), { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const at = pair.indexOf('=');
      if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  open() {
    const url = new URL('/ws', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, { headers: this.headers() } as any);
    ws.onmessage = () => { this.received++; };
    this.sockets.push(ws);
    return new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('socket refused')); });
  }
}

const commits = () => Number(execFileSync('psql', [pgUrl, '-Atqc',
  "select xact_commit from pg_stat_database where datname = current_database()"], { encoding: 'utf8' }).trim());
/** Commits a phase caused, net of what the idle installation commits meanwhile. */
async function measure(idlePerSecond: number, run: () => Promise<void>): Promise<number> {
  await sleep(2_000);
  const before = commits(), started = Date.now();
  await run();
  await sleep(3_000); // let the fan-out finish and the statistics flush
  return commits() - before - idlePerSecond * ((Date.now() - started) / 1000);
}

const admin = new Person();
await admin.call('POST', '/api/login', { email: adminEmail, password: adminPassword });
const policyVersions = (await new Person().call('GET', '/api/launch'))?.acceptance?.signup;
async function signUp(): Promise<Person> {
  const person = new Person();
  const name = `Fanout ${randomBytes(4).toString('hex')}`;
  const created = await person.call('POST', '/api/signup', { name, email: `${name.replace(' ', '-').toLowerCase()}@load.invalid`,
    password: `pw-${randomBytes(12).toString('hex')}`, acceptedPolicies: true, policyVersions });
  person.id = String(created?.user?.id ?? '');
  const organizations = await person.call('GET', '/api/organizations');
  person.orgId = String((Array.isArray(organizations) ? organizations : organizations.organizations)[0].id);
  person.projectId = String((await person.call('POST', `/api/organizations/${person.orgId}/projects`, { name: `P ${name}` })).id);
  return person;
}

// The writer creates the events; the bystander's organization takes the epoch bumps.
const writer = await signUp();
const bystander = await signUp();
const spare = await signUp();
await writer.open();
const people: Person[] = [];
let n = 0;
const event = () => writer.call('POST', `/api/projects/${writer.projectId}/tasks`, { title: `fan-out ${n++}`, prompt: 'x', draft: true });
const bump = async () => {
  await bystander.call('POST', `/api/organizations/${bystander.orgId}/members`, { userId: spare.id, authorization: { level: 'developer', scope: 'organization' } });
  await bystander.call('DELETE', `/api/organizations/${bystander.orgId}/members/${spare.id}`);
};
await admin.call('POST', `/api/organizations/${bystander.orgId}/subscription/gift`, { plan: 'team' });
console.log('| people with sockets | sockets | commits/event, no bump | commits/bump alone | commits/event after a bump | extra per event per socket |');
console.log('|---:|---:|---:|---:|---:|---:|');
for (const target of populations) {
  while (people.length < target) {
    const person = await signUp();
    for (let s = 0; s < socketsPerUser; s++) await person.open();
    people.push(person);
  }
  const sockets = people.length * socketsPerUser + 1;
  await sleep(3_000);
  const idleStart = commits(); await sleep(10_000); const idle = (commits() - idleStart) / 10;
  const plain = await measure(idle, async () => { for (let i = 0; i < events; i++) { await event(); await sleep(300); } });
  const bumps = await measure(idle, async () => { for (let i = 0; i < events; i++) { await bump(); await sleep(300); } });
  const both = await measure(idle, async () => { for (let i = 0; i < events; i++) { await bump(); await event(); await sleep(300); } });
  const extra = (both - bumps - plain) / events;
  console.log(`| ${people.length} | ${sockets} | ${(plain / events).toFixed(1)} | ${(bumps / events).toFixed(1)} | ${(both / events - bumps / events).toFixed(1)} | ${(extra / sockets).toFixed(2)} |`);
}
for (const person of [writer, ...people]) for (const ws of person.sockets) ws.close();
process.exit(0);
