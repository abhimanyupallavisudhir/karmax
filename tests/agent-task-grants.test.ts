import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationGrantError, AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import type { AuthorizationSelection } from '../src/domain/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPlatformMcpServer, apiOps } from '../src/platform/mcp.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { evaluateQuery, taskStatus } from '../src/domain/search.js';
import { parseQuery } from '../src/domain/query-language.js';

/**
 * An agent that creates a task gives it the authorization and vault credentials
 * it needs, up to what the agent itself holds. What it cannot grant is not a dead
 * end: the task is kept as a draft and the agent asks someone who can grant it,
 * as a person does from the task form (SPEC §8.2).
 */
async function fixture() {
  const store = await Store.create(':memory:');
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = await store.createProject('Site', {}, organization.id);
  const authorization = await AuthorizationService.create(store);
  await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
  for (const userId of ['admin', 'maint', 'dev']) await store.setOrganizationMembership(organization.id, userId, 'member');
  await authorization.grant('system:test', { principalId: 'user:admin', scopeKey: organizationScope(organization.id), profileId: 'administrator' });
  await authorization.grant('system:test', { principalId: 'user:maint', scopeKey: projectScope(project.id), profileId: 'maintainer' });
  await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const started: string[] = [];
  const signals: Array<{ workflowId: string; name: string; args: unknown[] }> = [];
  const client = { workflow: {
    getHandle: (workflowId: string) => ({ executeUpdate: async () => undefined, query: async () => { throw new Error('no live query'); },
      describe: async () => ({ runId: 'run', status: { name: 'RUNNING' } }),
      signal: async (name: string, ...args: unknown[]) => { signals.push({ workflowId, name, args }); } }),
    start: async (_type: unknown, options: { workflowId: string }) => { started.push(options.workflowId); return {}; },
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const human = async (userId: string) => (await tokens.mintPrincipal(`user:${userId}`,
    await authorization.capabilities(`user:${userId}`, project.id, organization.id), project.id, undefined, organization.id)).token;
  const vault = new VaultItems(store, undefined, undefined, organization.id);
  const login = await vault.save({ type: 'login', label: 'Stripe dashboard', domains: ['stripe.com'] });
  const cap = `use-credential:item:${login.id}`;
  /** The Do agent of a developer's task: only its own token, no human subject. */
  const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
    workflowVersion: '1.4.0', createdBy: { kind: 'user', userId: 'dev' }, params: { prompt: 'work' } });
  const agentOf = async (taskId: string, extra: string[] = []) => {
    const held = [...await authorization.capabilities('user:dev', project.id, organization.id), ...extra];
    return (await tokens.mint({ taskId, profileId: 'do', role: 'do', principal: `task-agent:${taskId}:do`,
      projectId: project.id, organizationId: organization.id, ceiling: held, grantorCaps: held })).token;
  };
  const agent = (extra: string[] = []) => agentOf(parent.id, extra);
  const developer: AuthorizationSelection = { level: 'developer', scope: 'projects', projectIds: [project.id] };
  const maintainer: AuthorizationSelection = { level: 'maintainer', scope: 'projects', projectIds: [project.id] };
  return { store, organization, project, api, human, agent, agentOf, cap, signals, developer, maintainer, started, parent };
}

const credentialsOf = (task: { params: Record<string, unknown> }) =>
  ((task.params._authorization as { capabilities: string[] }).capabilities).filter((cap) => cap.startsWith('use-credential:'));

