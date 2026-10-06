import { describe, expect, it } from 'vitest';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { storeBackends } from './helpers/store-backends.js';

/** `@maintainers`, `@admins` and `@superadmins` name everyone whose effective
 * authorization in the task's project reaches that level, however it was
 * granted: an organization grant, a project grant, project or team membership. */
describe.each(storeBackends)('level audiences ($name)', ({ open }) => {
  async function fixture() {
    const store = await open();
    const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = await store.createProject('Site', {}, organization.id);
    const other = await store.createProject('Elsewhere', {}, organization.id);
    const authorization = await AuthorizationService.create(store);
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
    for (const userId of ['admin', 'maintainer', 'lead', 'teammate', 'developer', 'elsewhere'])
      await store.setOrganizationMembership(organization.id, userId, 'member');
    const grant = (userId: string, scopeKey: ReturnType<typeof projectScope>, profileId: string) =>
      authorization.grant('system:test', { principalId: `user:${userId}`, scopeKey, profileId });
    await grant('admin', organizationScope(organization.id), 'administrator');
    await grant('maintainer', projectScope(project.id), 'maintainer');
    await grant('developer', projectScope(project.id), 'developer');
    await grant('elsewhere', projectScope(other.id), 'maintainer');
    // Maintainer through project membership, directly and through a team.
    await store.setProjectMembership(project.id, { kind: 'user', userId: 'lead' }, 'owner');
    const team = await store.createTeam({ organizationId: organization.id, name: 'Core' });
    await store.setTeamMembership(team.id, 'teammate');
    await store.setProjectMembership(project.id, { kind: 'team', teamId: team.id }, 'maintainer');
    const task = await store.createTask({ projectId: project.id, title: 'Work', workflow: 'just-do',
      workflowVersion: '1.0.0', createdBy: { kind: 'user', userId: 'developer' }, params: { prompt: 'work' } });
    return { store, task };
  }

  it('resolves each level and everyone above it', async () => {
    const { store, task } = await fixture();
    expect((await store.humanAudience(task.id, ['@superadmins'])).sort()).toEqual(['owner']);
    expect((await store.humanAudience(task.id, ['@admins'])).sort()).toEqual(['admin', 'owner']);
    expect((await store.humanAudience(task.id, ['@maintainers'])).sort())
      .toEqual(['admin', 'lead', 'maintainer', 'owner', 'teammate']);
    // Combined with other selectors like any audience.
    expect((await store.humanAudience(task.id, ['@admins', '@creator'])).sort()).toEqual(['admin', 'developer', 'owner']);
  });

  it('follows grants as they change', async () => {
    const { store, task } = await fixture();
    const authorization = await AuthorizationService.create(store);
    const organizationId = (await store.getProject(task.projectId))!.organizationId!;
    await authorization.revoke('system:test', 'user:admin', organizationScope(organizationId));
    expect(await store.humanAudience(task.id, ['@admins'])).toEqual(['owner']);
    await authorization.grant('system:test', { principalId: 'user:developer', scopeKey: organizationScope(organizationId), profileId: 'superadmin' });
    expect((await store.humanAudience(task.id, ['@superadmins'])).sort()).toEqual(['developer', 'owner']);
  });
});
