import { describe, it, expect } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { conversationPublisher, type PublishedView } from '../src/domain/view-publication.js';
import type { TaskView } from '../src/domain/types.js';

describe('durable conversation publication', () => {
  it('reuses immutable snapshots across restarts, mutations, and late retries', async () => {
    const store = new Store(':memory:');
    const project = store.createProject('Publication', {});
    const task = store.createTask({ projectId: project.id, title: 'T', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'x' } });
    const activities = () => makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });
    let core = activities();
    const writes: { view: PublishedView; reference: string }[] = [];
    const publish = conversationPublisher('run-one', async (view, reference) => {
      writes.push({ view, reference });
      await core.publishView(task.id, view, reference);
    });
    const view: TaskView = { taskId: task.id, title: 'T', workflow: 'software-dev', stage: 'do', status: 'active',
      messages: [{ id: 'm0', role: 'user', text: 'CI log '.repeat(25_000), ts: 0 }],
      transcripts: [{ role: 'do', label: 'Do', messages: [] }], actions: [], state: {}, updatedAt: 1 };
    view.transcripts![0]!.messages = view.messages;
    try {
      await publish(view);
      core = activities(); // No activity-local cache may be needed.
      await publish({ ...view, updatedAt: 2 });
      expect(writes[1]!.view.messages).toBeUndefined();
      expect(JSON.stringify(writes[1]).length).toBeLessThan(500);
      expect(store.getTask(task.id)?.lastView?.messages).toEqual(view.messages);

      view.messages[0]!.text = 'edited in place';
      view.transcripts!.push({ role: 'resolve', label: 'Resolve', messages: [] });
      await publish({ ...view, updatedAt: 3 });
      expect(writes[2]!.reference).not.toBe(writes[0]!.reference);
      expect(store.getTask(task.id)?.lastView?.messages[0]?.text).toBe('edited in place');

      // A retried old activity must read its own snapshot, not the current view.
      await core.publishView(task.id, writes[1]!.view, writes[1]!.reference);
      expect(store.getTask(task.id)?.lastView?.messages[0]?.text).toContain('CI log');
      expect(store.getTask(task.id)?.lastView?.transcripts).toHaveLength(1);
      await expect(core.publishView(task.id, writes[1]!.view, 'missing')).rejects.toThrow('snapshot is missing');
      await expect(core.publishView(task.id, view, writes[0]!.reference)).rejects.toThrow('reference was reused');

      // A replacement run writes its initial snapshot even if the old one exists.
      const restart = conversationPublisher('run-two', (v, ref) => core.publishView(task.id, v, ref));
      await restart(view);
      expect(store.getTask(task.id)?.lastView?.messages).toEqual(view.messages);
      store.deleteTask(task.id);
      expect(store.db.prepare('SELECT k FROM kv WHERE k LIKE ?').all(`view-conversation:${task.id}:%`)).toEqual([]);
    } finally { store.close(); }
  });

  it('does not reference an unacknowledged write', async () => {
    let fail = true;
    const publications: PublishedView[] = [];
    const publish = conversationPublisher('run', async (view) => {
      publications.push(view);
      if (fail) throw new Error('write failed');
    });
    const view = { messages: [], transcripts: [] } as unknown as TaskView;
    await expect(publish(view)).rejects.toThrow('write failed');
    fail = false;
    await publish(view);
    expect(publications.every((v) => v.messages !== undefined)).toBe(true);
  });

  it.each(['project', 'organization'])('removes conversation snapshots on %s deletion', (scope) => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Snapshots', ownerUserId: 'owner' });
    const project = store.createProject('P', {}, organization.id);
    const task = store.createTask({ projectId: project.id, title: 'T', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'x' } });
    const key = `view-conversation:${task.id}:run:0`;
    const nextKey = `view-conversation:${task.id}:run:1`;
    try {
      store.kvSet(key, 'conversation');
      store.kvSet(nextKey, 'also task-owned');
      store.kvSet('view-conversation:other-task:run:0', 'preserve');
      if (scope === 'project') store.deleteProject(project.id);
      else store.deleteOrganization(organization.id);
      expect(store.kvGet(key)).toBeUndefined();
      expect(store.kvGet(nextKey)).toBeUndefined();
      expect(store.kvGet('view-conversation:other-task:run:0')).toBe('preserve');
    } finally { store.close(); }
  });
});
