import { it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';

// A task waiting on GitHub looked again every 30 s whatever happened, and one
// installation reached 82% of its hourly GitHub budget (2026-11-09). Webhooks
// wake the watcher at once, so the poll backs off while nothing changes, and
// waits for the hourly reset once the budget is almost spent.
it('backs off while nothing changes, waits out a spent GitHub hour, and returns the observation without the budget', async () => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const taskQueue = 'github-landing-watch-test';
  const prs = [{ slug: 'test/repo', number: 1, headSha: 'abc', url: 'https://github.com/test/repo/pull/1' }];
  const looks: Array<{ at: number; rateBudget?: boolean }> = [];
  let answer: () => Record<string, unknown> = () => ({ status: 'waiting', prs, detail: 'Waiting for CI.',
    rateLimit: { limit: 5000, remaining: 4000, resetAt: Date.now() + 3_600_000 } });
  const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)) });
  const worker = await Worker.create({ connection: native, namespace: server.namespace, taskQueue, workflowBundle: bundle,
    maxCachedWorkflows: 2, maxConcurrentWorkflowTaskExecutions: 2, maxConcurrentActivityTaskExecutions: 2,
    activities: {
      mergeGithubPrs: async (_world: unknown, _prs: unknown, options: { mode?: string; rateBudget?: boolean }) => {
        looks.push({ at: Date.now(), ...(options.rateBudget ? { rateBudget: true } : {}) });
        return answer();
      },
    },
  });
  const run = worker.run();
  const handle = await client.workflow.start('githubLandingWatch', { taskQueue, workflowId: 'landing-watch-backoff', args: [{
    world: { id: 'w', kind: 'memory', root: '/fixture', branch: 'task', base: 'main' },
    previous: { status: 'waiting', prs, detail: 'Waiting for CI.' }, authority: 'creator', pollMs: 1_000,
  }] });
  try {
    await expect.poll(() => looks.length, { timeout: 20_000, interval: 20 }).toBeGreaterThanOrEqual(3);
    expect(looks.every((look) => look.rateBudget)).toBe(true);
    // 1 s, 2 s, 4 s: each wait twice the last (the dev server's timers fire on whole seconds).
    const gaps = looks.slice(1, 3).map((look, i) => look.at - looks[i]!.at);
    expect(gaps[0]!).toBeGreaterThan(1_500);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.5);

    // A webhook wakes it at once, whatever the backoff has reached.
    const woken = looks.length;
    const signalled = Date.now();
    await handle.signal('providerChanged');
    await expect.poll(() => looks.length, { timeout: 2_000, interval: 10 }).toBeGreaterThan(woken);
    expect(looks.at(-1)!.at - signalled).toBeLessThan(1_500);

    await handle.terminate();

    // With less than a fifth of the hour left, the next look waits for the
    // reset (8 s here) rather than the 2 s the backoff alone would wait.
    looks.length = 0;
    const reset = Date.now() + 8_000;
    answer = () => ({ status: 'waiting', prs, detail: 'Waiting for CI.', rateLimit: { limit: 5000, remaining: 50, resetAt: reset } });
    const spent = await client.workflow.start('githubLandingWatch', { taskQueue, workflowId: 'landing-watch-budget', args: [{
      world: { id: 'w', kind: 'memory', root: '/fixture', branch: 'task', base: 'main' },
      previous: { status: 'waiting', prs, detail: 'Waiting for CI.' }, authority: 'creator', pollMs: 1_000,
    }] });
    try {
      await expect.poll(() => looks.length, { timeout: 5_000, interval: 10 }).toBe(1);
      answer = () => ({ status: 'planned', prs, detail: 'Ready.', rateLimit: { limit: 5000, remaining: 4999, resetAt: reset + 3_600_000 } });
      await expect.poll(() => looks.length, { timeout: 15_000, interval: 20 }).toBe(2);
      expect(looks[1]!.at).toBeGreaterThanOrEqual(reset);
      // The change goes back to the task without the watcher's budget.
      expect(await spent.result()).toEqual({ status: 'planned', prs, detail: 'Ready.' });
    } finally { await spent.terminate().catch(() => undefined); }
  } finally {
    await handle.terminate().catch(() => undefined);
    worker.shutdown(); await run; await close(); await native.close(); await server.stop();
  }
}, 90_000);
