import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { LoginSandboxes, orderLoginSandboxCandidates, type LoginSandboxRoute } from '../src/agent/login-sandbox.js';
import { computerlessModelNeed } from '../src/agent/computerless.js';
import { claudeToolSurface } from '../src/agent/claude.js';
import { codexToolSurface } from '../src/agent/codex.js';
import { runTurn } from '../src/agent/runtime.js';
import { COMPUTERLESS_TOOL_SCHEMAS } from '../src/agent/tools.js';
import { projectReadiness } from '../src/platform/readiness.js';
import { credPolicyKey } from '../src/platform/credential-sources.js';
import type { AgentAdapter, TurnInput } from '../src/agent/types.js';
import type { World, WorldHandle, WorldProvider, WorldSpec } from '../src/world/types.js';

/** A cloud sandbox provider that records what was asked of it. */
class FakeSandboxes implements WorldProvider {
  readonly parkable = true;
  readonly capabilities = { remote: true, pty: false, snapshots: false, ports: false, networkPolicy: false } as const;
  created: WorldSpec[] = [];
  execs: string[] = [];
  opened = 0; parked: string[] = []; destroyed: string[] = [];
  /** Tests: every exec waits for this first (a pooled sandbox still warming up). */
  gate?: Promise<void>;
  /** Tests: a create returns only after this (the provider has made the sandbox, and it is listed, before it answers). */
  createGate?: Promise<void>;
  /** `killed`: killed in the provider by another process, while this one still holds its connection (E2B's open answers from that). */
  state = new Map<string, 'running' | 'parked' | 'gone' | 'killed'>();
  constructor(readonly kind: string, private dir: string) {}
  private world(handle: WorldHandle): World {
    const id = String(handle.meta?.sandboxId);
    return { handle, exec: async (_cmd: string, args: string[]) => {
      if (this.state.get(id) === 'killed') throw Object.assign(new Error('Sandbox is probably not running anymore'), { name: 'SandboxNotFoundError' });
      this.execs.push(args.join(' ')); await this.gate; return { code: 0, stdout: '', stderr: '' }; },
      destroy: async () => { await this.destroy(handle); } } as unknown as World;
  }
  async create(spec: WorldSpec): Promise<World> {
    this.created.push(spec);
    const id = `${this.kind}-sbx-${this.created.length}`;
    this.state.set(id, 'running');
    await this.createGate;
    return this.world({ kind: this.kind, id: spec.taskId, root: path.join(this.dir, id), branch: 'b', base: spec.base,
      meta: { sandboxId: id }, repos: [] } as WorldHandle);
  }
  async open(handle: WorldHandle): Promise<World> {
    const id = String(handle.meta?.sandboxId);
    if (this.state.get(id) === 'gone') throw new Error('sandbox not found');
    this.opened++;
    if (this.state.get(id) !== 'killed') this.state.set(id, 'running');
    return this.world(handle);
  }
  /** The control plane's answer, as E2BWorldProvider.probe gives it. */
  async probe(handle: WorldHandle): Promise<'ready' | 'parked' | 'missing'> {
    const state = this.state.get(String(handle.meta?.sandboxId));
    return state === 'running' ? 'ready' : state === 'parked' ? 'parked' : 'missing';
  }
  async park(handle: WorldHandle): Promise<WorldHandle> { this.parked.push(String(handle.meta?.sandboxId)); this.state.set(String(handle.meta?.sandboxId), 'parked'); return handle; }
  async destroy(handle: WorldHandle): Promise<void> { this.destroyed.push(String(handle.meta?.sandboxId)); this.state.set(String(handle.meta?.sandboxId), 'gone'); }
  async status(): Promise<'ready'> { return 'ready'; }
}

