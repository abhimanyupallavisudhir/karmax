import * as __asyncCollections from '../src/util/async-collections.js';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import type { TaskView } from '../src/domain/types.js';

let store: Store;
afterEach(async () => { (await store?.close()); vi.restoreAllMocks(); });

it('shares audience policy across sync and async reads and caches membership reads only within a page', async () => {
  store = (await Store.create());
  const org = (await store.createOrganization({ name: 'Read models', ownerUserId: 'owner' }));
  (await store.setOrganizationMembership(org.id, 'reviewer', 'member'));
  const project = (await store.createProject('App', {}, org.id));
  const team = (await store.createTeam({ organizationId: org.id, name: 'Design' }));
  (await store.setTeamMembership(team.id, 'reviewer'));
  const tasks = (await __asyncCollections.from({ length: 30 }, async (_, i) => (await store.createTask({ projectId: project.id,
    title: `Task ${i}`, workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' },
    confirmationPolicy: { rule: 'any', targets: [{ kind: 'team', teamId: team.id }] } }))));
  const synchronous = (await store.listTaskSummaries(project.id));
  const reads = vi.spyOn(store.db, 'prepare');
  const page = await store.taskSummaryPage(project.id);
  expect(page.tasks).toEqual(synchronous);
  expect(reads.mock.calls.filter(([sql]) => sql.includes('FROM team_memberships'))).toHaveLength(1);
  expect(page.tasks[0]?.reviewers).toEqual(['reviewer']);
  reads.mockClear();
  expect((await store.listTaskAttempts(project.id)).map((task) => task.reviewers)).toEqual(tasks.map(() => ['reviewer']));
  expect(reads.mock.calls.filter(([sql]) => sql.includes('FROM team_memberships'))).toHaveLength(1);
  (await store.removeTeamMembership(team.id, 'reviewer'));
  expect((await store.taskSummaryPage(project.id)).tasks[0]?.reviewers).toEqual((await store.getTask(tasks[0]!.id))?.reviewers);
  expect((await store.taskSummaryPage(project.id)).tasks[0]?.reviewers).not.toContain('reviewer');
});

it('preserves inherited task numbers, tags, subscribers, transcripts, and draft projections', async () => {
  store = (await Store.create());
  (await store.claimPersonalOrganization('owner'));
  const project = (await store.createProject('Attempts'));
  const first = (await store.createTask({ projectId: project.id, title: 'Original', workflow: 'just-do',
    workflowVersion: '1', params: { prompt: 'fixture' } }));
  const alternate = (await store.createTask({ projectId: project.id, intentId: first.intentId, title: 'Alternate', workflow: 'just-do',
    workflowVersion: '1', params: { prompt: 'draft prompt', draft: true } }));
  const view: TaskView = { taskId: first.id, title: first.title, workflow: first.workflow, stage: 'do', status: 'active',
    messages: [{ id: 'm', text: 'history', role: 'agent', ts: 1 }], state: {}, actions: [], updatedAt: 1 };
  view.transcripts = [{ role: 'do', label: 'Do', messages: [...view.messages] }];
  const tag = (await store.createTag({ projectId: project.id, name: 'Topic' }));
  (await store.setTaskTags(first.id, [tag.id]));
  (await store.subscribeTask(first.id, { kind: 'user', userId: 'owner' }));
  (await store.saveView(first.id, view));
  expect(await store.getTaskAsync(first.id)).toEqual((await store.getTask(first.id)));
  expect(await store.taskSnapshotAsync(first.id)).toEqual(view);
  expect((await store.taskMetadataAsync(alternate.id))?.num).toBe(first.num);
  (await store.setPrincipalAttempt(alternate.id));
  expect(await store.taskPointerByNumAsync(project.id, first.num!)).toEqual({ id: alternate.id, num: first.num, projectId: project.id });
  expect(await store.taskPointerByNumAsync('another-project', first.num!)).toBeUndefined();
  expect((await store.taskMetadataAsync(first.id))?.lastView?.messages).toBeUndefined();
  const tokens = new TokenAuthority();
  const token = (await tokens.mintPrincipal('user:owner', ['*'], project.id)).token;
  const api = new KarmaxApi({ store, tokens, client: {} as any, taskQueue: 'fixture' });
  expect(await api.getDraftViewAsync(token, alternate.id)).toEqual((await api.getDraftView(token, alternate.id)));
  const fullRead = vi.spyOn(store, 'getTask').mockImplementation(() => { throw Error('synchronous conversation hydration'); });
  const groupRead = vi.spyOn(store, 'attemptGroup').mockImplementation(() => { throw Error('sibling conversation hydration'); });
  const snapshot = vi.spyOn(store, 'taskSnapshotAsync');
  expect(await api.getTaskView(token, first.id)).toMatchObject({ taskId: first.id, messages: view.messages });
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(fullRead).not.toHaveBeenCalled();
  expect(groupRead).not.toHaveBeenCalled();
});

