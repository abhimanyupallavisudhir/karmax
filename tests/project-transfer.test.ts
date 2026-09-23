import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { ProjectTransfers } from '../src/platform/project-transfer.js';
import { AuthorizationService, DEFAULT_AUTHORIZATION_PROFILES } from '../src/platform/authorization.js';
import { beginEnvironmentBuild, finishEnvironmentBuild, ProjectEnvironment } from '../src/store/project-environment.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import previousProfiles from './fixtures/authorization-pre-diagnostics.json';

const stores: Store[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
async function fixture() {
  const store = await Store.create(':memory:'); stores.push(store);
  const source = (await store.createOrganization({ name: 'Source', ownerUserId: 'alice' }));
  const destination = (await store.createOrganization({ name: 'Destination', ownerUserId: 'bob' }));
  const project = (await store.createProject('Folder/Project', {}, source.id));
  (await store.setProjectMembership(project.id, { kind: 'user', userId: 'alice' }, 'owner'));
  const authorize = (cap: string, org: string) => {
    if (!['project:transfer-out', 'project:transfer-in'].includes(cap) || ![source.id, destination.id].includes(org)) throw new Error('denied');
  };
  const transfers = new ProjectTransfers(store, { principal: 'user:operator', authorize,
    workflowClosed: async () => true });
  return { store, source, destination, project, transfers };
}

describe('project transfer', () => {
  it('moves atomically, preserves IDs/history, replaces access, and retries idempotently', async () => {
    const { store, source, destination, project, transfers } = (await fixture());
    const task = (await store.createTask({ projectId: project.id, title: 'History', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'Keep me' } }));
    (await store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done' } as any));
    (await store.appendEvent({ taskId: task.id, type: 'example', ts: 1, payload: { text: 'History' } }));
    const tokens = new TokenAuthority(store);
    const old = (await tokens.mint({ taskId: task.id, profileId: 'developer', principal: 'user:alice', projectIds: [project.id], organizationId: source.id, ceiling: ['*'], grantorCaps: ['*'] }));
    const preview = (await transfers.preview(project.id, destination.id));
    expect(preview.blockers).toEqual([]);
    const moved = await transfers.move(project.id, destination.id, preview.id);
    expect(moved.id).toBe(project.id);
    expect(moved.organizationId).toBe(destination.id);
    expect(moved.folder).toBeUndefined();
    expect((await store.getTask(task.id))?.title).toBe('History');
    expect((await store.userIsProjectMember(project.id, 'alice'))).toBe(false);
    expect((await store.userIsProjectMember(project.id, 'bob'))).toBe(true);
    expect((await tokens.verify(old.token))).toBeUndefined();
    expect(await transfers.move(project.id, destination.id, preview.id)).toEqual(moved);
    expect((await store.auditSince()).filter(r => r.scopeKey === 'organization:' + source.id).some(r => r.action === 'project.transferred')).toBe(true);
  });

  it('rejects a stale preview without changing ownership or access', async () => {
    const { store, destination, project, transfers } = (await fixture());
    const preview = (await transfers.preview(project.id, destination.id));
    (await store.renameProject(project.id, 'Changed'));
    await expect(transfers.move(project.id, destination.id, preview.id)).rejects.toThrow(/changed|preview/i);
    expect((await store.getProject(project.id))?.organizationId).toBe(project.organizationId);
    expect((await store.userIsProjectMember(project.id, 'alice'))).toBe(true);
  });

  it('checks both organization permissions again when committing', async () => {
    const { store, destination, project, transfers } = (await fixture());
    const preview = (await transfers.preview(project.id, destination.id));
    const denied = new ProjectTransfers(store, { principal: 'user:operator', authorize: () => { throw new Error('denied'); }, workflowClosed: async () => true });
    await expect(denied.move(project.id, destination.id, preview.id)).rejects.toThrow('denied');
    expect((await store.getProject(project.id))?.organizationId).toBe(project.organizationId);
  });

  it('does not trust a terminal view while the workflow is still running', async () => {
    const { store, destination, project } = (await fixture());
    const task = (await store.createTask({ projectId: project.id, title: 'Finishing', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } }));
    (await store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done' } as any));
    const transfers = new ProjectTransfers(store, { principal: 'operator', authorize: () => {}, workflowClosed: async () => false });
    const preview = (await transfers.preview(project.id, destination.id));
    await expect(transfers.move(project.id, destination.id, preview.id)).rejects.toThrow(/workflow|running/i);
    expect((await store.getProject(project.id))?.organizationId).toBe(project.organizationId);
    expect((await store.kvGet(`project-transfer-lock:${project.id}`))).toBeUndefined();
  });

  it('blocks a payment while the provider authorization is in flight', async () => {
    const { store, project, destination, transfers } = (await fixture());
    const task = (await store.createTask({ projectId: project.id, title: 'Draft', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'purchase', draft: true } }));
    (await store.createPaymentSpendRequest({ organizationId: project.organizationId!, projectId: project.id, taskId: task.id,
      amount: 100, status: 'authorizing' }));
    expect((await transfers.preview(project.id, destination.id)).blockers).toContainEqual(expect.objectContaining({ code: 'spending' }));
  });

  it('blocks active work, name collisions, and resources with source-owned storage', async () => {
    const { store, destination, project, transfers } = (await fixture());
    (await store.createProject('Project', {}, destination.id));
    (await store.createTask({ projectId: project.id, title: 'Running', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } }));
    (await store.db.prepare(`INSERT INTO resource_attachments (id, organizationId, projectId, name, driver, target, access, isolation, source, credentialHandles, publish, enabled, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('resource', project.organizationId, project.id, 'Database', 'volume@1', '{}', 'read', 'fork', '{}', '[]', 'review', 1, 1, 1));
    const preview = (await transfers.preview(project.id, destination.id));
    expect(preview.blockers.map(b => b.code)).toEqual(expect.arrayContaining(['name-conflict', 'active-tasks', 'resources']));
  });
});

describe('project transfer boundaries and recovery', () => {
  it('rolls back ownership, grants, tokens and task changes if any commit write fails', async () => {
    const { store, destination, project, transfers } = (await fixture());
    const draft = (await store.createTask({ projectId: project.id, title: 'Draft', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'hello', draft: true } }));
    const tokens = new TokenAuthority(store);
    const old = (await tokens.mintPrincipal('user:alice', ['*'], project.id, 60_000, project.organizationId)).token;
    const preview = (await transfers.preview(project.id, destination.id));
    const append = store.appendAudit;
    store.appendAudit = () => { throw new Error('injected write failure'); };
    await expect(transfers.move(project.id, destination.id, preview.id)).rejects.toThrow('injected write failure');
    store.appendAudit = append;
    expect((await store.getProject(project.id))?.organizationId).toBe(project.organizationId);
    expect((await store.userIsProjectMember(project.id, 'alice'))).toBe(true);
    expect((await store.userIsProjectMember(project.id, 'bob'))).toBe(false);
    expect((await store.getTask(draft.id))?.params).toEqual(draft.params);
    expect((await tokens.verify(old))).toBeDefined();
    expect((await store.kvGet(`project-transfer-lock:${project.id}`))).toBeUndefined();
    expect((await transfers.move(project.id, destination.id, preview.id)).organizationId).toBe(destination.id);
  });

  it('fences new tasks and stale organization tokens during and after cutover', async () => {
    const { store, destination, project, source } = (await fixture());
    const task = (await store.createTask({ projectId: project.id, title: 'History', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } }));
    (await store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done' } as any));
    const tokens = new TokenAuthority(store);
    const old = (await tokens.mintPrincipal('user:alice', ['*'], undefined, 60_000, source.id)).token;
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const checking = new Promise<void>(resolve => { release = resolve; });
    const transfers = new ProjectTransfers(store, { principal: 'operator', authorize: () => {}, workflowClosed: async () => { entered(); await checking; return true; } });
    const preview = (await transfers.preview(project.id, destination.id));
    const moving = transfers.move(project.id, destination.id, preview.id);
    await started;
    expect((await tokens.check(old, 'task:create', { projectId: project.id })).ok).toBe(false);
    expect((await tokens.check(old, 'task:read', { projectId: project.id })).ok).toBe(true);
    await expect(store.createTask({ projectId: project.id, title: 'Late', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'late' } })).rejects.toThrow(/move in progress/);
    release(); await moving;
    expect((await tokens.check(old, 'task:read', { projectId: project.id })).ok).toBe(false);
    const fresh = (await tokens.mintPrincipal('user:bob', ['*'], project.id, 60_000, destination.id)).token;
    expect((await tokens.check(fresh, 'task:read', { projectId: project.id, taskId: task.id })).ok).toBe(true);
    expect((await tokens.check(fresh, 'task:signal', { projectId: project.id, taskId: task.id })).ok).toBe(false);
    await expect(store.assertProjectOrganization(project.id, source.id)).rejects.toThrow(/organization changed/);
  });

  it('clears task-keyed credentials, public shares, profiles and source-only access', async () => {
    const { store, destination, project, transfers, source } = (await fixture());
    const task = (await store.createTask({ projectId: project.id, title: 'Draft', workflow: 'just-do', workflowVersion: '1', params: {
      prompt: 'Keep the prompt', draft: true, profiles: { do: 'source-profile' }, 'agent:do': { mcpConnections: ['source-mcp'] },
      _authorization: { capabilities: ['*'], principal: 'user:alice' }, _githubAccountId: 'source-account', paymentPolicy: { cardIds: ['source-card'], budget: null },
    } }));
    for (const key of [`vault:grant:${task.id}`, `vault:pass:${task.id}`, `vault:task-policy:${task.id}`, `permission:grant:${task.id}`]) (await store.kvSet(key, 'secret-authority'));
    (await store.kvSet(`conversation-share-index:${task.id}:do`, 'public')); (await store.kvSet('conversation-share:public', '{}'));
    (await store.kvSet(`vault:requests:${source.id}`, JSON.stringify([{ taskId: task.id }, { taskId: 'other' }])));
    (await store.kvSet('service-connection:shared', JSON.stringify({ organizationId: source.id, projectIds: [project.id, 'other-project'] })));
    (await store.db.prepare('INSERT INTO profiles (id, json) VALUES (?, ?)').run(`${project.id}::do-default`, JSON.stringify({ id: `${project.id}::do-default`, account: 'source-account' })));
    (await store.setSettings(project.id, '__common__', { 'agent:do': { account: 'source-account' } }));
    const preview = (await transfers.preview(project.id, destination.id));
    await transfers.move(project.id, destination.id, preview.id);
    const params = (await store.getTask(task.id))!.params;
    expect(params.prompt).toBe('Keep the prompt');
    expect(params.profiles).toBeUndefined();
    expect(params._githubAccountId).toBeUndefined();
    expect(params.paymentPolicy).toBeUndefined();
    expect(params['agent:do']).toBeUndefined();
    expect(params._authorization).toMatchObject({ capabilities: [], organizationId: destination.id, attenuationAccepted: false });
    expect((await store.kvGet(`vault:grant:${task.id}`))).toBeUndefined();
    expect((await store.kvGet('conversation-share:public'))).toBeUndefined();
    expect(JSON.parse((await store.kvGet(`vault:requests:${source.id}`))!)).toEqual([{ taskId: 'other' }]);
    expect(JSON.parse((await store.kvGet('service-connection:shared'))!).projectIds).toEqual(['other-project']);
    expect((await store.getProfile(`${project.id}::do-default`))).toBeUndefined();
    expect((await store.getSettings(project.id, '__common__'))).toBeUndefined();
  });

  it('remaps repository and wiki attachments without moving repository credentials', async () => {
    const { store, source, destination, project, transfers } = (await fixture());
    const repo = { provider: 'github' as const, providerId: '123', owner: 'owner', name: 'code', sshUrl: 'git@github.com:owner/code.git', defaultBranch: 'main', private: true };
    const from = (await store.upsertRepository({ ...repo, organizationId: source.id }));
    (await store.attachProjectRepository({ projectId: project.id, repositoryId: from.id }));
    (await store.db.prepare('INSERT INTO project_wikis (projectId, repositoryId, createdAt, updatedAt) VALUES (?, ?, ?, ?)').run(project.id, from.id, 1, 1));
    expect((await transfers.preview(project.id, destination.id)).blockers.some(b => b.code === 'repository')).toBe(true);
    const to = (await store.upsertRepository({ ...repo, organizationId: destination.id }));
    const preview = (await transfers.preview(project.id, destination.id));
    expect(preview.blockers).toEqual([]);
    await transfers.move(project.id, destination.id, preview.id);
    expect((await store.listProjectRepositories(project.id))[0]?.repositoryId).toBe(to.id);
    expect((await store.projectWiki(project.id))?.repository?.id).toBe(to.id);
    expect((await store.getRepository(from.id))?.organizationId).toBe(source.id);
  });

  it('rejects changed destination defaults and expired previews', async () => {
    const { store, destination, project, transfers } = (await fixture());
    const stale = (await transfers.preview(project.id, destination.id));
    (await store.setSettings(`organization:${destination.id}`, '__common__', { prompt: 'Changed policy' }));
    await expect(transfers.move(project.id, destination.id, stale.id)).rejects.toThrow(/changed/);
    const expired = (await transfers.preview(project.id, destination.id));
    const key = `project-transfer:${expired.id}`;
    (await store.kvSet(key, JSON.stringify({ ...JSON.parse((await store.kvGet(key))!), expiresAt: 1 })));
    await expect(transfers.move(project.id, destination.id, expired.id)).rejects.toThrow(/expired/);
  });
});

describe('transfer policy defaults', () => {
  it('fences deletion of either organization, and removes historical world reopen hints', async () => {
    const { store, destination, project, transfers } = (await fixture());
    (await store.kvSet(`organization-deleting:${destination.id}`, 'pending'));
    expect((await transfers.preview(project.id, destination.id)).blockers.some(b => b.code === 'deletion')).toBe(true);
    (await store.kvDelete(`organization-deleting:${destination.id}`));
    const task = (await store.createTask({ projectId: project.id, title: 'History', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } }));
    (await store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done', worldPath: '/source/world', world: { id: task.id, kind: 'worktree' } } as any));
    (await store.db.prepare('INSERT INTO world_instances (worldId, generation, handle, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(task.id, 1, '{}', 'released', 1, 1));
    const preview = (await transfers.preview(project.id, destination.id));
    await transfers.move(project.id, destination.id, preview.id);
    expect((await store.getTask(task.id))?.lastView?.world).toBeUndefined();
    expect((await store.getTask(task.id))?.lastView?.worldPath).toBeUndefined();
  });
});


describe('transfer capabilities on existing installations', () => {
  it('upgrades untouched administrator defaults without granting transfer to maintainers', async () => {
    const { store } = (await fixture());
    // Freeze the released profile: deriving history from today's defaults
    // turns every new capability into an imaginary historical default.
    const administrator = previousProfiles.find(p => p.id === 'administrator')!;
    (await store.setAuthorizationProfile('global', { ...administrator, capabilities: administrator.capabilities.filter(cap => !cap.startsWith('project:transfer-')) }));
    await AuthorizationService.create(store);
    expect((await store.getAuthorizationProfile('global', 'administrator')).capabilities).toContain('project:transfer-out');
    expect((await store.getAuthorizationProfile('global', 'maintainer')).capabilities).not.toContain('project:transfer-out');
    (await store.setAuthorizationProfile('global', { ...administrator, name: 'Customized', capabilities: ['project:read'] }));
    await AuthorizationService.create(store);
    expect((await store.getAuthorizationProfile('global', 'administrator')).capabilities).toEqual(['project:read']);
    const current = DEFAULT_AUTHORIZATION_PROFILES.find(p => p.id === 'administrator')!;
    const narrowed = { ...current, capabilities: current.capabilities.filter(cap => !cap.startsWith('project:transfer-')) };
    await store.setAuthorizationProfile('global', narrowed);
    await AuthorizationService.create(store);
    expect((await store.getAuthorizationProfile('global', 'administrator')).capabilities).toEqual(narrowed.capabilities);
  });
});


describe('environment build admission during transfer', () => {
  it('rejects a source connection captured before a move-away-and-back and fences superseded attempts', async () => {
    const { store, project, source, destination, transfers } = (await fixture());
    const original = { organizationId: source.id, transferGeneration: '' };
    let preview = (await transfers.preview(project.id, destination.id));
    await transfers.move(project.id, destination.id, preview.id);
    preview = (await transfers.preview(project.id, source.id));
    await transfers.move(project.id, source.id, preview.id);
    await expect(beginEnvironmentBuild(store, project.id, original, 'e2b', 'digest')).rejects.toThrow(/moved/);
    const scope = { organizationId: source.id, transferGeneration: (await store.kvGet(`project-transfer-current:${project.id}`))! };
    const attempt = (await beginEnvironmentBuild(store, project.id, scope, 'e2b', 'digest'));
    expect((await finishEnvironmentBuild(store, attempt, { status: 'failed', error: 'provider failure' }))).toBe(true);
    const replacement = (await beginEnvironmentBuild(store, project.id, scope, 'e2b', 'digest'));
    expect((await finishEnvironmentBuild(store, attempt, { status: 'ready', ref: 'old' }))).toBe(false);
    expect((await finishEnvironmentBuild(store, replacement, { status: 'ready', ref: 'new' }))).toBe(true);
    expect((await new ProjectEnvironment(store).readyBuild(project.id, 'e2b', 'digest'))?.ref).toBe('new');
  });

  it('refuses build admission while transfer liveness checks hold the project fence', async () => {
    const { store, project, destination, source } = (await fixture());
    const task = (await store.createTask({ projectId: project.id, title: 'History', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'history' } }));
    (await store.saveView(task.id, { taskId: task.id, status: 'done' } as any));
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<boolean>(resolve => { release = () => resolve(true); });
    const transfers = new ProjectTransfers(store, { principal: 'operator', authorize: () => {}, workflowClosed: () => { entered(); return waiting; } });
    const preview = (await transfers.preview(project.id, destination.id));
    const moving = transfers.move(project.id, destination.id, preview.id);
    await started;
    await expect(beginEnvironmentBuild(store, project.id, { organizationId: source.id, transferGeneration: '' }, 'e2b', 'digest')).rejects.toThrow(/move in progress/);
    release();
    await moving;
  });
});
