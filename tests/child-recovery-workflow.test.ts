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

// WF-31: a person or agent action that replaces a child's run (a stage move, a
// hold for human input, an escalation, a permission request) ends that run
// through its cancellation cleanup while the task goes on. The parent used to
// read that run's result as the child's settlement, "finished: cancelled",
// and then never heard how the child really ended.
async function parentWithSleepingChild(name: string, childPrompt = '@sleep 30000') {
  const repo = await h.makeRepo(name);
  const project = (await h.store.createProject(name, { repos: [repo] }));
  const prompt = `@subtask Child :: ${childPrompt}\n@wait`;
  const task = (await h.store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
    workflowVersion: '1.26.0', params: { prompt } }));
  const parent = await h.client.workflow.start('softwareDev@1.26.0', {
    taskQueue: TASK_QUEUE, workflowId: task.id,
    args: [{ taskId: task.id, projectId: project.id, title: 'Parent', prompt,
      base: 'main', target: 'main', project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }],
  });
  await expect.poll(async () => (await parent.query<any>('view')).subTasks?.length, { timeout: 20_000 }).toBe(1);
  const childId: string = (await parent.query<any>('view')).subTasks[0];
  const child = h.client.workflow.getHandle(childId);
  if (childPrompt.startsWith('@sleep'))
    await expect.poll(async () => (await child.query<any>('view')).agentTurn?.state, { timeout: 20_000 }).toBe('running');
  const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
  const parentMessages = async () => ((await parent.query<any>('view')).messages as { text: string }[])
    .map((message) => message.text);
  const settlements = async () => (await parentMessages())
    .filter((text) => text.startsWith(`Sub-task ${childId} finished:`));
  /** The child's raises its parent's Do agent has been shown. */
  const raises = async () => (await parentMessages())
    .filter((text) => text.startsWith(`Sub-task "Child" (${childId}) needs you`));
  return { parent, child, childId, token, settlements, raises };
}

/** True once the parent's history holds the child run's close and a workflow
 * task that processed it, so a query now reflects what the parent made of it. */
async function parentProcessedChildClose(parent: { fetchHistory(): Promise<any> }) {
  const events: any[] = (await parent.fetchHistory()).events ?? [];
  const closed = events.findIndex((event) => event.childWorkflowExecutionCompletedEventAttributes);
  return closed >= 0 && events.slice(closed).some((event) => event.workflowTaskCompletedEventAttributes);
}

it('WF-31: a child a person marks done settles its parent as done', async () => {
  const { parent, child, childId, token, settlements } = await parentWithSleepingChild('child-marked-done');
  try {
    expect(await h.api.moveTaskStage(token, childId, 'done')).toMatchObject({ stage: 'done', status: 'done' });
    await expect.poll(settlements, { timeout: 20_000 }).toEqual([`Sub-task ${childId} finished: done.`]);
  } finally {
    await child.terminate('test cleanup').catch(() => undefined);
    await parent.terminate('test cleanup').catch(() => undefined);
  }
}, 90_000);

it('WF-31: a child held for human input stays outstanding until its successor really ends', async () => {
  const { parent, child, childId, token, settlements } = await parentWithSleepingChild('child-held');
  try {
    await h.api.moveTaskStage(token, childId, 'human');
    await expect.poll(async () => (await child.query<any>('view')).waitingFor?.kind, { timeout: 20_000 }).toBe('human');
    await expect.poll(() => parentProcessedChildClose(parent), { timeout: 20_000 }).toBe(true);
    expect(await settlements()).toEqual([]);
    await h.api.signalTask(token, childId, 'cancel');
    await expect.poll(settlements, { timeout: 20_000 }).toEqual([`Sub-task ${childId} finished: cancelled.`]);
  } finally {
    await child.terminate('test cleanup').catch(() => undefined);
    await parent.terminate('test cleanup').catch(() => undefined);
  }
}, 90_000);

// #456: a child whose run was replaced (here held for a person, as an
// escalation does) took itself for a top-level task. Its Review went to
// @creator and its parent, waiting on it, was never asked.
it('a replaced child still raises its Review to its parent', async () => {
  const { parent, child, childId, token, raises } = await parentWithSleepingChild('child-held-review');
  try {
    await h.api.moveTaskStage(token, childId, 'human');
    await expect.poll(async () => (await child.query<any>('view')).waitingFor?.kind, { timeout: 20_000 }).toBe('human');
    await h.api.signalTask(token, childId, 'followUp',
      '@run printf done > child.txt && git add -A && git commit -q -m child\n@openpr');
    await expect.poll(async () => {
      const view = await child.query<any>('view');
      return `${view.stage}/${view.waitingFor?.kind}`;
    }, { timeout: 30_000 }).toBe('review/parent');
    await expect.poll(raises, { timeout: 20_000 }).toEqual([expect.stringContaining('needs_confirmation')]);
  } finally {
    await child.terminate('test cleanup').catch(() => undefined);
    await parent.terminate('test cleanup').catch(() => undefined);
  }
}, 90_000);

// #456: a child's Do turn that ends without open_pr asks its parent to approve
// what it has. The parent's confirm was dropped there, leaving both waiting.
it('a parent\'s confirm of a child waiting in Do opens its PR, and the next confirm lands it', async () => {
  const { parent, child, childId, raises, settlements } = await parentWithSleepingChild('child-do-confirm',
    '@run printf done > child.txt && git add -A && git commit -q -m child\\n@incomplete');
  try {
    await expect.poll(async () => {
      const view = await child.query<any>('view');
      return `${view.stage}/${view.waitingFor?.kind}`;
    }, { timeout: 30_000 }).toBe('do/parent');
    await expect.poll(raises, { timeout: 20_000 })
      .toEqual([expect.stringMatching(/needs_confirmation: Its Do turn ended without opening a PR[\s\S]*Its last message:\nran: printf/)]);
    await parent.signal('followUp', { id: 'r1', role: 'user', text: '@respond confirm', ts: 0 });
    await expect.poll(async () => {
      const view = await child.query<any>('view');
      return `${view.stage}/${view.waitingFor?.kind}`;
    }, { timeout: 30_000 }).toBe('review/parent');
    await expect.poll(async () => (await raises()).length, { timeout: 20_000 }).toBe(2);
    await parent.signal('followUp', { id: 'r2', role: 'user', text: '@respond confirm', ts: 0 });
    await expect.poll(settlements, { timeout: 30_000 }).toEqual([`Sub-task ${childId} finished: done.`]);
  } finally {
    await child.terminate('test cleanup').catch(() => undefined);
    await parent.terminate('test cleanup').catch(() => undefined);
  }
}, 120_000);
