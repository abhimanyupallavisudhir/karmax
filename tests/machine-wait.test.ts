// A task whose runner lease is queued says it waits for a machine: its place,
// what is full and where, on its page and in lists, whichever caller asked
// for the lease (wiki incidents/lessons, Worlds 2026-11-04: every
// org_personal task waited 12 h for a lease while their pages read "Starting
// agent" or "Setup", and Confirm timed out).
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { RunnerPoolService } from '../src/world/runners.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { ProviderCapacityFull } from '../src/agent/limits.js';
import { MACHINE_WAIT, MachineQueued, leaseWaitDeadline, machineWaits, PLACE_KEPT_MS, keepPlace, keptPlace, withMachineWait } from '../src/world/machine-wait.js';
import type { TaskView } from '../src/domain/types.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const until = async (check: () => Promise<boolean>, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** A hosted organization on the free plan (5 computers at once), all 5 in use. */
async function fixture() {
  const store = await Store.create(':memory:', { hosted: true });
  cleanups.push(() => store.close());
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id);
  const runners = new RunnerPoolService(store);
  const pool = await runners.ensureDefaultPool(project, 'e2b');
  const task = async (title: string) => (await store.createTask({ projectId: project.id, title, workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: title } as any })).id;
  const busy: string[] = [];
  for (let index = 0; index < pool.capacity.activeWorlds; index++) {
    const id = await task(`Busy ${index}`);
    const lease = await store.requestWorldLease({ runnerPoolId: pool.id, organizationId: organization.id, projectId: project.id, taskId: id, worldId: id });
    expect(lease.acquired).toBe(true);
    busy.push(lease.id);
  }
  const tokens = new TokenAuthority();
  const token = (await tokens.mintPrincipal('user:owner', ['*'], project.id)).token;
  const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens });
  const view = (taskId: string, patch: Partial<TaskView>) => store.saveView(taskId, { taskId, title: 'T', workflow: 'software-dev',
    stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: Date.now(), ...patch } as TaskView);
  /** Ask for a lease the way an activity does, in the background. */
  const waitFor = (taskId: string, extra: Partial<Parameters<RunnerPoolService['acquire']>[0]> = {}) => {
    const controller = new AbortController();
    const result = runners.acquire({ project, taskId, worldId: taskId, provider: 'e2b', pollMs: 5, signal: controller.signal, ...extra });
    result.catch(() => undefined);
    cleanups.push(() => controller.abort());
    return result;
  };
  const queued = (taskId: string) => until(async () => (await store.worldLeasesForTask(taskId)).some((lease) => lease.state === 'queued'));
  return { store, organization, project, runners, pool, task, busy, api, token, view, waitFor, queued };
}

