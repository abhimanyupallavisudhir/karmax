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
function fixture() {
  const store = new Store(':memory:');
  store.claimPersonalOrganization('owner');
  store.setOrganizationMembership('org_personal', 'dev', 'member');
  const project = store.createProject('Forks');
  const authorization = new AuthorizationService(store);
  authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' });
  authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const tokenFor = (userId: string, extra: string[] = []) => tokens.mintPrincipal(
    `user:${userId}`, [...authorization.capabilities(`user:${userId}`, project.id, 'org_personal'), ...extra],
    project.id, undefined, 'org_personal',
  ).token;
  const client = { workflow: { getHandle: () => ({ executeUpdate: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const maintainer: AuthorizationSelection = { level: 'maintainer', scope: 'projects', projectIds: [project.id] };
  // A finished source task that a human elevated to maintainer mid-run and
  // approved one vault credential for.
  const source = store.createTask({
    projectId: project.id, title: 'Source', workflow: 'software-dev', workflowVersion: '1.26.0',
    createdBy: { kind: 'user', userId: 'owner' },
    params: { prompt: 'source', _authorization: {
      ...authorization.taskGrant('user:owner', project.id, maintainer),
      capabilities: [...authorization.taskGrant('user:owner', project.id, maintainer).capabilities, 'use-credential:item:cred_safe'],
      principal: 'user:owner',
    } },
  });
  store.kvSet(`session:${source.id}:do`, 'source-session');
  return { store, project, api, tokenFor, source, maintainer };
}

describe('fork_agent reauthorize', () => {
  it('reads the grants a task ended with in task-creation shape', () => {
    const f = fixture();
    expect(previousTaskGrants(f.store.getTask(f.source.id)!)).toEqual({
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
    f.store.close();
  });

  it('starts the fork from the source grants only when asked', async () => {
    const f = fixture();
    const token = f.tokenFor('owner', ['use-credential:item:cred_safe']);
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
    expect(f.store.getTask(f.source.id)?.params._authorization).toEqual(f.source.params._authorization);
    f.store.close();
  });

  it('lets an explicit profile override the source level while credentials still carry over', async () => {
    const f = fixture();
    const fork = await f.api.forkTaskAgent(f.tokenFor('owner', ['use-credential:item:cred_safe']),
      { taskId: f.source.id, message: 'continue', reauthorize: true, authorizationProfile: 'developer' });
    expect(fork.params._authorization).toMatchObject({ level: 'developer' });
    expect((fork.params._authorization as any).capabilities).toContain('use-credential:item:cred_safe');
    f.store.close();
  });

  it('refuses to re-authorize beyond the forking caller’s own authority', async () => {
    const f = fixture();
    await expect(f.api.forkTaskAgent(f.tokenFor('dev'), { taskId: f.source.id, message: 'continue', reauthorize: true }))
      .rejects.toThrow(/cannot grant/i);
    f.store.close();
  });
});
