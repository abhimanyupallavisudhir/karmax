import { afterAll, beforeAll, expect, it } from 'vitest';
import { appGrantFixture, type AppGrantFixture } from './helpers/app-grants.js';

// A task's Parameters say who created it, whatever their credential: a person
// in the console, the same person through a CLI login, an MCP app or a
// personal token, a task's agent (linked to its task, when the reader may read
// it), or tavya's own automation. The view carries it as `creator`.
let f: AppGrantFixture;
beforeAll(async () => { f = await appGrantFixture(); });
afterAll(async () => { await f.g.close(); });

async function createDraft(auth: { cookie?: string; bearer?: string }, projectId: string, title: string) {
  const created = await f.call('POST', `/api/projects/${projectId}/tasks`, auth,
    { workflow: 'software-dev', title, params: { prompt: title }, draft: true });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body as { id: string; num?: number };
}
/** As if it had started (no Temporal here): no longer a draft, and its workflow published a view. */
async function start(taskId: string) {
  await f.g.store.clearDraft(taskId);
  await f.g.store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ taskId, title: 'x', workflow: 'software-dev',
    stage: 'do', status: 'active', actions: [], state: {} }), taskId);
}
async function creatorOf(taskId: string, auth: { cookie?: string; bearer?: string } = { cookie: f.cookie }) {
  const view = await f.call('GET', `/api/tasks/${taskId}`, auth);
  expect(view.status, JSON.stringify(view.body)).toBe(200);
  return view.body?.creator;
}

it('names a person who created a task in the console, with no credential beside them', async () => {
  const task = await createDraft({ cookie: f.cookie }, f.site.id, 'From the console');
  expect(await creatorOf(task.id)).toEqual({ createdBy: { kind: 'user', userId: f.user.id } });
  await start(task.id);
  expect(await creatorOf(task.id)).toEqual({ createdBy: { kind: 'user', userId: f.user.id } });
});

it('names the CLI login or personal token a person created a task with', async () => {
  const { access_token } = await f.deviceLogin({}, 'ada-laptop');
  const byCli = await createDraft({ bearer: access_token }, f.site.id, 'From the CLI');
  expect(await creatorOf(byCli.id)).toMatchObject({ createdBy: { kind: 'user', userId: f.user.id },
    via: { kind: 'cli', name: 'ada-laptop', grantId: expect.any(String) } });

  const minted = await f.call('POST', '/api/user/tokens', { cookie: f.cookie }, { name: 'CI', expiresInDays: 7 });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  const byToken = await createDraft({ bearer: minted.body.token }, f.site.id, 'From CI');
  expect(await creatorOf(byToken.id)).toMatchObject({ createdBy: { kind: 'user', userId: f.user.id },
    via: { kind: 'token', name: 'CI', grantId: minted.body.id } });

  // The list record carries it too: a draft's page is its form, which has no view.
  const list = await f.call('GET', `/api/projects/${f.site.id}/tasks`, { cookie: f.cookie });
  const tasks = Array.isArray(list.body) ? list.body : list.body.tasks;
  expect(tasks.find((t: any) => t.id === byCli.id)).toMatchObject({ createdBy: { kind: 'user', userId: f.user.id },
    createdVia: { kind: 'cli', name: 'ada-laptop' } });
});

it("names a task's agent with a link to its task, only for a reader who may read that task", async () => {
  const source = await createDraft({ cookie: f.cookie }, f.docs.id, 'Planner');
  const agent = (await f.g.tokens.mint({ taskId: source.id, profileId: 'claude', role: 'do', principal: `user:${f.user.id}`,
    projectIds: [f.site.id, f.docs.id], organizationId: f.organization.id, ceiling: ['*'], grantorCaps: ['*'] })).token;
  const child = await createDraft({ bearer: agent }, f.site.id, 'Planned by an agent');
  await start(child.id);
  const sourceRecord = await f.g.store.getTask(source.id);
  expect(await creatorOf(child.id)).toEqual({ createdBy: { kind: 'task-agent', taskId: source.id, role: 'do' },
    task: { id: source.id, projectId: f.docs.id, num: sourceRecord!.num, title: 'Planner' } });

  // A login limited to Site still learns an agent created it, not which task.
  const { access_token } = await f.deviceLogin({ projectIds: [f.site.id] }, 'site-only');
  expect(await creatorOf(child.id, { bearer: access_token })).toEqual({
    createdBy: { kind: 'task-agent', taskId: source.id, role: 'do' } });
});

it("records tavya's own automation as the credential", async () => {
  const { token } = await f.g.tokens.mintPrincipal('system:triggers', ['*'], f.site.id, 60_000, f.organization.id);
  const created = await createDraft({ bearer: token }, f.site.id, 'Scheduled');
  expect(await creatorOf(created.id)).toEqual({ via: { kind: 'system', principal: 'system:triggers' } });
});
