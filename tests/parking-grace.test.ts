import { expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import type { TaskView } from '../src/domain/types.js';

it.each(['conversation.message', 'task.transition-requested', 'task.cancel-requested', 'idle'])(
  'allows immediate transitions before expensive parking: %s', async eventType => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Grace');
    const task = await store.createTask({ projectId: project.id, title: 'Review', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' } });
    const handle = { id: task.id, kind: 'container', root: '/workspace', branch: 'task', base: 'main' };
    const worlds = { get: () => ({ parkable: true }), status: vi.fn(async () => 'ready'), park: vi.fn(async () => handle) };
    const checkpoint = vi.fn(async () => ({ id: 'checkpoint', generation: 1 }));
    const core = makeCoreActivities({ store, worlds: worlds as any, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), checkpoints: { checkpoint } as any });
    vi.useFakeTimers();
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] }, messages: [], actions: [], updatedAt: Date.now(),
      state: {}, world: handle } as TaskView;
    try {
      const fence = await core.publishView(task.id, view, undefined, { separateLifecycle: true });
      const publication = core.parkWaitingWorld(task.id, view, fence!);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(worlds.status).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      if (eventType !== 'idle') {
        await store.appendEvent({ taskId: task.id, type: eventType, ts: Date.now(), payload: { signal: 'confirm' } });
        await vi.advanceTimersByTimeAsync(250);
      } else await vi.advanceTimersByTimeAsync(13_000);
      await publication;
      expect(worlds.park).toHaveBeenCalledTimes(eventType === 'idle' ? 1 : 0);
      expect(checkpoint).toHaveBeenCalledTimes(eventType === 'idle' ? 1 : 0);
    } finally { vi.useRealTimers(); await store.close(); }
  });