describe('an agent creating a task', () => {
  it('grants it the authorization and credentials the agent holds', async () => {
    const f = await fixture();
    const task = await f.api.createTask(await f.agent([f.cap]), { projectId: f.project.id, workflow: 'just-do', prompt: 'pay',
      authorization: f.developer, credentialGrants: [f.cap], holdForAuthorization: true });
    expect(task.params.draft).toBe(false);
    expect(task.authorizationGap).toBeUndefined();
    expect(task.params._authorization).toMatchObject({ level: 'developer', profileAttenuated: false });
    expect(credentialsOf(task)).toEqual([f.cap]);
  });

  it('passes on a credential its own task stored, without asking anyone (task #716)', async () => {
    const f = await fixture();
    const vault = new VaultItems(f.store, undefined, undefined, f.organization.id);
    const stored = await vault.save({ type: 'api-key', label: 'AWS key it created',
      provenance: { source: `task:${f.parent.id}`, taskId: f.parent.id } });
    const storedCap = `use-credential:item:${stored.id}`;
    const task = await f.api.createTask(await f.agent(), { projectId: f.project.id, workflow: 'just-do', prompt: 'use it',
      authorization: f.developer, credentialGrants: [storedCap], holdForAuthorization: true });
    expect(task.params.draft).toBe(false);
    expect(task.authorizationGap).toBeUndefined();
    expect(credentialsOf(task)).toEqual([storedCap]);
    // Another task's agent did not create it, so it still has to ask.
    const other = await f.store.createTask({ projectId: f.project.id, title: 'Other', workflow: 'software-dev',
      workflowVersion: '1.4.0', createdBy: { kind: 'user', userId: 'dev' }, params: { prompt: 'work' } });
    const refused = await f.api.createTask(await f.agentOf(other.id), { projectId: f.project.id, workflow: 'just-do', prompt: 'use it',
      authorization: f.developer, credentialGrants: [storedCap], holdForAuthorization: true });
    expect(refused.params.draft).toBe(true);
    expect(refused.authorizationGap).toMatchObject({ missingCapabilities: [storedCap] });
    expect(refused.authorizationRequest).toBeDefined();
  });

  it('asks a person only for what it cannot grant itself, keeping its own credential', async () => {
    const f = await fixture();
    const vault = new VaultItems(f.store, undefined, undefined, f.organization.id);
    const stored = await vault.save({ type: 'api-key', label: 'its own key',
      provenance: { source: `task:${f.parent.id}`, taskId: f.parent.id } });
    const storedCap = `use-credential:item:${stored.id}`;
    const agent = await f.agent();
    const held = await f.api.createTask(agent, { projectId: f.project.id, workflow: 'just-do', prompt: 'deploy',
      authorization: f.maintainer, credentialGrants: [storedCap, f.cap], holdForAuthorization: true });
    expect(held.params.draft).toBe(true);
    expect(held.authorizationGap!.missingCapabilities).toContain(f.cap);
    expect(held.authorizationGap!.missingCapabilities).not.toContain(storedCap);
    await f.api.resolveAuthorizationRequest(await f.human('admin'), {
      organizationId: f.organization.id, requestId: held.authorizationRequest!.id, action: 'approve' });
    const task = (await f.store.getTask(held.id))!;
    expect(task.params.draft).toBe(false);
    expect(credentialsOf(task).sort()).toEqual([storedCap, f.cap].sort());
  });

  it('lets a task grant its own stored credential to a draft it created later', async () => {
    const f = await fixture();
    const agent = await f.agent();
    const draft = await f.api.createTask(agent, { projectId: f.project.id, workflow: 'just-do', prompt: 'later',
      authorization: f.developer, draft: true, holdForAuthorization: true });
    const vault = new VaultItems(f.store, undefined, undefined, f.organization.id);
    const stored = await vault.save({ type: 'api-key', label: 'made after the draft',
      provenance: { source: `task:${f.parent.id}`, taskId: f.parent.id } });
    const storedCap = `use-credential:item:${stored.id}`;
    await f.api.setTaskAuthorization(agent, draft.id, f.developer, [storedCap]);
    expect(credentialsOf((await f.store.getTask(draft.id))!)).toEqual([storedCap]);
  });

  it('runs a task it cannot fully grant: it waits for approval, asked at once, and starts when approved (task #716)', async () => {
    const f = await fixture();
    const held = await f.api.createTask(await f.agent(), { projectId: f.project.id, workflow: 'just-do', prompt: 'deploy',
      authorization: f.maintainer, credentialGrants: [f.cap], holdForAuthorization: true,
      authorizationReason: 'It deploys the site and pays Stripe.' });
    // Not started, but not a draft to anyone looking at it: numbered and waiting.
    expect(held.params).toMatchObject({ draft: true, _awaitingApproval: held.authorizationRequest!.id });
    expect(held.num).toEqual(expect.any(Number));
    expect(f.started).not.toContain(held.id);
    expect(held.params._authorization).toMatchObject({ profileAttenuated: true, attenuationAccepted: false });
    expect(held.authorizationGap).toMatchObject({ summon: '@admins', missingCapabilities: expect.arrayContaining(['project:edit', f.cap]) });
    expect(held.authorizationGap!.next).toMatch(/^Waiting for approval from @admins/);
    expect(held.authorizationRequest).toMatchObject({ audience: ['@admins'] });
    const [request] = await f.api.listAuthorizationRequests(await f.human('owner'), { organizationId: f.organization.id, taskId: held.id });
    expect(request).toMatchObject({ id: held.authorizationRequest!.id, authorization: f.maintainer, credentialGrants: [f.cap],
      target: { kind: 'task', taskId: held.id, queueAfterApproval: true }, reason: 'It deploys the site and pays Stripe.' });
    expect([...request!.recipients].sort()).toEqual(['admin', 'owner']);
    // Asking does not hold the creating agent's own task.
    expect((await f.store.getTask(f.parent.id))!.lastView?.waitingFor).toBeUndefined();

    const resolved = await f.api.resolveAuthorizationRequest(await f.human('admin'), {
      organizationId: f.organization.id, requestId: request!.id, action: 'approve' });
    expect(resolved).toMatchObject({ status: 'granted', queued: true });
    const task = (await f.store.getTask(held.id))!;
    expect(task.params.draft).toBe(false);
    expect(task.params._awaitingApproval).toBeNull();
    expect(task.num).toBe(held.num);
    expect(f.started).toContain(held.id);
    expect(task.params._authorization).toMatchObject({ level: 'maintainer', profileAttenuated: false });
    expect(credentialsOf(task)).toEqual([f.cap]);
    // Without the option the API still refuses, so the console can show its warning first.
    await expect(f.api.createTask(await f.agent(), { projectId: f.project.id, workflow: 'just-do', prompt: 'deploy',
      authorization: f.maintainer })).rejects.toBeInstanceOf(AuthorizationGrantError);
  });

  it('routes the ask to the audience it names', async () => {
    const f = await fixture();
    const held = await f.api.createTask(await f.agent(), { projectId: f.project.id, workflow: 'just-do', prompt: 'deploy',
      authorization: f.maintainer, holdForAuthorization: true, authorizationAudience: ['user:maint'] });
    expect(held.authorizationGap).toMatchObject({ summon: '@maintainers' });
    expect(held.authorizationRequest).toMatchObject({ audience: ['user:maint'] });
  });

  it('arms its dependency once approved, and a denial makes it a draft again', async () => {
    const f = await fixture();
    const dependency = await f.api.createTask(await f.human('dev'), { projectId: f.project.id, workflow: 'just-do', prompt: 'first' });
    const triggers = [{ kind: 'dependency', tasks: [dependency.id] }];
    const waiting = await f.api.createTask(await f.agent(), { projectId: f.project.id, workflow: 'just-do', prompt: 'then',
      params: { triggers }, authorization: f.maintainer, holdForAuthorization: true });
    await f.api.resolveAuthorizationRequest(await f.human('admin'), {
      organizationId: f.organization.id, requestId: waiting.authorizationRequest!.id, action: 'approve' });
    expect((await f.store.getTask(waiting.id))!.params).toMatchObject({ draft: false, triggerState: 'armed' });
    expect(f.started).not.toContain(waiting.id);

    const denied = await f.api.createTask(await f.agent(), { projectId: f.project.id, workflow: 'just-do', title: 'Deploy the site',
      prompt: 'deploy', authorization: f.maintainer, holdForAuthorization: true });
    // Ignoring the request only hides it: the task still waits on it.
    await f.api.resolveAuthorizationRequest(await f.human('admin'), {
      organizationId: f.organization.id, requestId: denied.authorizationRequest!.id, action: 'dismiss' });
    expect((await f.store.getTask(denied.id))!.params._awaitingApproval).toBe(denied.authorizationRequest!.id);
    expect(f.signals).toEqual([]);
    await f.api.resolveAuthorizationRequest(await f.human('admin'), {
      organizationId: f.organization.id, requestId: denied.authorizationRequest!.id, action: 'deny' });
    expect((await f.store.getTask(denied.id))!.params).toMatchObject({ draft: true, _awaitingApproval: null });
    // The agent that created it hears so at once, from that task.
    expect(f.signals).toHaveLength(1);
    const [told] = f.signals;
    expect(told).toMatchObject({ workflowId: f.parent.id, name: 'followUp', args: [expect.objectContaining({
      author: `task:${denied.id}`, authorLabel: `Task #${denied.num}` }), 'do'] });
    expect((told!.args[0] as { text: string }).text).toMatch(/denied the maintainer authorization .*"Deploy the site".* did not start/);
    expect((told!.args[0] as { text: string }).text).toContain(`PATCH /api/tasks/${denied.id}/authorization`);
  });

  it('tells no one when the creating task has finished, nor when a person created it', async () => {
    const f = await fixture();
    const byPerson = await f.api.createTask(await f.human('dev'), { projectId: f.project.id, workflow: 'just-do', prompt: 'deploy',
      authorization: f.maintainer, holdForAuthorization: true });
    await f.api.resolveAuthorizationRequest(await f.human('admin'), {
      organizationId: f.organization.id, requestId: byPerson.authorizationRequest!.id, action: 'deny' });
    const byAgent = await f.api.createTask(await f.agent(), { projectId: f.project.id, workflow: 'just-do', prompt: 'deploy',
      authorization: f.maintainer, holdForAuthorization: true });
    await f.store.saveView(f.parent.id, { stage: 'done', status: 'done' } as any);
    await f.api.resolveAuthorizationRequest(await f.human('admin'), {
      organizationId: f.organization.id, requestId: byAgent.authorizationRequest!.id, action: 'deny' });
    expect(f.signals).toEqual([]);
    expect((await f.store.getTask(byAgent.id))!.params.draft).toBe(true);
  });

  it('only keeps a deliberate draft, which its creator asks for when it should run', async () => {
    const f = await fixture();
    const agent = await f.agent();
    const draft = await f.api.createTask(agent, { projectId: f.project.id, workflow: 'just-do', prompt: 'deploy',
      authorization: f.maintainer, draft: true, holdForAuthorization: true });
    expect(draft.authorizationRequest).toBeUndefined();
    expect(draft.params._awaitingApproval).toBeUndefined();
    expect(draft.authorizationGap!.next).toContain('request_permission');
    const asked = await f.api.requestPermission(agent, { taskId: draft.id, reason: 'Deploys.' });
    expect(asked).toMatchObject({ status: 'needs_approval', audience: ['@maintainers'] });
    expect((await f.store.getTask(draft.id))!.params._awaitingApproval).toBe(asked.requestId);
  });

  it('is searched as waiting for approval, not as its creator’s draft', () => {
    const waiting = { id: 't', projectId: 'p', title: 'Deploy', createdBy: { kind: 'user', userId: 'dev' },
      params: { draft: true, _awaitingApproval: 'areq_1' } } as any;
    const draft = { ...waiting, id: 'd', params: { draft: true } };
    const ids = (q: string) => evaluateQuery([waiting, draft], parseQuery(q), { now: 0 }).tasks.map((t) => t.id);
    expect(ids('is:awaiting-approval')).toEqual(['t']);
    expect(ids('is:draft')).toEqual(['d']);
    expect(evaluateQuery([waiting, draft], parseQuery('for:me'), { now: 0, userId: 'dev' }).tasks.map((t) => t.id)).toEqual(['d']);
    expect(taskStatus(waiting)).toBe('waiting');
  });

  it('cannot ask on behalf of a task it did not create, nor for one that needs nothing', async () => {
    const f = await fixture();
    const own = await f.api.createTask(await f.agent(), { projectId: f.project.id, workflow: 'just-do', prompt: 'small',
      authorization: f.developer, draft: true, holdForAuthorization: true });
    await expect(f.api.requestPermission(await f.agent(), { taskId: own.id, reason: 'x' })).rejects.toThrow(/already has/);
    const someoneElses = await f.api.createTask(await f.human('dev'), { projectId: f.project.id, workflow: 'just-do',
      prompt: 'deploy', authorization: f.maintainer, draft: true, allowAttenuation: true });
    await expect(f.api.requestPermission(await f.agent(), { taskId: someoneElses.id, reason: 'x' }))
      .rejects.toThrow(/only the task creator/);
  });
});

