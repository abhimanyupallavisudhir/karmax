import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BudgetService, MockPaymentProvider } from '../src/autonomy/payments.js';
import { DurableEventFanout } from '../src/gateway/fanout.js';
import { DatabaseVault } from '../src/autonomy/vault-database.js';
import { LocalKek, organizationScope } from '../src/autonomy/vault-keys.js';
import { Store } from '../src/store/db.js';
import { noteExternalEffect } from '../src/store/sql.js';
import { storeMetricsSnapshot } from '../src/store/transaction-metrics.js';

/**
 * Store invariants under concurrent PostgreSQL transactions. Two Stores on
 * independent pools stand in for the gateway and its activity process; each
 * runs several transactions at once on its own pool. Every scenario runs both
 * concurrently (the default) and under the `KARMAX_STORE_GLOBAL_LOCK` kill
 * switch, which must keep the former serialized behaviour.
 */
const url = process.env.KARMAX_TEST_POSTGRES_URL;
const admin = url ? new Pool({ connectionString: url }) : undefined;
const stores: Store[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
afterAll(async () => { await admin?.end(); });

async function pair(options: { hosted?: boolean } = {}): Promise<[Store, Store]> {
  await admin!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const first = await Store.create(url!, options);
  stores.push(first);
  const other = new URL(url!);
  other.searchParams.set('application_name', 'karmax-concurrency-peer');
  const second = await Store.create(other.href, options);
  stores.push(second);
  return [first, second];
}

/** Run `count` calls of `operation`, alternating between the two Stores. */
function race<T>(stores: [Store, Store], count: number, operation: (store: Store, index: number) => Promise<T>) {
  return Promise.allSettled(Array.from({ length: count }, (_, index) => operation(stores[index % 2]!, index)));
}
async function taskList(store: Store, projectId: string, count: number) {
  const tasks = [];
  for (let i = 0; i < count; i++) tasks.push(await store.createTask({ projectId, title: `T${i}`, workflow: 'just-do',
    workflowVersion: '1', params: { prompt: 'work' } }));
  return tasks;
}
const fulfilled = (results: PromiseSettledResult<unknown>[]) => results.filter(result => result.status === 'fulfilled').length;
const reasons = (results: PromiseSettledResult<unknown>[]) => results.flatMap(result =>
  result.status === 'rejected' ? [String((result.reason as Error)?.message ?? result.reason)] : []);

describe.skipIf(!url).each([
  { mode: 'concurrent', globalLock: '' },
  { mode: 'global lock (kill switch)', globalLock: '1' },
])('Store invariants with $mode PostgreSQL transactions', ({ globalLock }) => {
  beforeAll(() => { vi.stubEnv('KARMAX_STORE_GLOBAL_LOCK', globalLock); });
  afterAll(() => { vi.unstubAllEnvs(); });

  it('admits no more hosted worlds than the organization allows', async () => {
    const [a, b] = await pair({ hosted: true });
    const organization = await a.createOrganization({ name: 'Leases', ownerUserId: 'owner' });
    const project = await a.createProject('Leases', {}, organization.id);
    await a.setOrganizationUsagePolicy(organization.id, { maxActiveAgentTurns: 2, maxRemoteStartsPerMinute: 1_000 });
    const allowed = (await a.getOrganizationUsagePolicy(organization.id)).maxActiveWorlds;
    expect(allowed).toBeLessThan(8);
    await a.createRunnerPool({ id: 'pool', organizationId: organization.id, name: 'Cloud', provider: 'e2b', mode: 'customer',
      capacity: { activeWorlds: 100, cpu: 1_000, memoryMb: 1_000_000, gpu: 0 }, enabled: true });
    const tasks = await taskList(a, project.id, 8);
    const results = await race([a, b], 8, (store, i) => store.requestWorldLease({ runnerPoolId: 'pool',
      organizationId: organization.id, projectId: project.id, taskId: tasks[i]!.id, worldId: tasks[i]!.id }));
    expect(reasons(results)).toEqual([]);
    const acquired = results.filter(result => result.status === 'fulfilled' && result.value.acquired);
    expect(acquired).toHaveLength(allowed);
    // Releasing every active lease promotes exactly as many queued ones.
    await race([a, b], acquired.length, (store, i) => store.releaseWorldLease((acquired[i] as PromiseFulfilledResult<{ id: string }>).value.id));
    const active = await admin!.query("SELECT COUNT(*)::int n FROM world_leases WHERE state='active'");
    expect(active.rows[0].n).toBe(allowed);
  });

  it('admits no more worlds than a runner pool holds', async () => {
    const [a, b] = await pair();
    const project = await a.createProject('Pool');
    await a.createRunnerPool({ id: 'local', organizationId: project.organizationId!, name: 'Local', provider: 'worktree',
      mode: 'customer', capacity: { activeWorlds: 3, cpu: 1_000, memoryMb: 1_000_000, gpu: 0 }, enabled: true });
    const tasks = await taskList(a, project.id, 8);
    const results = await race([a, b], 8, (store, i) => store.requestWorldLease({ runnerPoolId: 'local',
      organizationId: project.organizationId!, projectId: project.id, taskId: tasks[i]!.id, worldId: tasks[i]!.id }));
    expect(reasons(results)).toEqual([]);
    expect(results.filter(result => result.status === 'fulfilled' && result.value.acquired)).toHaveLength(3);
  });

  it('admits no more concurrent agent turns than the organization allows', async () => {
    const [a, b] = await pair();
    const project = await a.createProject('Agents');
    const task = await a.createTask({ projectId: project.id, title: 'Work', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: 'work' } });
    await a.setOrganizationUsagePolicy(project.organizationId!, { maxActiveAgentTurns: 2, maxAgentStartsPerMinute: 1_000 });
    const results = await race([a, b], 8, (store, i) => store.admitAgentUsage({ id: `turn-${i}`,
      organizationId: project.organizationId!, projectId: project.id, taskId: task.id, provider: 'anthropic', fundingSource: 'customer' }));
    expect(fulfilled(results)).toBe(2);
    expect(new Set(reasons(results))).toEqual(new Set(['organization active model turn limit reached']));
  });

  it('never reserves uploads beyond a storage quota', async () => {
    const [a, b] = await pair();
    const project = await a.createProject('Storage');
    const organizationId = project.organizationId!;
    await a.saveStorageLocation({ id: 'bucket', organizationId, name: 'Bucket', kind: 's3', config: { bucket: 'b' },
      isDefault: false, status: 'ready', quotaBytes: 1_000 });
    const results = await race([a, b], 8, (store, i) => store.reserveStorageUpload(`upload-${i}`, organizationId, 'bucket', 300,
      Date.now() + 60_000));
    expect(fulfilled(results)).toBe(3);
    const reserved = await admin!.query('SELECT COALESCE(SUM(bytes),0)::int n FROM storage_upload_reservations');
    expect(reserved.rows[0].n).toBe(900);
  });

  it('never counts a quota as free while chunks are retained concurrently', async () => {
    const [a, b] = await pair();
    const project = await a.createProject('Chunks');
    const organizationId = project.organizationId!;
    await a.saveStorageLocation({ id: 'bucket', organizationId, name: 'Bucket', kind: 's3', config: { bucket: 'b' },
      isDefault: false, status: 'ready', quotaBytes: 1_000 });
    const results = await race([a, b], 8, (store, i) => store.retainResourceChunks(organizationId,
      [{ id: `chunk-${i}`, bytes: 300 }], 'bucket'));
    expect(fulfilled(results)).toBe(3);
    expect((await a.storageLocationUsage('bucket')).retainedBytes).toBe(900);
  });

  it('keeps chunk reference counts exact under concurrent retain and release', async () => {
    const [a, b] = await pair();
    const organizationId = (await a.createProject('Refs')).organizationId!;
    await a.retainResourceChunks(organizationId, [{ id: 'shared', bytes: 10 }]);
    // One reference is held throughout; 6 more come and go concurrently.
    await race([a, b], 6, store => store.retainResourceChunks(organizationId, [{ id: 'shared', bytes: 10 }]));
    const released = await race([a, b], 6, store => store.releaseResourceChunks(organizationId, ['shared']));
    expect(reasons(released)).toEqual([]);
    expect(released.flatMap(result => result.status === 'fulfilled' ? result.value : [])).toEqual([]);
    expect((await admin!.query("SELECT refs::int FROM resource_snapshot_chunks WHERE \"chunkId\"='shared'")).rows).toEqual([{ refs: 1 }]);
  });

  it('never grants spend beyond a task budget', async () => {
    const [a, b] = await pair();
    const project = await a.createProject('Payments');
    const provider = new MockPaymentProvider(a);
    const card = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Work', cap: 100_000 });
    await provider.fund(card.id, 100_000);
    const task = await a.createTask({ projectId: project.id, title: 'Pay', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'Pay', paymentPolicy: { cardIds: [card.id], budget: 300 },
        _authorization: { capabilities: [`use-card:${card.id}`] } } });
    const ctx = { projectId: project.id, taskId: task.id, capabilities: [`use-card:${card.id}`] };
    const services = [new BudgetService(a, provider), new BudgetService(b, new MockPaymentProvider(b))];
    const results = await race([a, b], 8, (_store, i) => services[i % 2]!.request(ctx, { amount: 100, why: `spend ${i}` }));
    expect(reasons(results)).toEqual([]);
    expect(results.filter(result => result.status === 'fulfilled' && result.value.status === 'granted')).toHaveLength(3);
    expect(await a.paymentSpent(task.id)).toBe(300);
  });

  it('loses no concurrent review-info merges', async () => {
    const [a, b] = await pair();
    const project = await a.createProject('Review');
    const task = await a.createTask({ projectId: project.id, title: 'Review', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: 'work' } });
    const fields = ['summary', 'caption', 'notes', 'risks', 'testing', 'followUps'];
    const results = await race([a, b], fields.length, (store, i) =>
      store.checkpointReviewInfo(task.id, { [fields[i]!]: `value ${i}` } as never));
    expect(reasons(results)).toEqual([]);
    expect(Object.keys(JSON.parse((await a.kvGet(`pending-review:${task.id}`))!)).sort()).toEqual([...fields].sort());
  });

  it('lets exactly one compare-and-set win', async () => {
    const [a, b] = await pair();
    await a.kvSet('cas', 'v0');
    const results = await race([a, b], 8, (store, i) => store.kvCompareAndSet('cas', 'v0', `v${i + 1}`));
    expect(results.filter(result => result.status === 'fulfilled' && result.value === true)).toHaveLength(1);
  });

  it('numbers concurrently created tasks uniquely', async () => {
    const [a, b] = await pair();
    const project = await a.createProject('Numbers');
    const results = await race([a, b], 8, (store, i) => store.createTask({ projectId: project.id, title: `T${i}`,
      workflow: 'just-do', workflowVersion: '1', params: { prompt: 'work' } }));
    expect(reasons(results)).toEqual([]);
    const numbers = results.map(result => (result as PromiseFulfilledResult<{ num?: number }>).value.num);
    expect(new Set(numbers).size).toBe(8);
  });

  it('keeps a connection for reads while transactions wait on one entity lock', async () => {
    const [a] = await pair();
    const project = await a.createProject('Busy');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>(resolve => { locked = resolve; });
    const holder = a.transaction(async () => { await a.lock(`org:${project.organizationId}`); locked(); await held; });
    await holding;
    // More waiters than the pool has connections.
    const waiters = Array.from({ length: 6 }, () => a.transaction(async () => { await a.lock(`org:${project.organizationId}`); }));
    try {
      const started = Date.now();
      expect((await a.getProject(project.id))?.id).toBe(project.id);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      release();
      await holder;
      await Promise.allSettled(waiters);
    }
  });

  it('pages `since` past an event that commits after a later one, exactly once', async () => {
    const [a, b] = await pair();
    const project = await a.createProject('Since');
    // Two tasks: one task's events already commit in seq order under its row.
    const [first, second] = await taskList(a, project.id, 2);
    let cursor = await b.latestEventSeq();
    const seen: string[] = [];
    const poll = async () => {
      for (const event of await b.allEventsSince(cursor)) {
        if (event.type.startsWith('test.')) seen.push(event.type);
        cursor = event.seq;
      }
    };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let appended!: () => void;
    const inserted = new Promise<void>(resolve => { appended = resolve; });
    const early = a.transaction(async () => {
      await a.appendEvent({ type: 'test.early', taskId: first!.id, ts: Date.now(), payload: {} });
      appended();
      await held;
    });
    await inserted;
    const late = b.appendEvent({ type: 'test.late', taskId: second!.id, ts: Date.now(), payload: {} });
    // Concurrently the higher seq commits now; under the global lock it waits.
    await Promise.race([late, new Promise(resolve => setTimeout(resolve, 300))]);
    await poll();
    expect(seen).toEqual([]);
    release();
    await Promise.all([early, late]);
    await poll();
    await poll();
    expect(seen).toEqual(['test.early', 'test.late']);
  });

  it('pages the audit log past an entry that commits after a later one, exactly once', async () => {
    const [a, b] = await pair();
    let cursor = (await b.auditRecent(1)).at(-1)?.seq ?? 0;
    const seen: string[] = [];
    const poll = async () => {
      for (const entry of await b.auditSince(cursor)) {
        if (String(entry.action).startsWith('test.')) seen.push(entry.action);
        cursor = entry.seq;
      }
    };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let appended!: () => void;
    const inserted = new Promise<void>(resolve => { appended = resolve; });
    const early = a.transaction(async () => {
      await a.appendAudit({ principalId: 'system:test', action: 'test.early' });
      appended();
      await held;
    });
    await inserted;
    const late = b.appendAudit({ principalId: 'system:test', action: 'test.late' });
    await Promise.race([late, new Promise(resolve => setTimeout(resolve, 300))]);
    await poll();
    expect(seen).toEqual([]);
    release();
    await Promise.all([early, late]);
    await poll();
    await poll();
    expect(seen).toEqual(['test.early', 'test.late']);
  });

  it('delivers an event that commits after a later one to live subscribers', async () => {
    const [a, b] = await pair();
    const project = await a.createProject('Events');
    const task = await a.createTask({ projectId: project.id, title: 'Events', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: 'work' } });
    const fanout = await DurableEventFanout.create(b, undefined, 20);
    const seen: string[] = [];
    const off = fanout.on(event => { if (event.type.startsWith('test.')) seen.push(event.type); });
    try {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let appended!: () => void;
      const inserted = new Promise<void>(resolve => { appended = resolve; });
      const early = a.transaction(async () => {
        await a.appendEvent({ type: 'test.early', taskId: task.id, ts: Date.now(), payload: {} });
        appended();
        await held;
      });
      await inserted;
      const late = b.appendEvent({ type: 'test.late', taskId: task.id, ts: Date.now(), payload: {} });
      // Let the subscriber read past the early event's seq before it commits.
      // Under the global lock the later append waits for the early commit instead.
      await Promise.race([late.then(() => vi.waitFor(() => expect(seen).toContain('test.late'), { timeout: 2_000 })),
        new Promise(resolve => setTimeout(resolve, 300))]);
      release();
      await Promise.all([early, late]);
      await vi.waitFor(() => expect(seen.sort()).toEqual(['test.early', 'test.late']), { timeout: 5_000 });
    } finally { off(); fanout.close(); }
  });
});

