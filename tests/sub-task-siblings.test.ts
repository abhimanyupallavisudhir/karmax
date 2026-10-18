import { expect, it } from 'vitest';

// Messaging any task of the project (siblings included) is a Developer's
// capability: tests/message-other-tasks.test.ts.

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