it('queries the replacement run if it changes while the async snapshot is loading', async () => {
  store = (await Store.create());
  const project = (await store.createProject('Run pin'));
  const task = (await store.createTask({ projectId: project.id, title: 'Run', workflow: 'just-do', workflowVersion: '1',
    params: { prompt: 'fixture', _workflowRunId: 'old-run' } }));
  const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
    messages: [], actions: [], state: {}, updatedAt: 1 };
  (await store.saveView(task.id, view));
  const getHandle = vi.fn(() => ({ query: async () => view }));
  const tokens = new TokenAuthority();
  const token = (await tokens.mintPrincipal('user:owner', ['*'], project.id)).token;
  const api = new KarmaxApi({ store, tokens, client: { workflow: { getHandle } } as any, taskQueue: 'fixture' });
  const snapshot = store.taskSnapshotAsync.bind(store);
  vi.spyOn(store, 'taskSnapshotAsync').mockImplementation(async id => {
    const result = await snapshot(id);
    (await store.patchTaskParams(task.id, { _workflowRunId: 'replacement-run' }));
    return result;
  });
  await api.getTaskView(token, task.id, { live: true });
  expect(getHandle).toHaveBeenCalledWith(task.id, 'replacement-run');
});

it('preserves the legacy personal-organization fallback in audience resolution', async () => {
  store = (await Store.create());
  (await store.claimPersonalOrganization('owner'));
  const project = (await store.createProject('Legacy project'));
  const task = (await store.createTask({ projectId: project.id, title: 'Legacy', workflow: 'just-do', workflowVersion: '1',
    params: { prompt: 'fixture' } }));
  (await store.db.prepare('UPDATE projects SET organizationId=NULL WHERE id=?').run(project.id));
  expect((await store.humanAudience(task.id, ['@owners']))).toEqual(['owner']);
});

it('scans multiple async pages without recounting and preserves full/compact list and search semantics', async () => {
  store = (await Store.create());
  const project = (await store.createProject('Bulk reads'));
  const other = (await store.createProject('Other tenant'));
  const tag = (await store.createTag({ projectId: project.id, name: 'release' }));
  const records = (await __asyncCollections.from({ length: 205 }, async (_, i) => (await store.createTask({ projectId: project.id,
    title: `Task ${i}`, workflow: 'just-do', workflowVersion: '1', params: { prompt: 'work', archived: i === 0 } }))));
  (await store.createTask({ projectId: other.id, title: 'Private', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'work' } }));
  for (const index of [0, 204]) {
    const task = records[index]!;
    (await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      messages: [{ id: 'm', text: 'searchable history', role: 'agent', ts: 1 }], state: {}, actions: [], updatedAt: 1 }));
    (await store.setTaskTags(task.id, [tag.id]));
  }
  const expected = (await store.listTasks(project.id));
  const compact = (await store.listTaskSummaries(project.id));
  const tags = (await store.listTags(project.id));
  const tokens = new TokenAuthority();
  const token = (await tokens.mintPrincipal('user:owner', ['*'], project.id)).token;
  const api = new KarmaxApi({ store, tokens, client: {} as any, taskQueue: 'fixture' });
  vi.spyOn(store, 'listTasks').mockImplementation(() => { throw Error('unbounded synchronous list'); });
  vi.spyOn(store, 'listTaskSummaries').mockImplementation(() => { throw Error('synchronous summary list'); });
  vi.spyOn(store, 'listTags').mockImplementation(() => { throw Error('synchronous tags'); });
  const reads = vi.spyOn(store.db, 'prepare');
  expect(await api.listTasks(token, project.id)).toEqual(expected);
  expect(await api.listTaskSummaries(token, project.id)).toEqual(compact);
  expect(await api.listTags(token, project.id)).toEqual(tags);
  expect((await api.searchTasks(token, project.id, 'conversation:searchable')).tasks.map(t => t.id).sort())
    .toEqual([records[0]!.id, records[204]!.id].sort());
  expect((await api.searchTasks(token, project.id, 'says:searchable -is:archived')).tasks.map(t => t.id))
    .toEqual([records[204]!.id]);
  expect(reads.mock.calls.some(([sql]) => /COUNT\(\*\).*tasks/i.test(sql))).toBe(false);
  const pages = reads.mock.calls.filter(([sql]) => sql.includes('JOIN task_intents') && !sql.startsWith('SELECT i.id'));
  expect(pages.length).toBeGreaterThanOrEqual(8);
  expect(pages.every(([sql]) => sql.includes('LIMIT ? OFFSET ?'))).toBe(true);
  await expect(api.listTasks(token, other.id)).rejects.toThrow();
});

it('does not skip or duplicate logical tasks when order and principal attempts change between pages', async () => {
  store = (await Store.create());
  const project = (await store.createProject('Concurrent scan'));
  const tasks = (await __asyncCollections.from({ length: 201 }, async (_, i) => (await store.createTask({ projectId: project.id,
    title: `Task ${i}`, workflow: 'just-do', workflowVersion: '1', params: { prompt: 'work' } }))));
  const scan = store.taskReadPages(project.id);
  const first = await scan.next();
  if (first.done) throw Error('missing first page');
  expect(first.value?.map(t => t.id)).toEqual(tasks.slice(0, 200).map(t => t.id));
  (await store.reorderTask(tasks[200]!.id, -1));
  (await store.reorderTask(tasks[0]!.id, 9999));
  (await store.createTask({ projectId: project.id, title: 'Inserted during scan', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'work' } }));
  const alternate = (await store.createTask({ projectId: project.id, intentId: tasks[200]!.intentId,
    title: 'New principal', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'work' } }));
  (await store.setPrincipalAttempt(alternate.id));
  const last = await scan.next();
  if (last.done) throw Error('missing last page');
  expect(last.value?.map(t => t.id)).toEqual([alternate.id]);
  expect(last.value?.[0]?.num).toBe(tasks[200]!.num);
  expect((await scan.next()).done).toBe(true);
});
