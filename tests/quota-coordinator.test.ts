import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { accountCoordinatorId, SIG_ACCOUNT_GRANTED } from '../src/coordinators/names.js';
import { newId } from '../src/util/id.js';
import { makeCoordinatorActivities } from '../src/activities/coordinator.js';

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
  // The account ids a grantee was sent, in order ('(relist)' asks it to re-request).
  const grants = async (taskId: string) => {
    const history = await h.client.workflow.getHandle(taskId).fetchHistory();
    return (history.events ?? []).flatMap((event: any) => {
      const signal = event.workflowExecutionSignaledEventAttributes;
      if (signal?.signalName !== SIG_ACCOUNT_GRANTED) return [];
      const payload = signal.input?.payloads?.[0]?.data;
      return [JSON.parse(Buffer.from(payload).toString('utf8')).accountId];
    });
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

  it('an out-of-order return retires the returning task’s lease, not the oldest one', async () => {
    // Two concurrent turns on ONE credential. Task A grants first, B second.
    const coord = await startCoord([A({ id: 'A', maxConcurrent: 2 })]);
    const gA = await grantee();
    const gB = await grantee();
    const leases = (taskId: string) =>
      coord.query('accountTaskLeases', taskId) as Promise<string[]>;
    await coord.signal('leaseAccount', { taskId: gA.id, turnId: 'ta', provider: 'claude' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(1);
    await coord.signal('leaseAccount', { taskId: gB.id, turnId: 'tb', provider: 'claude' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(2);

    // B finishes FIRST and returns. The ledger used to drop the OLDEST record for the
    // credential — A's — because the signal carried no lease identity. `inUse` stayed
    // right, but attribution inverted: the surviving lease was credited to B.
    await coord.signal('returnAccount', { accountId: 'A', taskId: gB.id, turnId: 'tb' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(1);

    // The decisive assertion. `sweepDeadLeases` reclaims by `lease.taskId`, so a
    // ledger that credits A's live lease to B means: once B's workflow ends the sweep
    // frees a credential A is still using (real over-subscription of a login, which is
    // what trips provider rate-limit lockouts), while `stopTaskActivity` — which reads
    // exactly this query — cancels the wrong task's turn.
    expect(await leases(gA.id)).toEqual(['ta']);
    expect(await leases(gB.id)).toEqual([]);

    await gA.h.signal('finish'); await gB.h.signal('finish');
    await coord.terminate('done');
  });

  // Signals are applied in order, so once a freshly-registered marker credential is
  // visible every signal sent before the register has already run. Cheaper and far
  // more reliable than polling on the value under test (which passes transiently
  // while the second, buggy decrement is still in flight).
  const barrier = async (coord: any, extra: any[] = []) => {
    await coord.signal('registerAccounts', {
      accounts: [...extra, { id: 'ZZ', configHome: '/tmp/ZZ', provider: 'claude', maxConcurrent: 1 }],
    });
    await expect.poll(async () => !!(await acct('ZZ')), { timeout: 10_000 }).toBe(true);
  };
  const twoLeases = async () => {
    // Two concurrent turns on ONE credential (cap 2): A grants first, B second.
    const coord = await startCoord([A({ id: 'A', maxConcurrent: 2 })]);
    const gA = await grantee();
    const gB = await grantee();
    await coord.signal('leaseAccount', { taskId: gA.id, turnId: 'ta', provider: 'claude' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(1);
    await coord.signal('leaseAccount', { taskId: gB.id, turnId: 'tb', provider: 'claude' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(2);
    const leases = (taskId: string) => coord.query('accountTaskLeases', taskId) as Promise<string[]>;
    return { coord, gA, gB, leases };
  };

  it('a DUPLICATE returnAccount does not double-decrement inUse (over-subscription)', async () => {
    const { coord, gA, gB, leases } = await twoLeases();

    // B returns twice: an activity retry whose signal landed the first time, or the
    // workflow's `finally` racing a resend. The ledger lookup below correctly refuses
    // to evict someone else's record the second time — but `inUse` was decremented
    // unconditionally *before* that lookup, so capacity came back twice.
    await coord.signal('returnAccount', { accountId: 'A', taskId: gB.id, turnId: 'tb' });
    await coord.signal('returnAccount', { accountId: 'A', taskId: gB.id, turnId: 'tb' });
    await barrier(coord, [{ id: 'A', configHome: '/tmp/A', provider: 'claude', maxConcurrent: 2 }]);

    // A is still actively using the credential, so exactly one slot is owed. Dropping
    // to 0 hands the login out beyond `maxConcurrent` — the mirror image of the leak
    // the granted-lease ledger exists to close, and what trips provider lockouts.
    expect((await acct('A')).inUse).toBe(1);
    expect(await leases(gA.id)).toEqual(['ta']);
    expect(await leases(gB.id)).toEqual([]);

    await gA.h.signal('finish'); await gB.h.signal('finish');
    await coord.terminate('done');
  });

  it('a cancel that reclaims a GRANTED lease is not refunded again by a late return', async () => {
    const { coord, gA, gB, leases } = await twoLeases();

    // `stopTaskActivity` cancels B's granted lease (terminated workflows never run
    // their `finally`), and an already-scheduled returnAccount activity lands after.
    await coord.signal('cancelAccountLease', { taskId: gB.id, turnId: 'tb' });
    await coord.signal('returnAccount', { accountId: 'A', taskId: gB.id, turnId: 'tb' });
    await barrier(coord, [{ id: 'A', configHome: '/tmp/A', provider: 'claude', maxConcurrent: 2 }]);

    expect((await acct('A')).inUse).toBe(1); // only B's slot came back
    expect(await leases(gA.id)).toEqual(['ta']);
    expect(await leases(gB.id)).toEqual([]);

    await gA.h.signal('finish'); await gB.h.signal('finish');
    await coord.terminate('done');
  });

  it('still frees capacity for an identity-less (legacy) returnAccount payload', async () => {
    // Older task-workflow versions send `{ accountId }` with no lease identity; the
    // oldest-record fallback stays the only option for them and must still release.
    const coord = await startCoord([A({ id: 'A' })]);
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 't1', provider: 'claude' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(1);

    await coord.signal('returnAccount', { accountId: 'A' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(0);
    expect(await (coord.query('accountTaskLeases', g.id) as Promise<string[]>)).toEqual([]);

    await g.h.signal('finish');
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

  it('removes a cancelled parked request immediately', async () => {
    const coord = await startCoord([A({ status: 'exhausted', resetAt: Date.now() + 3_600_000 })]);
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 'cancel-me', provider: 'claude' });
    await expect.poll(async () => (await accounts()).waiting, { timeout: 3000 }).toBe(1);

    await coord.signal('cancelAccountLease', { taskId: g.id, turnId: 'cancel-me' });
    await expect.poll(async () => (await accounts()).waiting, { timeout: 3000 }).toBe(0);
    expect((await acct('A')).inUse).toBe(0);

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

  // Every allowed credential needing a person used to DENY the turn, which
  // escalated the task with an error. A credential wall is a wait like quota:
  // the request parks and is granted the moment a credential recovers.
  it('parks a request whose only allowed credential needs attention, then grants it on recovery', async () => {
    const coord = await startCoord([A({ id: 'A' })]);
    await coord.signal('setAccountAvailability', { accountId: 'A', status: 'needs-attention' });
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 't1', allowed: ['A'] });
    expect(await coord.query('accountLease', { taskId: g.id })).toEqual({
      waiting: true, detail: 'Every allowed credential needs attention — sign in again or add one',
    });
    expect(await grants(g.id)).toEqual([]);
    await coord.signal('setAccountAvailability', { accountId: 'A', status: 'available', onlyIfStatus: 'needs-attention' });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => grants(g.id), { timeout: 10_000 }).toEqual(['A']);
    await g.h.signal('finish');
    await coord.terminate('done');
  });

  it('asks a parked request to re-list its credentials when a new credential registers', async () => {
    const coord = await startCoord([A({ id: 'A', status: 'needs-attention' })]);
    const walled = await grantee();
    await coord.signal('leaseAccount', { taskId: walled.id, turnId: 'wall', allowed: ['missing:org_personal:claude'] });
    const quota = await grantee();
    await coord.signal('reportExhausted', { accountId: 'A', window: '5h', resetAt: Date.now() + 3_600_000 });
    await coord.signal('leaseAccount', { taskId: quota.id, turnId: 'quota', allowed: ['A'] });
    await expect.poll(async () => (await accounts()).waiting, { timeout: 10_000 }).toBe(2);

    // An existing credential re-registering is not news; a new one is.
    await coord.signal('registerAccounts', { accounts: [{ id: 'A', configHome: '/tmp/A', provider: 'claude', kind: 'login' }] });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await accounts()).waiting).toBe(2);
    await coord.signal('registerAccounts', { accounts: [
      { id: 'A', configHome: '/tmp/A', provider: 'claude', kind: 'login' },
      { id: 'B', configHome: '/tmp/B', provider: 'claude', kind: 'login' },
    ] });
    await expect.poll(async () => (await accounts()).waiting, { timeout: 10_000 }).toBe(0);
    await expect.poll(() => grants(walled.id), { timeout: 10_000 }).toEqual(['(relist)']);
    await expect.poll(() => grants(quota.id), { timeout: 10_000 }).toEqual(['(relist)']);
    expect((await acct('B')).inUse).toBe(0); // policy decides; the coordinator never guesses
    await walled.h.signal('finish');
    await quota.h.signal('finish');
    await coord.terminate('done');
  });

  it('re-lists parked requests when a credential policy changes', async () => {
    const coord = await startCoord([A({ id: 'A', status: 'manual-off' })]);
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 't1', allowed: ['A'] });
    await expect.poll(async () => (await accounts()).waiting, { timeout: 10_000 }).toBe(1);
    await makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE }).relistAccountLeases();
    await expect.poll(async () => (await accounts()).waiting, { timeout: 10_000 }).toBe(0);
    await expect.poll(() => grants(g.id), { timeout: 10_000 }).toEqual(['(relist)']);
    await g.h.signal('finish');
    await coord.terminate('done');
  });

  it('acknowledges availability changes only after they are applied', async () => {
    const coord = await startCoord([A({ id: 'A' })]);
    const activities = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });

    // This activity used to return as soon as its signal was accepted by Temporal,
    // allowing an immediate retry to lease A again before the signal handler ran.
    await activities.setAccountAvailability({ accountId: 'A', status: 'needs-attention' });
    expect((await acct('A')).status).toBe('needs-attention');

    await activities.reportAccountExhausted({ accountId: 'A', window: '5h', resetHint: 'in 1 hour' });
    expect((await acct('A')).status).toBe('exhausted');
    expect((await acct('A')).resetAt).toBeGreaterThan(Date.now());
    await coord.terminate('done');
  });

  it('retains the source and safe reason for the latest automatic quarantine', async () => {
    const coord = await startCoord([A({ id: 'A' })]);
    await coord.signal('setAccountAvailability', {
      accountId: 'A', status: 'needs-attention',
      transition: {
        source: 'provider-failure', sourceTaskId: 'task_source', sourceActivityId: '17',
        kind: 'credential', provider: 'codex', at: Date.now(),
        diagnostic: { code: 'token_expired', status: 401, requestId: 'req_safe' },
      },
    });

    expect(await acct('A')).toMatchObject({
      status: 'needs-attention',
      lastTransition: {
        source: 'provider-failure', sourceTaskId: 'task_source', sourceActivityId: '17',
        kind: 'credential', provider: 'codex',
        diagnostic: { code: 'token_expired', status: 401, requestId: 'req_safe' },
      },
    });
    await coord.terminate('done');
  });

  it('recovers an automatic needs-attention quarantine without overriding a manual disable', async () => {
    const coord = await startCoord([A({ id: 'A' }), A({ id: 'B', configHome: '/tmp/B' })]);
    const activities = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await activities.setAccountAvailability({ accountId: 'A', status: 'needs-attention' });
    await activities.setAccountAvailability({ accountId: 'B', status: 'manual-off' });

    await activities.setAccountAvailability({
      accountId: 'A', status: 'available', onlyIfStatus: 'needs-attention',
    });
    await activities.setAccountAvailability({
      accountId: 'B', status: 'available', onlyIfStatus: 'needs-attention',
    });

    expect((await acct('A')).status).toBe('available');
    expect((await acct('B')).status).toBe('manual-off');
    await coord.terminate('done');
  });

  it('acknowledges whether a lease actually parked or was granted immediately', async () => {
    const coord = await startCoord([A({ id: 'A' })]);
    const activities = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    const immediate = await grantee();

    await expect(activities.leaseAccount(immediate.id, 'immediate', 'claude')).resolves.toEqual({
      waiting: false,
    });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(1);

    const parked = await grantee();
    await expect(activities.leaseAccount(parked.id, 'parked', 'claude')).resolves.toEqual({
      waiting: true,
      detail: 'Waiting for a free slot on an allowed account',
    });
    expect((await accounts()).waiting).toBe(1);

    await immediate.h.signal('finish');
    await parked.h.signal('finish');
    await coord.terminate('done');
  });

  it('explains quota waits using only the request’s allowed accounts', async () => {
    const resetAt = Date.now() + 3_600_000;
    const coord = await startCoord([
      A({ id: 'allowed', status: 'exhausted', resetAt }),
      A({ id: 'other-organization' }),
    ]);
    const activities = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    const g = await grantee();
    const expected = { waiting: true, earliestResetAt: resetAt,
      detail: 'Provider usage limit reached; the task resumes automatically when quota resets' };
    expect(await activities.leaseAccount(g.id, 'quota', 'claude', ['allowed'])).toEqual(expected);
    expect(await coord.query('accountLease', { taskId: g.id })).toEqual(expected);
    expect((await acct('other-organization')).inUse).toBe(0);
    await coord.signal('setAccountAvailability', { accountId: 'allowed', status: 'available' });
    await expect.poll(() => coord.query('accountLease', { taskId: g.id }), { timeout: 10_000 })
      .toEqual({ waiting: false });
    await g.h.signal('finish');
    await coord.terminate('done');
  });

  it('also parks provider-fallback requests when every compatible credential needs attention', async () => {
    const coord = await startCoord([A({ id: 'A', status: 'needs-attention' })]);
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 'fallback', provider: 'claude' });
    await expect.poll(async () => (await accounts()).waiting, { timeout: 5000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await grants(g.id)).toEqual([]);
    await coord.signal('setAccountAvailability', { accountId: 'A', status: 'available' });
    await expect.poll(async () => grants(g.id), { timeout: 10_000 }).toEqual(['A']);
    await g.h.signal('finish');
    await coord.terminate('done');
  });

  it('prunes a stale account no longer in the authoritative set, but keeps an in-use one', async () => {
    const coord = await startCoord([A({ id: 'A' }), A({ id: 'B', configHome: '/tmp/B' })]);
    // Lease A so it's in-use; B stays idle.
    const g = await grantee();
    await coord.signal('leaseAccount', { taskId: g.id, turnId: 't1', allowed: ['A'] });
    await expect.poll(async () => (await acct('A')).inUse, { timeout: 10_000 }).toBe(1);

    // Re-register with the full set now MISSING both A and B (both "removed"). The
    // idle one (B) is pruned; the in-use one (A) is kept until its turn finishes.
    await coord.signal('registerAccounts', { accounts: [{ id: 'C', configHome: '/tmp/C', provider: 'claude', kind: 'login' }] });
    await expect.poll(async () => ((await accounts()).accounts as any[]).map((a) => a.id).sort(), { timeout: 10_000 })
      .toEqual(['A', 'C']); // B pruned (idle, removed); A kept (in-use); C added
    await g.h.signal('finish');
    await coord.terminate('done');
  });

  it('defaults a login to 10 concurrent turns, and a re-register raises/lowers the cap', async () => {
    const coord = await startCoord([]);
    // Registered via the signal (not seeded) so the kind-based default applies.
    await coord.signal('registerAccounts', { accounts: [{ id: 'L', configHome: '/tmp/L', provider: 'claude', kind: 'login' }] });
    await expect.poll(async () => (await acct('L'))?.maxConcurrent, { timeout: 10_000 }).toBe(10); // default, not 1

    // Two turns lease the same login concurrently (both under the cap of 10).
    const g1 = await grantee(), g2 = await grantee();
    await coord.signal('leaseAccount', { taskId: g1.id, turnId: 't1', allowed: ['L'] });
    await coord.signal('leaseAccount', { taskId: g2.id, turnId: 't2', allowed: ['L'] });
    await expect.poll(async () => (await acct('L')).inUse, { timeout: 10_000 }).toBe(2); // NOT serialized

    // Re-register with an explicit lower cap — the change is applied to the live account.
    await coord.signal('registerAccounts', { accounts: [{ id: 'L', configHome: '/tmp/L', provider: 'claude', kind: 'login', maxConcurrent: 1 }] });
    await expect.poll(async () => (await acct('L')).maxConcurrent, { timeout: 10_000 }).toBe(1);

    await g1.h.signal('finish'); await g2.h.signal('finish');
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
