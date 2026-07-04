import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { accountCoordinatorId } from '../src/coordinators/names.js';
import { newId } from '../src/util/id.js';

/**
 * Hermetic verification of the quota engine's core (RESOLVE-PLAN §2) — provider-
 * scoped leasing, re-lease-on-exhaustion, park→refresh→grant, and manual override.
 * Drives the account coordinator directly (no agents, no real provider calls), so
 * it burns ZERO quota and is fully deterministic. A `pingWorkflow` stands in as the
 * grantee that receives the account-granted signal.
 */
describe('account coordinator — quota engine', () => {
  let h: Harness;
  beforeAll(async () => { h = await bootHarness('mock'); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  const accounts = () => h.client.workflow.getHandle(accountCoordinatorId()).query('accounts') as Promise<any>;
  const acct = async (id: string) => ((await accounts()).accounts as any[]).find((a) => a.id === id);
  const startCoord = async (seed: any[]) => {
    // The coordinator is a fixed-id singleton; clear any prior run first.
    try { await h.client.workflow.getHandle(accountCoordinatorId()).terminate('reset'); } catch { /* not running */ }
    const coord = await h.client.workflow.start('accountCoordinator', {
      taskQueue: TASK_QUEUE,
      workflowId: accountCoordinatorId(),
      args: [{ state: { accounts: seed, queue: [], processed: 0 } }],
    });
    return coord;
  };
  // A running grantee so the coordinator's grant signal lands (else it reclaims).
  const grantee = async () => {
    const id = newId('task');
    const h2 = await h.client.workflow.start('pingWorkflow', { taskQueue: TASK_QUEUE, workflowId: id, args: ['x'] });
    return { id, h: h2 };
  };
  const A = (over: any = {}) => ({ id: 'A', configHome: '/tmp/A', provider: 'claude', maxConcurrent: 1, inUse: 0, status: 'available', ...over });

  it('leases only an account of the requested provider (claude↔claude, codex↔codex)', async () => {
    const coord = await startCoord([
      { id: 'cl', configHome: '/tmp/cl', provider: 'claude', maxConcurrent: 1, inUse: 0, status: 'available' },
      { id: 'cx', configHome: '/tmp/cx', provider: 'codex', maxConcurrent: 1, inUse: 0, status: 'available' },
    ]);
    const g1 = await grantee();
    await coord.signal('leaseAccount', { taskId: g1.id, turnId: 't1', provider: 'codex' });
    // The codex account is leased; the claude one is untouched (no head-of-line block either).
    await expect.poll(async () => (await acct('cx')).inUse, { timeout: 10_000 }).toBe(1);
    expect((await acct('cl')).inUse).toBe(0);

    const g2 = await grantee();
    await coord.signal('leaseAccount', { taskId: g2.id, turnId: 't2', provider: 'claude' });
    await expect.poll(async () => (await acct('cl')).inUse, { timeout: 10_000 }).toBe(1);

    await g1.h.signal('finish'); await g2.h.signal('finish');
    await coord.terminate('done');
  });

  it('on exhaustion, re-leasing picks a DIFFERENT available login of the same provider', async () => {
    const coord = await startCoord([A({ id: 'A' }), A({ id: 'B', configHome: '/tmp/B' })]);
    const g1 = await grantee();
    await coord.signal('leaseAccount', { taskId: g1.id, turnId: 't1', provider: 'claude' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(1);

    // Ground-truth exhaustion report for A (far-future reset so it won't self-refresh here).
    await coord.signal('reportExhausted', { accountId: 'A', window: '5h', resetAt: Date.now() + 3_600_000 });
    await expect.poll(async () => (await acct('A')).status, { timeout: 10_000 }).toBe('exhausted');

    const g2 = await grantee();
    await coord.signal('leaseAccount', { taskId: g2.id, turnId: 't2', provider: 'claude' });
    // Must grant B (A is exhausted), not A.
    await expect.poll(async () => (await acct('B')).inUse, { timeout: 10_000 }).toBe(1);
    expect((await acct('A')).inUse).toBe(0);

    await g1.h.signal('finish'); await g2.h.signal('finish');
    await coord.terminate('done');
  });

  it('parks a request when the pool is exhausted, then grants it when the refresh timer fires', async () => {
    const coord = await startCoord([A()]);
    // Exhaust the only account with a SHORT reset so the refresh timer fires during the test.
    await coord.signal('reportExhausted', { accountId: 'A', window: '5h', resetAt: Date.now() + 2500 });
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 't1', provider: 'claude' });

    // Parked: not granted yet, and the request is waiting.
    await expect.poll(async () => (await accounts()).waiting, { timeout: 3000 }).toBeGreaterThanOrEqual(1);
    expect((await acct('A')).inUse).toBe(0);

    // After the reset instant passes, the coordinator refreshes A and grants the parked request.
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 12_000 }).toBe(1);
    expect((await acct('A')).status).toBe('available');

    await g.h.signal('finish');
    await coord.terminate('done');
  });

  it('grants the first AVAILABLE credential in the allow-list order (policy precedence)', async () => {
    const coord = await startCoord([A({ id: 'A' }), A({ id: 'B', configHome: '/tmp/B' })]);
    const g = await grantee();
    // The allow-list prefers B over A → B is granted even though A is also free.
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 't1', allowed: ['B', 'A'] });
    await expect.poll(async () => (await acct('B')).inUse, { timeout: 10_000 }).toBe(1);
    expect((await acct('A')).inUse).toBe(0);
    await g.h.signal('finish');
    await coord.terminate('done');
  });

  it('skips an exhausted first choice to the next credential in the allow-list', async () => {
    const coord = await startCoord([A({ id: 'A' }), A({ id: 'B', configHome: '/tmp/B' })]);
    await coord.signal('reportExhausted', { accountId: 'A', window: '5h', resetAt: Date.now() + 3_600_000 });
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 't1', allowed: ['A', 'B'] }); // prefers A, but A is exhausted → B
    await expect.poll(async () => (await acct('B')).inUse, { timeout: 10_000 }).toBe(1);
    expect((await acct('A')).inUse).toBe(0);
    await g.h.signal('finish');
    await coord.terminate('done');
  });

  it('DENIES a request whose only allowed credential needs attention (task escalates, not parks)', async () => {
    const coord = await startCoord([A({ id: 'A' })]);
    await coord.signal('setAccountAvailability', { accountId: 'A', status: 'needs-attention' });
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 't1', allowed: ['A'] });
    // Denied → the request is dequeued (not parked forever); nothing is leased for use.
    await expect.poll(async () => (await accounts()).waiting, { timeout: 5000 }).toBe(0);
    expect((await acct('A')).inUse).toBe(0);
    await g.h.signal('finish');
    await coord.terminate('done');
  });

  it('honors a manual availability override (mark available → the parked request is granted)', async () => {
    const coord = await startCoord([A()]);
    await coord.signal('reportExhausted', { accountId: 'A', window: '5h', resetAt: Date.now() + 3_600_000 }); // far out
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 't1', provider: 'claude' });
    await expect.poll(async () => (await accounts()).waiting, { timeout: 3000 }).toBeGreaterThanOrEqual(1);

    // Manual "Mark available now" — should immediately free the login and grant.
    await coord.signal('setAccountAvailability', { accountId: 'A', status: 'available' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(1);

    await g.h.signal('finish');
    await coord.terminate('done');
  });
});
