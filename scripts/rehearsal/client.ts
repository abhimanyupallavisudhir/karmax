/** Seeds a turnkey stack with production-shaped data through its HTTP API, and
 *  verifies that data later, for scripts/rehearse-upgrade.sh. It never touches
 *  the database: whatever the API of the revision under test cannot do, the
 *  rehearsal does not do either.
 *
 *    node --experimental-strip-types scripts/rehearsal/client.ts seed   --app URL --origin URL --state FILE
 *    node --experimental-strip-types scripts/rehearsal/client.ts verify --app URL --origin URL --state FILE
 *         --phase NAME [--resume]
 *
 *  `seed` writes everything it created, with the values it expects back, to the
 *  state file; `verify` checks each of them and exits non-zero on any failure.
 *  `--resume` also answers the task parked in Do and waits for it to finish
 *  its next turn in its (resumed) world. Agents are the mock; worlds are the
 *  rehearsal's local E2B stand-in (scripts/rehearsal/fake-e2b.ts).
 */
import http from 'node:http';
import fs from 'node:fs';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const command = process.argv[2];
const app = new URL(required('app'));
const origin = new URL(required('origin'));
const stateFile = required('state');

// ---------------------------------------------------------------- HTTP

const obj = (value: Json | undefined): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const arr = (value: Json | undefined): Json[] => Array.isArray(value) ? value : [];
const str = (value: Json | undefined): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);

interface Reply { status: number; body: Json; text: string }

/** One person's cookies, as their browser would keep them. */
class Session {
  readonly cookies = new Map<string, string>();
  readonly name: string;
  constructor(name: string) { this.name = name; }

  request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: app.hostname, port: app.port || 80, method, path,
        headers: {
          // The app sits behind Caddy in production; this is what Caddy forwards.
          host: origin.host, origin: origin.origin, 'x-forwarded-proto': 'https', 'x-forwarded-host': origin.host,
          accept: 'application/json',
          ...(this.cookies.size ? { cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
        timeout: 60_000,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          for (const cookie of response.headers['set-cookie'] ?? []) {
            const [pair = ''] = cookie.split(';');
            const at = pair.indexOf('=');
            if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: Json = null;
          try { parsed = text ? JSON.parse(text) as Json : null; } catch { parsed = text; }
          resolve({ status: response.statusCode ?? 0, body: parsed, text });
        });
      });
      request.on('timeout', () => request.destroy(new Error(`${method} ${path} timed out`)));
      request.on('error', reject);
      request.end(payload);
    });
  }

  /** A call that must succeed (2xx); anything else aborts with the app's answer. */
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Json> {
    const reply = await this.request(method, path, body, headers);
    if (reply.status < 200 || reply.status >= 300)
      throw new Error(`${this.name}: ${method} ${path} → ${reply.status} ${reply.text.slice(0, 500)}`);
    return reply.body;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) { last = error; }
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? `: ${last instanceof Error ? last.message : String(last)}` : ''}`);
    await sleep(1_000);
  }
}

// ---------------------------------------------------------------- the seeded state

interface Person { name: string; email: string; password: string; id: string }
interface SeededTask { id: string; projectId: string; title: string; texts: string[]; expect: string }
interface State {
  seededAt: string;
  siteName: string;
  owner: Person;
  member: Person;
  organization: { id: string; name: string };
  projects: Array<{ id: string; name: string }>;
  tasks: Record<string, SeededTask>;
  vault: {
    login: { id: string; username: string; password: string; totp: string };
    apiKey: { id: string; secret: string };
    sshKey: { id: string; privateKey: string };
  };
  card: { id: string; last4: string; cap: number };
  secrets: { projectId: string; env: { name: string; value: string }; file: { name: string; value: string; path: string } };
  share: { taskId: string; url: string };
  resumed: string[];
  /** What the FROM revision could not seed through its API, and why. */
  gaps: string[];
}

const readState = (): State => JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State;
const writeState = (state: Partial<State>) => fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

// ---------------------------------------------------------------- TOTP (RFC 6238)

function base32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error(`invalid base32 character ${char}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let at = 0; at + 8 <= bits.length; at += 8) bytes.push(parseInt(bits.slice(at, at + 8), 2));
  return Buffer.from(bytes);
}

