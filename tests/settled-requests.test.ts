import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { AuthorizationRequests } from '../src/platform/authorization-requests.js';
import { ServiceConnections } from '../src/integrations/service-connections.js';
import { TASK_SETTLED } from '../src/platform/settled-requests.js';

// Once a task is done or cancelled, nothing it asked for can reach it any more,
// so its asks stop asking: no "approval needed" in its row, rail, inbox or bell.
// Each is ignored, as a person's Ignore would (permission requests are
// withdrawn, PL-10). A failed task keeps them: recovery resumes it still waiting.
describe('the requests of a task that settled', () => {
  async function asked() {
    const store = await Store.create(':memory:');
    const organization = await store.createOrganization({ name: 'Settle', ownerUserId: 'owner' });
    const project = await store.createProject('P', {}, organization.id);
    const task = await store.createTask({ projectId: project.id, title: 'Asks', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } });
    const vault = new VaultItems(store, undefined, undefined, organization.id);
    const credential = (await vault.request({ taskId: task.id, caps: [], domain: 'github.com', mode: 'use', why: 'log in' })).requestId!;
    const authorizations = new AuthorizationRequests(store, organization.id);
    const authorization = (await authorizations.request({ projectId: project.id, target: { kind: 'task', taskId: task.id },
      authorization: { level: 'developer' } as any, capabilities: [], missingCapabilities: [], audience: ['user:owner'],
      recipients: ['owner'], reason: 'Access', requestedBy: `task-agent:${task.id}:do` })).id;
    const connection = { id: 'conn_1', organizationId: organization.id, ownerId: 'owner', toolkit: 'gmail', label: 'Gmail',
      projectIds: [project.id], taskId: task.id, status: 'requested', createdAt: 1, updatedAt: 1 };
    await store.kvSet(`service-connection:${connection.id}`, JSON.stringify(connection));
    const connections = new ServiceConnections(store, {} as any);
    for (const [type, requestId] of [['credential.approval-requested', credential], ['authorization.approval-requested', authorization],
      ['connection.requested', connection.id]] as const)
      await store.appendEvent({ taskId: task.id, type, ts: Date.now(), payload: { requestId, recipients: ['owner'] } });
    expect((await store.listInbox('owner', organization.id)).map((item) => item.kind)).toContain('approval-requested');
    const view = (status: 'active' | 'done' | 'failed' | 'cancelled') => ({ taskId: task.id, title: task.title,
      workflow: task.workflow, stage: status === 'active' ? 'do' as const : status, status, messages: [], actions: [],
      state: {}, updatedAt: 1 });
    const state = async () => ({
      credential: (await vault.requests({ taskId: task.id }))[0]!,
      authorization: (await authorizations.requests({ taskId: task.id }))[0]!,
      connection: (await connections.all()).find((candidate) => candidate.id === connection.id)!,
    });
    return { store, organization, task, view, state };
  }

  it.each(['done', 'cancelled'] as const)('ignores every request still asking once it is %s', async (status) => {
    const f = await asked();
    try {
      await f.store.saveView(f.task.id, f.view('active'));
      await f.store.saveView(f.task.id, f.view(status));
      const after = await f.state();
      for (const request of [after.credential, after.authorization, after.connection])
        expect(request.dismissed).toMatchObject({ by: TASK_SETTLED });
      // Ignored, not decided: still answerable, as after a person's Ignore.
      expect([after.credential.status, after.authorization.status, after.connection.status]).toEqual(['pending', 'pending', 'requested']);
      expect((await f.store.eventsSince(f.task.id, 0)).map((event) => event.type)).toEqual(expect.arrayContaining(
        ['credential.approval-dismissed', 'authorization.approval-dismissed', 'connection.dismissed']));
      expect((await f.store.listInbox('owner', f.organization.id)).map((item) => item.kind)).not.toContain('approval-requested');
    } finally { await f.store.close(); }
  });

  it('keeps a failed task\'s requests asking', async () => {
    const f = await asked();
    try {
      await f.store.saveView(f.task.id, f.view('active'));
      await f.store.saveView(f.task.id, f.view('failed'));
      const after = await f.state();
      for (const request of [after.credential, after.authorization, after.connection]) expect(request.dismissed).toBeUndefined();
    } finally { await f.store.close(); }
  });

  it('ignores the requests of tasks that settled before this existed', async () => {
    const f = await asked();
    try {
      // Settled without the hook, as before this change.
      await f.store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify(f.view('done')), f.task.id);
      await f.store.retentionSweep();
      const after = await f.state();
      for (const request of [after.credential, after.authorization, after.connection])
        expect(request.dismissed).toMatchObject({ by: TASK_SETTLED });
    } finally { await f.store.close(); }
  });
});
