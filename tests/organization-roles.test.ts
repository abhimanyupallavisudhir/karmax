import { describe, it, expect } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, organizationScope } from '../src/platform/authorization.js';

describe('organization-owned authorization roles', () => {
  it('persists custom roles and uses them for people and tasks only in their organization', () => {
    const store = new Store(':memory:');
    try {
      let auth = new AuthorizationService(store);
      const org = store.createOrganization({ name: 'One' });
      const other = store.createOrganization({ name: 'Two' });
      const project = store.createProject('One', {}, org.id);
      const foreign = store.createProject('Two', {}, other.id);
      const role = auth.createOrganizationRole('root', org.id, {
        id: 'god', name: 'Task reader', description: 'Read tasks', capabilities: ['task:read'],
      }, ['*']);
      expect(role.id).not.toBe('god');
      expect(role.builtin).toBe(false);
      auth = new AuthorizationService(store);
      expect(auth.profiles(project.id)).toContainEqual(expect.objectContaining({ id: role.id }));
      expect(auth.profiles(foreign.id).some((p) => p.id === role.id)).toBe(false);
      auth.replacePrincipalAuthorization('root', 'user:reader', org.id,
        { level: role.id, scope: 'organization' }, ['*']);
      expect(auth.selectionForPrincipal('user:reader', org.id)).toEqual({ level: role.id, scope: 'organization' });
      expect(auth.capabilities('user:reader', project.id)).toEqual(['task:read']);
      expect(auth.capabilities('user:reader', foreign.id)).toEqual([]);
      expect(auth.taskGrant('user:reader', project.id,
        { level: role.id, scope: 'projects', projectIds: [project.id] }).capabilities).toEqual(['task:read']);
      expect(auth.taskGrant('user:reader', project.id,
        { level: role.id, scope: 'organization' }).attenuated).toBe(false);
      expect(() => auth.taskGrant('root', foreign.id,
        { level: role.id, scope: 'organization' }, ['*'])).toThrow(/unknown authorization/);
      expect(() => auth.taskGrant('root', project.id,
        { level: role.id, scope: 'global' }, ['*'])).toThrow(/requires project or organization/);
      auth.replacePrincipalAuthorization('root', 'user:reader', org.id,
        { level: role.id, scope: 'projects', projectIds: [project.id] }, ['*']);
      expect(auth.selectionForPrincipal('user:reader', org.id)?.level).toBe(role.id);
      expect(auth.grants('user:reader').some((g) => g.scopeKey === organizationScope(org.id))).toBe(false);
    } finally { store.close(); }
  });

  it('rejects unknown, global-only and unheld permissions and duplicate names', () => {
    const store = new Store(':memory:');
    try {
      const auth = new AuthorizationService(store);
      const org = store.createOrganization({ name: 'One' });
      const create = (capabilities: string[], actorCaps = ['*'], name = 'Custom') =>
        auth.createOrganizationRole('root', org.id, { id: '', name, description: 'Custom access', capabilities }, actorCaps);
      for (const caps of [[], ['invented'], ['task:*'], ['*']]) expect(() => create(caps)).toThrow();
      for (const cap of ['settings:write', 'authorization:write', 'workflow:install'])
        expect(() => create([cap])).toThrow(/cannot grant/);
      expect(() => create(['task:delete'], ['task:read'])).toThrow(/cannot grant/);
      create(['task:read']);
      expect(() => create(['task:read'], ['*'], ' custom ')).toThrow(/already exists/);
      expect(() => create(['task:read'], ['*'], 'Developer')).toThrow(/already exists/);
      expect(() => auth.assertCanGrantSelection('user:none', org.id,
        { level: auth.profiles(undefined, org.id).find((p) => p.name === 'Custom')!.id, scope: 'organization' }, [])).toThrow(/cannot grant/);
    } finally { store.close(); }
  });
});