let dir: string;
let store: Store;
let worlds: WorldRegistry;
let e2b: FakeSandboxes;
let clock: number;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-sandbox-'));
  store = await Store.create(':memory:');
  worlds = new WorldRegistry();
  e2b = new FakeSandboxes('e2b', dir);
  worlds.register(e2b);
  clock = Date.now();
  // The pool has its own test below; elsewhere a claim would make extra sandboxes.
  process.env.KARMAX_LOGIN_SANDBOX_POOL = '0';
});
afterEach(async () => {
  delete process.env.KARMAX_LOGIN_SANDBOX_POOL;
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const routeTo = (candidates: LoginSandboxRoute['candidates'], extra: Partial<LoginSandboxRoute> = {}) =>
  async (): Promise<LoginSandboxRoute> => ({ candidates, ...extra });
const sandboxes = (route = routeTo([{ provider: 'e2b', funding: 'own' }])) =>
  new LoginSandboxes({ store, worlds, route, now: () => clock, pollMs: 20 });

async function taskIn(organizationId: string, title = 'Ask') {
  const project = await store.createProject(`P ${title} ${Math.random()}`, {}, organizationId);
  return store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.0.0',
    params: { prompt: 'hi', computer: { provider: 'none' } } as any });
}

describe('which models a task without a computer runs', () => {
  it('a login runs where there is a computer for its CLI; nowhere, it says so honestly', () => {
    expect(computerlessModelNeed({ provider: 'claude' }, { apiKey: false, login: true, compute: true })).toBeUndefined();
    expect(computerlessModelNeed({ provider: 'codex' }, { apiKey: false, login: true, compute: true })).toBeUndefined();
    const none = computerlessModelNeed({ provider: 'claude' }, { apiKey: false, login: true });
    expect(none).toMatchObject({ fix: 'computer' });
    expect(none!.message).toMatch(/Claude Code login replies from a small cloud computer, and this organization has none it can use/);
    expect(none!.message).not.toMatch(/runs only on a computer/);
    expect(computerlessModelNeed({ provider: 'codex' }, { apiKey: false, login: true, compute: 'its compute credit is spent' })!.message)
      .toMatch(/Codex login .* its compute credit is spent/);
    // Neither a key nor a login: an account is missing, not a computer.
    expect(computerlessModelNeed({ provider: 'claude' }, { apiKey: false })).toMatchObject({ fix: 'key' });
    // An API key still runs host-side; models with neither rail still can't.
    expect(computerlessModelNeed({ provider: 'claude' }, { apiKey: true })).toBeUndefined();
    expect(computerlessModelNeed({ provider: 'kimi' as never }, { apiKey: true, login: true, compute: true })).toMatchObject({ fix: 'model' });
  });
});

describe('the CLI of a task without a computer is offered tavya\'s tools only', () => {
  it('Claude Code: no built-in tool, exactly the computerless platform tools, in-process', () => {
    const surface = claudeToolSurface({ platformOnly: true, remote: true });
    expect(surface.builtIns).toEqual([]);
    expect(surface.stdioPlatform).toBe(false);
    expect(surface.controls.map((tool) => tool.name).sort()).toEqual(COMPUTERLESS_TOOL_SCHEMAS.map((tool) => tool.name).sort());
    expect(claudeToolSurface({ platformOnly: false, remote: true }).builtIns).toBeUndefined();
  });

  it('Codex: the same tools as dynamic tools, its shell and other tools off, a read-only sandbox', () => {
    const surface = codexToolSurface({ platformOnly: true, remote: true });
    expect(surface.dynamicTools.map((tool) => tool.name).sort()).toEqual(COMPUTERLESS_TOOL_SCHEMAS.map((tool) => tool.name).sort());
    expect(surface.flags.join(' ')).toMatch(/features\.shell_tool=false/);
    expect(surface.flags.join(' ')).toMatch(/include_apply_patch_tool=false/);
    expect(surface.sandbox).toBe('read-only');
    expect(codexToolSurface({ platformOnly: false, remote: true }).sandbox).toBe('danger-full-access');
  });

  it('the runtime gives a turn with a machine for its CLI to the adapter\'s CLI rail, not the host-side loop', async () => {
    const none = await new WorldRegistry().create('none', { taskId: 'task_login_runtime', base: 'main' });
    const called: string[] = [];
    const adapter: AgentAdapter = {
      provider: 'claude',
      async runTurn(input) { called.push(`cli:${input.harnessWorld?.handle.kind}`); return { termination: { kind: 'success', status: 'end_turn' }, output: 'cli' }; },
      async runComputerlessTurn() { called.push('host'); return { termination: { kind: 'success', status: 'end_turn' }, output: 'host' }; },
    };
    const sandbox = await e2b.create({ taskId: 'task_login_runtime', base: 'main' });
    const input: TurnInput = { profile: { id: 'p', name: 'p', provider: 'claude', role: 'do', capabilities: [] }, world: none,
      messages: [{ id: 'm', role: 'user', ts: 0, text: 'hi' }], role: 'do', systemPrompt: 's' };
    expect((await runTurn({ ...input, harnessWorld: sandbox }, { adapters: new Map([['claude', adapter]]) })).output).toBe('cli');
    expect((await runTurn(input, { adapters: new Map([['claude', adapter]]) })).output).toBe('host');
    expect(called).toEqual(['cli:e2b', 'host']);
    await none.destroy();
  });
});