describe.skipIf(!url)('deadlocks between concurrent PostgreSQL transactions', () => {
  /** Two transactions on independent pools take the same two task rows in
   * opposite orders: PostgreSQL aborts one of them with 40P01. */
  async function deadlock(sideEffect: boolean) {
    const [a, b] = await pair();
    const project = await a.createProject('Deadlock');
    const [one, two] = await taskList(a, project.id, 2);
    let aHolds!: () => void, bHolds!: () => void;
    const aLocked = new Promise<void>(resolve => { aHolds = resolve; });
    const bLocked = new Promise<void>(resolve => { bHolds = resolve; });
    const runs = { a: 0, b: 0 };
    const side = (store: Store, mine: string, theirs: string, key: 'a' | 'b', holds: () => void, other: Promise<void>) =>
      store.transaction(async () => {
        runs[key]++;
        await store.lockTask(mine);
        holds();
        await other;
        if (sideEffect) noteExternalEffect();
        await store.lockTask(theirs);
        await store.kvSet(`deadlock:${key}`, String(runs[key]));
      });
    const results = await Promise.allSettled([side(a, one!.id, two!.id, 'a', aHolds, bLocked),
      side(b, two!.id, one!.id, 'b', bHolds, aLocked)]);
    return { a, results, runs };
  }

  it('re-runs the side PostgreSQL aborted, so both complete', async () => {
    const before = storeMetricsSnapshot();
    const { a, results, runs } = await deadlock(false);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(runs.a + runs.b).toBeGreaterThanOrEqual(3);
    expect(await a.kvGet('deadlock:a')).toBe(String(runs.a));
    expect(await a.kvGet('deadlock:b')).toBe(String(runs.b));
    const after = storeMetricsSnapshot();
    expect(after.failures.deadlock).toBeGreaterThan(before.failures.deadlock);
    expect(after.retries.retried).toBeGreaterThan(before.retries.retried);
  });

  it('never deadlocks a vault write against rotating or shredding its scope, nor writes under a retired key', async () => {
    const [a, b] = await pair();
    const kek = { current: LocalKek.fromText('store-concurrency-vault-key-material-01'), others: [] };
    const one = await DatabaseVault.open(a.db, { kek });
    const two = await DatabaseVault.open(b.db, { kek });
    const scope = organizationScope('org_race');
    const handles = new Set<string>();
    // Each surviving entry must open with its scope's current keyring: a write
    // under a retired (rotated or shredded) data key would not.
    const assertReadable = async () => {
      for (const handle of handles) if (await one.has(handle)) expect(await two.reveal(handle)).toMatch(/^v/);
    };
    await one.put('seed', 'v0', scope); handles.add('seed');
    for (let round = 0; round < 6; round++) {
      handles.add(`rotate-${round}`);
      const results = await Promise.allSettled([one.put(`rotate-${round}`, `v${round}`, scope), two.rotateDataKey(scope)]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
      await assertReadable();
    }
    // Organization deletion shreds the scope while a vault write runs inside a
    // caller's transaction holding the organization's vault lock (as VaultItems does).
    for (let round = 0; round < 6; round++) {
      handles.add(`late-${round}`);
      const results = await Promise.allSettled([
        b.transaction(async () => { await b.lock('vault:org_race'); await two.put(`late-${round}`, `v${round}`, scope); }),
        one.destroyScope(scope),
      ]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const ring = await a.db.prepare('SELECT 1 AS present FROM vault_keyrings WHERE scope=?').get(scope);
      const entries = Number(((await a.db.prepare('SELECT COUNT(*) AS n FROM vault_entries WHERE scope=?').get(scope)) as { n: number }).n);
      // Shredded last: nothing left. Written last: a new keyring holds what was written.
      expect(entries === 0 || !!ring).toBe(true);
      await assertReadable();
    }
  });

  it('reports the deadlock instead of re-running an attempt that wrote outside the database', async () => {
    const before = storeMetricsSnapshot();
    const { results, runs } = await deadlock(true);
    const failed = results.filter(result => result.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: '40P01' });
    expect(runs.a + runs.b).toBe(2);
    expect(storeMetricsSnapshot().retries.unsafe).toBe(before.retries.unsafe + 1);
  });
});
