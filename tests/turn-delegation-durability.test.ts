import { afterEach, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

afterEach(() => { vi.restoreAllMocks(); });

// create_sub_task / respond_to_sub_task answer "queued" at once, but used to be
// delivered only in the finished turn's result. A turn interrupted after the
// call (session limit, dropped connection, worker restart) resumed without
// them, and the resumed agent, having been told they were queued, never asked
// again: task #367 lost two sub-tasks that way.
it('delivers sub-tasks and answers queued before a retried turn was interrupted, once', async () => {
  const store = await Store.create(':memory:');
  const project = await store.createProject('Delegation');
  const task = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
    workflowVersion: '1.26.0', params: { prompt: 'work' } as any });
  const child = await store.createTask({ projectId: project.id, title: 'Child', workflow: 'software-dev',
    workflowVersion: '1.26.0', params: { prompt: 'child' } as any, parentTaskId: task.id });
  const worlds = new WorldRegistry();
  const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
  let attempt = 1;
  vi.spyOn(Context, 'current').mockImplementation(() => ({
    info: { attempt, activityId: 'turn', workflowExecution: { runId: 'run' } },
    cancellationSignal: new AbortController().signal, heartbeat: () => {},
  }) as any);
  const spawn = { title: 'Wiki', prompt: 'Sort the wiki.' };
  const answer = { childTaskId: child.id, action: 'retry' as const };
  const runTurn = vi.fn(async (_input: any, ctx: any) => {
    if (attempt === 1) {
      await ctx.createSubTask(spawn);
      await ctx.respondToSubTask(answer);
      throw new Error('the session ended before this turn finished');
    }
    await ctx.createSubTask(spawn); // a resumed agent may repeat itself
    return { termination: { kind: 'success', status: 'end_turn' }, output: 'resumed' };
  });
  const core = makeCoreActivities({ store, worlds,
    adapters: new Map([['claude', { provider: 'claude', runTurn }]]) as any,
    profiles: new ProfileResolver(store, 'claude') });
  const args = { taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`, agentSlotGranted: true, worldHandle: world.handle,
    messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }],
    task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev',
      agents: { do: { provider: 'claude', model: 'test' } } } } as any;
  try {
    await expect(core.runAgentTurn(args)).rejects.toThrow();
    attempt = 2;
    const result = await core.runAgentTurn(args);
    expect(result.subTasks).toEqual([spawn]);
    expect(result.subTaskResponses).toEqual([answer]);
    // The next turn starts clean.
    expect(await store.kvGet(`turnspawns:${task.id}#0`)).toBeUndefined();
  } finally { await world.destroy(); await store.close(); }
});
