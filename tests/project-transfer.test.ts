import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { ProjectTransfers } from '../src/platform/project-transfer.js';
import { AuthorizationService, DEFAULT_AUTHORIZATION_PROFILES } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(s => s.close()));
function fixture() {
  const store = new Store(':memory:'); stores.push(store);
  const source = store.createOrganization({ name: 'Source', ownerUserId: 'alice' });
  const destination = store.createOrganization({ name: 'Destination', ownerUserId: 'bob' });
  const project = store.createProject('Folder/Project', {}, source.id);
  store.setProjectMembership(project.id, { kind: 'user', userId: 'alice' }, 'owner');
  const authorize = (cap: string, org: string) => {
    if (!['project:transfer-out', 'project:transfer-in'].includes(cap) || ![source.id, destination.id].includes(org)) throw new Error('denied');
  };
  const transfers = new ProjectTransfers(store, { principal: 'user:operator', authorize,
    workflowClosed: async () => true });
  return { store, source, destination, project, transfers };
}

describe('project transfer', () => {
  it('moves atomically, preserves IDs/history, replaces access, and retries idempotently', async () => {
    const { store, source, destination, project, transfers } = fixture();
    const task = store.createTask({ projectId: project.id, title: 'History', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'Keep me' } });
    store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done' } as any);
    store.appendEvent({ taskId: task.id, type: 'example', ts: 1, payload: { text: 'History' } });
    const tokens = new TokenAuthority(store);
    const old = tokens.mint({ taskId: task.id, profileId: 'developer', principal: 'user:alice', projectIds: [project.id], organizationId: source.id, ceiling: ['*'], grantorCaps: ['*'] });
    const preview = transfers.preview(project.id, destination.id);
    expect(preview.blockers).toEqual([]);
    const moved = await transfers.move(project.id, destination.id, preview.id);
    expect(moved.id).toBe(project.id);
    expect(moved.organizationId).toBe(destination.id);
    expect(moved.folder).toBeUndefined();
    expect(store.getTask(task.id)?.title).toBe('History');
    expect(store.userIsProjectMember(project.id, 'alice')).toBe(false);
    expect(store.userIsProjectMember(project.id, 'bob')).toBe(true);
    expect(tokens.verify(old.token)).toBeUndefined();
    expect(await transfers.move(project.id, destination.id, preview.id)).toEqual(moved);
    expect(store.auditSince().filter(r => r.scopeKey === 'organization:' + source.id).some(r => r.action === 'project.transferred')).toBe(true);
  });

  it('rejects a stale preview without changing ownership or access', async () => {
    const { store, destination, project, transfers } = fixture();
    const preview = transfers.preview(project.id, destination.id);
    store.renameProject(project.id, 'Changed');
    await expect(transfers.move(project.id, destination.id, preview.id)).rejects.toThrow(/changed|preview/i);
    expect(store.getProject(project.id)?.organizationId).toBe(project.organizationId);
    expect(store.userIsProjectMember(project.id, 'alice')).toBe(true);
  });

  it('checks both organization permissions again when committing', async () => {
    const { store, destination, project, transfers } = fixture();
    const preview = transfers.preview(project.id, destination.id);
    const denied = new ProjectTransfers(store, { principal: 'user:operator', authorize: () => { throw new Error('denied'); }, workflowClosed: async () => true });
    await expect(denied.move(project.id, destination.id, preview.id)).rejects.toThrow('denied');
    expect(store.getProject(project.id)?.organizationId).toBe(project.organizationId);
  });

  it('does not trust a terminal view while the workflow is still running', async () => {
    const { store, destination, project } = fixture();
    const task = store.createTask({ projectId: project.id, title: 'Finishing', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } });
    store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done' } as any);
    const transfers = new ProjectTransfers(store, { principal: 'operator', authorize: () => {}, workflowClosed: async () => false });
    const preview = transfers.preview(project.id, destination.id);
    await expect(transfers.move(project.id, destination.id, preview.id)).rejects.toThrow(/workflow|running/i);
    expect(store.getProject(project.id)?.organizationId).toBe(project.organizationId);
    expect(store.kvGet(`project-transfer-lock:${project.id}`)).toBeUndefined();
  });

  it('blocks active work, name collisions, and resources with source-owned storage', () => {
    const { store, destination, project, transfers } = fixture();
    store.createProject('Project', {}, destination.id);
    store.createTask({ projectId: project.id, title: 'Running', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } });
    store.db.prepare(`INSERT INTO resource_attachments (id, organizationId, projectId, name, driver, target, access, isolation, source, credentialHandles, publish, enabled, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('resource', project.organizationId, project.id, 'Database', 'volume@1', '{}', 'read', 'fork', '{}', '[]', 'review', 1, 1, 1);
    const preview = transfers.preview(project.id, destination.id);
    expect(preview.blockers.map(b => b.code)).toEqual(expect.arrayContaining(['name-conflict', 'active-tasks', 'resources']));
  });
});

describe('project transfer boundaries and recovery', () => {
  it('rolls back ownership, grants, tokens and task changes if any commit write fails', async () => {
    const { store, destination, project, transfers } = fixture();
    const draft = store.createTask({ projectId: project.id, title: 'Draft', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'hello', draft: true } });
    const tokens = new TokenAuthority(store);
    const old = tokens.mintPrincipal('user:alice', ['*'], project.id, 60_000, project.organizationId).token;
    const preview = transfers.preview(project.id, destination.id);
    const append = store.appendAudit;
    store.appendAudit = () => { throw new Error('injected write failure'); };
    await expect(transfers.move(project.id, destination.id, preview.id)).rejects.toThrow('injected write failure');
    store.appendAudit = append;
    expect(store.getProject(project.id)?.organizationId).toBe(project.organizationId);
    expect(store.userIsProjectMember(project.id, 'alice')).toBe(true);
    expect(store.userIsProjectMember(project.id, 'bob')).toBe(false);
    expect(store.getTask(draft.id)?.params).toEqual(draft.params);
    expect(tokens.verify(old)).toBeDefined();
    expect(store.kvGet(`project-transfer-lock:${project.id}`)).toBeUndefined();
    expect((await transfers.move(project.id, destination.id, preview.id)).organizationId).toBe(destination.id);
  });

  it('fences new tasks and stale organization tokens during and after cutover', async () => {
    const { store, destination, project, source } = fixture();
    const task = store.createTask({ projectId: project.id, title: 'History', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } });
    store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done' } as any);
    const tokens = new TokenAuthority(store);
    const old = tokens.mintPrincipal('user:alice', ['*'], undefined, 60_000, source.id).token;
    let release!: () => void;
    const checking = new Promise<void>(resolve => { release = resolve; });
    const transfers = new ProjectTransfers(store, { principal: 'operator', authorize: () => {}, workflowClosed: async () => { await checking; return true; } });
    const preview = transfers.preview(project.id, destination.id);
    const moving = transfers.move(project.id, destination.id, preview.id);
    expect(tokens.check(old, 'task:create', { projectId: project.id }).ok).toBe(false);
    expect(tokens.check(old, 'task:read', { projectId: project.id }).ok).toBe(true);
    expect(() => store.createTask({ projectId: project.id, title: 'Late', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'late' } })).toThrow(/move in progress/);
    release(); await moving;
    expect(tokens.check(old, 'task:read', { projectId: project.id }).ok).toBe(false);
    const fresh = tokens.mintPrincipal('user:bob', ['*'], project.id, 60_000, destination.id).token;
    expect(tokens.check(fresh, 'task:read', { projectId: project.id, taskId: task.id }).ok).toBe(true);
    expect(tokens.check(fresh, 'task:signal', { projectId: project.id, taskId: task.id }).ok).toBe(false);
    expect(() => store.assertProjectOrganization(project.id, source.id)).toThrow(/organization changed/);
  });

  it('clears task-keyed credentials, public shares, profiles and source-only access', async () => {
    const { store, destination, project, transfers, source } = fixture();
    const task = store.createTask({ projectId: project.id, title: 'Draft', workflow: 'just-do', workflowVersion: '1', params: {
      prompt: 'Keep the prompt', draft: true, profiles: { do: 'source-profile' }, 'agent:do': { mcpConnections: ['source-mcp'] },
      _authorization: { capabilities: ['*'], principal: 'user:alice' }, _githubAccountId: 'source-account',
    } });
    for (const key of [`vault:grant:${task.id}`, `vault:pass:${task.id}`, `vault:task-policy:${task.id}`, `permission:grant:${task.id}`]) store.kvSet(key, 'secret-authority');
    store.kvSet(`conversation-share-index:${task.id}:do`, 'public'); store.kvSet('conversation-share:public', '{}');
    store.kvSet(`vault:requests:${source.id}`, JSON.stringify([{ taskId: task.id }, { taskId: 'other' }]));
    store.kvSet('service-connection:shared', JSON.stringify({ organizationId: source.id, projectIds: [project.id, 'other-project'] }));
    store.db.prepare('INSERT INTO profiles (id, json) VALUES (?, ?)').run(`${project.id}::do-default`, JSON.stringify({ id: `${project.id}::do-default`, account: 'source-account' }));
    store.setSettings(project.id, '__common__', { 'agent:do': { account: 'source-account' } });
    const preview = transfers.preview(project.id, destination.id);
    await transfers.move(project.id, destination.id, preview.id);
    const params = store.getTask(task.id)!.params;
    expect(params.prompt).toBe('Keep the prompt');
    expect(params.profiles).toBeUndefined();
    expect(params._githubAccountId).toBeUndefined();
    expect(params['agent:do']).toBeUndefined();
    expect(params._authorization).toMatchObject({ capabilities: [], organizationId: destination.id, attenuationAccepted: false });
    expect(store.kvGet(`vault:grant:${task.id}`)).toBeUndefined();
    expect(store.kvGet('conversation-share:public')).toBeUndefined();
    expect(JSON.parse(store.kvGet(`vault:requests:${source.id}`)!)).toEqual([{ taskId: 'other' }]);
    expect(JSON.parse(store.kvGet('service-connection:shared')!).projectIds).toEqual(['other-project']);
    expect(store.getProfile(`${project.id}::do-default`)).toBeUndefined();
    expect(store.getSettings(project.id, '__common__')).toBeUndefined();
  });

  it('remaps repository and wiki attachments without moving repository credentials', async () => {
    const { store, source, destination, project, transfers } = fixture();
    const repo = { provider: 'github' as const, providerId: '123', owner: 'owner', name: 'code', sshUrl: 'git@github.com:owner/code.git', defaultBranch: 'main', private: true };
    const from = store.upsertRepository({ ...repo, organizationId: source.id });
    store.attachProjectRepository({ projectId: project.id, repositoryId: from.id });
    store.db.prepare('INSERT INTO project_wikis (projectId, repositoryId, createdAt, updatedAt) VALUES (?, ?, ?, ?)').run(project.id, from.id, 1, 1);
    expect(transfers.preview(project.id, destination.id).blockers.some(b => b.code === 'repository')).toBe(true);
    const to = store.upsertRepository({ ...repo, organizationId: destination.id });
    const preview = transfers.preview(project.id, destination.id);
    expect(preview.blockers).toEqual([]);
    await transfers.move(project.id, destination.id, preview.id);
    expect(store.listProjectRepositories(project.id)[0]?.repositoryId).toBe(to.id);
    expect(store.projectWiki(project.id)?.repository?.id).toBe(to.id);
    expect(store.getRepository(from.id)?.organizationId).toBe(source.id);
  });

  it('rejects changed destination defaults and expired previews', async () => {
    const { store, destination, project, transfers } = fixture();
    const stale = transfers.preview(project.id, destination.id);
    store.setSettings(`organization:${destination.id}`, '__common__', { prompt: 'Changed policy' });
    await expect(transfers.move(project.id, destination.id, stale.id)).rejects.toThrow(/changed/);
    const expired = transfers.preview(project.id, destination.id);
    const key = `project-transfer:${expired.id}`;
    store.kvSet(key, JSON.stringify({ ...JSON.parse(store.kvGet(key)!), expiresAt: 1 }));
    await expect(transfers.move(project.id, destination.id, expired.id)).rejects.toThrow(/expired/);
  });
});

describe('transfer policy defaults', () => {
  it('fences deletion of either organization, and removes historical world reopen hints', async () => {
    const { store, destination, project, transfers } = fixture();
    store.kvSet(`organization-deleting:${destination.id}`, 'pending');
    expect(transfers.preview(project.id, destination.id).blockers.some(b => b.code === 'deletion')).toBe(true);
    store.kvDelete(`organization-deleting:${destination.id}`);
    const task = store.createTask({ projectId: project.id, title: 'History', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } });
    store.saveView(task.id, { taskId: task.id, status: 'done', stage: 'done', worldPath: '/source/world', world: { id: task.id, kind: 'worktree' } } as any);
    store.db.prepare('INSERT INTO world_instances (worldId, generation, handle, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(task.id, 1, '{}', 'released', 1, 1);
    const preview = transfers.preview(project.id, destination.id);
    await transfers.move(project.id, destination.id, preview.id);
    expect(store.getTask(task.id)?.lastView?.world).toBeUndefined();
    expect(store.getTask(task.id)?.lastView?.worldPath).toBeUndefined();
  });
});


describe('transfer capabilities on existing installations', () => {
  it('upgrades untouched administrator defaults without granting transfer to maintainers', () => {
    const { store } = fixture();
    const administrator = DEFAULT_AUTHORIZATION_PROFILES.find(p => p.id === 'administrator')!;
    store.setAuthorizationProfile('global', { ...administrator, capabilities: administrator.capabilities.filter(cap => !cap.startsWith('project:transfer-')) });
    new AuthorizationService(store);
    expect(store.getAuthorizationProfile('global', 'administrator').capabilities).toContain('project:transfer-out');
    expect(store.getAuthorizationProfile('global', 'maintainer').capabilities).not.toContain('project:transfer-out');
    store.setAuthorizationProfile('global', { ...administrator, name: 'Customized', capabilities: ['project:read'] });
    new AuthorizationService(store);
    expect(store.getAuthorizationProfile('global', 'administrator').capabilities).toEqual(['project:read']);
  });
});
