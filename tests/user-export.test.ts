import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';

describe('user data export', () => {
  it('organizes directly linked records by organization without leaking unrelated work', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'alice' });
    store.setOrganizationMembership(organization.id, 'bob', 'member');
    const team = store.createTeam({ organizationId: organization.id, name: 'Design' });
    store.setTeamMembership(team.id, 'alice');
    const project = store.createProject('Roadmap', {}, organization.id);
    store.setProjectMembership(project.id, { kind: 'user', userId: 'alice' }, 'owner');
    const mine = store.createTask({ projectId: project.id, title: 'My task', workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'my private prompt' },
      createdBy: { kind: 'user', userId: 'alice' } });
    store.createTask({ projectId: project.id, title: 'Someone else’s task', workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'must not leak' },
      createdBy: { kind: 'user', userId: 'bob' } });
    store.subscribeTask(mine.id, { kind: 'user', userId: 'alice' });
    store.appendAudit({ principalId: 'user:alice', action: 'task.created', scopeKey: `project:${project.id}`,
      detail: { taskId: mine.id } });
    store.setPrincipalGrant('user:alice', `organization:${organization.id}`, { profileId: 'owner' });
    store.setDeliveryPreferences({ userId: 'alice', organizationId: organization.id,
      browser: true, email: true, slack: false, routine: true });

    store.appendEvent({taskId:mine.id,type:'timing',ts:Date.now(),payload:{name:'retained'}});
    const exported = store.exportUserData('alice', 'alice@example.com') as any;
    expect(exported.organizations[0].tasks[0].events.some((e:any)=>e.type==='timing')).toBe(false);
    expect(((store.exportOrganization(organization.id) as any).tables.events as any[]).some(e=>e.type==='timing')).toBe(false);
    store.setSettings('global','timing',{enabled:true});
    expect(((store.exportOrganization(organization.id) as any).tables.events as any[]).some(e=>e.type==='timing')).toBe(true);
    const optedIn = store.exportUserData('alice', 'alice@example.com') as any;
    expect(optedIn.organizations[0].tasks[0].events.some((e:any)=>e.type==='timing')).toBe(true);
    expect(store.eventsOfType(mine.id,'timing')).toHaveLength(1);

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

  it('includes invitations addressed to the user but never invitation or OAuth state secrets', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    store.createOrganizationInvitation({ organizationId: organization.id,
      email: 'alice@example.com', invitedBy: 'owner' });
    store.createGithubInstallState(organization.id, 'owner', 60_000);
    store.db.prepare(`INSERT INTO payment_oauth_states
      (stateHash, organizationId, userId, redirectUri, createdAt, expiresAt, usedAt)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`).run('payment-secret', organization.id, 'alice', '/', 1, 2);

    const exported = store.exportUserData('alice', 'ALICE@example.com') as any;

    expect(exported.organizations[0].invitations).toHaveLength(1);
    expect(exported.organizations[0].invitations[0].tokenHash).toBeUndefined();
    expect(JSON.stringify(exported)).not.toContain('payment-secret');
    expect(JSON.stringify(exported)).not.toContain('tokenHash');
  });
});
