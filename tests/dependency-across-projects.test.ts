import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AppGrants, sessionCapabilities } from '../src/auth/app-grants.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { TriggerScheduler } from '../src/platform/trigger-scheduler.js';
import type { KarmaxEvent } from '../src/domain/types.js';

/**
 * A task may wait on a task in another project of its organization, exactly as
 * it may fork one: whoever saves it must be able to read that task, and the
 * task's own Authorization must reach its project — an armed task keeps
 * watching the other project, and its agent then reads what that task did.
 */
async function fixture() {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('owner'));
  (await store.setOrganizationMembership('org_personal', 'dev', 'member'));
  const source = (await store.createProject('Pramana'));
  const target = (await store.createProject('Indike'));
  const authorization = (await AuthorizationService.create(store));
  for (const project of [source, target])
    (await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' }));
  (await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(target.id), profileId: 'developer' }));
  const tokens = new TokenAuthority(store);
  tokens.connectIdentitySessions(async (sessionId, userId) => !sessionId.startsWith('grant_') || (await new AppGrants(store).live(sessionId, userId)));
  // What the gateway mints for a browser session on a route in `projectId`.
  const routeToken = async (userId: string, projectId: string) => (await tokens.mintPrincipal(`user:${userId}`,
    (await sessionCapabilities(authorization, userId, undefined, { projectId, organizationId: 'org_personal' })),
    projectId, undefined, 'org_personal')).token;
  const client = { workflow: { getHandle: () => ({ executeUpdate: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const bus = new KarmaxBus();
  const fired: string[] = [];
  const scheduler = new TriggerScheduler({ store, bus, reconcileMs: 0, fire: async (taskId) => void fired.push(taskId) });
  api.setTriggerArmer(scheduler);
  (await scheduler.start());
  const task = (await store.createTask({ projectId: source.id, title: 'Source', workflow: 'software-dev', workflowVersion: '1.26.0',
    createdBy: { kind: 'user', userId: 'owner' }, params: { prompt: 'source' } }));
  const close = async () => { (await scheduler.stop()); (await store.close()); };
  return { store, source, target, api, routeToken, task, authorization, bus, fired, scheduler, close };
}

const after = (...tasks: string[]) => ({ prompt: 'update the client', triggers: [{ kind: 'dependency', tasks }] });
const authorization = (...projectIds: string[]) => ({ level: 'developer', scope: 'projects' as const, projectIds });

describe('a task depending on a task in another project', () => {
  it('waits for it and starts when it succeeds', async () => {
    const f = (await fixture());
    const token = (await f.routeToken('owner', f.target.id));
    const dependent = (await f.api.createTask(token, { projectId: f.target.id,
      authorization: authorization(f.target.id, f.source.id), params: after(f.task.id) }));
    expect(dependent.projectId).toBe(f.target.id);
    expect(dependent.params.triggerState).toBe('armed');
    expect(f.fired).toEqual([]);
    (await f.store.saveView(f.task.id, { taskId: f.task.id, status: 'done' } as any));
    (await f.bus.emit({ type: 'view.updated', taskId: f.task.id, ts: 0, payload: { status: 'done' } } as KarmaxEvent));
    expect(f.fired).toEqual([dependent.id]);
    (await f.close());
  });

  it("refuses a person who cannot read the dependency's project", async () => {
    const f = (await fixture());
    await expect(f.api.createTask((await f.routeToken('dev', f.target.id)), { projectId: f.target.id, draft: true,
      params: after(f.task.id) })).rejects.toThrow(/missing capability task:read in project "Pramana"/);
    (await f.close());
  });

  it('does not reach into another organization', async () => {
    const f = (await fixture());
    const other = (await f.store.createOrganization({ name: 'Elsewhere', ownerUserId: 'owner' }));
    const outside = (await f.store.createProject('Outside', {}, other.id));
    (await f.authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(outside.id), profileId: 'maintainer' }));
    const foreign = (await f.store.createTask({ projectId: outside.id, title: 'Foreign', workflow: 'software-dev', workflowVersion: '1.26.0',
      createdBy: { kind: 'user', userId: 'owner' }, params: { prompt: 'foreign' } }));
    await expect(f.api.createTask((await f.routeToken('owner', f.target.id)), { projectId: f.target.id, draft: true,
      params: after(foreign.id) })).rejects.toThrow(/belongs to another organization|scoped to/);
    (await f.close());
  });

  it("never arms a stored dependency on another organization's task, which would otherwise leak its outcome", async () => {
    const f = (await fixture());
    const other = (await f.store.createOrganization({ name: 'Elsewhere', ownerUserId: 'owner' }));
    const outside = (await f.store.createProject('Outside', {}, other.id));
    const foreign = (await f.store.createTask({ projectId: outside.id, title: 'Foreign', workflow: 'software-dev', workflowVersion: '1.26.0',
      params: { prompt: 'foreign' } }));
    (await f.store.saveView(foreign.id, { taskId: foreign.id, status: 'done' } as any));
    const armed = (await f.store.createTask({ projectId: f.target.id, title: 'Armed', workflow: 'software-dev', workflowVersion: '1.26.0',
      params: { ...after(foreign.id), triggerState: 'armed' } }));
    await expect(f.scheduler.arm(armed)).rejects.toThrow(`dependency task ${foreign.id} does not exist`);
    expect(f.fired).toEqual([]);
    (await f.close());
  });
});

describe("starting a task whose authorization does not reach its dependency's project", () => {
  it('refuses Run task up front, naming the project to add, and leaves no task behind', async () => {
    const f = (await fixture());
    const token = (await f.routeToken('owner', f.target.id));
    await expect(f.api.createTask(token, { projectId: f.target.id, authorization: authorization(f.target.id), params: after(f.task.id) }))
      .rejects.toThrow('Add project "Pramana" to this task’s Authorization to depend on #1');
    expect((await f.store.listTasks(f.target.id))).toEqual([]);
    (await f.close());
  });

  it('keeps such a task a draft when it is queued, until the project is added', async () => {
    const f = (await fixture());
    const token = (await f.routeToken('owner', f.target.id));
    const draft = (await f.api.createTask(token, { projectId: f.target.id, draft: true,
      authorization: authorization(f.target.id), params: after(f.task.id) }));
    await expect(f.api.queueTask(token, draft.id)).rejects.toThrow(/Add project "Pramana" to this task’s Authorization/);
    expect((await f.store.getTask(draft.id))!.params.draft).toBe(true);
    (await f.api.setTaskAuthorization(token, draft.id, authorization(f.target.id, f.source.id)));
    expect((await f.api.queueTask(token, draft.id)).params.triggerState).toBe('armed');
    (await f.close());
  });

  it('refuses an armed task the new dependency, leaving it armed as it was', async () => {
    const f = (await fixture());
    const token = (await f.routeToken('owner', f.target.id));
    const local = (await f.store.createTask({ projectId: f.target.id, title: 'Local', workflow: 'software-dev', workflowVersion: '1.26.0',
      params: { prompt: 'local' } }));
    const armed = (await f.api.createTask(token, { projectId: f.target.id, authorization: authorization(f.target.id), params: after(local.id) }));
    expect(armed.params.triggerState).toBe('armed');
    await expect(f.api.updateArmedParams(token, armed.id, after(local.id, f.task.id), { keepArmed: true }))
      .rejects.toThrow('Add project "Pramana" to this task’s Authorization to depend on #1');
    const unchanged = (await f.store.getTask(armed.id))!;
    expect(unchanged.params.triggerState).toBe('armed');
    expect(unchanged.params.triggers).toEqual(after(local.id).triggers);
    (await f.close());
  });
});
