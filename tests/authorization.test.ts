import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { allows, CAPABILITIES, CAPABILITY_GROUPS } from '../src/platform/capabilities.js';

describe('durable authorization policy', () => {
  it('publishes every known capability exactly once in the grouped checklist', () => {
    const listed = CAPABILITY_GROUPS.flatMap((group) => group.capabilities.map((cap) => cap.id));
    expect(new Set(listed)).toEqual(new Set(CAPABILITIES));
    expect(listed).toHaveLength(new Set(listed).size);
    expect(CAPABILITY_GROUPS.every((group) => group.description && group.capabilities.every((cap) => cap.label && cap.description))).toBe(true);
  });

  it('reserves workflow code installation for global authority', async () => {
    const store = (await Store.create(':memory:'));
    try {
      const authz = (await AuthorizationService.create(store));
      expect(allows((await authz.profile('administrator'))!.capabilities, 'workflow:install')).toBe(false);
      expect(allows((await authz.profile('maintainer'))!.capabilities, 'workflow:install')).toBe(false);
      expect(allows((await authz.profile('god'))!.capabilities, 'workflow:install')).toBe(true);
      const organization = (await store.createOrganization({ name: 'Acme' }));
      const project = (await store.createProject('P', {}, organization.id));
      (await authz.grant('root', { principalId: 'user:tenant', scopeKey: `organization:${organization.id}`, profileId: 'god' }));
      expect(allows((await authz.capabilities('user:tenant', project.id)), 'workflow:install')).toBe(false);
    } finally { (await store.close()); }
  });

  it('migrates unchanged built-in profiles that previously allowed workflow installation', async () => {
    const store = (await Store.create(':memory:'));
    try {
      const authz = (await AuthorizationService.create(store));
      for (const id of ['maintainer', 'administrator']) {
        const profile = (await authz.profile(id))!;
        (await store.setAuthorizationProfile('global', { ...profile,
          capabilities: [...profile.capabilities, 'workflow:install'] }));
      }
      const upgraded = (await AuthorizationService.create(store));
      for (const id of ['maintainer', 'administrator']) {
        expect(allows((await upgraded.profile(id))!.capabilities, 'workflow:install')).toBe(false);
      }
    } finally { (await store.close()); }
  });

  it('seeds the five canonical authorization levels and resolves project defaults', async () => {
    const store = (await Store.create(':memory:'));
    const authz = (await AuthorizationService.create(store));
    expect((await authz.profiles()).map((p) => p.id)).toEqual(['administrator', 'developer', 'god', 'maintainer', 'viewer']);
    expect((await authz.profile('viewer'))!.capabilities).toContain('task:read');
    expect((await authz.profile('viewer'))!.capabilities).not.toContain('task:create');
    expect((await authz.profile('god'))!.capabilities).toEqual(['*']);
    expect((await authz.defaultProfile('p1'))).toBe('developer');
    (await authz.setDefault('user:admin', 'maintainer', 'p1'));
    expect((await authz.defaultProfile('p1'))).toBe('maintainer');
    expect((await authz.defaultProfile('p2'))).toBe('developer');
    await expect((async () => (await authz.setDefault('user:admin', 'operator')))()).rejects.toThrow(/unknown authorization level/i);
    (await store.kvSet('authz:default:global', 'operator'));
    const migrated = (await AuthorizationService.create(store));
    expect((await migrated.defaultProfile())).toBe('developer');
  });

  it('grants Viewer, Developer, and Project maintainer to project lists or an organization', async () => {
    const store = (await Store.create(':memory:'));
    const authz = (await AuthorizationService.create(store));
    const organization = (await store.createOrganization({ name: 'Acme' }));
    const one = (await store.createProject('One', {}, organization.id));
    const two = (await store.createProject('Two', {}, organization.id));
    const otherOrg = (await store.createOrganization({ name: 'Other' }));
    const foreign = (await store.createProject('Foreign', {}, otherOrg.id));

    (await authz.grant('root', { principalId: 'user:maintainer', scopeKey: `organization:${organization.id}`, profileId: 'maintainer' }));
    const projects = (await authz.taskGrant('user:maintainer', one.id, {
      level: 'developer', scope: 'projects', projectIds: [one.id, two.id],
    }));
    expect(projects).toMatchObject({ level: 'developer', scope: 'projects', projectIds: [one.id, two.id], attenuated: false });
    expect(projects.capabilities).toContain('task:manage-own');

    const wholeOrg = (await authz.taskGrant('user:maintainer', one.id, {
      level: 'maintainer', scope: 'organization',
    }));
    expect(wholeOrg).toMatchObject({ level: 'maintainer', scope: 'organization', organizationId: organization.id, attenuated: false });
    await expect((async () => (await authz.taskGrant('user:maintainer', one.id, {
      level: 'developer', scope: 'projects', projectIds: [foreign.id],
    })))()).rejects.toThrow(/same organization/i);
  });

  it('forces Administrator to organization scope and God to global scope', async () => {
    const store = (await Store.create(':memory:'));
    const authz = (await AuthorizationService.create(store));
    const organization = (await store.createOrganization({ name: 'Acme' }));
    const project = (await store.createProject('One', {}, organization.id));
    (await authz.grant('root', { principalId: 'user:god', scopeKey: 'global', profileId: 'god' }));

    expect((await authz.taskGrant('user:god', project.id, { level: 'administrator', scope: 'organization' })))
      .toMatchObject({ level: 'administrator', scope: 'organization', organizationId: organization.id, attenuated: false });
    expect((await authz.taskGrant('user:god', project.id, { level: 'god', scope: 'global' })))
      .toMatchObject({ level: 'god', scope: 'global', attenuated: false, capabilities: ['*'] });
    await expect((async () => (await authz.taskGrant('user:god', project.id, {
      level: 'administrator', scope: 'projects', projectIds: [project.id],
    })))()).rejects.toThrow(/organization scope/i);
    await expect((async () => (await authz.taskGrant('user:god', project.id, { level: 'god', scope: 'organization' })))()).rejects.toThrow(/global scope/i);
  });

  it('replaces a person\'s organization authorization with one canonical scoped selection', async () => {
    const store = (await Store.create(':memory:'));
    const authz = (await AuthorizationService.create(store));
    const organization = (await store.createOrganization({ name: 'Acme' }));
    const one = (await store.createProject('One', {}, organization.id));
    const two = (await store.createProject('Two', {}, organization.id));
    (await authz.grant('root', { principalId: 'user:god', scopeKey: 'global', profileId: 'god' }));

    (await authz.replacePrincipalAuthorization('user:god', 'user:dev', organization.id, {
      level: 'developer', scope: 'projects', projectIds: [one.id, two.id],
    }));
    expect((await authz.grants('user:dev')).map((grant) => grant.scopeKey).sort()).toEqual([
      `project:${one.id}`, `project:${two.id}`,
    ].sort());
    expect((await authz.selectionForPrincipal('user:dev', organization.id))).toEqual({
      level: 'developer', scope: 'projects', projectIds: [one.id, two.id],
    });

    (await authz.replacePrincipalAuthorization('user:god', 'user:dev', organization.id, {
      level: 'administrator', scope: 'organization',
    }));
    expect((await authz.grants('user:dev'))).toEqual([
      expect.objectContaining({ scopeKey: `organization:${organization.id}`, profileId: 'administrator' }),
    ]);
  });

  it('migrates untouched legacy built-ins without overwriting customized profiles', async () => {
    const store = (await Store.create(':memory:'));
    (await store.setAuthorizationProfile('global', {
      id: 'developer', name: 'Developer', builtin: true,
      description: 'Work with tasks, conversations, review actions, queues, and skills inside assigned projects.',
      capabilities: [
        'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
        'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
      ],
    }));
    (await AuthorizationService.create(store));
    expect((await store.getAuthorizationProfile('global', 'developer')).capabilities).toEqual(
      expect.arrayContaining(['vault:store', 'organization:read', 'repository:read']),
    );

    (await store.setAuthorizationProfile('global', {
      id: 'maintainer', name: 'My maintainer', builtin: true, description: 'custom',
      capabilities: ['project:read', 'task:read'],
    }));
    (await AuthorizationService.create(store));
    expect((await store.getAuthorizationProfile('global', 'maintainer')).capabilities).toEqual(['project:read', 'task:read']);
  });

  it('migrates legacy grants into the five canonical levels', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme' }));
    const project = (await store.createProject('App', {}, organization.id));
    (await store.setAuthorizationProfile('global', {
      id: 'operator', name: 'Automation operator', builtin: true, description: 'legacy', capabilities: ['task:*'],
    }));
    (await store.setPrincipalGrant('user:global-admin', 'global', {
      principalId: 'user:global-admin', scopeKey: 'global', profileId: 'administrator', grantedBy: 'root', grantedAt: 1,
    }));
    (await store.setPrincipalGrant('user:org-operator', `organization:${organization.id}`, {
      principalId: 'user:org-operator', scopeKey: `organization:${organization.id}`, profileId: 'operator', grantedBy: 'root', grantedAt: 1,
    }));
    (await store.setPrincipalGrant('user:project-operator', `project:${project.id}`, {
      principalId: 'user:project-operator', scopeKey: `project:${project.id}`, profileId: 'operator', grantedBy: 'root', grantedAt: 1,
    }));

    const authz = (await AuthorizationService.create(store));

    expect((await authz.profiles()).map((profile) => profile.id)).not.toContain('operator');
    expect((await authz.grants('user:global-admin'))[0]).toMatchObject({ profileId: 'god', scopeKey: 'global' });
    expect((await authz.selectionForPrincipal('user:org-operator', organization.id))).toEqual({
      level: 'administrator', scope: 'organization',
    });
    expect((await authz.selectionForPrincipal('user:project-operator', organization.id))).toEqual({
      level: 'maintainer', scope: 'projects', projectIds: [project.id],
    });
  });

  it('caps a requested task profile at the creator and records attenuation', async () => {
    const store = (await Store.create(':memory:'));
    const authz = (await AuthorizationService.create(store));
    const organization = (await store.createOrganization({ name: 'Acme' }));
    const project = (await store.createProject('P1', {}, organization.id));
    (await authz.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' }));
    const requested = (await authz.taskGrant('user:dev', project.id, 'administrator'));
    expect(requested.attenuated).toBe(true);
    expect(allows(requested.capabilities, 'task:create')).toBe(true);
    expect(allows(requested.capabilities, 'user:write')).toBe(false);
    const delegated = (await authz.taskGrant('user:admin', project.id, 'administrator', ['task:read']));
    expect(delegated.capabilities).toEqual(['task:read']);
  });

  it('supports project profile overlays, revocation, and durable audit', async () => {
    const store = (await Store.create(':memory:'));
    const authz = (await AuthorizationService.create(store));
    (await authz.saveProfile('user:admin', projectScope('p1'), {
      id: 'developer', name: 'Restricted developer', description: 'Read only here', capabilities: ['project:read', 'task:read'],
    }));
    (await authz.grant('user:admin', { principalId: 'user:a', scopeKey: projectScope('p1'), profileId: 'developer' }));
    expect((await authz.capabilities('user:a', 'p1'))).toEqual(['project:read', 'task:read']);
    (await authz.revoke('user:admin', 'user:a', projectScope('p1')));
    expect((await authz.capabilities('user:a', 'p1'))).toEqual([]);
    expect((await store.auditSince()).map((e) => e.action)).toEqual([
      'authorization.profile.saved', 'authorization.grant.saved', 'authorization.grant.revoked',
    ]);
  });

  it('lets an organization Administrator manage tenant payments without host authority', async () => {
    const store = (await Store.create(':memory:'));
    const authz = (await AuthorizationService.create(store));
    const organization = (await store.createOrganization({ name: 'Acme' }));
    const project = (await store.createProject('App', {}, organization.id));
    (await authz.grant('root', {
      principalId: 'user:administrator',
      scopeKey: `organization:${organization.id}`,
      profileId: 'administrator',
    }));
    const capabilities = (await authz.capabilities('user:administrator', project.id, organization.id));
    expect(capabilities).toContain('payment:*');
    expect(capabilities).not.toContain('process:*');
  });

  it('applies team and @all project profiles dynamically', async () => {
    const store = (await Store.create(':memory:'));
    const authz = (await AuthorizationService.create(store));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    (await store.setOrganizationMembership(organization.id, 'alice', 'member'));
    const project = (await store.createProject('App', {}, organization.id));
    const team = (await store.createTeam({ organizationId: organization.id, name: 'Leaders' }));
    (await store.setTeamMembership(team.id, 'alice'));
    (await store.setProjectMembership(project.id, { kind: 'team', teamId: team.id }, 'maintainer'));
    expect(allows((await authz.capabilities('user:alice', project.id)), 'project:settings:write')).toBe(true);

    (await store.removeProjectMembership(project.id, { kind: 'team', teamId: team.id }));
    (await store.setProjectMembership(project.id, { kind: 'organization', organizationId: organization.id }, 'administrator'));
    expect(allows((await authz.capabilities('user:alice', project.id)), 'project:settings:write')).toBe(true);
    expect(allows((await authz.capabilities('user:alice', project.id)), 'project:delete')).toBe(true);
  });

  it('accepts the workflow-role capabilities exposed by the checklist', async () => {
    const authz = (await AuthorizationService.create((await Store.create(':memory:'))));
    await (async () => (await authz.saveProfile('user:admin', 'global', {
      id: 'reviewer', name: 'Reviewer', description: 'Workflow decisions',
      capabilities: ['resolve-decision', 'confirm-decision', 'merge-into:*'],
    })))();
  });

  it('caps project grants and cannot redefine a global grant through an overlay', async () => {
    const store = (await Store.create(':memory:'));
    const authz = (await AuthorizationService.create(store));
    (await authz.grant('root', { principalId: 'user:project-admin', scopeKey: projectScope('p1'), profileId: 'administrator' }));
    const local = (await authz.capabilities('user:project-admin', 'p1'));
    expect(local).toContain('task:*');
    expect(local).not.toContain('*');
    expect(allows(local, 'user:write')).toBe(false);
    expect((await authz.capabilities('user:project-admin'))).toEqual([]);

    (await authz.grant('root', { principalId: 'user:developer', scopeKey: 'global', profileId: 'developer' }));
    (await authz.saveProfile('root', projectScope('p1'), {
      id: 'developer', name: 'Escalating overlay', description: 'must not affect the global grant', capabilities: ['*'],
    }));
    const globalInProject = (await authz.capabilities('user:developer', 'p1'));
    expect(globalInProject).not.toContain('*');
    expect(allows(globalInProject, 'user:write')).toBe(false);
  });
});
