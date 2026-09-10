import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { KarmaxApi } from '../src/platform/api.js';
import type { TaskView } from '../src/domain/types.js';

const attachment = { caption: 'Read the security challenge', actions: [
  { kind: 'open' as const, label: 'View challenge', target: 'review-artifacts/challenge.png' },
] };

describe('review info before turn completion', () => {
  it('persists the tool result before cancellation and keeps snapshot/live/action/recovery views consistent', async () => {
    const store = new Store(':memory:');
    const project = store.createProject('Review publication');
    const task = store.createTask({ projectId: project.id, title: 'Challenge', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' } });
    const original: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow,
      stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 1,
      reviewInfo: { caption: 'Old caption', actions: [], changedFiles: ['existing.txt'] } };
    store.saveView(task.id, original);
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any, ctx: any) {
      const handlers = platformToolHandlers(input.world, ctx);
      expect(await handlers.create_review_info!({ caption: attachment.caption })).toBe('review info recorded');
      expect(await handlers.create_review_info!({ actions: attachment.actions })).toBe('review info recorded');
      expect(store.getTask(task.id)?.lastView?.reviewInfo).toMatchObject(attachment);
      throw new Error('turn stopped for human escalation');
    } }]]) as any;
    const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'mock') });
    try {
      await expect(core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`,
        agentSlotGranted: true, worldHandle: world.handle, messages: [],
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {},
          workflow: 'software-dev', agents: { do: { provider: 'mock' } } },
      } as any)).rejects.toThrow('turn stopped for human escalation');
      expect(store.db.prepare("SELECT seq FROM events WHERE taskId=? AND type='review.updated'").get(task.id)).toBeTruthy();
      // The workflow has not received TurnResult and may publish its stale frame.
      await core.publishView(task.id, original);
      expect(store.getTask(task.id)?.lastView?.reviewInfo).toMatchObject({ ...attachment, changedFiles: ['existing.txt'] });
      const api = new KarmaxApi({ store, client: { workflow: { getHandle: () => ({ query: async () => original }) } },
        tokens: { check: () => ({ ok: true, payload: {} }) } } as any);
      // Both the drawer and review-action endpoint use getTaskView; the latter queries live.
      expect((await api.getTaskView('test', task.id))?.reviewInfo).toMatchObject(attachment);
      expect((await api.getTaskView('test', task.id, { live: true }))?.reviewInfo).toMatchObject(attachment);
      const recovery = await (api as any).transitionSourceView(store.getTask(task.id));
      expect(recovery.reviewInfo).toMatchObject(attachment);
      await core.publishView(task.id, { ...recovery, status: 'waiting', state: { humanPauseOrigin: 'do' },
        waitingFor: { kind: 'human', audience: ['@creator'], detail: 'Read challenge' } });
      expect(store.kvGet(`pending-review:${task.id}`)).toBeUndefined();
      // Once incorporated, later workflow changes are not masked by an old overlay.
      await core.publishView(task.id, { ...recovery, reviewInfo: { caption: 'Finished', actions: [] } });
      expect(store.getTask(task.id)?.lastView?.reviewInfo?.caption).toBe('Finished');
      store.checkpointReviewInfo(task.id, attachment);
      store.deleteTask(task.id);
      expect(store.kvGet(`pending-review:${task.id}`)).toBeUndefined();
    } finally { await world.destroy(); store.close(); }
  });

  it('awaits persistence and propagates failures instead of acknowledging a lost attachment', async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => { release = resolve; });
    const handlers = platformToolHandlers({} as any, { createReviewInfo: () => persisted } as any);
    let acknowledged = false;
    const request = handlers.create_review_info!(attachment).then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    release(); await request;
    expect(acknowledged).toBe(true);
    const failing = platformToolHandlers({} as any, { createReviewInfo: async () => { throw new Error('storage unavailable'); } } as any);
    await expect(failing.create_review_info!(attachment)).rejects.toThrow('storage unavailable');
  });
});
