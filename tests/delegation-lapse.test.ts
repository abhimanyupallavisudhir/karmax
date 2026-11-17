import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { HumanDelegationLapsed, TokenAuthority } from '../src/platform/tokens.js';
import type { TaskView } from '../src/domain/types.js';
import { isDelegationLapseOfItsOwn } from '../src/domain/escalation.js';

/**
 * A human delegation tavya minted for a task must never strand it with a
 * person (wiki incidents/lessons, fingerprint 8209137dc12067d1): one task's
 * lifecycle (a series, an attempt or a parent deleted) never takes another's
 * permission with it, and one that lapses on its own is renewed by the person
 * it acts for when they act on the task.
 */
describe('a task\'s human delegation', () => {
  let store: Store;
  let tokens: TokenAuthority;
  let organizationId: string;
  let projectId: string;

  beforeEach(async () => {
    store = await Store.create(':memory:');
    tokens = new TokenAuthority(store);
    const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'alice' });
    organizationId = organization.id;
    projectId = (await store.createProject('Site', {}, organization.id)).id;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await store.close();
  });

  const task = (title: string, params: Record<string, unknown> = {}) => store.createTask({ projectId, title,
    workflow: 'software-dev', workflowVersion: '1.30.0', createdBy: { kind: 'user', userId: 'alice' }, params: { prompt: title, ...params } });
  const turn = (taskId: string, delegationId: string) => tokens.mint({ taskId, profileId: 'do', role: 'do', principal: 'user:alice',
    projectId, organizationId, ceiling: ['task:read'], grantorCaps: ['task:read'], delegationId });
  const alice = async () => (await tokens.mintPrincipal('user:alice', ['task:read', 'task:create'], projectId, 60_000, organizationId)).token;

  // task_mwhwdr1i47e5d65f20, 2026-11-15: "Run again" on a monthly series made a
  // run whose delegation was derived from the series'. The person deleted the
  // series an hour later; that revoked its delegation, the retention sweep
  // purged it, and the run's next turn failed "invalid, expired, or
  // task-mismatched human delegation", stopping it for the person.
  it('outlives the task it was derived from being deleted', async () => {
    const series = await task('Monthly link check', { repeatable: true });
    const run = await task('Monthly link check', { runOf: series.id });
    const seriesDelegation = (await tokens.delegateHuman(await alice(), { taskId: series.id, projectId, organizationId,
      externalIdentities: { githubAccountId: '42' } }))!;
    const runDelegation = await tokens.deriveHumanDelegation(seriesDelegation.id, { taskId: run.id, projectId, organizationId });
    // Its sub-task, derived in turn from the run's.
    const child = await task('Sub-task');
    const childDelegation = await tokens.deriveHumanDelegation(runDelegation.id, { taskId: child.id, projectId, organizationId });

    await store.deleteTask(series.id);
    await store.purgeHumanDelegations();

    const minted = await turn(run.id, runDelegation.id);
    expect(minted.record.humanSubject).toMatchObject({ userId: 'alice', presence: 'delegated', externalIdentities: { githubAccountId: '42' } });
    expect(minted.record.expiresAt).toBeLessThanOrEqual(seriesDelegation.expiresAt);
    expect((await turn(child.id, childDelegation.id)).record.humanSubject?.userId).toBe('alice');

    // The run deleted in its turn: its sub-task still acts for alice.
    await store.deleteTask(run.id);
    await store.purgeHumanDelegations();
    expect((await turn(child.id, childDelegation.id)).record.humanSubject?.userId).toBe('alice');
    // The deleted task's own delegation is gone.
    await expect(turn(run.id, runDelegation.id)).rejects.toThrow(HumanDelegationLapsed);
  });

  it('is still revoked with a scope it lies in', async () => {
    const series = await task('Series');
    const run = await task('Run');
    const seriesDelegation = (await tokens.delegateHuman(await alice(), { taskId: series.id, projectId, organizationId }))!;
    const runDelegation = await tokens.deriveHumanDelegation(seriesDelegation.id, { taskId: run.id, projectId, organizationId });
    await store.revokeHumanDelegations({ organizationId });
    await expect(turn(run.id, runDelegation.id)).rejects.toThrow();
  });

  // Production held five live delegations whose parent had been revoked and
  // purged before this fix: the retention sweep repairs them.
  it('is repaired by the retention sweep when its parent was already purged', async () => {
    const run = await task('Run');
    const now = Date.now(), expiresAt = now + 86_400_000;
    await store.putHumanDelegation('dlg_orphan', { id: 'dlg_orphan', taskId: run.id, humanUserId: 'alice', projectId, organizationId,
      parentDelegationId: 'dlg_purged', issuedAt: now, expiresAt }, expiresAt);
    // And one whose parent is revoked but not yet purged.
    const parent = await task('Parent');
    await store.putHumanDelegation('dlg_revoked', { id: 'dlg_revoked', taskId: parent.id, humanUserId: 'alice', projectId, organizationId,
      issuedAt: now, expiresAt }, expiresAt);
    const sibling = await task('Sibling');
    await store.putHumanDelegation('dlg_sibling', { id: 'dlg_sibling', taskId: sibling.id, humanUserId: 'alice', projectId, organizationId,
      parentDelegationId: 'dlg_revoked', issuedAt: now, expiresAt }, expiresAt);
    await store.db.prepare('UPDATE human_delegations SET revokedAt=? WHERE id=?').run(now, 'dlg_revoked');
    await expect(turn(run.id, 'dlg_orphan')).rejects.toThrow();

    await store.purgeHumanDelegations();

    expect((await turn(run.id, 'dlg_orphan')).record.humanSubject?.userId).toBe('alice');
    expect((await turn(sibling.id, 'dlg_sibling')).record.humanSubject?.userId).toBe('alice');
  });

  it('says in words, when it lapses, who renews it and how', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    const run = await task('Run');
    const delegation = (await tokens.delegateHuman(await alice(), { taskId: run.id, projectId, organizationId, ttlMs: 60_000 }))!;
    vi.setSystemTime(new Date('2026-12-20T00:00:00Z'));
    const failure = await turn(run.id, delegation.id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HumanDelegationLapsed);
    expect(String((failure as Error).message)).toMatch(/permission to act for .* expired on 2026-11-15.*Retry/);
    // The person's to renew, so not reported as tavya's error; one withdrawn still is.
    expect(isDelegationLapseOfItsOwn(`Activity task failed → ${(failure as Error).message}`)).toBe(true);
    expect(isDelegationLapseOfItsOwn(new HumanDelegationLapsed('dlg_x').message)).toBe(false);
  });

  // tavya-error dbf20980640bd94b, 2026-11-17: a series' delegation expired on
  // its own, the hourly sweep deleted the row, and its next run's lapse read
  // as "withdrawn" — reported as tavya's error, the person told something false.
  it('still says it expired, not that it was withdrawn, once the retention sweep has purged it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T19:29:16Z'));
    const series = await task('Repair GitHub workflow');
    const expired = (await tokens.delegateHuman(await alice(), { taskId: series.id, projectId, organizationId, ttlMs: 30 * 86_400_000 }))!;
    const other = await task('Deleted');
    const withdrawn = (await tokens.delegateHuman(await alice(), { taskId: other.id, projectId, organizationId, ttlMs: 30 * 86_400_000 }))!;
    await store.revokeHumanDelegationsForTask(other.id);
    vi.setSystemTime(new Date('2026-11-17T07:17:40Z'));
    await store.purgeHumanDelegations();
    const lapse = async (delegationId: string) => String(((await turn(series.id, delegationId).catch((error: unknown) => error)) as Error).message);
    expect(await lapse(expired.id)).toMatch(/expired on 2026-11-16\b/);
    expect(isDelegationLapseOfItsOwn(`Activity task failed → ${await lapse(expired.id)}`)).toBe(true);
    expect(await lapse(withdrawn.id)).toMatch(/was withdrawn/);
    // What is kept says nothing of the person or what they allowed.
    const kept = await store.db.prepare('SELECT json FROM human_delegations WHERE id IN (?, ?)').all(expired.id, withdrawn.id) as Array<{ json: string }>;
    expect(kept.map((row) => row.json)).toEqual(['{}', '{}']);
    // Forgotten after a year: a lapse then says only what it can — that it lapsed, the
    // person's to renew — never a withdrawal nothing shows, which is reported as tavya's error.
    vi.setSystemTime(new Date('2027-11-18T00:00:00Z'));
    await store.purgeHumanDelegations();
    expect(await store.db.prepare('SELECT id FROM human_delegations WHERE id IN (?, ?)').all(expired.id, withdrawn.id)).toEqual([]);
    for (const id of [expired.id, withdrawn.id]) {
      expect(await lapse(id)).toMatch(/permission to act for the person who authorized it has lapsed\. It is renewed when that person presses Retry/);
      expect(isDelegationLapseOfItsOwn(`Activity task failed → ${await lapse(id)}`)).toBe(true);
    }
  });

  // tavya-error dbf20980640bd94b again, 2026-11-17 12:56 UTC, after the tombstones deployed:
  // "Repair GitHub workflow Promote" (#977) ran from a series whose delegation the sweep had
  // deleted before there were tombstones. A missing row shows no withdrawal; a revoked row does.
  it('says a delegation purged before tombstones has lapsed, and only a revoked one was withdrawn', async () => {
    const series = await task('Repair GitHub workflow');
    const purged = (await tokens.delegateHuman(await alice(), { taskId: series.id, projectId, organizationId }))!;
    await store.db.prepare('DELETE FROM human_delegations WHERE id=?').run(purged.id);
    const failure = await turn(series.id, purged.id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HumanDelegationLapsed);
    expect((failure as Error).message).toMatch(/has lapsed\./);
    expect(isDelegationLapseOfItsOwn(`Activity task failed → ${(failure as Error).message}`)).toBe(true);
    const other = await task('Other');
    const revoked = (await tokens.delegateHuman(await alice(), { taskId: other.id, projectId, organizationId }))!;
    await store.revokeHumanDelegationsForTask(other.id);
    const withdrawal = String(((await turn(other.id, revoked.id).catch((error: unknown) => error)) as Error).message);
    expect(withdrawal).toMatch(/was withdrawn/);
    expect(isDelegationLapseOfItsOwn(`Activity task failed → ${withdrawal}`)).toBe(false);
  });

  describe('renewed by the person it acts for', () => {
    async function blocked() {
      const authorization = await AuthorizationService.create(store);
      const signals: string[] = [];
      const client = { workflow: { getHandle: (id: string) => ({
        describe: async () => ({ runId: 'run', status: { name: 'RUNNING' } }),
        query: async () => (await store.getTask(id))?.lastView,
        signal: async (name: string) => { signals.push(name); },
        executeUpdate: async () => undefined,
      }), start: async () => ({}) } } as any;
      const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
      const run = await task('Run', { _githubAccountId: '42' });
      const delegation = (await tokens.delegateHuman(await alice(), { taskId: run.id, projectId, organizationId, ttlMs: 60_000,
        externalIdentities: { githubAccountId: '42' } }))!;
      await store.updateTaskParams(run.id, { ...run.params, _authorization: { level: 'developer', scope: 'projects', projectIds: [projectId],
        organizationId, principal: 'user:alice', capabilities: ['task:read'], delegationId: delegation.id } });
      await store.saveView(run.id, { taskId: run.id, title: 'Run', workflow: 'software-dev', stage: 'do', status: 'blocked',
        error: 'Activity task failed → lapsed', messages: [], actions: [{ kind: 'signal', name: 'retry', label: 'Retry' }],
        state: {}, updatedAt: 1 } as unknown as TaskView);
      return { api, run, delegation, signals };
    }
    const delegationOf = async (taskId: string) =>
      ((await store.getTask(taskId))!.params._authorization as { delegationId: string }).delegationId;
    const userToken = async (userId: string) =>
      (await tokens.mintPrincipal(`user:${userId}`, ['task:read', 'task:signal', 'task:create'], projectId, 60_000, organizationId)).token;

    it('when they press Retry', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { api, run, delegation, signals } = await blocked();
      vi.setSystemTime(Date.now() + 120_000);
      await expect(turn(run.id, delegation.id)).rejects.toThrow(HumanDelegationLapsed);

      await api.signalTask(await userToken('alice'), run.id, 'retry');

      expect(signals).toContain('retry');
      const renewed = await delegationOf(run.id);
      expect(renewed).not.toBe(delegation.id);
      const minted = await turn(run.id, renewed);
      expect(minted.record.humanSubject).toMatchObject({ userId: 'alice', externalIdentities: { githubAccountId: '42' } });
    });

    it('but not by anyone else', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { api, run, delegation } = await blocked();
      vi.setSystemTime(Date.now() + 120_000);
      await api.signalTask(await userToken('bob'), run.id, 'retry').catch(() => undefined);
      expect(await delegationOf(run.id)).toBe(delegation.id);
    });

    // A monthly series nobody ran by hand for 30 days: its scheduled run still
    // starts, says why it stops, and the person's Retry renews it; Run again
    // renews the series itself.
    it('for a run of a series whose permission lapsed, and for the series on Run again', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { api } = await blocked();
      const series = await task('Monthly', { repeatable: true, _githubAccountId: '42' });
      const seriesDelegation = (await tokens.delegateHuman(await alice(), { taskId: series.id, projectId, organizationId, ttlMs: 60_000,
        externalIdentities: { githubAccountId: '42' } }))!;
      await store.updateTaskParams(series.id, { ...series.params, _authorization: { level: 'developer', scope: 'projects',
        projectIds: [projectId], organizationId, principal: 'user:alice', capabilities: ['task:read'], delegationId: seriesDelegation.id } });
      vi.setSystemTime(Date.now() + 120_000);

      const scheduler = (await tokens.mintPrincipal('system:triggers', ['*'])).token;
      const { startedTaskId: run } = await api.fireTriggeredTask(scheduler, series.id, 'clone');
      await expect(turn(run, await delegationOf(run))).rejects.toThrow(/expired on/);
      await store.saveView(run, { taskId: run, title: 'Monthly', workflow: 'software-dev', stage: 'do', status: 'blocked',
        error: 'lapsed', messages: [], actions: [{ kind: 'signal', name: 'retry', label: 'Retry' }], state: {}, updatedAt: 1 } as unknown as TaskView);
      await api.signalTask(await userToken('alice'), run, 'retry');
      expect((await turn(run, await delegationOf(run))).record.humanSubject?.externalIdentities?.githubAccountId).toBe('42');

      const { startedTaskId: again } = await api.runAgain(await userToken('alice'), series.id);
      expect(await delegationOf(series.id)).not.toBe(seriesDelegation.id);
      expect((await turn(again, await delegationOf(again))).record.humanSubject?.userId).toBe('alice');
    });

    // #977 and #982, 2026-11-17: runs of "Repair GitHub workflow", whose
    // series' permission had lapsed. Retry on #977 renewed #977 alone, so the
    // next failure's run (#982) stopped the same way, and so would every one
    // after it. A run acts through its series' permission: the person acting
    // on the run renews that too.
    it('for the series too when they act on one of its runs, so its next run starts', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { api } = await blocked();
      const series = await task('Repair', { repeatable: true, _githubAccountId: '42' });
      const seriesDelegation = (await tokens.delegateHuman(await alice(), { taskId: series.id, projectId, organizationId, ttlMs: 60_000,
        externalIdentities: { githubAccountId: '42' } }))!;
      await store.updateTaskParams(series.id, { ...series.params, _authorization: { level: 'developer', scope: 'projects',
        projectIds: [projectId], organizationId, principal: 'user:alice', capabilities: ['task:read'], delegationId: seriesDelegation.id } });
      vi.setSystemTime(Date.now() + 120_000);

      const scheduler = (await tokens.mintPrincipal('system:triggers', ['*'])).token;
      const { startedTaskId: first } = await api.fireTriggeredTask(scheduler, series.id, 'clone');
      await store.saveView(first, { taskId: first, title: 'Repair', workflow: 'software-dev', stage: 'do', status: 'blocked',
        error: 'lapsed', messages: [], actions: [{ kind: 'signal', name: 'retry', label: 'Retry' }], state: {}, updatedAt: 1 } as unknown as TaskView);
      await api.signalTask(await userToken('alice'), first, 'retry');
      expect(await delegationOf(series.id)).not.toBe(seriesDelegation.id);

      const { startedTaskId: next } = await api.fireTriggeredTask(scheduler, series.id, 'clone');
      expect((await turn(next, await delegationOf(next))).record.humanSubject?.externalIdentities?.githubAccountId).toBe('42');
    });

    it('but not the series for someone it does not act for', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { api } = await blocked();
      const series = await task('Repair', { repeatable: true });
      const seriesDelegation = (await tokens.delegateHuman(await alice(), { taskId: series.id, projectId, organizationId, ttlMs: 60_000 }))!;
      await store.updateTaskParams(series.id, { ...series.params, _authorization: { level: 'developer', scope: 'projects',
        projectIds: [projectId], organizationId, principal: 'user:alice', capabilities: ['task:read'], delegationId: seriesDelegation.id } });
      vi.setSystemTime(Date.now() + 120_000);
      const scheduler = (await tokens.mintPrincipal('system:triggers', ['*'])).token;
      const { startedTaskId: run } = await api.fireTriggeredTask(scheduler, series.id, 'clone');
      await api.signalTask(await userToken('bob'), run, 'retry').catch(() => undefined);
      expect(await delegationOf(series.id)).toBe(seriesDelegation.id);
    });

    it('and left alone while it holds', async () => {
      const { api, run, delegation } = await blocked();
      await store.updateTaskParams(run.id, { ...(await store.getTask(run.id))!.params,
        _authorization: { ...(await store.getTask(run.id))!.params._authorization as object, delegationId: delegation.id } });
      // A fresh 30-day delegation, nowhere near lapsing.
      const fresh = (await tokens.delegateHuman(await alice(), { taskId: run.id, projectId, organizationId,
        externalIdentities: { githubAccountId: '42' } }))!;
      await store.updateTaskParams(run.id, { ...(await store.getTask(run.id))!.params,
        _authorization: { ...(await store.getTask(run.id))!.params._authorization as object, delegationId: fresh.id } });
      await api.signalTask(await userToken('alice'), run.id, 'retry');
      expect(await delegationOf(run.id)).toBe(fresh.id);
    });
  });
});