describe('a queued runner lease', () => {
  it('shows as Waiting for a machine, with its place and what is full, instead of "Starting agent" or Setup', async () => {
    const f = await fixture();
    const first = await f.task('Setting up');
    const second = await f.task('Waking');
    await f.view(first, { stage: 'setup', status: 'active' });
    // A turn already given its login, waiting for its machine to wake.
    await f.view(second, { stage: 'do', status: 'waiting', waitingFor: { kind: 'agentSlot', detail: 'Starting agent' },
      agentTurn: { turnId: 't', role: 'do', state: 'waiting-slot' } });
    const firstLease = f.waitFor(first);
    await f.queued(first);
    f.waitFor(second);
    await f.queued(second);

    const waking = await f.api.getTaskView(f.token, second);
    expect(waking).toMatchObject({ status: 'waiting', waitingFor: { kind: 'retry', summary: MACHINE_WAIT, provider: 'e2b', ahead: 1 } });
    expect(waking!.waitingFor!.detail).toMatch(/All 5 computers this organization may run at once are in use/);
    expect(waking!.waitingFor!.detail).toMatch(/1 task is ahead of this one/);
    const setup = await f.api.getTaskView(f.token, first);
    expect(setup).toMatchObject({ stage: 'setup', status: 'waiting', waitingFor: { kind: 'retry', summary: MACHINE_WAIT, ahead: 0 } });
    expect(setup!.waitingFor!.detail).not.toMatch(/ahead/);

    // A machine frees: the first is let in and says what it does again; the second moves up.
    await f.runners.release(f.busy[0]!, 'e2b');
    await firstLease;
    expect((await f.api.getTaskView(f.token, first))).toMatchObject({ stage: 'setup', status: 'active' });
    expect((await f.api.getTaskView(f.token, first))!.waitingFor).toBeUndefined();
    expect((await f.api.getTaskView(f.token, second))!.waitingFor).toMatchObject({ summary: MACHINE_WAIT, ahead: 0 });
  });

  it('never hides what a person is asked, nor marks a finished task waiting', () => {
    const wait = { provider: 'e2b', ahead: 2, detail: 'All 5 computers … are in use.', since: 1, runnerPoolId: 'p' };
    const base = { taskId: 't', title: 'T', workflow: 'software-dev', messages: [], actions: [], state: {}, updatedAt: 1 } as unknown as TaskView;
    const review = { ...base, stage: 'review', status: 'waiting', waitingFor: { kind: 'confirm' } } as TaskView;
    expect(withMachineWait(review, wait)).toBe(review);
    const asked = { ...base, stage: 'do', status: 'waiting', waitingFor: { kind: 'human', detail: 'Which one?' } } as TaskView;
    expect(withMachineWait(asked, wait)).toBe(asked);
    const done = { ...base, stage: 'done', status: 'done' } as TaskView;
    expect(withMachineWait(done, wait)).toBe(done);
    const landing = { ...base, stage: 'merge', status: 'active' } as TaskView;
    expect(withMachineWait(landing, wait)).toMatchObject({ stage: 'merge', status: 'waiting',
      waitingFor: { kind: 'retry', summary: MACHINE_WAIT, provider: 'e2b', ahead: 2 } });
    expect(withMachineWait(landing, undefined)).toBe(landing);
  });

  it('reads every waiting task of a list at once, and only theirs', async () => {
    const f = await fixture();
    const waiting = await f.task('Waiting');
    const idle = await f.task('Idle');
    f.waitFor(waiting);
    await f.queued(waiting);
    const waits = await machineWaits(f.store);
    expect([...waits.keys()]).toEqual([waiting]);
    expect(waits.get(waiting)).toMatchObject({ provider: 'e2b', ahead: 0, runnerPoolId: f.pool.id });
    expect(waits.has(idle)).toBe(false);
  });

  it('leaves a task alone that already runs on its machine while something else of it (a terminal) waits for another', async () => {
    const f = await fixture();
    const running = await f.task('Running');
    // It holds one of the five computers; a dedicated terminal asks for another.
    await f.runners.release(f.busy[0]!, 'e2b');
    await f.runners.acquire({ project: f.project, taskId: running, worldId: running, provider: 'e2b' });
    await f.view(running, { stage: 'do', status: 'active' });
    f.waitFor(running);
    await f.queued(running);
    expect((await f.api.getTaskView(f.token, running))).toMatchObject({ status: 'active' });
    expect((await machineWaits(f.store)).has(running)).toBe(false);
  });

  it('tells live pages when it starts and stops waiting', async () => {
    const f = await fixture();
    const id = await f.task('Live');
    const events: Array<{ type: string; taskId?: string; payload: any }> = [];
    f.store.onEventRecorded((event) => { if (event.type === 'world.machine-wait') events.push(event as any); });
    const lease = f.waitFor(id);
    await until(async () => events.length > 0);
    expect(events[0]).toMatchObject({ taskId: id, payload: { waiting: true, provider: 'e2b', ahead: 0, projectId: f.project.id } });
    await f.runners.release(f.busy[0]!, 'e2b');
    await lease;
    await until(async () => events.length > 1);
    expect(events.at(-1)).toMatchObject({ taskId: id, payload: { waiting: false } });
  });

  it('gives up at its deadline as a machine wait the workflow shows and retries, keeping its place in the queue', async () => {
    const f = await fixture();
    const early = await f.task('Early');
    const late = await f.task('Late');
    const refused = await f.waitFor(early, { waitUntil: Date.now() + 40 }).then(() => undefined, (error) => error);
    expect(refused).toBeInstanceOf(MachineQueued);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    expect(refused.message).toMatch(/All 5 computers this organization may run at once are in use/);
    // Nothing is left holding a place in the database while nobody waits.
    expect(await f.store.worldLeasesForTask(early)).toEqual([]);
    f.waitFor(late);
    await f.queued(late);
    // It asks again (the workflow's retry): it is still ahead of the one that came later.
    const again = f.waitFor(early);
    await f.queued(early);
    expect((await machineWaits(f.store)).get(early)).toMatchObject({ ahead: 0 });
    expect((await machineWaits(f.store)).get(late)).toMatchObject({ ahead: 1 });
    await f.runners.release(f.busy[0]!, 'e2b');
    await again;
    expect((await f.store.worldLeasesForTask(late)).map((lease) => lease.state)).toEqual(['queued']);
  });

  it('forgets a place nobody asked for again for a while', async () => {
    const f = await fixture();
    const id = await f.task('Gone');
    expect(await keptPlace(f.store, id, id, 1_000)).toBeUndefined();
    await keepPlace(f.store, id, id, 500, 1_000);
    expect(await keptPlace(f.store, id, id, 2_000)).toBe(500);
    expect(await keptPlace(f.store, id, id, 1_000 + PLACE_KEPT_MS)).toBeUndefined();
  });

  it('waits at most half of what its activity may run, so the work after admission still fits', () => {
    expect(leaseWaitDeadline({ currentAttemptScheduledTimestampMs: 1_000, startToCloseTimeoutMs: 300_000 })).toBe(151_000);
    expect(leaseWaitDeadline({ currentAttemptScheduledTimestampMs: 1_000, startToCloseTimeoutMs: 0 })).toBeUndefined();
    expect(leaseWaitDeadline(undefined)).toBeUndefined();
  });
});