describe('login sandboxes', () => {
  it('one per task, kept across its turns: running it is reused, parked after its idle time it resumes, gone it is replaced', async () => {
    const org = await store.createOrganization({ name: 'Reuse' });
    const task = await taskIn(org.id);
    const pool = sandboxes();
    const first = await pool.open({ organizationId: org.id, taskId: task.id });
    expect(first.reused).toBe(false);
    expect(e2b.created).toHaveLength(1);
    // No repository, no setup: a scratch sandbox, labelled apart from the task's own worlds.
    expect(e2b.created[0]).toMatchObject({ taskId: task.id, organizationId: org.id, scratch: true, generation: 0 });
    expect(e2b.created[0]!.repos).toBeUndefined();
    // The template's own size: another would build a template of its own.
    expect(e2b.created[0]!.resources).toBeUndefined();
    await first.settle();
    const second = await pool.open({ organizationId: org.id, taskId: task.id });
    expect(second.reused).toBe(true);
    expect(e2b.created).toHaveLength(1);
    await second.settle();
    // Idle past its time: parked by the sweep, and resumed by the next turn.
    clock += 10 * 60_000;
    expect(await pool.housekeep()).toBe(1);
    expect(e2b.parked).toEqual(['e2b-sbx-1']);
    expect((await pool.entry(task.id))?.state).toBe('parked');
    const third = await pool.open({ organizationId: org.id, taskId: task.id });
    expect(third.reused).toBe(true);
    expect((await pool.entry(task.id))?.state).toBe('running');
    await third.settle();
    // Gone (reaped by the provider): a new one.
    e2b.state.set('e2b-sbx-1', 'gone');
    const fourth = await pool.open({ organizationId: org.id, taskId: task.id });
    expect(fourth.reused).toBe(false);
    expect(e2b.created).toHaveLength(2);
    await fourth.settle();
  });

  it('goes when its task ends, or after a day parked', async () => {
    const org = await store.createOrganization({ name: 'Ends' });
    const ended = await taskIn(org.id, 'Ended');
    const idle = await taskIn(org.id, 'Idle');
    const pool = sandboxes();
    for (const task of [ended, idle]) await (await pool.open({ organizationId: org.id, taskId: task.id })).settle();
    await (store as any).db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ status: 'done' }), ended.id);
    await pool.housekeep();
    expect(await pool.entry(ended.id)).toBeUndefined();
    expect(e2b.destroyed).toContain('e2b-sbx-1');
    clock += 10 * 60_000;
    await pool.housekeep();
    expect((await pool.entry(idle.id))?.state).toBe('parked');
    clock += 25 * 60 * 60_000;
    await pool.housekeep();
    expect(await pool.entry(idle.id)).toBeUndefined();
    expect(e2b.destroyed).toContain('e2b-sbx-2');
  });

  it('an organization runs at most its cap at once; the next waits, first come first served, and says so', async () => {
    const org = await store.createOrganization({ name: 'Capped' });
    await store.setOrganizationUsagePolicy(org.id, { maxLoginSandboxes: 1 } as any);
    const [a, b, c] = [await taskIn(org.id, 'A'), await taskIn(org.id, 'B'), await taskIn(org.id, 'C')];
    const pool = sandboxes();
    const running = await pool.open({ organizationId: org.id, taskId: a.id });
    const told: unknown[] = [];
    const order: string[] = [];
    const second = pool.open({ organizationId: org.id, taskId: b.id, onQueued: (queued) => { told.push(queued); } })
      .then((opened) => { order.push('B'); return opened; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = pool.open({ organizationId: org.id, taskId: c.id }).then((opened) => { order.push('C'); return opened; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual([]);
    expect(told).toEqual([{ inUse: 1, cap: 1, ahead: 0 }]);
    // A's sandbox parks after its turn and idle time: its slot goes to B, then C.
    // (A short idle time: the clock must not jump past the waiters' own leases.)
    process.env.KARMAX_LOGIN_SANDBOX_IDLE_MS = '1000';
    try {
      await running.settle();
      clock += 2_000;
      await pool.housekeep();
      const b1 = await second;
      expect(order).toEqual(['B']);
      await b1.settle();
      clock += 2_000;
      await pool.housekeep();
      await (await third).settle();
      expect(order).toEqual(['B', 'C']);
    } finally { delete process.env.KARMAX_LOGIN_SANDBOX_IDLE_MS; }
    // Another organization is not held back by this one's cap.
    const other = await store.createOrganization({ name: 'Other' });
    await (await pool.open({ organizationId: other.id, taskId: (await taskIn(other.id)).id })).settle();
  });

  it('hosted: an owner may lower the cap, never raise it above the installation\'s', async () => {
    const org = await store.createOrganization({ name: 'Policy' });
    expect((await store.getOrganizationUsagePolicy(org.id)).maxLoginSandboxes).toBe(2);
    (store as { hosted: boolean }).hosted = true;
    try {
      await store.setOrganizationUsagePolicy(org.id, { maxLoginSandboxes: 50 } as any);
      expect((await store.getOrganizationUsagePolicy(org.id)).maxLoginSandboxes).toBe(2);
      await store.setOrganizationUsagePolicy(org.id, { maxLoginSandboxes: 1 } as any);
      expect((await store.getOrganizationUsagePolicy(org.id)).maxLoginSandboxes).toBe(1);
    } finally { (store as { hosted: boolean }).hosted = false; }
  });

  it('books the seconds a provider does not report itself', async () => {
    const daytona = new FakeSandboxes('daytona', dir);
    worlds.register(daytona);
    const org = await store.createOrganization({ name: 'Booked' });
    const task = await taskIn(org.id);
    const pool = sandboxes(routeTo([{ provider: 'daytona', funding: 'managed' }]));
    await (await pool.open({ organizationId: org.id, taskId: task.id })).settle();
    clock += 4 * 60_000;
    await pool.housekeep();
    const rows = await (store as any).db.prepare('SELECT * FROM usage_events WHERE taskId=?').all(task.id) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'daytona', kind: 'world.active', fundingSource: 'managed' });
    expect(Number(rows[0].quantity)).toBeCloseTo(240, 0);
    // E2B reports its own executions: nothing is booked here.
    const other = await taskIn(org.id, 'E2B');
    await (await sandboxes().open({ organizationId: org.id, taskId: other.id })).settle();
    clock += 10 * 60_000;
    await sandboxes().housekeep();
    expect(await (store as any).db.prepare('SELECT * FROM usage_events WHERE taskId=?').all(other.id)).toEqual([]);
  });

  it('keeps a paused sandbox whose CLI already started, ready for the next conversation, while the organization uses them', async () => {
    process.env.KARMAX_LOGIN_SANDBOX_POOL = '1';
    const org = await store.createOrganization({ name: 'Pooled' });
    const pool = sandboxes();
    const first = await taskIn(org.id, 'First');
    await (await pool.open({ organizationId: org.id, taskId: first.id })).settle();
    // The first conversation made one, and refills the pool beside it: warmed, then paused.
    await expect.poll(() => e2b.parked.length).toBe(1);
    const pooledId = e2b.parked[0]!;
    expect(e2b.created.at(-1)!.taskId).toMatch(/^login-pool-/);
    expect(e2b.execs.some((command) => /-p hi/.test(command))).toBe(true);
    // The reaper spares the pooled sandbox, though no task carries its label.
    expect(await pool.protects(e2b.created.at(-1)!.taskId)).toBe(true);
    // The next conversation claims it (resumed, no new sandbox), and the pool refills again.
    const second = await taskIn(org.id, 'Second');
    const opened = await pool.open({ organizationId: org.id, taskId: second.id });
    expect((opened.world.handle.meta as { sandboxId?: string }).sandboxId).toBe(pooledId);
    expect(await pool.protects(e2b.created[1]!.taskId, (handle) => handle.meta?.sandboxId === pooledId)).toBe(true);
    await opened.settle();
    await expect.poll(() => e2b.created.length).toBe(3);
    // An organization that stopped using them loses its pool.
    clock += 2 * 24 * 60 * 60_000;
    await pool.housekeep();
    expect(e2b.destroyed).toContain('e2b-sbx-3');
  });

  it('a pooled sandbox still warming up is not claimed: the conversation gets its own, and the pooled one stays parked', async () => {
    process.env.KARMAX_LOGIN_SANDBOX_POOL = '1';
    process.env.KARMAX_LOGIN_SANDBOXES_PER_ORG = '3';
    const org = await store.createOrganization({ name: 'Warming' });
    const pool = sandboxes();
    let release!: () => void;
    e2b.gate = new Promise((resolve) => { release = resolve; });
    await (await pool.open({ organizationId: org.id, taskId: (await taskIn(org.id, 'First')).id })).settle();
    await expect.poll(() => e2b.created.length).toBe(2);
    const warming = String((e2b.created.at(-1) as WorldSpec).taskId);
    const second = await pool.open({ organizationId: org.id, taskId: (await taskIn(org.id, 'Second')).id });
    expect(second.world.handle.id).not.toBe(warming);
    release();
    await expect.poll(() => e2b.parked.length).toBe(1);
    await second.settle();
    // Warmed and parked, it is claimable now.
    const third = await pool.open({ organizationId: org.id, taskId: (await taskIn(org.id, 'Third')).id });
    expect(third.world.handle.id).toBe(warming);
    await third.settle();
    delete process.env.KARMAX_LOGIN_SANDBOXES_PER_ORG;
  });

  it('tries the fastest first (measured 2026-11-19: E2B, Fly.io, Agent37, then Daytona), the organization\'s own accounts before managed ones', () => {
    // As the compute router ranks them: own first, then by price.
    expect(orderLoginSandboxCandidates([
      { provider: 'daytona', funding: 'own' }, { provider: 'e2b', funding: 'own' },
      { provider: 'agent37', funding: 'managed' }, { provider: 'fly', funding: 'managed' }, { provider: 'e2b', funding: 'managed' },
    ])).toEqual([
      { provider: 'e2b', funding: 'own' }, { provider: 'daytona', funding: 'own' },
      { provider: 'e2b', funding: 'managed' }, { provider: 'fly', funding: 'managed' }, { provider: 'agent37', funding: 'managed' },
    ]);
  });

  it('on a VM that stops in seconds (Agent37, Fly.io) it parks and pools as on E2B; on Daytona an idle one is deleted', async () => {
    process.env.KARMAX_LOGIN_SANDBOX_POOL = '1';
    for (const kind of ['agent37', 'fly']) {
      const vm = new FakeSandboxes(kind, dir);
      worlds.register(vm);
      const org = await store.createOrganization({ name: `VM ${kind}` });
      const pool = sandboxes(routeTo([{ provider: kind, funding: 'managed' }]));
      const task = await taskIn(org.id);
      await (await pool.open({ organizationId: org.id, taskId: task.id })).settle();
      // A stopped machine waits for the next conversation (only its disk is billed): a small disk.
      await expect.poll(() => vm.parked.length).toBe(1);
      expect(vm.created.map((spec) => spec.resources)).toEqual([{ diskGb: 5 }, { diskGb: 5 }]);
      expect(vm.created.at(-1)!.taskId).toMatch(/^login-pool-/);
      clock += 10 * 60_000;
      await pool.housekeep();
      expect((await pool.entry(task.id))?.state).toBe('parked');
      expect(vm.destroyed).toEqual([]);
    }
    const daytona = new FakeSandboxes('daytona', dir);
    worlds.register(daytona);
    const org = await store.createOrganization({ name: 'Daytona' });
    const pool = sandboxes(routeTo([{ provider: 'daytona', funding: 'own' }]));
    const task = await taskIn(org.id);
    await (await pool.open({ organizationId: org.id, taskId: task.id })).settle();
    clock += 10 * 60_000;
    await pool.housekeep();
    expect(await pool.entry(task.id)).toBeUndefined();
    expect(daytona.destroyed).toEqual(['daytona-sbx-1']);
    expect(daytona.parked).toEqual([]);
  });

  it('the orphan reaper never finds one being made unrecorded: it waits for the record (tavya-error 392322d5fc85238d)', async () => {
    // Production, 2026-11-20 22:22:05.9: a computerless task's new E2B login sandbox was listed by the lifecycle
    // sweep before its entry was saved, judged a "duplicate" of the task's `none` world and killed 0.6 s after it was made.
    process.env.KARMAX_LOGIN_SANDBOX_POOL = '1';
    const org = await store.createOrganization({ name: 'Racing' });
    const task = await taskIn(org.id);
    const pool = sandboxes();
    // The reaper's judgement, as WorldLifecycleManager.reapOrphanSandboxes makes it: under the label's operation lock.
    const reaperSpares = (label: string, sandboxId: string) =>
      worlds.withOperation(label, () => pool.protects(label, (handle) => handle.meta?.sandboxId === sandboxId));
    let made!: () => void;
    e2b.createGate = new Promise((resolve) => { made = resolve; });
    const opening = pool.open({ organizationId: org.id, taskId: task.id });
    await expect.poll(() => e2b.created.length).toBe(1);
    // Made in the provider (so listed), its create not answered yet: the reaper looks now.
    const spared = reaperSpares(task.id, 'e2b-sbx-1');
    made();
    expect(await spared).toBe(true);
    const opened = await opening;
    // The pool's refill, made the same way, is spared the same way.
    await expect.poll(() => e2b.created.length).toBe(2);
    const label = String(e2b.created[1]!.taskId);
    e2b.createGate = undefined;
    expect(await reaperSpares(label, 'e2b-sbx-2')).toBe(true);
    await opened.settle();
    await expect.poll(() => e2b.parked.length).toBe(1);
    // A claim moves a pooled sandbox from the pool to its task: the reaper looking meanwhile still spares it.
    const second = await taskIn(org.id, 'Second');
    let claimed!: () => void;
    const claiming = new Promise<void>((resolve) => { claimed = resolve; });
    const kvSet = store.kvSet.bind(store);
    (store as any).kvSet = async (key: string, value: string) => {
      // The moment the pooled sandbox has left the pool, before its task's entry exists.
      if (key.startsWith('login-sandbox-owner:')) { claimed(); await new Promise((resolve) => setTimeout(resolve, 50)); }
      return kvSet(key, value);
    };
    const claim = pool.open({ organizationId: org.id, taskId: second.id });
    await claiming;
    expect(await reaperSpares(label, 'e2b-sbx-2')).toBe(true);
    (store as any).kvSet = kvSet;
    expect((await claim).world.handle.id).toBe(label);
    expect(e2b.destroyed).toEqual([]);
  });

  it('one lost under a turn is forgotten when the turn fails, so the retry gets a new one instead of the dead one for ever', async () => {
    const org = await store.createOrganization({ name: 'Lost' });
    const task = await taskIn(org.id);
    const pool = sandboxes();
    const first = await pool.open({ organizationId: org.id, taskId: task.id });
    // Killed in the provider (reaped by another process, expired, an outage), while this process still holds a connection to it.
    e2b.state.set('e2b-sbx-1', 'killed');
    const failure = await first.world.exec('bash', ['-c', 'true']).catch((error: unknown) => error);
    await first.settle(failure);
    expect(await pool.entry(task.id)).toBeUndefined();
    const retry = await pool.open({ organizationId: org.id, taskId: task.id });
    expect(retry.reused).toBe(false);
    expect(e2b.created).toHaveLength(2);
    await retry.settle();
    // A turn that failed with its sandbox alive keeps it.
    const third = await pool.open({ organizationId: org.id, taskId: task.id });
    await third.settle(new Error('the model refused'));
    expect(third.reused).toBe(true);
    expect((await pool.entry(task.id))?.handle.meta?.sandboxId).toBe('e2b-sbx-2');
    // So does one whose provider cannot say (no control-plane probe).
    const probe = e2b.probe;
    (e2b as any).probe = undefined;
    const fourth = await pool.open({ organizationId: org.id, taskId: task.id });
    await fourth.settle(new Error('lost'));
    (e2b as any).probe = probe;
    expect(await pool.entry(task.id)).toBeDefined();
  });

  it('the orphan reaper spares a live task\'s login sandbox, and only that one', async () => {
    const org = await store.createOrganization({ name: 'Reaper' });
    const task = await taskIn(org.id);
    const pool = sandboxes();
    await (await pool.open({ organizationId: org.id, taskId: task.id })).settle();
    const entry = (await pool.entry(task.id))!;
    expect(await pool.protects(task.id, (handle) => handle.meta?.sandboxId === entry.handle.meta?.sandboxId)).toBe(true);
    expect(await pool.protects(task.id, () => false)).toBe(false);
    expect(await pool.protects('task_unknown')).toBe(false);
  });
});

