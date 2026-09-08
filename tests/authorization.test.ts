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

  it('reserves workflow code installation for global authority', () => {
    const store = new Store(':memory:');
    try {
      const authz = new AuthorizationService(store);
      expect(allows(authz.profile('administrator')!.capabilities, 'workflow:install')).toBe(false);
      expect(allows(authz.profile('maintainer')!.capabilities, 'workflow:install')).toBe(false);
      expect(allows(authz.profile('god')!.capabilities, 'workflow:install')).toBe(true);
      const organization = store.createOrganization({ name: 'Acme' });
      const project = store.createProject('P', {}, organization.id);
      authz.grant('root', { principalId: 'user:tenant', scopeKey: `organization:${organization.id}`, profileId: 'god' });
      expect(allows(authz.capabilities('user:tenant', project.id), 'workflow:install')).toBe(false);
    } finally { store.close(); }
  });

  it('migrates unchanged built-in profiles that previously allowed workflow installation', () => {
    const store = new Store(':memory:');
    try {
      const authz = new AuthorizationService(store);
      for (const id of ['maintainer', 'administrator']) {
        const profile = authz.profile(id)!;
        store.setAuthorizationProfile('global', { ...profile,
          capabilities: [...profile.capabilities, 'workflow:install'] });
      }
      const upgraded = new AuthorizationService(store);
      for (const id of ['maintainer', 'administrator']) {
        expect(allows(upgraded.profile(id)!.capabilities, 'workflow:install')).toBe(false);
      }
    } finally { store.close(); }
  });

  it('seeds the five canonical authorization levels and resolves project defaults', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    expect(authz.profiles().map((p) => p.id)).toEqual(['administrator', 'developer', 'god', 'maintainer', 'viewer']);
    expect(authz.profile('viewer')!.capabilities).toContain('task:read');
    expect(authz.profile('viewer')!.capabilities).not.toContain('task:create');
    expect(authz.profile('god')!.capabilities).toEqual(['*']);
    expect(authz.defaultProfile('p1')).toBe('developer');
    authz.setDefault('user:admin', 'maintainer', 'p1');
    expect(authz.defaultProfile('p1')).toBe('maintainer');
    expect(authz.defaultProfile('p2')).toBe('developer');
    expect(() => authz.setDefault('user:admin', 'operator')).toThrow(/unknown authorization level/i);
    store.kvSet('authz:default:global', 'operator');
    const migrated = new AuthorizationService(store);
    expect(migrated.defaultProfile()).toBe('developer');
  });

  it('grants Viewer, Developer, and Project maintainer to project lists or an organization', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    const organization = store.createOrganization({ name: 'Acme' });
    const one = store.createProject('One', {}, organization.id);
    const two = store.createProject('Two', {}, organization.id);
    const otherOrg = store.createOrganization({ name: 'Other' });
    const foreign = store.createProject('Foreign', {}, otherOrg.id);

    authz.grant('root', { principalId: 'user:maintainer', scopeKey: `organization:${organization.id}`, profileId: 'maintainer' });
    const projects = authz.taskGrant('user:maintainer', one.id, {
      level: 'developer', scope: 'projects', projectIds: [one.id, two.id],
    });
    expect(projects).toMatchObject({ level: 'developer', scope: 'projects', projectIds: [one.id, two.id], attenuated: false });
    expect(projects.capabilities).toContain('task:*');

    const wholeOrg = authz.taskGrant('user:maintainer', one.id, {
      level: 'maintainer', scope: 'organization',
    });
    expect(wholeOrg).toMatchObject({ level: 'maintainer', scope: 'organization', organizationId: organization.id, attenuated: false });
    expect(() => authz.taskGrant('user:maintainer', one.id, {
      level: 'developer', scope: 'projects', projectIds: [foreign.id],
    })).toThrow(/same organization/i);
  });

  it('forces Administrator to organization scope and God to global scope', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    const organization = store.createOrganization({ name: 'Acme' });
    const project = store.createProject('One', {}, organization.id);
    authz.grant('root', { principalId: 'user:god', scopeKey: 'global', profileId: 'god' });

    expect(authz.taskGrant('user:god', project.id, { level: 'administrator', scope: 'organization' }))
      .toMatchObject({ level: 'administrator', scope: 'organization', organizationId: organization.id, attenuated: false });
    expect(authz.taskGrant('user:god', project.id, { level: 'god', scope: 'global' }))
      .toMatchObject({ level: 'god', scope: 'global', attenuated: false, capabilities: ['*'] });
    expect(() => authz.taskGrant('user:god', project.id, {
      level: 'administrator', scope: 'projects', projectIds: [project.id],
    })).toThrow(/organization scope/i);
    expect(() => authz.taskGrant('user:god', project.id, { level: 'god', scope: 'organization' }))
      .toThrow(/global scope/i);
  });

  it('replaces a person\'s organization authorization with one canonical scoped selection', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    const organization = store.createOrganization({ name: 'Acme' });
    const one = store.createProject('One', {}, organization.id);
    const two = store.createProject('Two', {}, organization.id);
    authz.grant('root', { principalId: 'user:god', scopeKey: 'global', profileId: 'god' });

    authz.replacePrincipalAuthorization('user:god', 'user:dev', organization.id, {
      level: 'developer', scope: 'projects', projectIds: [one.id, two.id],
    });
    expect(authz.grants('user:dev').map((grant) => grant.scopeKey).sort()).toEqual([
      `project:${one.id}`, `project:${two.id}`,
    ].sort());
    expect(authz.selectionForPrincipal('user:dev', organization.id)).toEqual({
      level: 'developer', scope: 'projects', projectIds: [one.id, two.id],
    });

    authz.replacePrincipalAuthorization('user:god', 'user:dev', organization.id, {
      level: 'administrator', scope: 'organization',
    });
    expect(authz.grants('user:dev')).toEqual([
      expect.objectContaining({ scopeKey: `organization:${organization.id}`, profileId: 'administrator' }),
    ]);
  });

  it('migrates untouched legacy built-ins without overwriting customized profiles', () => {
    const store = new Store(':memory:');
    store.setAuthorizationProfile('global', {
      id: 'developer', name: 'Developer', builtin: true,
      description: 'Work with tasks, conversations, review actions, queues, and skills inside assigned projects.',
      capabilities: [
        'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
        'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
      ],
    });
    new AuthorizationService(store);
    expect(store.getAuthorizationProfile('global', 'developer').capabilities).toEqual(
      expect.arrayContaining(['vault:store', 'organization:read', 'repository:read']),
    );

    store.setAuthorizationProfile('global', {
      id: 'maintainer', name: 'My maintainer', builtin: true, description: 'custom',
      capabilities: ['project:read', 'task:read'],
    });
    new AuthorizationService(store);
    expect(store.getAuthorizationProfile('global', 'maintainer').capabilities).toEqual(['project:read', 'task:read']);
  });

  it('migrates legacy grants into the five canonical levels', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme' });
    const project = store.createProject('App', {}, organization.id);
    store.setAuthorizationProfile('global', {
      id: 'operator', name: 'Automation operator', builtin: true, description: 'legacy', capabilities: ['task:*'],
    });
    store.setPrincipalGrant('user:global-admin', 'global', {
      principalId: 'user:global-admin', scopeKey: 'global', profileId: 'administrator', grantedBy: 'root', grantedAt: 1,
    });
    store.setPrincipalGrant('user:org-operator', `organization:${organization.id}`, {
      principalId: 'user:org-operator', scopeKey: `organization:${organization.id}`, profileId: 'operator', grantedBy: 'root', grantedAt: 1,
    });
    store.setPrincipalGrant('user:project-operator', `project:${project.id}`, {
      principalId: 'user:project-operator', scopeKey: `project:${project.id}`, profileId: 'operator', grantedBy: 'root', grantedAt: 1,
    });

    const authz = new AuthorizationService(store);

    expect(authz.profiles().map((profile) => profile.id)).not.toContain('operator');
    expect(authz.grants('user:global-admin')[0]).toMatchObject({ profileId: 'god', scopeKey: 'global' });
    expect(authz.selectionForPrincipal('user:org-operator', organization.id)).toEqual({
      level: 'administrator', scope: 'organization',
    });
    expect(authz.selectionForPrincipal('user:project-operator', organization.id)).toEqual({
      level: 'maintainer', scope: 'projects', projectIds: [project.id],
    });
  });

  it('caps a requested task profile at the creator and records attenuation', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    const organization = store.createOrganization({ name: 'Acme' });
    const project = store.createProject('P1', {}, organization.id);
    authz.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
    const requested = authz.taskGrant('user:dev', project.id, 'administrator');
    expect(requested.attenuated).toBe(true);
    expect(allows(requested.capabilities, 'task:create')).toBe(true);
    expect(allows(requested.capabilities, 'user:write')).toBe(false);
    const delegated = authz.taskGrant('user:admin', project.id, 'administrator', ['task:read']);
    expect(delegated.capabilities).toEqual(['task:read']);
  });

  it('supports project profile overlays, revocation, and durable audit', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    authz.saveProfile('user:admin', projectScope('p1'), {
      id: 'developer', name: 'Restricted developer', description: 'Read only here', capabilities: ['project:read', 'task:read'],
    });
    authz.grant('user:admin', { principalId: 'user:a', scopeKey: projectScope('p1'), profileId: 'developer' });
    expect(authz.capabilities('user:a', 'p1')).toEqual(['project:read', 'task:read']);
    authz.revoke('user:admin', 'user:a', projectScope('p1'));
    expect(authz.capabilities('user:a', 'p1')).toEqual([]);
    expect(store.auditSince().map((e) => e.action)).toEqual([
      'authorization.profile.saved', 'authorization.grant.saved', 'authorization.grant.revoked',
    ]);
  });

  it('lets an organization Administrator manage tenant payments without host authority', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    const organization = store.createOrganization({ name: 'Acme' });
    const project = store.createProject('App', {}, organization.id);
    authz.grant('root', {
      principalId: 'user:administrator',
      scopeKey: `organization:${organization.id}`,
      profileId: 'administrator',
    });
    const capabilities = authz.capabilities('user:administrator', project.id, organization.id);
    expect(capabilities).toContain('payment:*');
    expect(capabilities).not.toContain('process:*');
  });

  it('applies team and @all project profiles dynamically', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    store.setOrganizationMembership(organization.id, 'alice', 'member');
    const project = store.createProject('App', {}, organization.id);
    const team = store.createTeam({ organizationId: organization.id, name: 'Leaders' });
    store.setTeamMembership(team.id, 'alice');
    store.setProjectMembership(project.id, { kind: 'team', teamId: team.id }, 'maintainer');
    expect(allows(authz.capabilities('user:alice', project.id), 'project:settings:write')).toBe(true);

    store.removeProjectMembership(project.id, { kind: 'team', teamId: team.id });
    store.setProjectMembership(project.id, { kind: 'organization', organizationId: organization.id }, 'administrator');
    expect(allows(authz.capabilities('user:alice', project.id), 'project:settings:write')).toBe(true);
    expect(allows(authz.capabilities('user:alice', project.id), 'project:delete')).toBe(false);
  });

  it('accepts the workflow-role capabilities exposed by the checklist', () => {
    const authz = new AuthorizationService(new Store(':memory:'));
    expect(() => authz.saveProfile('user:admin', 'global', {
      id: 'reviewer', name: 'Reviewer', description: 'Workflow decisions',
      capabilities: ['resolve-decision', 'confirm-decision', 'merge-into:*'],
    })).not.toThrow();
  });

  it('caps project grants and cannot redefine a global grant through an overlay', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    authz.grant('root', { principalId: 'user:project-admin', scopeKey: projectScope('p1'), profileId: 'administrator' });
    const local = authz.capabilities('user:project-admin', 'p1');
    expect(local).toContain('task:*');
    expect(local).not.toContain('*');
    expect(allows(local, 'user:write')).toBe(false);
    expect(authz.capabilities('user:project-admin')).toEqual([]);

    authz.grant('root', { principalId: 'user:developer', scopeKey: 'global', profileId: 'developer' });
    authz.saveProfile('root', projectScope('p1'), {
      id: 'developer', name: 'Escalating overlay', description: 'must not affect the global grant', capabilities: ['*'],
    });
    const globalInProject = authz.capabilities('user:developer', 'p1');
    expect(globalInProject).not.toContain('*');
    expect(allows(globalInProject, 'user:write')).toBe(false);
  });
});
