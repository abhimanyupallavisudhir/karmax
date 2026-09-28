import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';

// PL-11 through the real workflow: create_sub_task `params` ride the turn
// result into spawnSubTasks and prepareChildTask, and reach the child's Do turn.
// The mock agent's `@profile` echoes the model/effort its turn ran with.

let h: Harness;
beforeAll(async () => { h = await bootHarness('mock'); }, 60_000);
afterAll(async () => { await h?.stop(); });

async function startParent(name: string, prompt: string) {
  const repo = await h.makeRepo(name);
  const project = (await h.store.createProject(name, { repos: [repo] }));
  await h.store.upsertProfile({ id: `${project.id}::parent-do`, name: 'Parent', role: 'do', provider: 'mock', model: 'parent-model', effort: 'low' });
  const task = (await h.store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
    workflowVersion: '1.26.0', params: { prompt } }));
  const parent = await h.client.workflow.start('softwareDev@1.26.0', {
    taskQueue: TASK_QUEUE, workflowId: task.id,
    args: [{ taskId: task.id, projectId: project.id, title: 'Parent', prompt, profiles: { do: `${project.id}::parent-do` },
      base: 'main', target: 'main', project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }],
  });
  return { parent, task };
}

const agentTexts = async (handle: { query<T>(name: string): Promise<T> }) =>
  ((await handle.query<any>('view')).messages as { role: string; text: string }[])
    .filter((message) => message.role === 'agent').map((message) => message.text).join('\n');

it('PL-11: a child spawned with params runs the chosen agent, and one without runs its parent\'s', async () => {
  const { parent } = await startParent('subtask-params-chosen', [
    '@subtaskwith {"agent:do":{"provider":"mock","model":"child-model","effort":"high"}} :: Chosen :: @profile',
    '@subtask Inherited :: @profile',
    '@wait',
  ].join('\n'));
  try {
    await expect.poll(async () => (await parent.query<any>('view')).subTasks?.length, { timeout: 20_000 }).toBe(2);
    const [chosen, inherited] = ((await parent.query<any>('view')).subTasks as string[]).map((id) => h.client.workflow.getHandle(id));
    await expect.poll(() => agentTexts(chosen!), { timeout: 30_000 }).toContain('profile: child-model/high');
    await expect.poll(() => agentTexts(inherited!), { timeout: 30_000 }).toContain('profile: parent-model/low');
  } finally {
    await parent.signal('cancel').catch(() => undefined);
    await parent.result().catch(() => undefined);
  }
}, 90_000);

it('PL-11: a refused create_sub_task reaches the agent as an error and spawns nothing', async () => {
  const { parent, task } = await startParent('subtask-params-refused',
    '@subtaskwith {"agent:do":{"provider":"gemini"}} :: Bad :: @profile');
  try {
    await expect.poll(() => agentTexts(parent), { timeout: 30_000 }).toContain('subtask refused: unknown agent provider "gemini"');
    expect((await parent.query<any>('view')).subTasks ?? []).toEqual([]);
    expect(await h.store.childTasks(task.id)).toEqual([]);
  } finally {
    await parent.signal('cancel').catch(() => undefined);
    await parent.result().catch(() => undefined);
  }
}, 60_000);
