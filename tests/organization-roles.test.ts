import { describe, it, expect } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, organizationScope } from '../src/platform/authorization.js';

describe('organization-owned authorization roles', () => {
  it('persists custom roles and uses them for people and tasks only in their organization', async () => {
    const store = (await Store.create(':memory:'));
    try {
      let auth = (await AuthorizationService.create(store));
      const org = (await store.createOrganization({ name: 'One' }));
      const other = (await store.createOrganization({ name: 'Two' }));
      const project = (await store.createProject('One', {}, org.id));
      const foreign = (await store.createProject('Two', {}, other.id));
      const role = (await auth.createOrganizationRole('root', org.id, {
        id: 'god', name: 'Task reader', description: 'Read tasks', capabilities: ['task:read'],
      }, ['*']));
      expect(role.id).not.toBe('god');
      expect(role.builtin).toBe(false);
      auth = (await AuthorizationService.create(store));
      expect((await auth.profiles(project.id))).toContainEqual(expect.objectContaining({ id: role.id }));
      expect((await auth.profiles(foreign.id)).some((p) => p.id === role.id)).toBe(false);
      (await auth.replacePrincipalAuthorization('root', 'user:reader', org.id,
        { level: role.id, scope: 'organization' }, ['*']));
      expect((await auth.selectionForPrincipal('user:reader', org.id))).toEqual({ level: role.id, scope: 'organization' });
      expect((await auth.capabilities('user:reader', project.id))).toEqual(['task:read']);
      expect((await auth.capabilities('user:reader', foreign.id))).toEqual([]);
      expect((await auth.taskGrant('user:reader', project.id,
        { level: role.id, scope: 'projects', projectIds: [project.id] })).capabilities).toEqual(['task:read']);
      expect((await auth.taskGrant('user:reader', project.id,
        { level: role.id, scope: 'organization' })).attenuated).toBe(false);
      await expect((async () => (await auth.taskGrant('root', foreign.id,
        { level: role.id, scope: 'organization' }, ['*'])))()).rejects.toThrow(/unknown authorization/);
      await expect((async () => (await auth.taskGrant('root', project.id,
        { level: role.id, scope: 'global' }, ['*'])))()).rejects.toThrow(/requires project or organization/);
      (await auth.replacePrincipalAuthorization('root', 'user:reader', org.id,
        { level: role.id, scope: 'projects', projectIds: [project.id] }, ['*']));
      expect((await auth.selectionForPrincipal('user:reader', org.id))?.level).toBe(role.id);
      expect((await auth.grants('user:reader')).some((g) => g.scopeKey === organizationScope(org.id))).toBe(false);
    } finally { (await store.close()); }
  });

  it('rejects unknown, global-only and unheld permissions and duplicate names', async () => {
    const store = (await Store.create(':memory:'));
    try {
      const auth = (await AuthorizationService.create(store));
      const org = (await store.createOrganization({ name: 'One' }));
      const create = async (capabilities: string[], actorCaps = ['*'], name = 'Custom') =>
        (await auth.createOrganizationRole('root', org.id, { id: '', name, description: 'Custom access', capabilities }, actorCaps));
      for (const caps of [[], ['invented'], ['task:*'], ['*']]) await expect((async () => (await create(caps)))()).rejects.toThrow();
      for (const cap of ['settings:write', 'authorization:write', 'workflow:install'])
        await expect((async () => (await create([cap])))()).rejects.toThrow(/cannot grant/);
      await expect((async () => (await create(['task:delete'], ['task:read'])))()).rejects.toThrow(/cannot grant/);
      (await create(['task:read']));
      await expect((async () => (await create(['task:read'], ['*'], ' custom ')))()).rejects.toThrow(/already exists/);
      await expect((async () => (await create(['task:read'], ['*'], 'Developer')))()).rejects.toThrow(/already exists/);
      await expect((async () => (await auth.assertCanGrantSelection('user:none', org.id,
        { level: (await auth.profiles(undefined, org.id)).find((p) => p.name === 'Custom')!.id, scope: 'organization' }, [])))()).rejects.toThrow(/cannot grant/);
    } finally { (await store.close()); }
  });
});