describe('a turn of a task without a computer on a subscription login', () => {
  async function setup(hosted: boolean, route: () => Promise<LoginSandboxRoute>) {
    const org = await store.createOrganization({ name: `Turn ${hosted} ${Math.random()}` });
    const project = await store.createProject(`Assistant ${Math.random()}`, { worldProvider: 'none' } as any, org.id);
    const task = await store.createTask({ projectId: project.id, title: 'Ask', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'hi', computer: { provider: 'none' } } as any });
    const configHomes = new ConfigHomeManager(path.join(dir, 'homes'));
    const home = configHomes.ensure('claude', 'subscription', org.id);
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
    const captured: TurnInput[] = [];
    const adapters = new Map<any, any>([['claude', {
      provider: 'claude',
      async runTurn(input: TurnInput) {
        captured.push(input);
        // As the CLI's start does (seedRemoteAgentHome's bootstrap): a dead sandbox fails it.
        if (input.harnessWorld && input.harnessWorld !== input.world) await input.harnessWorld.exec('true', []);
        return { termination: { kind: 'success', status: 'end_turn' }, output: 'done' }; },
      async runComputerlessTurn() { throw new Error('a login never runs host-side'); },
    }]]);
    (store as { hosted: boolean }).hosted = hosted;
    const none = await worlds.create('none', { taskId: task.id, base: 'main' });
    const pool = new LoginSandboxes({ store, worlds, route, now: () => clock, pollMs: 20 });
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const core = makeCoreActivities({ store, worlds, adapters, configHomes, broker, loginSandboxes: pool,
      profiles: new ProfileResolver(store, 'claude') });
    const turn = (n: number) => core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#${n}`, agentSlotGranted: true,
      worldHandle: none.handle, messages: [{ id: `m${n}`, role: 'user', text: 'What is waiting on me?', ts: 0 }],
      task: { taskId: task.id, projectId: project.id, title: 'Ask', prompt: 'hi', project: { worldProvider: 'none' }, workflow: 'software-dev',
        agents: { do: { provider: 'claude', model: 'claude-opus-5-5' } } },
      accountConfigHome: home, accountCredentialKind: 'login' } as any);
    const login = `login:${org.id}:claude:subscription`;
    return { org, project, task, home, captured, none, pool, core, turn, login };
  }
  afterEach(() => { (store as { hosted: boolean }).hosted = false; });

  it('hosted: runs the login\'s CLI in the task\'s login sandbox, the same one turn after turn', async () => {
    const { captured, none, pool, task, turn } = await setup(true, routeTo([{ provider: 'e2b', funding: 'managed' }]));
    await turn(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.world.handle.kind).toBe('none');
    expect(captured[0]!.harnessWorld?.handle.kind).toBe('e2b');
    expect(captured[0]!.resolvedAuth?.configHome).toBeTruthy();
    expect(captured[0]!.resolvedAuth?.apiKey).toBeUndefined();
    // No MCP servers and no work environment, as any task without a computer.
    expect(captured[0]!.agentMcp).toEqual([]);
    await turn(2);
    expect(captured[1]!.harnessWorld?.handle.kind).toBe('e2b');
    expect(e2b.created).toHaveLength(1);
    // The turn is over: the sandbox stays, idle, until the sweep parks it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await pool.entry(task.id))?.busyUntil).toBeUndefined();
    await none.destroy();
  });

  it('hosted: a turn whose login sandbox was lost fails once; its retry runs in a new one (tavya-error 392322d5fc85238d)', async () => {
    const { captured, none, pool, task, turn } = await setup(true, routeTo([{ provider: 'e2b', funding: 'managed' }]));
    await turn(1);
    // Killed by another process while this worker keeps its connection: every call into it fails.
    e2b.state.set('e2b-sbx-1', 'killed');
    await expect(turn(2)).rejects.toThrow(/not running anymore/);
    // The activity's retry, and every later turn, get a sandbox that runs.
    await expect.poll(async () => (await pool.entry(task.id))?.handle.meta?.sandboxId).not.toBe('e2b-sbx-1');
    await turn(2);
    expect(captured.at(-1)!.harnessWorld?.handle.meta?.sandboxId).toBe('e2b-sbx-2');
    expect(e2b.created).toHaveLength(2);
    await none.destroy();
  });

  it('self-hosted: runs the CLI on this machine, no sandbox', async () => {
    const { captured, none, turn } = await setup(false, routeTo([{ provider: 'e2b' }]));
    await turn(1);
    expect(captured[0]!.harnessWorld).toBe(captured[0]!.world);
    expect(captured[0]!.world.handle.kind).toBe('none');
    expect(e2b.created).toHaveLength(0);
    await none.destroy();
  });

  it('hosted with no computer to run it in: refuses before any machine or model, saying why', async () => {
    const { captured, none, turn } = await setup(true, routeTo([], { reason: 'this organization has no cloud computer to run it in' }));
    await expect(turn(1)).rejects.toThrow(/Claude Code login replies from a small cloud computer, and this organization has no cloud computer/);
    expect(captured).toHaveLength(0);
    expect(e2b.created).toHaveLength(0);
    await none.destroy();
  });

  it('the credential order offers the login where its CLI can run, and only a key where it cannot', async () => {
    const withCompute = await setup(true, routeTo([{ provider: 'e2b' }]));
    await store.kvSet(credPolicyKey.organization(withCompute.org.id), JSON.stringify({ order: [withCompute.login], on: [withCompute.login] }));
    const ask = (s: typeof withCompute) => s.core.resolveCredentialOrder({ taskId: s.task.id, projectId: s.project.id, provider: 'claude', role: 'do',
      task: { projectId: s.project.id, project: { worldProvider: 'none' }, agents: { do: { provider: 'claude' } } } } as any);
    expect(await ask(withCompute)).toEqual([withCompute.login]);
    const without = await setup(true, routeTo([], { reason: 'none' }));
    await store.kvSet(credPolicyKey.organization(without.org.id), JSON.stringify({ order: [without.login], on: [without.login] }));
    expect(await ask(without)).toEqual([]);
  });
});

