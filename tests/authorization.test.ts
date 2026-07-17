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

  it('seeds four configurable job profiles and resolves project defaults', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    expect(authz.profiles().map((p) => p.id)).toEqual(['administrator', 'developer', 'maintainer', 'operator']);
    expect(authz.defaultProfile('p1')).toBe('developer');
    authz.setDefault('user:admin', 'maintainer', 'p1');
    expect(authz.defaultProfile('p1')).toBe('maintainer');
    expect(authz.defaultProfile('p2')).toBe('developer');
  });

  it('caps a requested task profile at the creator and records attenuation', () => {
    const store = new Store(':memory:');
    const authz = new AuthorizationService(store);
    authz.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope('p1'), profileId: 'developer' });
    const requested = authz.taskGrant('user:dev', 'p1', 'administrator');
    expect(requested.attenuated).toBe(true);
    expect(allows(requested.capabilities, 'task:create')).toBe(true);
    expect(allows(requested.capabilities, 'user:write')).toBe(false);
    const delegated = authz.taskGrant('user:admin', 'p1', 'administrator', ['task:read']);
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
    expect(allows(authz.capabilities('user:alice', project.id), 'project:delete')).toBe(true);
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
