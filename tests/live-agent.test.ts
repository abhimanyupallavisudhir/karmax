import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * Live end-to-end test with a REAL coding agent (no mock). Gated on a real key
 * so the hermetic suite stays free/fast. Proves karmax drives a real model to
 * produce real code that merges into the user's repo — the whole point.
 *
 * Run with: KARMAX_RUN_LIVE=1 OPENAI_API_KEY=… npx vitest run tests/live-agent.test.ts
 */
const LIVE = liveEnabled() && !!process.env.OPENAI_API_KEY;

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
    const project = await h.store.createProject('Live agent', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false });
    const task = await h.store.createTask({ projectId: project.id, title: 'Add an add() function',
      workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'Add an add() function' } });
    const taskId = task.id;
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          taskId,
          projectId: project.id,
          title: 'Add an add() function',
          prompt:
            'Create a file named add.js that exports a function `add(a, b)` returning their sum, using exactly `module.exports = { add };`. Keep it minimal. Then call signal_completion.',
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
    const failures = (await h.store.eventsOfType(taskId, 'agent.activity'))
      .filter(event => event.payload.kind === 'turn' && event.payload.phase === 'failed');
    expect(failures).toEqual([]);

    // the agent's real code is on main and actually works
    const onMain = await git(repo, ['show', 'main:add.js']);
    expect(onMain.code).toBe(0);
    expect(onMain.stdout).toMatch(/add/);
    // Landing updates the branch without mutating a possibly dirty canonical
    // checkout. Execute the committed bytes and propagate Node failures.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('node', ['--input-type=commonjs', '-e',
      `${onMain.stdout}\nconsole.log(module.exports.add(2,3))`], { cwd: repo });
    const out = stdout.trim();
    expect(out).toBe('5');

    // the stored session is the REAL OpenAI Responses conversation id (SPEC §10.5)
    const session = (await h.store.kvGet(`session:${taskId}:do`));
    expect(session).toMatch(/^resp_/);
  }, 180_000);
});
