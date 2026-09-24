import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi, previousTaskGrants } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import type { AuthorizationSelection } from '../src/domain/types.js';

/**
 * Forking an agent with `reauthorize` starts the fork from the grants the SOURCE
 * task ended with (its — possibly elevated — authorization selection plus its
 * vault credential grants) instead of the project default. It rides the normal
 * createTask path, so it can never hand a fork more than the caller could grant
 * a fresh task.
 */
async function fixture() {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('owner'));
  (await store.setOrganizationMembership('org_personal', 'dev', 'member'));
  const project = (await store.createProject('Forks'));
  const authorization = (await AuthorizationService.create(store));
  (await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' }));
  (await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' }));
  const tokens = new TokenAuthority(store);
  const tokenFor = async (userId: string, extra: string[] = []) => (await tokens.mintPrincipal(
    `user:${userId}`, [...(await authorization.capabilities(`user:${userId}`, project.id, 'org_personal')), ...extra],
    project.id, undefined, 'org_personal',
  )).token;
  const client = { workflow: { getHandle: () => ({ executeUpdate: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const maintainer: AuthorizationSelection = { level: 'maintainer', scope: 'projects', projectIds: [project.id] };
  // A finished source task that a human elevated to maintainer mid-run and
  // approved one vault credential for.
  const source = (await store.createTask({
    projectId: project.id, title: 'Source', workflow: 'software-dev', workflowVersion: '1.26.0',
    createdBy: { kind: 'user', userId: 'owner' },
    params: { prompt: 'source', _authorization: {
      ...(await authorization.taskGrant('user:owner', project.id, maintainer)),
      capabilities: [...(await authorization.taskGrant('user:owner', project.id, maintainer)).capabilities, 'use-credential:item:cred_safe'],
      principal: 'user:owner',
    } },
  }));
  (await store.kvSet(`session:${source.id}:do`, 'source-session'));
  return { store, project, api, tokenFor, source, maintainer };
}

describe('fork_agent reauthorize', () => {
  it('defaults to unpublished source work, permits a different base, and uses the landing target after completion', async () => {
    const f = (await fixture());
    const token = (await f.tokenFor('owner'));
    (await f.store.saveView(f.source.id, { taskId: f.source.id, status: 'cancelled',
      branch: 'karmax/source', targetBranch: 'release', messages: [], state: {} } as any));
    const fork = await f.api.forkTaskAgent(token, { taskId: f.source.id, message: 'continue' });
    expect(fork.params.base).toBe('karmax/source');
    expect(fork.params._forkWorld).toMatchObject({ taskId: f.source.id, base: 'karmax/source', unpublished: true });
    const changed = await f.api.forkTaskAgent(token, { taskId: f.source.id, message: 'fresh', base: 'main', target: 'release' });
    expect(changed.params.base).toBe('main');
    expect(changed.params.target).toBe('release');
    (await f.store.saveView(f.source.id, { taskId: f.source.id, status: 'done',
      branch: 'karmax/source', targetBranch: 'release', messages: [], state: {} } as any));
    const landed = await f.api.forkTaskAgent(token, { taskId: f.source.id, message: 'follow up' });
    expect(landed.params.base).toBe('release');
    expect(landed.params._forkWorld).toMatchObject({ unpublished: false });
    (await f.store.close());
  });

  it('ignores injected world provenance and honors an explicit default branch from the form', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.source.id, { taskId: f.source.id, status: 'waiting',
      branch: 'karmax/source', targetBranch: 'main', messages: [], state: {} } as any));
    const fork = await f.api.createTask((await f.tokenFor('owner')), { projectId: f.project.id, draft: true,
      params: { prompt: 'fresh', base: 'main', 'agent:do': { resumeFrom: { taskId: f.source.id } },
        _forkWorld: { taskId: 'another-project', base: 'main' } } });
    expect(fork.params.base).toBe('main');
    expect(fork.params._forkWorld).toMatchObject({ taskId: f.source.id, base: 'karmax/source' });
    const edited = await f.api.updateArmedParams((await f.tokenFor('owner')), fork.id, { base: 'release' }, { keepArmed: false });
    expect(edited.params._forkWorld).toEqual(fork.params._forkWorld);
    const cleared = await f.api.updateArmedParams((await f.tokenFor('owner')), fork.id,
      { prompt: 'ordinary task', base: 'main' }, { replace: true, keepArmed: false });
    expect(cleared.params._forkWorld).toBeUndefined();
    (await f.store.close());
  });

  it('starts a fork that waits for its source to succeed from where the source lands', async () => {
    const f = (await fixture());
    const token = (await f.tokenFor('owner'));
    (await f.store.saveView(f.source.id, { taskId: f.source.id, status: 'waiting',
      branch: 'karmax/source', targetBranch: 'release', messages: [], state: {} } as any));
    const fork = (triggers: unknown[], base?: string) => f.api.createTask(token, { projectId: f.project.id, draft: true,
      params: { prompt: 'after it lands', ...(base ? { base } : {}), triggers, 'agent:do': { resumeFrom: { taskId: f.source.id } } } });
    expect((await fork([{ kind: 'dependency', tasks: [f.source.id] }])).params.base).toBe('release');
    expect((await fork([{ kind: 'dependency', tasks: ['task_other', f.source.id], on: 'done' }])).params.base).toBe('release');
    // Only a guaranteed landing moves the start; an explicit branch always wins.
    expect((await fork([{ kind: 'dependency', tasks: [f.source.id], on: 'failed' }])).params.base).toBe('karmax/source');
    expect((await fork([{ kind: 'dependency', tasks: ['task_other', f.source.id], mode: 'any' }])).params.base).toBe('karmax/source');
    expect((await fork([{ kind: 'dependency', tasks: ['task_other'] }])).params.base).toBe('karmax/source');
    expect((await fork([{ kind: 'dependency', tasks: [f.source.id] }], 'karmax/source')).params.base).toBe('karmax/source');
    (await f.store.close());
  });

  it('reads the grants a task ended with in task-creation shape', async () => {
    const f = (await fixture());
    expect(previousTaskGrants((await f.store.getTask(f.source.id))!)).toEqual({
      authorization: f.maintainer,
      credentialGrants: ['use-credential:item:cred_safe'],
      credentialPolicies: {},
    });
    // Legacy records only carry a profile id; organization-wide levels carry no project list.
    expect(previousTaskGrants({ projectId: 'p', params: { _authorization: { profileId: 'developer' } } } as any).authorization)
      .toEqual({ level: 'developer', scope: 'projects', projectIds: ['p'] });
    expect(previousTaskGrants({ projectId: 'p', params: { _authorization: { level: 'administrator', scope: 'organization' } } } as any).authorization)
      .toEqual({ level: 'administrator', scope: 'organization' });
    expect(previousTaskGrants({ projectId: 'p', params: {} } as any)).toEqual({ credentialGrants: [], credentialPolicies: {} });
    (await f.store.close());
  });

  it('starts the fork from the source grants only when asked', async () => {
    const f = (await fixture());
    const token = (await f.tokenFor('owner', ['use-credential:item:cred_safe']));
    const plain = await f.api.forkTaskAgent(token, { taskId: f.source.id, message: 'continue' });
    expect(plain.params._authorization).toMatchObject({ level: 'developer' });
    expect((plain.params._authorization as any).capabilities).not.toContain('use-credential:item:cred_safe');

    const reauthorized = await f.api.forkTaskAgent(token, { taskId: f.source.id, message: 'continue', reauthorize: true });
    expect(reauthorized.params['agent:do']).toMatchObject({ resumeFrom: { taskId: f.source.id, role: 'do' } });
    expect(reauthorized.params._authorization).toMatchObject({
      level: 'maintainer', scope: 'projects', projectIds: [f.project.id], attenuated: false, principal: 'user:owner',
    });
    expect((reauthorized.params._authorization as any).capabilities).toContain('use-credential:item:cred_safe');
    // The source is never touched.
    expect((await f.store.getTask(f.source.id))?.params._authorization).toEqual(f.source.params._authorization);
    (await f.store.close());
  });

  it('lets an explicit profile override the source level while credentials still carry over', async () => {
    const f = (await fixture());
    const fork = await f.api.forkTaskAgent((await f.tokenFor('owner', ['use-credential:item:cred_safe'])),
      { taskId: f.source.id, message: 'continue', reauthorize: true, authorizationProfile: 'developer' });
    expect(fork.params._authorization).toMatchObject({ level: 'developer' });
    expect((fork.params._authorization as any).capabilities).toContain('use-credential:item:cred_safe');
    (await f.store.close());
  });

  it('refuses to re-authorize beyond the forking caller’s own authority', async () => {
    const f = (await fixture());
    await expect(f.api.forkTaskAgent((await f.tokenFor('dev')), { taskId: f.source.id, message: 'continue', reauthorize: true }))
      .rejects.toThrow(/cannot grant/i);
    (await f.store.close());
  });
});

describe('vault task defaults', () => {
  it('rejects wildcard grants and policies for unselected credentials in saved defaults', async () => {
    const f = (await fixture());
    try {
      await expect(f.store.setSettings(f.project.id, 'vault', { credentialGrants: ['use-credential:*'] })).rejects.toThrow(/individual vault/);
      await expect(f.store.setSettings(f.project.id, 'vault', { credentialGrants: [], credentialPolicies: { private: { reveal: 'auto' } } })).rejects.toThrow(/Invalid vault/);
    } finally { (await f.store.close()); }
  });
  it('inherits organization then project selections, snapshots grants, and honors explicit empty overrides', async () => {
    const f = (await fixture());
    try {
      const token = (await f.tokenFor('owner', ['use-credential:item:org_login', 'use-credential:item:project_login']));
      const create = async (credentialGrants?: string[]) => (await f.api.createTask(token, { projectId: f.project.id, draft: true, params: { prompt: 'Defaults' }, credentialGrants }));
      const grants = (task: any) => task.params._authorization.capabilities.filter((cap: string) => cap.startsWith('use-credential:item:'));
      (await f.store.setSettings('organization:org_personal', 'vault', { credentialGrants: ['use-credential:item:org_login'] }));
      const inherited = await create();
      expect(grants(inherited)).toContain('use-credential:item:org_login');
      (await f.store.setSettings(f.project.id, 'vault', { credentialGrants: ['use-credential:item:project_login'] }));
      expect(grants(await create())).toEqual(['use-credential:item:project_login']);
      expect(grants(await create([]))).toEqual([]);
      (await f.store.setSettings(f.project.id, 'vault', { credentialGrants: [] }));
      expect(grants(await create())).toEqual([]);
      (await f.store.setSettings(f.project.id, 'vault', {}));
      expect(grants(await create())).toEqual(['use-credential:item:org_login']);
      expect(grants((await f.store.getTask(inherited.id)))).toContain('use-credential:item:org_login');
    } finally { (await f.store.close()); }
  });
  it('does not grant inherited credentials beyond the creator’s authority or cross organizations', async () => {
    const f = (await fixture());
    try {
      (await f.store.setSettings('organization:org_personal', 'vault', { credentialGrants: ['use-credential:item:private'] }));
      const limited = await f.api.createTask((await f.tokenFor('dev')), { projectId: f.project.id, draft: true, params: { prompt: 'Limited' } });
      expect((limited.params._authorization as any).capabilities).not.toContain('use-credential:item:private');
      const otherOrg = (await f.store.createOrganization({ name: 'Other', ownerUserId: 'owner' }));
      (await f.store.setSettings('organization:org_personal', 'vault', {}));
      (await f.store.setSettings(`organization:${otherOrg.id}`, 'vault', { credentialGrants: ['use-credential:item:private'] }));
      const task = await f.api.createTask((await f.tokenFor('owner')), { projectId: f.project.id, draft: true, params: { prompt: 'Other defaults do not apply' } });
      expect((task.params._authorization as any).capabilities).not.toContain('use-credential:item:private');
    } finally { (await f.store.close()); }
  });
});