function totp(seed: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', base32(seed)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

// ---------------------------------------------------------------- tasks

async function view(session: Session, taskId: string): Promise<JsonObject> {
  return obj(await session.call('GET', `/api/tasks/${taskId}`));
}

const describeView = (task: JsonObject) =>
  `stage=${str(task.stage)} status=${str(task.status)} waitingFor=${str(obj(task.waitingFor).kind) || '-'}`;

async function settle(session: Session, taskId: string, what: string, wanted: (task: JsonObject) => boolean,
  timeoutMs = 180_000): Promise<JsonObject> {
  let last: JsonObject = {};
  try {
    return await until(`${what} (task ${taskId})`, timeoutMs, async () => {
      last = await view(session, taskId);
      if (str(last.status) === 'failed') throw new Error(`task ${taskId} failed: ${describeView(last)} ${str(last.error)}`);
      return wanted(last) ? last : undefined;
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; last seen ${describeView(last)}`);
  }
}

const atReview = (task: JsonObject) => str(task.stage) === 'review' && str(task.status) === 'waiting';
const parkedForInput = (task: JsonObject) => str(task.stage) === 'do' && str(task.status) === 'waiting'
  && str(obj(task.waitingFor).kind) === 'human';
// The mock agent, without the default profile's browser MCP: in a remote world
// that installs Node and Chromium on every turn, which production's E2B
// template bakes in and the rehearsal's sandbox image does not.
const mockAgentSpec = { provider: 'mock', mcpConnections: [] };
const mockAgent = { 'agent:do': mockAgentSpec };

async function createTask(session: Session, projectId: string, title: string, prompt: string, extra: JsonObject = {}): Promise<string> {
  const task = obj(await session.call('POST', `/api/projects/${projectId}/tasks`,
    { title, prompt, params: mockAgent, ...extra }));
  const id = str(task.id);
  if (!id) throw new Error(`creating "${title}" returned no id: ${JSON.stringify(task)}`);
  console.log(`  task ${id} "${title}"`);
  return id;
}

async function followUp(session: Session, taskId: string, text: string) {
  await session.call('POST', `/api/tasks/${taskId}/signal`, { signal: 'followUp', text, role: 'do' });
}

async function conversation(session: Session, taskId: string): Promise<string[]> {
  const reply = obj(await session.call('GET', `/api/tasks/${taskId}/conversation?role=do`));
  return arr(reply.messages).map((message) => str(obj(message).text));
}

// ---------------------------------------------------------------- seed

async function waitForApp(session: Session) {
  await until('the app to answer /api/session', 300_000, async () =>
    (await session.request('GET', '/api/session')).status === 200 ? true : undefined);
}

async function seed() {
  if (fs.existsSync(stateFile)) throw new Error(`${stateFile} already exists; seed a fresh stack with a fresh state file`);
  const tag = randomBytes(3).toString('hex');
  const state: Partial<State> = { seededAt: new Date().toISOString(), tasks: {}, resumed: [], gaps: [] };
  const save = () => writeState(state);
  const owner = new Session('owner');
  await waitForApp(owner);

  console.log('• people and the organization');
  const ownerPerson: Person = { name: 'Rehearsal Owner', email: 'owner@rehearse.localhost', password: `owner-${randomBytes(12).toString('hex')}`, id: '' };
  const setup = obj(await owner.call('POST', '/api/setup', ownerPerson));
  ownerPerson.id = str(obj(setup.user).id);
  state.owner = ownerPerson; save();

  state.siteName = `Rehearsal ${tag}`;
  await owner.call('PUT', '/api/settings/installation', { siteName: state.siteName });

  const memberPerson: Person = { name: 'Rehearsal Member', email: 'member@rehearse.localhost', password: `member-${randomBytes(12).toString('hex')}`, id: '' };
  memberPerson.id = str(obj(await owner.call('POST', '/api/users',
    { name: memberPerson.name, email: memberPerson.email, password: memberPerson.password })).id);
  state.member = memberPerson; save();

  const organization = obj(await owner.call('POST', '/api/organizations', { name: `Rehearsal Co ${tag}` }));
  const orgId = str(organization.id);
  state.organization = { id: orgId, name: str(organization.name) }; save();
  // A second member needs a paid seat. The installation's owner can grant a
  // plan without any payment provider.
  await owner.call('POST', `/api/organizations/${orgId}/subscription/gift`, { plan: 'team' },
    { 'idempotency-key': `rehearsal-gift-${tag}` });
  await owner.call('POST', `/api/organizations/${orgId}/members`,
    { userId: memberPerson.id, authorization: { level: 'developer', scope: 'organization' } });
  await owner.call('PUT', `/api/profiles?organizationId=${orgId}`, { role: 'do', ...mockAgentSpec });
  // Worlds come from the rehearsal's E2B stand-in; the key only has E2B's shape.
  await owner.call('PUT', `/api/organizations/${orgId}/world-providers/e2b`,
    { apiKey: `e2b_${randomBytes(20).toString('hex')}`, name: 'Rehearsal E2B stand-in' });

  console.log('• projects, secrets and settings');
  state.projects = [];
  for (const name of ['Web', 'Ops']) {
    const project = obj(await owner.call('POST', `/api/organizations/${orgId}/projects`, { name: `${name} ${tag}` }));
    state.projects.push({ id: str(project.id), name: str(project.name) });
    await owner.call('PUT', `/api/settings/project/${str(project.id)}/software-dev`, { values: mockAgent });
  }
  save();
  const [web, ops] = state.projects;
  if (!web || !ops) throw new Error('projects were not created');
  state.secrets = {
    projectId: web.id,
    env: { name: 'REHEARSAL_ENV_SECRET', value: `env-${randomBytes(12).toString('hex')}` },
    file: { name: 'REHEARSAL_FILE_SECRET', value: `file-${randomBytes(12).toString('hex')}`, path: 'config/rehearsal-secret.txt' },
  };
  await owner.call('POST', `/api/projects/${web.id}/secrets`, { name: state.secrets.env.name, value: state.secrets.env.value });
  await owner.call('POST', `/api/projects/${web.id}/secrets`,
    { name: state.secrets.file.name, value: state.secrets.file.value, file: state.secrets.file.path });
  save();

  console.log('• vault and card');
  const vault = `/api/vault/items?organizationId=${orgId}`;
  const totpSeed = base32Seed();
  const login = { username: 'rehearsal-user', password: `pw-${randomBytes(12).toString('hex')}`, totp: totpSeed };
  const loginItem = obj(await owner.call('POST', vault, { type: 'login', label: 'Rehearsal login', username: login.username,
    domains: ['example.com'], secrets: { password: login.password, totp: login.totp }, policy: { use: 'auto', reveal: 'auto' } }));
  const apiSecret = `sk-rehearsal-${randomBytes(16).toString('hex')}`;
  const apiItem = obj(await owner.call('POST', vault, { type: 'api-key', label: 'Rehearsal API key',
    envVar: 'REHEARSAL_API_KEY', secrets: { secret: apiSecret } }));
  const { privateKey } = generateKeyPairSync('ed25519');
  const sshKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const sshItem = obj(await owner.call('POST', vault, { type: 'ssh-key', label: 'Rehearsal SSH key',
    envVar: 'REHEARSAL_SSH_KEY', secrets: { privateKey: sshKey } }));
  state.vault = {
    login: { id: str(loginItem.id), ...login },
    apiKey: { id: str(apiItem.id), secret: apiSecret },
    sshKey: { id: str(sshItem.id), privateKey: sshKey },
  };
  const card = obj(await owner.call('POST', `/api/cards?organizationId=${orgId}`, { provider: 'vault-card',
    label: 'Rehearsal card', cap: 5_000, details: { number: '4242424242424242', cvc: '321', expMonth: 12, expYear: 2034,
      billing: { line1: '1 Rehearsal Street', city: 'London', postalCode: 'N1 1AA', country: 'GB' } } }));
  state.card = { id: str(card.id), last4: str(card.last4), cap: 5_000 };
  save();

  console.log('• tasks and conversations');
  const tasks = state.tasks!;
  // A draft never runs.
  tasks.draft = { id: await createTask(owner, web.id, 'Rehearsal draft', 'Plan the rehearsal.', { draft: true }),
    projectId: web.id, title: 'Rehearsal draft', texts: [], expect: 'draft' };
  // A member's own draft, in the other project.
  const member = new Session('member');
  await member.call('POST', '/api/login', { email: memberPerson.email, password: memberPerson.password });
  tasks.memberDraft = { id: await createTask(member, ops.id, 'Member draft', 'A member wrote this.', { draft: true }),
    projectId: ops.id, title: 'Member draft', texts: [], expect: 'draft' };
  save();

  // One at Review after a single turn.
  const reviewId = await createTask(owner, web.id, 'Rehearsal at review', 'Write the notes.\n@write notes/review.md :: at review');
  tasks.review = { id: reviewId, projectId: web.id, title: 'Rehearsal at review', texts: ['wrote notes/review.md'], expect: 'review' };
  save();
  await settle(owner, reviewId, 'Review', atReview);

  // One done: two turns (a follow-up at Review sends it back to Do), then approved.
  const doneId = await createTask(owner, web.id, 'Rehearsal done', 'First draft.\n@write notes/done.md :: first');
  tasks.done = { id: doneId, projectId: web.id, title: 'Rehearsal done', expect: 'done',
    texts: ['wrote notes/done.md', 'Second turn: tighten the wording.'] };
  save();
  await settle(owner, doneId, 'Review', atReview);
  await followUp(owner, doneId, 'Second turn: tighten the wording.\n@write notes/done.md :: second');
  await settle(owner, doneId, 'the second turn to reach Review', (task) => atReview(task)
    && arr(task.messages).filter((message) => str(obj(message).role) === 'user').length >= 2);
  await owner.call('POST', `/api/tasks/${doneId}/signal`, { signal: 'confirm' });
  await settle(owner, doneId, 'Done', (task) => str(task.status) === 'done');

  // One parked in Do waiting for input: the agent is mid-turn when it asks a
  // person, as escalate_to_human does.
  const parkedId = await createTask(owner, web.id, 'Rehearsal parked for input', 'Start the migration plan.\n@sleep 600000');
  tasks.parked = { id: parkedId, projectId: web.id, title: 'Rehearsal parked for input', expect: 'parked',
    texts: ['Start the migration plan.'] };
  save();
  await settle(owner, parkedId, 'Do to start its turn', (task) => str(task.stage) === 'do' && str(task.status) === 'active');
  await owner.call('POST', `/api/tasks/${parkedId}/escalate`,
    { audience: ['@creator'], message: 'Which database should the migration target?' });
  await settle(owner, parkedId, 'the task to park in Do for input', parkedForInput);
  // Grant it the card, so the resumed turn can spend from it.
  await owner.call('PUT', `/api/tasks/${parkedId}/payments`, { cardIds: [state.card.id], budget: 1_000 });

  // A parent with a sub-task, in the other project.
  const parentId = await createTask(owner, ops.id, 'Rehearsal parent',
    'Split the work.\n@subtask Rehearsal child :: Do the child part.\n@write child.md :: child');
  tasks.parent = { id: parentId, projectId: ops.id, title: 'Rehearsal parent', texts: ['subtask: Rehearsal child'], expect: 'parent' };
  save();
  const outcome = await until('the sub-task to exist', 180_000, async () => {
    const list = arr(await owner.call('GET', `/api/projects/${ops.id}/tasks`)).map(obj);
    const child = list.find((task) => str(task.parentTaskId) === parentId);
    if (child) return { childId: str(child.id) };
    const parent = await view(owner, parentId);
    return str(parent.status) === 'failed' ? { failed: `${describeView(parent)}: ${str(parent.error)}` } : undefined;
  });
  if (outcome.childId) {
    tasks.child = { id: outcome.childId, projectId: ops.id, title: 'Rehearsal child', texts: [], expect: 'child' };
    save();
    await settle(owner, outcome.childId, 'the sub-task to reach Review', atReview);
  } else {
    // The FROM revision could not create it. That is its bug, not the
    // upgrade's: record it, and check the failed parent survives as it is.
    tasks.parent.expect = 'failed';
    tasks.parent.texts = [];
    state.gaps!.push(`sub-task: the parent ${parentId} failed instead of spawning it (${outcome.failed ?? ''}); `
      + `see its Temporal history for the cause`);
    save();
  }

  console.log('• a public conversation share');
  await owner.call('PUT', `/api/organizations/${orgId}/conversation-sharing`, { enabled: true });
  const share = obj(await owner.call('POST', `/api/tasks/${doneId}/conversation-share?role=do`));
  state.share = { taskId: doneId, url: str(share.url) };
  save();
  for (const gap of state.gaps ?? []) console.log(`GAP  ${gap}`);
  console.log(`seeded; state in ${stateFile}`);
}

function base32Seed(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return [...randomBytes(20)].map((byte) => alphabet[byte % 32]).join('');
}

// ---------------------------------------------------------------- verify

let failures = 0;
async function check(name: string, run: () => Promise<string | void>) {
  try {
    const detail = await run();
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function verify() {
  const state = readState();
  const phase = option('phase') ?? 'verify';
  console.log(`Verifying the data seeded at ${state.seededAt} (${phase})`);
  const owner = new Session('owner');
  const member = new Session('member');
  await waitForApp(owner);
  const orgId = state.organization.id;

  await check('the owner signs in', async () => {
    await owner.call('POST', '/api/login', { email: state.owner.email, password: state.owner.password });
    assert(obj(await owner.call('GET', '/api/session')).authenticated === true, 'session is not authenticated');
  });
  await check('the member signs in', async () => {
    await member.call('POST', '/api/login', { email: state.member.email, password: state.member.password });
  });
  await check('the site name is kept', async () => {
    const meta = obj(await owner.call('GET', '/api/meta'));
    assert(str(meta.siteName) === state.siteName, `siteName is ${str(meta.siteName)}, not ${state.siteName}`);
  });
  await check('the organization, its member and both projects are there', async () => {
    const members = arr(await owner.call('GET', `/api/organizations/${orgId}/members`)).map(obj);
    assert(members.some((entry) => str(obj(entry.user).email) === state.member.email || str(entry.userId) === state.member.id),
      `member ${state.member.email} missing from ${JSON.stringify(members).slice(0, 300)}`);
    const projects = arr(await owner.call('GET', `/api/organizations/${orgId}/projects`)).map(obj);
    for (const project of state.projects)
      assert(projects.some((entry) => str(entry.id) === project.id && str(entry.name) === project.name), `project ${project.name} missing`);
    return `${members.length} members, ${projects.length} projects`;
  });
  await check('the member still sees the organization', async () => {
    const organizations = arr(await member.call('GET', '/api/organizations')).map(obj);
    assert(organizations.some((entry) => str(entry.id) === orgId), 'organization missing from the member\'s list');
  });

  for (const [key, seeded] of Object.entries(state.tasks)) {
    await check(`task "${seeded.title}" is ${seeded.expect}`, async () => {
      const task = await view(owner, seeded.id);
      const summary = describeView(task);
      if (seeded.expect === 'draft') assert(obj(task.state).draft === true, `not a draft: ${summary}`);
      if (seeded.expect === 'review') assert(atReview(task), summary);
      if (seeded.expect === 'done') assert(str(task.status) === 'done', summary);
      if (seeded.expect === 'failed') assert(str(task.status) === 'failed', summary);
      if (seeded.expect === 'parked' && !state.resumed.includes(phase)) assert(parkedForInput(task), summary);
      if (seeded.expect === 'child') {
        const listed = arr(await owner.call('GET', `/api/projects/${seeded.projectId}/tasks`)).map(obj)
          .find((entry) => str(entry.id) === seeded.id);
        assert(listed && str(listed.parentTaskId) === state.tasks.parent?.id, `not the parent's sub-task: ${JSON.stringify(listed)}`);
      }
      const listed = arr(await owner.call('GET', `/api/projects/${seeded.projectId}/tasks?includeArchived=1`)).map(obj);
      assert(listed.some((entry) => str(entry.id) === seeded.id), `missing from its project's task list (${key})`);
      if (seeded.texts.length) {
        const texts = await conversation(owner, seeded.id);
        for (const text of seeded.texts)
          assert(texts.some((message) => message.includes(text)), `conversation lacks "${text}" (${texts.length} messages)`);
        return `${summary}, ${texts.length} messages`;
      }
      return summary;
    });
  }

  await check('the public share still serves the conversation', async () => {
    const anonymous = new Session('anonymous');
    const reply = await anonymous.request('GET', state.share.url, undefined, { accept: 'text/html' });
    assert(reply.status === 200, `${state.share.url} → ${reply.status}`);
    assert(reply.text.includes('Second turn: tighten the wording.'), 'the shared page lacks the conversation');
  });

  const vault = `organizationId=${orgId}`;
  const reveal = async (itemId: string, field: string) =>
    str(obj(await owner.call('POST', `/api/vault/items/${itemId}/reveal?${vault}`, { field })).value);
  await check('the vault login\'s password reads back', async () => {
    assert(await reveal(state.vault.login.id, 'password') === state.vault.login.password, 'password differs');
  });
  await check('the vault login\'s TOTP code is right', async () => {
    const reply = obj(await owner.call('POST', `/api/vault/resolve?${vault}`, { itemId: state.vault.login.id, field: 'totp' }));
    const now = Date.now();
    const valid = [now - 30_000, now, now + 30_000].map((at) => totp(state.vault.login.totp, at));
    assert(valid.includes(str(reply.value)), `code ${str(reply.value)} (${str(reply.status)}) is not one of ${valid.join('/')}`);
    return `code ${str(reply.value)}`;
  });
  await check('the vault API key reads back', async () => {
    assert(await reveal(state.vault.apiKey.id, 'secret') === state.vault.apiKey.secret, 'secret differs');
  });
  await check('the vault SSH key reads back', async () => {
    assert(await reveal(state.vault.sshKey.id, 'privateKey') === state.vault.sshKey.privateKey, 'private key differs');
  });
  await check('the card is active with its limit', async () => {
    const cards = arr(await owner.call('GET', `/api/cards?${vault}`)).map(obj);
    const card = cards.find((entry) => str(entry.id) === state.card.id);
    assert(card, 'card missing');
    assert(str(card.status) === 'active' && str(card.last4) === state.card.last4, JSON.stringify(card));
    assert(Number(card.remaining ?? card.available) > 0, `nothing remaining: ${JSON.stringify(card)}`);
    return `…${str(card.last4)}, ${str(card.remaining ?? card.available)} of ${str(card.cap)} cents left`;
  });
  await check('the project secrets are listed', async () => {
    const secrets = arr(obj(await owner.call('GET', `/api/projects/${state.secrets.projectId}/secrets`)).secrets).map(obj);
    for (const name of [state.secrets.env.name, state.secrets.file.name])
      assert(secrets.some((entry) => str(entry.name) === name), `${name} missing`);
  });

  if (process.argv.includes('--resume')) {
    const parked = state.tasks.parked;
    assert(parked, 'no parked task was seeded');
    await check('the parked task resumes on a follow-up and uses its secrets and card', async () => {
      const before = (await conversation(owner, parked.id)).length;
      const { env, file } = state.secrets;
      const answer = [
        `Use PostgreSQL (${phase}).`,
        `@run test "$${env.name}" = "${env.value}"`,
        `@run test "$(cat ${file.path})" = "${file.value}"`,
        '@spend 100 :: rehearsal card check',
      ].join('\n');
      await followUp(owner, parked.id, answer);
      const task = await settle(owner, parked.id, 'the resumed turn to reach Review', atReview, 300_000);
      const texts = await conversation(owner, parked.id);
      const replies = texts.slice(before).join('\n');
      for (const expected of [`test "$${env.name}"`, `test "$(cat ${file.path})"`])
        assert(new RegExp(`ran: ${escape(expected)}.*\\(exit 0\\)`).test(replies), `"${expected}" did not exit 0 in: ${replies.slice(0, 600)}`);
      assert(/spend 100: (granted|approved|ok)/i.test(replies), `the card spend was not granted: ${replies.slice(0, 600)}`);
      state.resumed.push(phase);
      writeState(state);
      return `${describeView(task)}, ${texts.length - before} new messages`;
    });
  }

  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

if (command === 'seed') await seed();
else if (command === 'verify') await verify();
else throw new Error('usage: client.ts seed|verify --app URL --origin URL --state FILE [--phase NAME] [--resume]');
