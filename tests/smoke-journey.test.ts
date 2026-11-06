import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { runSmoke } from '../src/ops/smoke.js';

/**
 * The smoke test's signed-in journey against a real gateway, Temporal and
 * worker (tests/smoke.test.ts covers its judgement against a stand-in): the
 * routes, the command task and the view it reads are the ones it will meet on
 * tavya.io, so a change to any of them that would blind the deploy gate fails here.
 */
describe('smoke test journey (real gateway + Temporal)', () => {
  let h: Harness;
  let url: string;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    h = await bootHarness('mock');
    const started = await h.startGateway();
    url = started.url;
    // The command calls tavya back from inside its computer, as on tavya.io.
    process.env.KARMAX_GATEWAY_URL = url;
    const repo = await h.makeRepo('smoke-repo');
    projectId = (await h.store.createProject('Smoke', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' })).id;
    token = (await h.tokens.mintPrincipal('user:smoke', ['*'], projectId)).token;
  }, 90_000);
  afterAll(async () => {
    delete process.env.KARMAX_GATEWAY_URL;
    await h?.stop();
  });

  it('serves the console, signs in, and runs a command task that reaches tavya from its computer', async () => {
    const report = await runSmoke({ url, token, projectId, pollMs: 250, journeyTimeoutMs: 90_000 });
    expect(report.steps.filter((step) => step.outcome !== 'ok')).toEqual([]);
    expect(report.outcome).toBe('ok');
    const taskId = report.steps.find((step) => step.name === 'task')!.detail.match(/task_[A-Za-z0-9_-]+/)![0];
    const task = (await h.store.getTask(taskId))!;
    expect(task.params?.command).toContain('tavya-smoke');
    expect((await h.store.eventsSince(taskId, 0)).filter((event) => event.type === 'turn.start')).toEqual([]);
  }, 120_000);
});
