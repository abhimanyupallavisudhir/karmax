import { describe, it, expect, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { conversationPage, conversationPublisher, type PublishedView } from '../src/domain/view-publication.js';
import type { TaskView } from '../src/domain/types.js';

describe('durable conversation publication', () => {
  it.each(['done', 'cancelled', 'failed'] as const)('prunes completed turn retry records on %s while retaining resumable sessions', async status => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Turn cleanup');
    const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'fixture' } });
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });
    const retryKeys = [`turnsession:${task.id}#0`, `turnsession:${task.id}:run#1`,
      'turnsession:legacy:run:activity', `turnresult:${task.id}:do:${task.id}:run#1`, `task-create:${task.id}:run:child`];
    const retained = [`session:${task.id}:do`, `sessionmeta:${task.id}:do`,
      `turnsession:${task.id}-other#0`, `turnsession:${task.id}-other:run#1`, 'turnsession:legacy:other:activity', `task-create:${task.id}-other:run:child`];
    const ctx = vi.spyOn(Context, 'current').mockReturnValue({ info: { workflowExecution: { runId: 'run' }, activityId: 'publish' } } as any);
    try {
      for (const key of [...retryKeys, ...retained]) await store.kvSet(key, 'saved');
      const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
        messages: [], actions: [], state: {}, updatedAt: 1 } as TaskView;
      await core.publishView(task.id, view);
      for (const key of retryKeys) expect(await store.kvGet(key)).toBe('saved');
      await core.publishView(task.id, { ...view, status });
      for (const key of retryKeys) expect(await store.kvGet(key)).toBeUndefined();
      for (const key of retained) expect(await store.kvGet(key)).toBe('saved');
    } finally { ctx.mockRestore(); await store.close(); }
  });

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
      const result = await store.retentionSweep(Date.now() + 30 * 24 * 60 * 60 * 1000);
      expect(result.viewSnapshots).toBe(1);
      expect(await store.kvGet(old)).toBeUndefined();
      expect(await store.kvGet(current)).toBeDefined();
      expect(await store.kvEntries(`view-publication-fence:${task.id}:`)).toEqual([]);
      expect(await store.kvEntries(`turnsession:${task.id}#`)).toEqual([]);
      expect((await store.getTask(task.id))?.lastView?.messages[0]?.text).toBe('new');
    } finally { await store.close(); }
  });

  // PS-3: a software-dev view's `updatedAt` is its history length, so the
  // window must run from when the task settled, and failed tasks settle too.
  it.each(['done', 'cancelled', 'failed'] as const)('keeps a %s task\'s superseded snapshots for a week after it settles', async status => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Retention');
    const task = await store.createTask({ projectId: project.id, title: 'Settled', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'fixture' } });
    const old = `view-conversation:${task.id}:run:0`;
    const fence = `view-publication-fence:${task.id}:run:activity`;
    const day = 24 * 60 * 60 * 1000;
    try {
      await store.kvSet(old, '{"messages":[]}');
      await store.kvSet(`view-conversation:${task.id}:run:1`, '{"messages":[]}');
      await store.kvSet(fence, '1');
      const settledAt = Date.now();
      await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow,
        stage: status, status, messages: [], actions: [], state: {}, updatedAt: 412 }, 'run:1');
      expect((await store.retentionSweep(settledAt + 6 * day)).viewSnapshots).toBe(0);
      expect(await store.kvGet(old)).toBeDefined();
      expect(await store.kvGet(fence)).toBe('1');
      const swept = await store.retentionSweep(settledAt + 8 * day);
      expect(swept).toMatchObject({ viewSnapshots: 1, publicationFences: 1 });
      expect(await store.kvGet(old)).toBeUndefined();
      expect(await store.kvGet(`view-conversation:${task.id}:run:1`)).toBeDefined();
    } finally { await store.close(); }
  });

  it('restarts the retention window when a settled task is resumed', async () => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Retention');
    const task = await store.createTask({ projectId: project.id, title: 'Retried', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'fixture' } });
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'failed', status: 'failed',
      messages: [], actions: [], state: {}, updatedAt: 3 } as TaskView;
    const day = 24 * 60 * 60 * 1000;
    try {
      await store.kvSet(`view-conversation:${task.id}:run:0`, '{"messages":[]}');
      await store.saveView(task.id, view);
      await store.saveView(task.id, { ...view, stage: 'do', status: 'active' });
      expect((await store.retentionSweep(Date.now() + 30 * day)).viewSnapshots).toBe(0);
      await store.saveView(task.id, view);
      expect((await store.retentionSweep(Date.now() + 6 * day)).viewSnapshots).toBe(0);
      expect((await store.retentionSweep(Date.now() + 8 * day)).viewSnapshots).toBe(1);
    } finally { await store.close(); }
  });

  it('starts the window at the first sweep for tasks that settled before settle times were recorded', async () => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Retention');
    const task = await store.createTask({ projectId: project.id, title: 'Legacy', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    const day = 24 * 60 * 60 * 1000;
    try {
      await store.kvSet(`view-conversation:${task.id}:run:0`, '{"messages":[]}');
      await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow,
        stage: 'done', status: 'done', messages: [], actions: [], state: {}, updatedAt: 1 });
      await store.kvDelete(`retention:settled:${task.id}`);
      const firstSweep = Date.now() + 30 * day;
      expect((await store.retentionSweep(firstSweep)).viewSnapshots).toBe(0);
      expect((await store.retentionSweep(firstSweep + 8 * day)).viewSnapshots).toBe(1);
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

  it('WF-4: writes a grown or edited conversation as a delta of its acknowledged snapshot', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Publication', {}));
    const task = (await store.createTask({ projectId: project.id, title: 'T', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'x' } }));
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });
    const writes: PublishedView[] = [];
    const publish = conversationPublisher('run', async (view, reference) => {
      writes.push(view);
      await core.publishView(task.id, view, reference);
    }, { patches: () => true });
    const messages: TaskView['messages'] = [{ id: 'm0', role: 'user', text: 'CI log '.repeat(25_000), ts: 0 }];
    const view: TaskView = { taskId: task.id, title: 'T', workflow: 'software-dev', stage: 'do', status: 'active',
      messages, transcripts: [{ role: 'do', label: 'Do', messages }], actions: [], state: {}, updatedAt: 1 };
    const saved = async () => (await store.getTask(task.id))?.lastView;
    try {
      await publish(view);
      messages.push({ id: 'a1', role: 'agent', text: 'Fixed.', ts: 1 });
      view.transcripts!.push({ role: 'confirm', label: 'Confirm', messages: [{ id: 'c0', role: 'user', text: 'Review', ts: 0 }] });
      await publish({ ...view, updatedAt: 2 });
      expect(writes[1]!.messages).toBeUndefined();
      expect(JSON.stringify(writes[1]).length).toBeLessThan(1_000);
      expect((await saved())?.messages).toEqual(messages);
      expect((await saved())?.transcripts).toEqual(view.transcripts);
      messages[0]!.text = 'edited in place';
      await publish({ ...view, updatedAt: 3 });
      expect(writes[2]!.conversationPatch?.messages).toMatchObject({ keep: 0 });
      expect((await saved())?.messages.map(m => m.text)).toEqual(['edited in place', 'Fixed.']);
      await expect(core.publishView(task.id, { ...writes[2]!, conversationPatch: { ...writes[2]!.conversationPatch!, base: 'gone' } },
        'run:9')).rejects.toThrow('snapshot is missing');
    } finally { (await store.close()); }
  });

  it('WF-4: a turn reads the transcript it references from the acknowledged snapshot', async () => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Turns');
    const task = await store.createTask({ projectId: project.id, title: 'Work', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'fixture' } });
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    vi.spyOn(worlds, 'open').mockResolvedValue(world);
    let delivered: string[] = [];
    const core = makeCoreActivities({ store, worlds, profiles: new ProfileResolver(store, 'mock'),
      adapters: new Map([['mock', { provider: 'mock', runTurn: async (input: any) => {
        delivered = input.messages.map((m: any) => m.text);
        return { output: 'done', termination: { kind: 'success', status: 'fixture' } };
      } }]]) as any });
    try {
      await store.kvSet(`view-conversation:${task.id}:run:3`, JSON.stringify({
        messages: [{ id: 'm0', role: 'user', text: 'first', ts: 0 }, { id: 'a1', role: 'agent', text: 'second', ts: 1 },
          { id: 'x', role: 'user', text: 'not part of this turn', ts: 2 }] }));
      await core.runAgentTurn({ taskId: task.id, role: 'do', agentSlotGranted: true, worldHandle: world.handle,
        messagesBase: { reference: 'run:3', role: 'do', count: 2 }, messages: [{ id: 'u2', role: 'user', text: 'third', ts: 2 }],
        task: { taskId: task.id, projectId: project.id, title: 'Work', prompt: 'work', project: {}, agents: { do: { provider: 'mock' } } } } as any);
      expect(delivered).toEqual(['first', 'second', 'third']);
    } finally { vi.restoreAllMocks(); await world.destroy(); await store.close(); }
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
      const retryKeys = [`turnsession:${task.id}:run#1`, `turnresult:${task.id}:do:${task.id}:run#1`];
      for (const key of retryKeys) await store.kvSet(key, 'saved');
      (await store.kvSet('view-conversation:other-task:run:0', 'preserve'));
      if (scope === 'project') (await store.deleteProject(project.id));
      else (await store.deleteOrganization(organization.id));
      expect((await store.kvGet(key))).toBeUndefined();
      expect((await store.kvGet(nextKey))).toBeUndefined();
      for (const key of retryKeys) expect(await store.kvGet(key)).toBeUndefined();
      expect((await store.kvGet('view-conversation:other-task:run:0'))).toBe('preserve');
    } finally { (await store.close()); }
  });
});

