import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';

/**
 * Live end-to-end test with a REAL coding agent (no mock). Gated on a real key
 * so the hermetic suite stays free/fast. Proves karmax drives a real model to
 * produce real code that merges into the user's repo — the whole point.
 *
 * Run with: OPENAI_API_KEY=… npx vitest run tests/live-agent.test.ts
 */
const LIVE = !!process.env.OPENAI_API_KEY && process.env.KARMAX_SKIP_LIVE !== '1';

describe.skipIf(!LIVE)('live agent (real model, real git)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness('codex');
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('drives a real agent to write working code that lands on main', async () => {
    const repo = await h.makeRepo('live');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          taskId,
          projectId: 'p1',
          title: 'Add an add() function',
          prompt:
            'Create a file named add.js that exports a function `add(a, b)` returning their sum, using CommonJS (module.exports). Keep it minimal. Then call signal_completion.',
          base: 'main',
          target: 'main',
          project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
        },
      ],
    });

    // the real agent works, then the task waits at Review
    await expect.poll(async () => (await handle.query('view') as any).stage, { timeout: 120_000, interval: 1500 }).toBe('review');
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');

    // the agent's real code is on main and actually works
    const onMain = await git(repo, ['show', 'main:add.js']);
    expect(onMain.code).toBe(0);
    expect(onMain.stdout).toMatch(/add/);
    const checkout = `${repo}`;
    const run = await git(checkout, ['stash']); // no-op safety
    void run;
    const { execFile } = await import('node:child_process');
    const out: string = await new Promise((resolve) => {
      execFile('node', ['-e', 'const {add}=require("./add.js"); console.log(add(2,3))'], { cwd: repo }, (_e, so) => resolve(String(so).trim()));
    });
    expect(out).toBe('5');
  }, 180_000);
});
