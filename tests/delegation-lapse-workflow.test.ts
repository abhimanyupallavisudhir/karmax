import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';

/**
 * task_mwhwdr1i47e5d65f20 (2026-11-15), end to end: "Run again" on a series
 * made a run whose human delegation was derived from the series'. The person
 * deleted the series while the run worked; the run's next turn failed
 * "invalid, expired, or task-mismatched human delegation" and stopped for
 * them. Its next turn here is started by no person (a system follow-up), so
 * nobody's presence renews anything: the run must simply keep acting for them.
 */
describe('a run of a deleted series', () => {
  let h: Harness;
  const previous = { floor: process.env.KARMAX_AGENT_MIN_FREE_MB, load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR };

  beforeAll(async () => {
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    h = await bootHarness('mock');
  }, 120_000);

  afterAll(async () => {
    await h?.stop();
    for (const [name, value] of [['KARMAX_AGENT_MIN_FREE_MB', previous.floor], ['KARMAX_AGENT_MAX_LOAD_FACTOR', previous.load]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('keeps acting for its person on its next turn', async () => {
    const repo = await h.makeRepo('delegation-lapse');
    const project = await h.store.createProject('Series', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false });
    const person = (await h.tokens.mintPrincipal('user:a', ['*'], undefined, undefined, project.organizationId)).token;
    const series = await h.api.createTask(person, { projectId: project.id, title: 'Monthly', draft: true,
      params: { 'agent:do': { provider: 'mock' } }, prompt: '@incomplete' } as any);
    const delegation = (await h.tokens.delegateHuman(person, { taskId: series.id, organizationId: project.organizationId }))!;
    const stored = (await h.store.getTask(series.id))!.params;
    await h.store.updateTaskParams(series.id, { ...stored, repeatable: true, _authorization: { ...stored._authorization as object,
      principal: 'user:a', scope: 'organization', organizationId: project.organizationId, delegationId: delegation.id,
      capabilities: ['task:*', 'project:read', 'signal-completion', 'merge-into:*'] } });

    const { startedTaskId: run } = await h.api.runAgain(person, series.id);
    const minted = async (count: number) => vi.waitFor(async () => {
      const events = await h.store.eventsSince(run, 0);
      expect(events.filter((event) => event.type === 'token.minted').length).toBeGreaterThanOrEqual(count);
      expect(events.some((event) => event.type === 'turn.result' && events.indexOf(event) > events.findLastIndex((e) => e.type === 'token.minted')))
        .toBe(true);
      return events;
    }, { timeout: 90_000, interval: 250 });
    await minted(1);
    const runDelegation = ((await h.store.getTask(run))!.params._authorization as { delegationId: string }).delegationId;
    expect(runDelegation).not.toBe(delegation.id);

    await h.api.deleteTask(person, series.id);
    await h.store.purgeHumanDelegations();
    expect(await h.store.getTask(series.id)).toBeUndefined();

    const system = (await h.tokens.mintPrincipal('system:test', ['*'])).token;
    await h.api.signalTask(system, run, 'followUp', '@incomplete again');
    await minted(2);
    const view = (await h.store.getTask(run))!.lastView!;
    expect(view.status).not.toBe('blocked');
    expect(String(view.error ?? '')).not.toMatch(/delegation|permission to act/);
    // The same delegation, handed up when its series' went.
    expect(((await h.store.getTask(run))!.params._authorization as { delegationId: string }).delegationId).toBe(runDelegation);
  }, 180_000);
});