describe('readiness of a task without a computer on a login', () => {
  it('ready where its CLI can run; otherwise the fix is a computer, not "pick another model"', async () => {
    const org = await store.createOrganization({ name: 'Ready' });
    const configHomes = new ConfigHomeManager(path.join(dir, 'homes'));
    const home = configHomes.ensure('claude', 'subscription', org.id);
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
    const agent = { provider: 'claude' as const, model: 'claude-opus-5-5' };
    const ask = (hosted: boolean, route: () => Promise<LoginSandboxRoute>) => projectReadiness({ store, hosted, configHomes,
      loginSandboxes: new LoginSandboxes({ store, worlds, route }) }, { organizationId: org.id }, [agent], { computerless: true });
    const ready = (await ask(true, routeTo([{ provider: 'e2b' }]))).agents[0]!;
    expect(ready).toMatchObject({ ready: true, sandbox: true });
    // Every computer full right now: it still starts, and waits for one.
    expect((await ask(true, routeTo([], { busy: 'all 2 in use' }))).agents[0]!.ready).toBe(true);
    const none = (await ask(true, routeTo([], { reason: 'this organization has no cloud computer to run it in' }))).agents[0]!;
    expect(none.ready).toBe(false);
    expect(none.need).toMatchObject({ provider: 'claude', computerlessFix: 'computer' });
    expect(none.need?.computerless).toMatch(/no cloud computer/);
    // Self-hosted: this machine runs it.
    expect((await ask(false, routeTo([]))).agents[0]!).toMatchObject({ ready: true });
  });
});