describe('the agent tools', () => {
  it('create_task grants what it can and asks for the rest itself; the task waits for approval (MCP)', async () => {
    const f = await fixture();
    const agent = await f.agent();
    const server = createPlatformMcpServer(apiOps(f.api, () => agent));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
    const text = (result: any) => result.content[0].text as string;

    const plain = await client.callTool({ name: 'create_task', arguments: { projectId: f.project.id, title: 'Small', prompt: 'small',
      workflow: 'just-do', authorization: f.developer } });
    expect((await f.store.getTask(text(plain)))!.params._authorization).toMatchObject({ level: 'developer', profileAttenuated: false });

    const held: any = JSON.parse(text(await client.callTool({ name: 'create_task', arguments: { projectId: f.project.id,
      title: 'Deploy', prompt: 'deploy', workflow: 'just-do', authorization: f.maintainer, credentialGrants: [f.cap],
      authorizationReason: 'It deploys the site.' } })));
    expect(held).toMatchObject({ waitingForApproval: { audience: ['@admins'] }, authorizationGap: { summon: '@admins' } });
    const [request] = await f.api.listAuthorizationRequests(await f.human('owner'), { organizationId: f.organization.id, taskId: held.id });
    expect(request).toMatchObject({ id: held.waitingForApproval.id, reason: 'It deploys the site.' });
  });

  it('create_task and request_permission send the grant and the task id (provider-neutral)', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const handlers = platformToolHandlers({} as any, { emit() {}, emitActivity() {},
      platformRequest: async (method: string, path: string, body: unknown) => { calls.push({ method, path, body }); return { id: 'task_x' }; } } as any);
    const authorization = { level: 'maintainer', scope: 'projects', projectIds: ['p'] };
    await handlers.create_task!({ project_id: 'p', title: 't', prompt: 'x', authorization, credential_grants: ['use-credential:item:i'],
      authorization_audience: ['user:maint'], authorization_reason: 'needs it' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/projects/p/tasks',
      body: { authorization, credentialGrants: ['use-credential:item:i'], holdForAuthorization: true,
        authorizationAudience: ['user:maint'], authorizationReason: 'needs it' } });
    await handlers.request_permission!({ task_id: 'task_x', reason: 'needs it' });
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/agent/permission-requests', body: { taskId: 'task_x', reason: 'needs it' } });
  });
});
