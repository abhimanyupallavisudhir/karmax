// Compute holds (wiki features/managed-compute § Holds): managed work reserves
// its machine's next minutes against the organization's credit before it runs,
// renews them while it runs, and is stopped and parked when they run out.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { COMPUTE_HOLD, ComputeCreditExhausted, assertComputeCredit, computeCredit, holdManagedCompute, listRate,
  machineRate } from '../src/world/managed-compute.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { WorldRegistry } from '../src/world/registry.js';
import { hadLiveWorldWork, hasLiveWorldWork } from '../src/domain/view-publication.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { startJob, stopJobs } from '../src/world/jobs.js';
import type { World } from '../src/world/types.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const T = Date.UTC(2026, 9, 15, 12);
const MIN = 60_000;
/** 64 vCPU / 128 GB on AWS: $2.861 an hour at list price, $5.722 at tavya's. */
const BIG = { cpu: 64, memoryMb: 131_072, diskGb: 0 };
const BIG_HOUR = 2_861_000;

async function fixture() {
  const store = await Store.create(':memory:', { hosted: true });
  cleanups.push(() => store.close());
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  await store.setOrganizationPlan(organization.id, 'individual');
  const project = await store.createProject('Cloud', { worldProvider: 'aws' }, organization.id);
  const task = async (title = 'Run') => store.createTask({ projectId: project.id, title, workflow: 'just-do', workflowVersion: '1.0.0',
    params: { prompt: title } as any });
  const hold = (id: string, taskId: string, now = T) => holdManagedCompute(store, { id, organizationId: organization.id, taskId,
    provider: 'aws', purpose: 'turn', shape: BIG }, now);
  /** Usage as the provider's feed books it. */
  const book = (id: string, taskId: string | undefined, costMicros: number, startedAt: number, endedAt: number,
    kind: 'world.active' | 'world.disk' = 'world.active', metadata?: Record<string, unknown>) =>
    store.recordUsage({ id: `usage:aws:${id}`, organizationId: organization.id, ...(taskId ? { taskId, worldId: taskId } : {}),
      provider: 'aws', kind, quantity: (endedAt - startedAt) / 1000, unit: 'second', costMicros, startedAt, endedAt,
      fundingSource: 'managed', ...(metadata ? { metadata } : {}) });
  return { store, organization, project, task, hold, book };
}

