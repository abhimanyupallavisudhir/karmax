import { describe, expect, it } from 'vitest';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { orderKey, queueKey } from '../src/scheduling/state.js';
import { planGrants } from '../src/scheduling/planner.js';

/**
 * Agent work in quota order, and the orders people (or agents) set by dragging
 * (wiki features/quota-scheduling): the API behind the Queues page.
 */
async function setup(caps = ['task:*', 'queue:*']) {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('owner'));
  const project = (await store.createProject('Scheduling'));
  const tokens = new TokenAuthority(store);
  const token = (await tokens.mintPrincipal('user:owner', caps, project.id, 60_000, project.organizationId)).token;
  const signals: string[] = [];
  let live: any = { queue: [], granted: [], holds: [] };
  const client = { workflow: { getHandle: () => ({
    query: async () => live,
    signal: async (name: string) => { signals.push(name); },
  }) } } as any;
  const task = async (title: string, extra: Record<string, unknown> = {}) => store.createTask({ projectId: project.id, title,
    workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: title } as any, ...extra });
  return { store, project, token, signals, task, setLive: (v: any) => { live = v; },
    api: new KarmaxApi({ store, tokens, client, taskQueue: 'test' }) };
}

describe('scheduling queue API', () => {
  it('lists running and waiting work in the planned order, with why and until when, sub-tasks under their task', async () => {
    const { store, project, token, task, setLive, api } = await setup();
    const a = await task('Alpha'), b = await task('Beta');
    const sub = await task('Beta part', { parentTaskId: b.id });
    const org = project.organizationId ?? 'org_personal';
    setLive({ queue: [{ taskId: a.id, turnId: '1' }, { taskId: sub.id, turnId: '2' }],
      granted: [{ taskId: b.id, turnId: '0', accountId: 'login:x', grantedAt: 5 }],
      holds: [{ taskId: a.id, turnId: '1', status: 'held', until: 1000 }] });
    await store.kvSet(queueKey(org), JSON.stringify({ at: 1, running: [], prices: {}, waiting: [
      { taskId: sub.id, turnId: '2', root: b.id, status: 'next', priority: 'medium' },
      { taskId: a.id, turnId: '1', root: a.id, status: 'held', until: 900, priority: 'medium' }] }));
    const view = await api.schedulingQueue(token);
    expect(view.running).toEqual([expect.objectContaining({ taskId: b.id, root: b.id, accountId: 'login:x', since: 5 })]);
    expect(view.waiting.map((w) => [w.taskId, w.root, w.status, w.until])).toEqual([[sub.id, b.id, 'next', undefined], [a.id, a.id, 'held', 1000]]);
    expect(view.waiting[0]).toMatchObject({ rootTitle: 'Beta', title: 'Beta part' });
    (await store.close());
  });

  it('records a placement between two tasks, refuses one that mixes a task with sub-tasks, and replans', async () => {
    const { store, project, token, task, signals, api } = await setup();
    const a = await task('A'), b = await task('B'), c = await task('C');
    const sub = await task('A part', { parentTaskId: a.id }), sub2 = await task('A part 2', { parentTaskId: a.id });
    await api.placeInQueue(token, { taskId: c.id, above: a.id, below: b.id });
    const org = project.organizationId ?? 'org_personal';
    expect(JSON.parse((await store.kvGet(orderKey(org)))!)).toEqual([
      expect.objectContaining({ above: a.id, below: c.id, moved: 'below' }),
      expect.objectContaining({ above: c.id, below: b.id, moved: 'above' })]);
    expect(signals).toContain('replanAccounts');
    await expect(api.placeInQueue(token, { taskId: c.id, above: sub.id })).rejects.toThrow(/among other tasks/);
    await expect(api.placeInQueue(token, { taskId: sub.id, above: b.id })).rejects.toThrow(/its own task/);
    await api.placeInQueue(token, { taskId: sub2.id, below: sub.id });
    // Back to automatic order, and a new priority clears a task's placements too.
    await api.clearQueuePlacement(token, sub2.id);
    await api.setTaskPriority(token, c.id, 3);
    expect(await store.kvGet(orderKey(org))).toBeUndefined();
    (await store.close());
  });

  it('refuses a caller without queue write access', async () => {
    const { store, token, task, api } = await setup(['task:read', 'queue:read']);
    const a = await task('A'), b = await task('B');
    await expect(api.placeInQueue(token, { taskId: a.id, below: b.id })).rejects.toThrow();
    (await store.close());
  });
});

describe('planner', () => {
  it('plans an organization\'s queued turns on its logins and saves the plan for the Queues page', async () => {
    const { store, project, task } = await setup();
    const urgent = await task('Urgent', { params: { prompt: 'u', priority: 4 } });
    const low = await task('Low', { params: { prompt: 'l', priority: 1 } });
    const org = project.organizationId ?? 'org_personal';
    const plan = await planGrants(store, {
      accounts: [{ id: 'login:a', provider: 'claude', kind: 'login', status: 'available', inUse: 9, maxConcurrent: 10 }],
      queue: [{ taskId: low.id, turnId: 'l', provider: 'claude', allowed: ['login:a'] },
        { taskId: urgent.id, turnId: 'u', provider: 'claude', allowed: ['login:a'] }],
      granted: [],
    }, Date.UTC(2030, 0, 1, 12));
    // One slot: it goes to the urgent task; the low one waits for the next slot.
    expect(plan.grants).toEqual([{ taskId: urgent.id, turnId: 'u', accountId: 'login:a' }]);
    expect(plan.holds).toEqual([{ taskId: low.id, turnId: 'l', status: 'next' }]);
    expect(plan.recheckMs).toBeGreaterThanOrEqual(60_000);
    const saved = JSON.parse((await store.kvGet(queueKey(org)))!);
    expect(saved.waiting.map((w: any) => [w.taskId, w.status, w.priority])).toEqual([[urgent.id, 'admit', 'urgent'], [low.id, 'next', 'low']]);
    (await store.close());
  });

  it('asks a long-running low-priority turn to pause when far more important work is blocked on its login', async () => {
    const { store, task } = await setup();
    const hog = await task('Hog', { params: { prompt: 'h', priority: 1 } });
    const urgent = await task('Urgent', { params: { prompt: 'u', priority: 4 } });
    const now = Date.UTC(2030, 0, 1, 12);
    const plan = await planGrants(store, {
      accounts: [{ id: 'login:a', provider: 'claude', kind: 'login', status: 'available', inUse: 1, maxConcurrent: 1 }],
      queue: [{ taskId: urgent.id, turnId: 'u', provider: 'claude', allowed: ['login:a'] }],
      granted: [{ taskId: hog.id, turnId: 'h', accountId: 'login:a', grantedAt: now - 30 * 60_000 }],
    }, now);
    expect(plan.grants).toEqual([]);
    expect(plan.yields).toEqual([{ taskId: hog.id, turnId: 'h' }]);
    // A turn that only just started keeps going.
    const fresh = await planGrants(store, {
      accounts: [{ id: 'login:a', provider: 'claude', kind: 'login', status: 'available', inUse: 1, maxConcurrent: 1 }],
      queue: [{ taskId: urgent.id, turnId: 'u', provider: 'claude', allowed: ['login:a'] }],
      granted: [{ taskId: hog.id, turnId: 'h', accountId: 'login:a', grantedAt: now - 60_000 }],
    }, now);
    expect(fresh.yields).toEqual([]);
    (await store.close());
  });
});
