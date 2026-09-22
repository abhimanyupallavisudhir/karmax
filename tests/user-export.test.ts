import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';

describe('user data export', () => {
  it('organizes directly linked records by organization without leaking unrelated work', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'alice' }));
    (await store.setOrganizationMembership(organization.id, 'bob', 'member'));
    const team = (await store.createTeam({ organizationId: organization.id, name: 'Design' }));
    (await store.setTeamMembership(team.id, 'alice'));
    const project = (await store.createProject('Roadmap', {}, organization.id));
    (await store.setProjectMembership(project.id, { kind: 'user', userId: 'alice' }, 'owner'));
    const mine = (await store.createTask({ projectId: project.id, title: 'My task', workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'my private prompt' },
      createdBy: { kind: 'user', userId: 'alice' } }));
    (await store.createTask({ projectId: project.id, title: 'Someone else’s task', workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'must not leak' },
      createdBy: { kind: 'user', userId: 'bob' } }));
    (await store.subscribeTask(mine.id, { kind: 'user', userId: 'alice' }));
    (await store.appendAudit({ principalId: 'user:alice', action: 'task.created', scopeKey: `project:${project.id}`,
      detail: { taskId: mine.id } }));
    (await store.setPrincipalGrant('user:alice', `organization:${organization.id}`, { profileId: 'owner' }));
    (await store.setDeliveryPreferences({ userId: 'alice', organizationId: organization.id,
      browser: true, email: true, slack: false, routine: true }));

    (await store.appendEvent({taskId:mine.id,type:'timing',ts:Date.now(),payload:{name:'retained'}}));
    const exported = (await store.exportUserData('alice', 'alice@example.com')) as any;
    expect(exported.organizations[0].tasks[0].events.some((e:any)=>e.type==='timing')).toBe(false);
    expect((((await store.exportOrganization(organization.id)) as any).tables.events as any[]).some(e=>e.type==='timing')).toBe(false);
    (await store.setSettings('global','timing',{enabled:true}));
    expect((((await store.exportOrganization(organization.id)) as any).tables.events as any[]).some(e=>e.type==='timing')).toBe(true);
    const optedIn = (await store.exportUserData('alice', 'alice@example.com')) as any;
    expect(optedIn.organizations[0].tasks[0].events.some((e:any)=>e.type==='timing')).toBe(true);
    expect((await store.eventsOfType(mine.id,'timing'))).toHaveLength(1);

    expect(exported.format).toBe('karmax-user-export');
    expect(exported.organizations).toHaveLength(1);
    expect(exported.organizations[0]).toMatchObject({
      organization: { id: organization.id, name: 'Acme' },
      membership: { userId: 'alice', role: 'owner' },
      teams: [{ team: { id: team.id, name: 'Design' }, membership: { userId: 'alice' } }],
      projectMemberships: [{ project: { id: project.id, name: 'Roadmap' } }],
      deliveryPreferences: { email: true },
    });
    expect(exported.organizations[0].tasks.map((entry: any) => entry.task.title)).toEqual(['My task']);
    expect(JSON.stringify(exported)).not.toContain('must not leak');
    expect(exported.authorization.grants).toEqual([
      expect.objectContaining({ principalId: 'user:alice', scopeKey: `organization:${organization.id}` }),
    ]);
    expect(exported.authorization.auditLog).toEqual([
      expect.objectContaining({ principalId: 'user:alice', action: 'task.created' }),
    ]);
  });

  it('includes invitations addressed to the user but never invitation or OAuth state secrets', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    (await store.createOrganizationInvitation({ organizationId: organization.id,
      email: 'alice@example.com', invitedBy: 'owner' }));
    (await store.createGithubInstallState(organization.id, 'owner', 60_000));
    (await store.db.prepare(`INSERT INTO payment_oauth_states
      (stateHash, organizationId, userId, redirectUri, createdAt, expiresAt, usedAt)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`).run('payment-secret', organization.id, 'alice', '/', 1, 2));

    const exported = (await store.exportUserData('alice', 'ALICE@example.com')) as any;

    expect(exported.organizations[0].invitations).toHaveLength(1);
    expect(exported.organizations[0].invitations[0].tokenHash).toBeUndefined();
    expect(JSON.stringify(exported)).not.toContain('payment-secret');
    expect(JSON.stringify(exported)).not.toContain('tokenHash');
  });
});