describe('compute holds', () => {
  it('reserve the next minutes of a machine, take what fits, and refuse when the first minutes do not', async () => {
    const f = await fixture();
    expect(listRate('aws', BIG)).toEqual({ activeMicrosPerHour: BIG_HOUR, diskMicrosPerHour: 0 });
    const [a, b, c, d, e] = await Promise.all([1, 2, 3, 4, 5].map((n) => f.task(`T${n}`)));
    expect(await f.hold('a', a!.id)).toBe(T + 15 * MIN);
    expect(await computeCredit(f.store, f.organization.id, T)).toMatchObject({ creditMicros: 5_000_000, usedMicros: 0,
      heldMicros: 1_430_500, availableMicros: 3_569_500 });
    expect(await f.hold('b', b!.id)).toBe(T + 15 * MIN);
    expect(await f.hold('c', c!.id)).toBe(T + 15 * MIN);
    // $0.7085 left covers 7.4 of this machine's minutes: enough to start.
    const partly = await f.hold('d', d!.id);
    expect(partly - T).toBeGreaterThan(7 * MIN);
    expect(partly - T).toBeLessThan(7.5 * MIN);
    expect((await computeCredit(f.store, f.organization.id, T)).availableMicros).toBeLessThanOrEqual(0);
    const refused = await f.hold('e', e!.id).catch((error) => error);
    expect(refused).toBeInstanceOf(ComputeCreditExhausted);
    expect(refused.message).toMatch(/^Out of compute: this month's \$5\.00 of compute is used up or held by work running now\. Add a compute pack or turn on auto top-up in Plan & billing/);
    expect(await f.store.computeHold('e')).toBeUndefined();
    expect(JSON.parse((await f.store.kvGet(`compute-short:${f.organization.id}`))!)).toMatchObject({ neededMicros: 1_430_500 });
  });

  it('are released as the provider books the usage they covered, or two hours after they end', async () => {
    const f = await fixture();
    const [a, b] = [await f.task('A'), await f.task('B')];
    await f.hold('a', a.id);
    await f.hold('b', b.id);
    // A's turn ended after ten minutes, B's after one; nothing is booked yet.
    await f.store.closeComputeHold('a', T + 10 * MIN);
    await f.store.closeComputeHold('b', T + MIN);
    const tenMinutes = Math.round(BIG_HOUR / 6);
    expect((await computeCredit(f.store, f.organization.id, T + 20 * MIN)).heldMicros).toBe(2 * Math.round(BIG_HOUR * 11 / 60));
    // The feed books A's ten minutes: they are used, no longer held.
    await f.book('a', a.id, tenMinutes, T, T + 10 * MIN);
    expect(await computeCredit(f.store, f.organization.id, T + 20 * MIN)).toMatchObject({ usedMicros: 2 * tenMinutes,
      heldMicros: 2 * Math.round(BIG_HOUR / 60) });
    // B's minute was never booked: it stops counting two hours after it ended.
    expect((await computeCredit(f.store, f.organization.id, T + MIN + 2 * 60 * MIN + 1)).heldMicros).toBe(0);
    // A booked full hour (Hetzner bills the started hour) releases a hold inside it.
    await f.hold('a2', a.id, T + 30 * MIN);
    await f.book('a-hour', a.id, BIG_HOUR, T + 30 * MIN, T + 90 * MIN);
    // (What is still held is B's unbooked minute.)
    expect((await computeCredit(f.store, f.organization.id, T + 31 * MIN)).heldMicros).toBe(2 * Math.round(BIG_HOUR / 60));
  });

  it('renew as far as the credit goes, and keep their end when nothing more fits', async () => {
    const f = await fixture();
    const a = await f.task('A');
    expect(await f.hold('a', a.id)).toBe(T + 15 * MIN);
    expect(await f.hold('a', a.id, T + 10 * MIN)).toBe(T + 25 * MIN);
    // Usage elsewhere leaves this hold $0.5722 more: six minutes.
    const other = await f.task('Other');
    const charge25 = 2 * Math.round(BIG_HOUR * 25 / 60);
    await f.book('other', other.id, (5_000_000 - charge25 - 572_200) / 2, T - 60 * MIN, T - 30 * MIN);
    expect(await f.hold('a', a.id, T + 20 * MIN)).toBeCloseTo(T + 31 * MIN, -3);
    // Nothing more: the hold keeps its end, and is not refused.
    expect(await f.hold('a', a.id, T + 26 * MIN)).toBeCloseTo(T + 31 * MIN, -3);
  });

  it('let two turns of one organization never both take its last minutes', async () => {
    const f = await fixture();
    const [a, b, c] = [await f.task('A'), await f.task('B'), await f.task('C')];
    // $1.5305 left: one 15-minute hold ($1.4305) and one minute.
    await f.book('earlier', c.id, (5_000_000 - 1_530_500) / 2, T - 60 * MIN, T - 30 * MIN);
    const results = await Promise.allSettled([f.hold('a', a.id), f.hold('b', b.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ComputeCreditExhausted);
  });

  it('price a machine by what its provider last booked for it at this size, else its list price', async () => {
    const f = await fixture();
    const a = await f.task('A');
    const shape = { cpu: 2, memoryMb: 4096, diskGb: 100 };
    expect(await machineRate(f.store, { organizationId: f.organization.id, taskId: a.id, provider: 'aws', shape }, T))
      .toEqual(listRate('aws', shape));
    await f.book('run', a.id, 5_710, T - 600_000, T - 600_000 + 202_000, 'world.active', { cpu: 2, memoryMb: 4096 });
    await f.book('disk', a.id, 13_000, T - 3_600_000, T, 'world.disk', { diskGb: 100 });
    expect(await machineRate(f.store, { organizationId: f.organization.id, taskId: a.id, provider: 'aws', shape }, T))
      .toEqual({ activeMicrosPerHour: Math.ceil(5_710 / 202 * 3600), diskMicrosPerHour: 13_000 });
    // A machine resized since: its list price until the provider books the new size.
    expect((await machineRate(f.store, { organizationId: f.organization.id, taskId: a.id, provider: 'aws', shape: { ...shape, cpu: 8 } }, T))
      .activeMicrosPerHour).toBe(listRate('aws', { ...shape, cpu: 8 }).activeMicrosPerHour);
  });

  it('start a new machine only if its first minutes fit', async () => {
    const f = await fixture();
    const a = await f.task('A');
    await f.book('earlier', a.id, (5_000_000 - 400_000) / 2, T - 60 * MIN, T - 30 * MIN);
    // $0.40 left: a small machine's five minutes fit, the big one's ($0.4768) do not.
    await expect(assertComputeCredit(f.store, f.organization.id, 'aws', T, { shape: { cpu: 2, memoryMb: 4096 } })).resolves.toBeUndefined();
    await expect(assertComputeCredit(f.store, f.organization.id, 'aws', T, { shape: BIG })).rejects.toBeInstanceOf(ComputeCreditExhausted);
  });
});

describe('a turn that outlives its hold', () => {
  it('is stopped where the credit ends, waits as Out of compute, and continues its session once there is credit', async () => {
    vi.stubEnv('KARMAX_AGENT_PROVIDER', 'mock');
    const saved = { ...COMPUTE_HOLD };
    Object.assign(COMPUTE_HOLD, { windowMs: 4_000, renewBeforeMs: 1_000, minStartMs: 500 });
    cleanups.push(() => { Object.assign(COMPUTE_HOLD, saved); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    const f = await fixture();
    const task = await f.task('Long');
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    cleanups.push(() => world.destroy());
    // The machine costs $3.60 an hour ($7.20 at tavya's prices): $0.006 left is three seconds of it.
    await f.store.recordUsage({ id: 'usage:memory:earlier', organizationId: f.organization.id, taskId: task.id, worldId: task.id,
      provider: 'memory', kind: 'world.active', quantity: 3600, unit: 'second', costMicros: 3_600_000,
      startedAt: Date.now() - 2 * 3_600_000, endedAt: Date.now() - 3_600_000, fundingSource: 'managed' });
    // $5 + a $10 gift, of which $7.20 used here and the rest elsewhere but $0.006.
    await f.store.setComputePackGift(f.organization.id, 1, 'operator');
    const used = 2 * 3_600_000;
    await f.store.recordUsage({ id: 'usage:memory:other', organizationId: f.organization.id, provider: 'memory', kind: 'world.active',
      quantity: 1, unit: 'second', costMicros: (15_000_000 - used - 6_000) / 2, startedAt: Date.now() - 3_600_000,
      endedAt: Date.now() - 3_599_000, fundingSource: 'managed' });
    vi.spyOn(Context, 'current').mockImplementation(() => ({ info: { attempt: 1, activityId: 'turn', workflowExecution: { runId: 'run' } },
      cancellationSignal: new AbortController().signal, heartbeat: () => {} }) as any);
    const sessions: Array<string | undefined> = [];
    const prompts: string[] = [];
    const runTurn = vi.fn(async (input: any, ctx: any) => {
      sessions.push(input.session);
      prompts.push(input.messages.map((m: any) => m.text).join('\n'));
      if (runTurn.mock.calls.length > 1) return { termination: { kind: 'success', status: 'end_turn' }, output: 'done', session: input.session };
      await ctx.onSession?.('session-long');
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      throw ctx.signal.reason;
    });
    const core = makeCoreActivities({ store: f.store, worlds, adapters: new Map([['mock', { provider: 'mock', runTurn }]]) as any,
      profiles: new ProfileResolver(f.store, 'mock') });
    const handle = { ...world.handle, meta: { ...world.handle.meta, funding: 'managed' } };
    const args = (turn: string) => ({ taskId: task.id, role: 'do', agentTurnId: turn, agentSlotGranted: true, agentAdmissionManaged: true,
      worldHandle: handle, session: 'session-before', deliveredMessages: 0,
      messages: [{ id: 'm0', role: 'user', text: 'Build it all', ts: 0 }],
      task: { taskId: task.id, projectId: f.project.id, title: task.title, prompt: 'work', project: {}, workflow: 'just-do',
        agents: { do: { provider: 'mock' } } } }) as any;

    const started = Date.now();
    const stopped = await core.runAgentTurn(args('turn-1')).catch((error) => error);
    expect(stopped).toMatchObject({ type: 'world-capacity', nonRetryable: true });
    expect(stopped.message).toMatch(/^Out of compute: /);
    // Stopped where its hold ended (about three seconds of credit), not run on.
    expect(Date.now() - started).toBeLessThan(8_000);
    expect((await f.store.eventsOfType(task.id, 'agent.activity')).map((event) => event.payload))
      .toContainEqual(expect.objectContaining({ phase: 'stopped', title: 'Out of compute' }));
    expect(await f.store.computeHold('turn:turn-1')).toMatchObject({ closedAt: expect.any(Number) });

    // Until there is credit, the next turn waits without touching the world.
    await expect(core.runAgentTurn(args('turn-2'))).rejects.toMatchObject({ type: 'world-capacity' });
    expect(runTurn).toHaveBeenCalledTimes(1);
    await f.store.setComputePackGift(f.organization.id, 2, 'operator');
    const resumed = await core.runAgentTurn(args('turn-3'));
    expect(resumed.output).toBe('done');
    expect(sessions).toEqual(['session-before', 'session-long']);
    expect(prompts[1]).toMatch(/stopped because the organization's compute credit ran out/);
    expect((await f.store.eventsOfType(task.id, 'turn.resumed')).map((event) => event.payload)).toContainEqual({ role: 'do', reason: 'compute' });
  }, 30_000);
});

describe('waiting for compute credit', () => {
  it('parks the world, unlike other retries', () => {
    const outOfCompute = { waitingFor: { kind: 'retry', summary: 'Out of compute', detail: 'Out of compute: …' } } as any;
    const machine = { waitingFor: { kind: 'retry', summary: 'Waiting for a machine' } } as any;
    expect(hasLiveWorldWork(outOfCompute)).toBe(false);
    expect(hasLiveWorldWork(machine)).toBe(true);
    // Workflow histories from before keep their decision.
    expect(hadLiveWorldWork(outOfCompute)).toBe(true);
  });
});

describe('a VM world resized to a bigger machine', () => {
  it('holds at the size it now runs at, not the size it was made at', async () => {
    // Production, 2026-10-29: a Hetzner world made at 2 vCPU and moved to 4
    // kept `meta.machine` at 2 vCPU, so its holds reserved half its rate.
    vi.stubEnv('KARMAX_AGENT_PROVIDER', 'mock');
    cleanups.push(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    const f = await fixture();
    const task = await f.task('Resized');
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    cleanups.push(() => world.destroy());
    const booked = (id: string, cpu: number, memoryMb: number, costMicros: number, endedAt: number) => f.store.recordUsage({
      id: `usage:memory:${id}`, organizationId: f.organization.id, taskId: task.id, worldId: task.id, provider: 'memory',
      kind: 'world.active', quantity: 3600, unit: 'second', costMicros, startedAt: endedAt - 3_600_000, endedAt,
      fundingSource: 'managed', metadata: { cpu, memoryMb } });
    await booked('small', 2, 4096, 44_226, Date.now() - 30 * MIN);
    await booked('big', 4, 8192, 79_911, Date.now() + 30 * MIN);
    await f.store.setComputePackGift(f.organization.id, 1, 'operator');
    vi.spyOn(Context, 'current').mockImplementation(() => ({ info: { attempt: 1, activityId: 'turn', workflowExecution: { runId: 'run' } },
      cancellationSignal: new AbortController().signal, heartbeat: () => {} }) as any);
    const runTurn = vi.fn(async (input: any) => ({ termination: { kind: 'success', status: 'end_turn' }, output: 'done', session: input.session }));
    const core = makeCoreActivities({ store: f.store, worlds, adapters: new Map([['mock', { provider: 'mock', runTurn }]]) as any,
      profiles: new ProfileResolver(f.store, 'mock') });
    const handle = { ...world.handle, meta: { ...world.handle.meta, funding: 'managed',
      machine: { cpu: 2, memoryMb: 4096, diskGb: 50 }, computer: { cpu: 4, memoryMb: 8192, diskGb: 50 } } };
    await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: 'turn-big', agentSlotGranted: true, agentAdmissionManaged: true,
      worldHandle: handle, session: 'session', deliveredMessages: 0, messages: [{ id: 'm0', role: 'user', text: 'Go', ts: 0 }],
      task: { taskId: task.id, projectId: f.project.id, title: task.title, prompt: 'work', project: {}, workflow: 'just-do',
        agents: { do: { provider: 'mock' } } } } as any);
    expect(await f.store.computeHold('turn:turn-big')).toMatchObject({ activeMicrosPerHour: 79_911, closedAt: expect.any(Number) });
  }, 30_000);
});

describe('a job wait on managed compute', () => {
  it('holds at the size the world is registered at, not the size its handle was given at', async () => {
    // Production, 2026-10-29: a job wait on a 50 GB Hetzner world held 20 GB
    // of disk (the provider's default), since the handle it was given named no size.
    const f = await fixture();
    const task = await f.task('Jobs');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-jobhold-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-jobhold-repo-'));
    cleanups.push(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    const local = await new WorktreeProvider(home).create({ taskId: task.id, repo, base: 'main', target: 'main' });
    cleanups.push(async () => { await stopJobs(local); });
    const machine = { cpu: 4, memoryMb: 8192, diskGb: 50 };
    const handle = { ...local.handle, kind: 'hetzner', version: 2, meta: { ...local.handle.meta, funding: 'managed' } } as any;
    await f.store.registerWorld({ ...handle, meta: { ...handle.meta, machine, computer: machine } }, f.project.id);
    const world = new Proxy(local, { get(target, key) {
      if (key === 'handle') return handle;
      const value = (target as any)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as World;
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'hetzner', capabilities: { remote: true }, async create() { throw new Error('unused'); },
      async open() { return world; }, async destroy() {} } as any);
    await f.store.setComputePackGift(f.organization.id, 1, 'operator');
    vi.spyOn(Context, 'current').mockImplementation(() => ({ cancellationSignal: new AbortController().signal, heartbeat() {},
      info: { attempt: 1, activityId: '7', workflowExecution: { workflowId: task.id, runId: 'run' } } } as any));
    cleanups.push(() => { vi.restoreAllMocks(); });
    const core = makeCoreActivities({ store: f.store, worlds, adapters: new Map() as any, profiles: new ProfileResolver(f.store, 'mock') });
    const job = await startJob(local, { command: 'sleep 30', name: 'build' });
    await core.awaitJobs(handle, [job.id], Date.now() + 1_500);
    expect(await f.store.computeHold(`jobs:${task.id}:run:7`)).toMatchObject({ purpose: 'jobs', provider: 'hetzner',
      ...listRate('hetzner', machine), closedAt: expect.any(Number) });
  }, 30_000);
});