// A continued run reads its predecessor's transcripts in pages, each well
// inside Temporal's payload limit, and rebuilds them exactly (WF-4).
it('pages a conversation across transcripts and rebuilds it exactly', () => {
  const message = (id: string, bytes = 100) => ({ id, role: 'agent' as const, text: 'x'.repeat(bytes), ts: 1 });
  const messages = [message('d1'), message('d2', 5_000), message('d3')];
  const conversation = { messages, transcripts: [{ role: 'do', label: 'Do agent', messages },
    { role: 'merge', label: 'Merge agent', messages: [message('m1'), message('m2')] }] };
  const rebuilt = new Map<string, string[]>();
  let offset: number | undefined = 0, pages = 0;
  while (offset !== undefined) {
    const page = conversationPage(conversation, offset, 1_000);
    for (const { role, messages: part } of page.roles) rebuilt.set(role, [...(rebuilt.get(role) ?? []), ...part.map(m => m.id)]);
    expect(page.roles.flatMap(role => role.messages).length).toBeGreaterThan(0);
    offset = page.next;
    pages++;
  }
  expect(Object.fromEntries(rebuilt)).toEqual({ do: ['d1', 'd2', 'd3'], merge: ['m1', 'm2'] });
  // The oversized message is a page on its own rather than a stall.
  expect(pages).toBe(3);
});
