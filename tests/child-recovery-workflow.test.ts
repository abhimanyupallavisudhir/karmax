import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { newId } from '../src/util/id.js';

let h: Harness;
beforeAll(async () => { h = await bootHarness('mock'); }, 60_000);
afterAll(async () => { await h?.stop(); });

it('WF-8: a replacement preserves a live child, restores it, and still supports real cancellation', async () => {
  const repo = await h.makeRepo('child-replacement');
  const taskId = newId('task');
  const input = { taskId, projectId: 'p1', title: 'Parent', prompt: '@subtask Child :: @sleep 30000',
    base: 'main', target: 'main', project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } };
  const parent = await h.client.workflow.start('softwareDev@1.26.0', {
    taskQueue: TASK_QUEUE, workflowId: taskId, args: [input],
  });
  let replacement: typeof parent | undefined;
  let child: ReturnType<typeof h.client.workflow.getHandle> | undefined;
  try {
    await expect.poll(async () => (await parent.query<any>('view')).subTasks?.length, { timeout: 20_000 }).toBe(1);
    const snapshot = await parent.query<any>('view');
    child = h.client.workflow.getHandle(snapshot.subTasks[0]);
    await expect.poll(async () => (await child!.query<any>('view')).agentTurn?.state, { timeout: 20_000 }).toBe('running');
    await parent.signal('prepareLifecycleReplacement');
    expect(await parent.result()).toMatchObject({ stage: 'cancelled' });
    expect((await child.describe()).status.name).toBe('RUNNING');
    replacement = await h.client.workflow.start('softwareDev@1.26.0', {
      taskQueue: TASK_QUEUE, workflowId: taskId,
      args: [{ ...input, recovery: { world: snapshot.world, messages: snapshot.messages,
        seen: snapshot.state.turnsSeen, resumeStage: 'do', pausedForHuman: true } }],
    });
    await expect.poll(async () => (await replacement!.query<any>('view')).subTasks, { timeout: 20_000 })
      .toEqual(snapshot.subTasks);
    await replacement.signal('cancel');
    expect(await replacement.result()).toMatchObject({ stage: 'cancelled' });
    expect(await child.result()).toMatchObject({ stage: 'cancelled' });
  } finally {
    await replacement?.terminate('test cleanup').catch(() => undefined);
    await child?.terminate('test cleanup').catch(() => undefined);
    await parent.terminate('test cleanup').catch(() => undefined);
  }
}, 60_000);
