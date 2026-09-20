import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { pingWorkflow, finish } from '../src/workflows/ping.js';

// This file intentionally boots one real Temporal server and worker. Keep it
// sequential like the other durable-engine integration suites.
describe('project transfer with real Temporal liveness', () => {
  let h: Harness;
  let base: string;
  let token: string;
  beforeAll(async () => {
    h = await bootHarness();
    base = (await h.startGateway()).url;
    token = (await (await fetch(`${base}/api/session`)).json() as any).token;
  }, 60_000);
  afterAll(async () => { await h?.stop(); });

  it('refuses a running workflow with a terminal projection, then preserves history and accepts new destination work', async () => {
    const project = (await h.store.createProject('Move with history'));
    const destination = (await h.store.createOrganization({ name: 'Receiving team', ownerUserId: 'receiver' }));
    const task = (await h.store.createTask({ projectId: project.id, title: 'Durable history', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'history' } }));
    const handle = await h.client.workflow.start(pingWorkflow, { taskQueue: TASK_QUEUE, workflowId: task.id, args: ['transfer'] });
    (await h.store.saveView(task.id, { taskId: task.id, title: task.title, workflow: 'just-do', status: 'done', stage: 'done', messages: [], actions: [], state: {} } as any));
    const route = `${base}/api/projects/${project.id}/transfer`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const preview = await (await fetch(route + `?destinationOrganizationId=${destination.id}`, { headers })).json() as any;
    expect(preview.blockers, JSON.stringify(preview)).toEqual([]);
    const move = () => fetch(route, { method: 'POST', headers, body: JSON.stringify({ destinationOrganizationId: destination.id, previewId: preview.id }) });
    const rejected = await move();
    expect(rejected.status).toBe(409);
    expect((await rejected.json() as any).error).toMatch(/workflow.*running/);
    expect((await h.store.getProject(project.id))?.organizationId).toBe('org_personal');
    await handle.signal(finish);
    expect(await handle.result()).toMatchObject({ started: 'transfer' });
    const accepted = await move();
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect((await h.store.getTask(task.id))?.title).toBe(task.title);
    expect((await h.store.getTask(task.id))?.num).toBe(task.num);
    const history = await fetch(`${base}/api/tasks/${task.id}`, { headers });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ taskId: task.id, actions: [], stageTransitions: [] });
    const fresh = await fetch(`${base}/api/projects/${project.id}/tasks`, { method: 'POST', headers,
      body: JSON.stringify({ projectId: project.id, title: 'New destination task', prompt: 'new work', workflow: 'just-do', draft: true }) });
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    expect(await fresh.json()).toMatchObject({ projectId: project.id, title: 'New destination task' });
  });
});
