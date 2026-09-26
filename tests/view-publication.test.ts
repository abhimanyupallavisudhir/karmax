import { describe, it, expect } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { conversationPublisher, type PublishedView } from '../src/domain/view-publication.js';
import type { TaskView } from '../src/domain/types.js';

describe('durable conversation publication', () => {
  it('prunes old terminal snapshots after the retry window while retaining the current reference', async () => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Retention');
    const task = await store.createTask({ projectId: project.id, title: 'Done', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    const old = `view-conversation:${task.id}:run:0`;
    const current = `view-conversation:${task.id}:run:1`;
    await store.kvSet(old, JSON.stringify({ messages: [{ id: 'old', role: 'agent', text: 'old', ts: 1 }] }));
    await store.kvSet(current, JSON.stringify({ messages: [{ id: 'new', role: 'agent', text: 'new', ts: 2 }] }));
    await store.kvSet(`view-publication-fence:${task.id}:run:activity`, '1');
    await store.kvSet(`turnsession:${task.id}#1`, 'session');
    await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow,
      stage: 'done', status: 'done', messages: [], actions: [], state: {}, updatedAt: 1 }, 'run:1');
    try {
      const result = await store.retentionSweep(30 * 24 * 60 * 60 * 1000);
      expect(result.viewSnapshots).toBe(1);
      expect(await store.kvGet(old)).toBeUndefined();
      expect(await store.kvGet(current)).toBeDefined();
      expect(await store.kvEntries(`view-publication-fence:${task.id}:`)).toEqual([]);
      expect(await store.kvEntries(`turnsession:${task.id}#`)).toEqual([]);
      expect((await store.getTask(task.id))?.lastView?.messages[0]?.text).toBe('new');
    } finally { await store.close(); }
  });

  it('reuses immutable snapshots across restarts, mutations, and late retries', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Publication', {}));
    const task = (await store.createTask({ projectId: project.id, title: 'T', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'x' } }));
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
      expect((await store.getTask(task.id))?.lastView?.messages).toEqual(view.messages);

      view.messages[0]!.text = 'edited in place';
      view.transcripts!.push({ role: 'resolve', label: 'Resolve', messages: [] });
      await publish({ ...view, updatedAt: 3 });
      expect(writes[2]!.reference).not.toBe(writes[0]!.reference);
      expect((await store.getTask(task.id))?.lastView?.messages[0]?.text).toBe('edited in place');

      // A retried old activity must read its own snapshot, not the current view.
      await core.publishView(task.id, writes[1]!.view, writes[1]!.reference);
      expect((await store.getTask(task.id))?.lastView?.messages[0]?.text).toContain('CI log');
      expect((await store.getTask(task.id))?.lastView?.transcripts).toHaveLength(1);
      await expect(core.publishView(task.id, writes[1]!.view, 'missing')).rejects.toThrow('snapshot is missing');
      await expect(core.publishView(task.id, view, writes[0]!.reference)).rejects.toThrow('reference was reused');

      // A replacement run writes its initial snapshot even if the old one exists.
      const restart = conversationPublisher('run-two', (v, ref) => core.publishView(task.id, v, ref));
      await restart(view);
      expect((await store.getTask(task.id))?.lastView?.messages).toEqual(view.messages);
      (await store.deleteTask(task.id));
      expect((await store.db.prepare('SELECT k FROM kv WHERE k LIKE ?').all(`view-conversation:${task.id}:%`))).toEqual([]);
    } finally { (await store.close()); }
  });

  it.each(['before', 'after'])('keeps critical escalation intact when replacement bootstrap publishes %s the ask', async (order) => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Notifications', ownerUserId: 'owner' }));
    const project = (await store.createProject('P', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Approve sign-in', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });
    const held: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do',
      status: 'waiting', waitingFor: { kind: 'human', audience: ['@creator'], detail: 'Approve sign-in now' },
      messages: [], actions: [], state: { humanPauseOrigin: 'do' }, updatedAt: 1 };
    const bootstrap = { ...held, status: 'active' as const, waitingFor: undefined };
    const publish = conversationPublisher('replacement', (view, ref) => core.publishView(task.id, view, ref));
    const inbox = async () => (await store.listInbox('owner', organization.id));
    try {
      (await store.saveView(task.id, held)); // Platform projection before the replacement starts publishing.
      if (order === 'before') await publish(bootstrap);
      (await store.appendEvent({ taskId: task.id, type: 'task.escalated', ts: 2,
        payload: { audience: ['@creator'], detail: held.waitingFor!.detail, urgency: 'critical' } }));
      const ask = (await inbox())[0]!;
      expect(ask).toMatchObject({ urgency: 'critical', unread: true });
      if (order === 'after') await publish(bootstrap);
      await publish(held); // Uses the bootstrap's conversation reference, even when it was suppressed.
      expect((await inbox())).toHaveLength(1);
      expect((await inbox())[0]).toMatchObject({ id: ask.id, urgency: 'critical', unread: true, createdAt: ask.createdAt });
      expect((await store.getTask(task.id))?.lastView?.waitingFor).toEqual(held.waitingFor);
      expect((await store.eventsSince(task.id, 0)).filter((event) => event.type === 'view.updated')
        .every((event) => event.payload.waitingFor === 'human')).toBe(true);
      // A real resume drops the pause marker and must still discharge the ask.
      await publish({ ...bootstrap, state: {} });
      expect((await inbox())).toEqual([]);
      expect((await store.getTask(task.id))?.lastView?.status).toBe('active');
    } finally { (await store.close()); }
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

  it.each(['project', 'organization'])('removes conversation snapshots on %s deletion', async (scope) => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Snapshots', ownerUserId: 'owner' }));
    const project = (await store.createProject('P', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'T', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'x' } }));
    const key = `view-conversation:${task.id}:run:0`;
    const nextKey = `view-conversation:${task.id}:run:1`;
    try {
      (await store.kvSet(key, 'conversation'));
      (await store.kvSet(nextKey, 'also task-owned'));
      (await store.kvSet('view-conversation:other-task:run:0', 'preserve'));
      if (scope === 'project') (await store.deleteProject(project.id));
      else (await store.deleteOrganization(organization.id));
      expect((await store.kvGet(key))).toBeUndefined();
      expect((await store.kvGet(nextKey))).toBeUndefined();
      expect((await store.kvGet('view-conversation:other-task:run:0'))).toBe('preserve');
    } finally { (await store.close()); }
  });
});
