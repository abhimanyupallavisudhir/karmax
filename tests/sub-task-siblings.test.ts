import { expect, it } from 'vitest';
import { DEVELOPER_WORKSPACE_CAPABILITIES } from '../src/platform/capabilities.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';

// Sub-tasks of one parent could not talk to each other: a Developer's task
// agent reaches another task's conversation only through task:manage-own, and
// that covered the tasks it created, never its siblings. Three sub-tasks that
// had to agree a shared design were merged into one task to work around it.
it('a sub-task\'s agent may message the other tasks of its tree, and do nothing else to them', async () => {
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Siblings');
    const create = (title: string, extra: Record<string, unknown> = {}) => store.createTask({ projectId: project.id, title,
      workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: title } as any, ...extra });
    const parent = await create('Parent');
    const byParent = { parentTaskId: parent.id, createdBy: { kind: 'task-agent', taskId: parent.id, role: 'do' } };
    const a = await create('A', byParent);
    const b = await create('B', byParent);
    const nephew = await create('B1', { parentTaskId: b.id, createdBy: { kind: 'task-agent', taskId: b.id, role: 'do' } });
    const unrelated = await create('Unrelated');
    const tokens = new TokenAuthority(store);
    const { token } = await tokens.mint({ taskId: a.id, profileId: 'do', role: 'do', principal: 'user:dev', projectId: project.id,
      ceiling: DEVELOPER_WORKSPACE_CAPABILITIES, grantorCaps: DEVELOPER_WORKSPACE_CAPABILITIES });
    const may = async (capability: any, taskId: string) => (await tokens.check(token, capability, { projectId: project.id, taskId })).ok;

    expect(await may('task:conversation:message', b.id)).toBe(true);
    expect(await may('task:conversation:message', nephew.id)).toBe(true);
    expect(await may('task:conversation:message', parent.id)).toBe(true);
    expect(await may('task:conversation:message', unrelated.id)).toBe(false);
    // Only messages: a sibling's settings and lifecycle stay its owner's.
    expect(await may('task:edit', b.id)).toBe(false);
    expect(await may('task:signal', b.id)).toBe(false);
    // A top-level task's agent has no tree to share.
    const top = await tokens.mint({ taskId: unrelated.id, profileId: 'do', role: 'do', principal: 'user:dev', projectId: project.id,
      ceiling: DEVELOPER_WORKSPACE_CAPABILITIES, grantorCaps: DEVELOPER_WORKSPACE_CAPABILITIES });
    expect((await tokens.check(top.token, 'task:conversation:message', { projectId: project.id, taskId: b.id })).ok).toBe(false);
  } finally { await store.close(); }
});

it('a sub-task is told its siblings at work and how to reach them', async () => {
  const { assemblePrompt } = await import('../src/agent/prompt.js');
  const prompt = (task: Record<string, unknown>, siblings?: Array<{ id: string; title: string; num?: number }>) => assemblePrompt({
    profile: { id: 'do', name: 'Do', provider: 'claude', role: 'do', capabilities: [] } as any, role: 'do',
    task: { taskId: 't', projectId: 'p', title: 'A3', prompt: 'work', ...task } as any,
    world: { kind: 'worktree', id: 't', root: '/w/t', branch: 'tavya/t', base: 'main' } as any,
    ...(siblings ? { siblings } : {}) });
  const child = prompt({ parentTaskId: 'task_parent' }, [{ id: 'task_a2', title: 'A2', num: 12 }, { id: 'task_a4', title: 'A4' }]);
  expect(child).toContain('You are a sub-task of task task_parent');
  expect(child).toContain('#12 "A2" (task_a2), "A4" (task_a4)');
  expect(child).toMatch(/message_agent\(task_id, message\)/);
  expect(prompt({ parentTaskId: 'task_parent' })).not.toContain('message_agent(task_id');
  expect(prompt({})).not.toContain('You are a sub-task');
});
