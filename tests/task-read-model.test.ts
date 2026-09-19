import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import type { TaskView } from '../src/domain/types.js';

let store: Store;
afterEach(() => { store?.close(); vi.restoreAllMocks(); });

it('shares audience policy across sync and async reads and caches membership reads only within a page', async () => {
  store = new Store();
  const org = store.createOrganization({ name: 'Read models', ownerUserId: 'owner' });
  store.setOrganizationMembership(org.id, 'reviewer', 'member');
  const project = store.createProject('App', {}, org.id);
  const team = store.createTeam({ organizationId: org.id, name: 'Design' });
  store.setTeamMembership(team.id, 'reviewer');
  const tasks = Array.from({ length: 30 }, (_, i) => store.createTask({ projectId: project.id,
    title: `Task ${i}`, workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' },
    confirmationPolicy: { rule: 'any', targets: [{ kind: 'team', teamId: team.id }] } }));
  const synchronous = store.listTaskSummaries(project.id);
  const reads = vi.spyOn(store.db, 'prepare');
  const page = await store.taskSummaryPage(project.id);
  expect(page.tasks).toEqual(synchronous);
  expect(reads.mock.calls.filter(([sql]) => sql.includes('FROM team_memberships'))).toHaveLength(1);
  expect(page.tasks[0]?.reviewers).toEqual(['reviewer']);
  store.removeTeamMembership(team.id, 'reviewer');
  expect((await store.taskSummaryPage(project.id)).tasks[0]?.reviewers).toEqual(store.getTask(tasks[0]!.id)?.reviewers);
  expect((await store.taskSummaryPage(project.id)).tasks[0]?.reviewers).not.toContain('reviewer');
});

it('preserves inherited task numbers, tags, subscribers, transcripts, and draft projections', async () => {
  store = new Store();
  store.claimPersonalOrganization('owner');
  const project = store.createProject('Attempts');
  const first = store.createTask({ projectId: project.id, title: 'Original', workflow: 'just-do',
    workflowVersion: '1', params: { prompt: 'fixture' } });
  const alternate = store.createTask({ projectId: project.id, intentId: first.intentId, title: 'Alternate', workflow: 'just-do',
    workflowVersion: '1', params: { prompt: 'draft prompt', draft: true } });
  const view: TaskView = { taskId: first.id, title: first.title, workflow: first.workflow, stage: 'do', status: 'active',
    messages: [{ id: 'm', text: 'history', role: 'agent', ts: 1 }], state: {}, actions: [], updatedAt: 1 };
  view.transcripts = [{ role: 'do', label: 'Do', messages: [...view.messages] }];
  const tag = store.createTag({ projectId: project.id, name: 'Topic' });
  store.setTaskTags(first.id, [tag.id]);
  store.subscribeTask(first.id, { kind: 'user', userId: 'owner' });
  store.saveView(first.id, view);
  expect(await store.getTaskAsync(first.id)).toEqual(store.getTask(first.id));
  expect(await store.taskSnapshotAsync(first.id)).toEqual(view);
  expect((await store.taskMetadataAsync(alternate.id))?.num).toBe(first.num);
  store.setPrincipalAttempt(alternate.id);
  expect(await store.taskPointerByNumAsync(project.id, first.num!)).toEqual({ id: alternate.id, num: first.num, projectId: project.id });
  expect(await store.taskPointerByNumAsync('another-project', first.num!)).toBeUndefined();
  expect((await store.taskMetadataAsync(first.id))?.lastView?.messages).toBeUndefined();
  const tokens = new TokenAuthority();
  const token = tokens.mintPrincipal('user:owner', ['*'], project.id).token;
  const api = new KarmaxApi({ store, tokens, client: {} as any, taskQueue: 'fixture' });
  expect(await api.getDraftViewAsync(token, alternate.id)).toEqual(api.getDraftView(token, alternate.id));
  const fullRead = vi.spyOn(store, 'getTask').mockImplementation(() => { throw Error('synchronous conversation hydration'); });
  const groupRead = vi.spyOn(store, 'attemptGroup').mockImplementation(() => { throw Error('sibling conversation hydration'); });
  const snapshot = vi.spyOn(store, 'taskSnapshotAsync');
  expect(await api.getTaskView(token, first.id)).toMatchObject({ taskId: first.id, messages: view.messages });
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(fullRead).not.toHaveBeenCalled();
  expect(groupRead).not.toHaveBeenCalled();
});

it('queries the replacement run if it changes while the async snapshot is loading', async () => {
  store = new Store();
  const project = store.createProject('Run pin');
  const task = store.createTask({ projectId: project.id, title: 'Run', workflow: 'just-do', workflowVersion: '1',
    params: { prompt: 'fixture', _workflowRunId: 'old-run' } });
  const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
    messages: [], actions: [], state: {}, updatedAt: 1 };
  store.saveView(task.id, view);
  const getHandle = vi.fn(() => ({ query: async () => view }));
  const tokens = new TokenAuthority();
  const token = tokens.mintPrincipal('user:owner', ['*'], project.id).token;
  const api = new KarmaxApi({ store, tokens, client: { workflow: { getHandle } } as any, taskQueue: 'fixture' });
  const snapshot = store.taskSnapshotAsync.bind(store);
  vi.spyOn(store, 'taskSnapshotAsync').mockImplementation(async id => {
    const result = await snapshot(id);
    store.updateTaskParams(task.id, { ...task.params, _workflowRunId: 'replacement-run' });
    return result;
  });
  await api.getTaskView(token, task.id, { live: true });
  expect(getHandle).toHaveBeenCalledWith(task.id, 'replacement-run');
});

it('preserves the legacy personal-organization fallback in audience resolution', async () => {
  store = new Store();
  store.claimPersonalOrganization('owner');
  const project = store.createProject('Legacy project');
  const task = store.createTask({ projectId: project.id, title: 'Legacy', workflow: 'just-do', workflowVersion: '1',
    params: { prompt: 'fixture' } });
  store.db.prepare('UPDATE projects SET organizationId=NULL WHERE id=?').run(project.id);
  expect(store.humanAudience(task.id, ['@owners'])).toEqual(['owner']);
});
