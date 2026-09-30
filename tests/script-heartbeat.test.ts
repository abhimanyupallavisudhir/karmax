import { expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { makeCoreActivities } from '../src/activities/core.js';
import { Store } from '../src/store/db.js';
import { ProfileResolver } from '../src/agent/profiles.js';

it('WF-26: scripts heartbeat while their world command runs and clear the timer', async () => {
  const store = await Store.create(':memory:');
  const project = await store.createProject('Scripts');
  const task = await store.createTask({ projectId: project.id, title: 'Script', workflow: 'script-exec',
    workflowVersion: '1.0.0', params: { prompt: 'held' } });
  let release!: (result: any) => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const result = new Promise(resolve => { release = resolve; });
  const heartbeat = vi.fn();
  const context = vi.spyOn(Context, 'current').mockReturnValue({ heartbeat } as any);
  const world = { exec: vi.fn(() => { started(); return result; }) };
  const core = makeCoreActivities({ store, worlds: { get: () => ({ capabilities: {} }), open: async () => world } as any,
    adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  vi.useFakeTimers();
  const run = core.runScript({ taskId: task.id, worldHandle: { id: task.id, kind: 'memory' } as any, command: 'held' });
  try {
    await Promise.race([running, run]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeat).toHaveBeenCalled();
  } finally {
    release({ code: 0, stdout: 'done', stderr: '' });
    await run;
    // The script's own heartbeat timer is cleared: no beat after it finished.
    // (Not vi.getTimerCount(): that also counts timers other files' leftover
    // background work creates while this window fakes them, and flaked in CI.)
    const beats = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(beats);
    vi.useRealTimers(); context.mockRestore(); await store.close();
  }
});
