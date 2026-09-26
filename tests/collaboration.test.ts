import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { BrowserDeliveryAdapter, DeliveryDispatcher } from '../src/collaboration/delivery.js';

describe('organization and collaboration domain', () => {
  it('does not treat a longer team route as a reference to its prefix', async () => {
    const store = await Store.create(':memory:');
    try {
      const org = await store.createOrganization({ name: 'Teams', ownerUserId: 'owner' });
      const project = await store.createProject('App', {}, org.id);
      const dev = await store.createTeam({ organizationId: org.id, name: 'Dev' });
      const developers = await store.createTeam({ organizationId: org.id, name: 'Developers' });
      await store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1',
        params: { prompt: 'fixture', responder: { kind: 'human', audience: ['@team:developers'] } } });
      await store.deleteTeam(dev.id);
      expect(await store.getTeam(dev.id)).toBeUndefined();
      await expect(store.deleteTeam(developers.id)).rejects.toThrow(/still used/);
    } finally { await store.close(); }
  });

  it('delivers simultaneous authorization asks even when request hashes collide', async () => {
    const store = await Store.create(':memory:');
    try {
      const org = await store.createOrganization({ name: 'Approvals', ownerUserId: 'owner' });
      const project = await store.createProject('App', {}, org.id);
      for (const [avatarId, requestId] of [['avatar-a', 'Aa'], ['avatar-b', 'BB']] as const)
        await store.addAuthorizationInbox(org.id, ['owner'],
          { kind: 'avatar-authorization', avatarId, projectId: project.id, requestId }, 1000);
      const inbox = await store.listInbox('owner', org.id);
      expect(inbox.map((row) => row.subject?.requestId).sort()).toEqual(['Aa', 'BB']);
    } finally { await store.close(); }
  });

  it('routes email by urgency for task and resource asks, retaining legacy defaults', async () => {
    const store = (await Store.create(':memory:'));
    const org = (await store.createOrganization({ name: 'Email', ownerUserId: 'owner' }));
    const project = (await store.createProject('App', {}, org.id));
    (await store.setDeliveryPreferences({ userId: 'owner', organizationId: org.id,
      browser: true, email: false, slack: false, routine: true, emailUrgencies: { critical: true, high: false } }));
    expect((await store.getDeliveryPreferences('owner', org.id)).emailUrgencies).toEqual({ critical: true, high: false });
    for (const urgency of ['critical', 'high'] as const) {
      const task = (await store.createTask({ projectId: project.id, title: urgency, workflow: 'just-do',
        workflowVersion: '1', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
      (await store.appendEvent({ taskId: task.id, type: 'credential.approval-requested', ts: Date.now(),
        payload: { urgency } }));
    }
    (await store.addAuthorizationInbox(org.id, ['owner'], { kind: 'avatar-authorization', avatarId: 'avatar', projectId: project.id, requestId: 'first' }));
    const delivered: string[] = [];
    const dispatcher = new DeliveryDispatcher(store, { browser: new BrowserDeliveryAdapter(),
      email: { deliver: async ({ inbox }) => { delivered.push(inbox.urgency); } } });
    await dispatcher.drain();
    expect(delivered).toEqual(['critical']);
    (await store.setDeliveryPreferences({ userId: 'owner', organizationId: org.id,
      browser: true, email: true, slack: false, routine: true }));
    (await store.addAuthorizationInbox(org.id, ['owner'], { kind: 'avatar-authorization', avatarId: 'avatar', projectId: project.id, requestId: 'second' }));
    await dispatcher.drain();
    expect(delivered).toEqual(['critical', 'high']);
    (await store.close());
  });

  it('migrates installation records into a personal organization', async () => {
    const store = (await Store.create(':memory:'));
    const personal = (await store.getOrganization('org_personal'));
    expect(personal).toMatchObject({ slug: 'personal', kind: 'personal' });
    const project = (await store.createProject('Existing shape'));
    expect(project.organizationId).toBe(personal!.id);
  });

  it('migrates generated personal-workspace labels to registered user names atomically', async () => {
    const store = (await Store.create(':memory:'));
    const users = [
      { id: 'alice', name: 'Alice Example' },
      { id: 'bob', name: 'Bob' },
    ];
    store.connectUserNames(() => users);
    (await store.claimPersonalOrganization('alice'));
    (await store.renameOrganization('org_personal', "Alice Example's workspace"));
    const bob = (await store.createOrganization({ name: "Bob's workspace", kind: 'personal', ownerUserId: 'bob' }));
    const custom = (await store.createOrganization({ name: 'My quiet corner', kind: 'personal', ownerUserId: 'custom' }));

    expect((await store.migratePersonalOrganizationNames(users))).toBe(2);
    expect((await store.getOrganization('org_personal'))?.name).toBe('Alice Example');
    expect((await store.getOrganization(bob.id))?.name).toBe('Bob');
    expect((await store.getOrganization(custom.id))?.name).toBe('My quiet corner');
    expect((await store.migratePersonalOrganizationNames(users))).toBe(0);
  });

  it('rolls back all personal-workspace renames when the new namespace has a collision', async () => {
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('alice'));
    (await store.renameOrganization('org_personal', "Alice's workspace"));
    (await store.createOrganization({ name: 'Alice' }));
    store.connectUserNames(() => [{ id: 'alice', name: 'Alice' }]);

    await expect((async () => (await store.migratePersonalOrganizationNames([{ id: 'alice', name: 'Alice' }])))()).rejects.toThrow(/already used by an organization/i);
    expect((await store.getOrganization('org_personal'))?.name).toBe("Alice's workspace");
  });

  it('migrates legacy user-organization name collisions without changing organization identity', async () => {
    const store = (await Store.create(':memory:'));
    const user = { id: 'alice', name: 'alice@example.com' };
    const organization = (await store.createOrganization({ name: user.name, ownerUserId: user.id }));
    const project = (await store.createProject('Legacy project', {}, organization.id));
    store.connectUserNames(() => [user]);

    expect((await store.migrateLegacyAccountNameCollisions([user]))).toBe(1);
    expect((await store.getOrganization(organization.id))).toMatchObject({
      id: organization.id, name: 'alice-example-com', slug: 'alice-example-com',
    });
    expect((await store.organizationMembership(organization.id, user.id))?.role).toBe('owner');
    expect((await store.getProject(project.id))?.organizationId).toBe(organization.id);
    expect((await store.claimPersonalOrganization(user.id, user.name))).toMatchObject({
      id: 'org_personal', name: user.name,
    });
    expect((await store.migrateLegacyAccountNameCollisions([user]))).toBe(0);
  });

  it('keeps a per-user default organization initialized to the owned personal workspace', async () => {
    const store = (await Store.create(':memory:'));
    const personal = (await store.createOrganization({ name: "Alice's workspace", kind: 'personal', ownerUserId: 'alice' }));
    const team = (await store.createOrganization({ name: 'Newest team', ownerUserId: 'team-owner' }));
    (await store.setOrganizationMembership(team.id, 'alice', 'member'));

    expect((await store.defaultOrganization('alice'))?.id).toBe(personal.id);
    expect((await store.defaultOrganization('alice'))?.id).toBe(personal.id); // joining a newer org does not update it
    await expect((async () => (await store.setDefaultOrganization('alice', (await store.getOrganization('org_personal'))!.id)))()).rejects.toThrow(/one of your organizations/);

    (await store.setDefaultOrganization('alice', team.id));
    expect((await store.defaultOrganization('alice'))?.id).toBe(team.id);
    (await store.removeOrganizationMembership(team.id, 'alice'));
    expect((await store.defaultOrganization('alice'))?.id).toBe(personal.id);
  });

  it('keeps membership, teams, repositories, and project access inside one organization', async () => {
    const store = (await Store.create(':memory:'));
    const acme = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const other = (await store.createOrganization({ name: 'Other', ownerUserId: 'outsider' }));
    (await store.setOrganizationMembership(acme.id, 'developer', 'member'));
    const project = (await store.createProject('Product', { worldProvider: 'e2b' }, acme.id));
    const team = (await store.createTeam({ organizationId: acme.id, name: 'Platform' }));
    (await store.setTeamMembership(team.id, 'developer'));
    await expect((async () => (await store.setTeamMembership(team.id, 'outsider')))()).rejects.toThrow(/belong to the organization/);
    (await store.setProjectMembership(project.id, { kind: 'team', teamId: team.id }, 'member'));

    (await store.setProjectMembership(project.id, { kind: 'organization', organizationId: acme.id }, 'member'));
    expect((await store.userIsProjectMember(project.id, 'owner'))).toBe(true);
    await expect((async () => (await store.setProjectMembership(project.id, { kind: 'organization', organizationId: other.id }, 'member')))()).rejects.toThrow(/another organization/);
    (await store.removeProjectMembership(project.id, { kind: 'organization', organizationId: acme.id }));

    expect((await store.userIsProjectMember(project.id, 'developer'))).toBe(true);
    await expect((async () => (await store.setProjectMembership(project.id, { kind: 'user', userId: 'outsider' }, 'member')))()).rejects.toThrow(/not a member/);

    const connection = await store.upsertGitConnection({ organizationId: acme.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    const otherConnection = await store.upsertGitConnection({ organizationId: other.id, provider: 'github',
      installationId: '42', accountLogin: 'acme' });
    expect(otherConnection.id).not.toBe(connection.id);
    expect(await store.listGitConnections(acme.id)).toEqual([connection]);
    expect(await store.listGitConnections(other.id)).toEqual([otherConnection]);
    const repository = (await store.upsertRepository({ organizationId: acme.id, provider: 'github', providerId: '100',
      owner: 'acme', name: 'product', sshUrl: 'git@github.com:acme/product.git', defaultBranch: 'main',
      private: true, gitConnectionId: connection.id }));
    (await store.setSettings(project.id, 'software-dev', { repos: ['/stale/local/path'], remote: 'none' }));
    (await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id, baseBranch: 'main', targetBranch: 'main' }));
    expect((await store.getProject(project.id))?.config.repos).toEqual(['git@github.com:acme/product.git']);
    expect((await store.getSettings(project.id, 'software-dev'))).toMatchObject({ repos: ['git@github.com:acme/product.git'], remote: 'none' });
    await expect((async () => (await store.attachProjectRepository({ projectId: project.id, repositoryId:
      (await store.upsertRepository({ organizationId: other.id, provider: 'github', owner: 'other', name: 'secret',
        sshUrl: 'git@github.com:other/secret.git', defaultBranch: 'main', private: true })).id })))()).rejects.toThrow(/same organization/);
    (await store.setProjectMembership(project.id, { kind: 'user', userId: 'owner' }, 'owner'));
    await expect((async () => (await store.setProjectMembership(project.id, { kind: 'user', userId: 'owner' }, 'member')))()).rejects.toThrow(/retain at least one owner/);
    await expect((async () => (await store.setOrganizationMembership(other.id, 'outsider', 'member')))()).rejects.toThrow(/retain at least one owner/);
  });

  it('keeps self-hosted repository sources at project scope instead of per workflow', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Local', ownerUserId: 'owner' }));
    const project = (await store.createProject('App', {}, organization.id));
    (await store.setSettings(project.id, 'software-dev', { repos: ['/old'], remote: 'none' }));
    (await store.setSettings(project.id, 'just-do', { repos: ['/also-old'] }));
    (await store.setSettings(`quick:${project.id}`, 'software-dev', { repos: ['/stale-quick'] }));
    (await store.setProjectRepositorySources(project.id, ['/work/app', '/work/app', ' git@github.com:acme/api.git ']));
    const expected = ['/work/app', 'git@github.com:acme/api.git'];
    expect((await store.getProject(project.id))?.config.repos).toEqual(expected);
    expect((await store.getSettings(project.id, 'software-dev'))).toMatchObject({ repos: expected, remote: 'none' });
    expect((await store.getSettings(project.id, 'just-do'))).toMatchObject({ repos: expected });
    expect((await store.getSettings(`quick:${project.id}`, 'software-dev'))).toMatchObject({ repos: expected });
  });

  it('stores immutable responsibility, auto-subscribes participants, and resolves a per-user inbox', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Team', ownerUserId: 'owner' }));
    (await store.setOrganizationMembership(organization.id, 'developer', 'member'));
    (await store.setOrganizationMembership(organization.id, 'reviewer', 'member'));
    const project = (await store.createProject('App', {}, organization.id));
    (await store.setProjectMembership(project.id, { kind: 'user', userId: 'developer' }, 'member'));
    (await store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer'));
    const task = (await store.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'ship it' }, createdBy: { kind: 'user', userId: 'owner' } }));

    (await store.setTaskResponsibility(task.id, {
      assignee: { kind: 'user', userId: 'developer' },
      delegate: { kind: 'task-agent', taskId: task.id, role: 'do' },
      confirmationPolicy: { targets: [{ kind: 'project-role', projectId: project.id, role: 'reviewer' }], rule: 'any' },
    }));
    expect((await store.getTask(task.id))).toMatchObject({
      createdBy: { kind: 'user', userId: 'owner' }, assignee: { kind: 'user', userId: 'developer' },
    });
    expect((await store.subscribersFor(task.id))).toEqual([
      { kind: 'user', userId: 'owner' }, { kind: 'user', userId: 'developer' },
    ]);
    expect((await store.listInbox('developer', organization.id)).map((x) => x.kind)).toEqual(['assigned']);

    (await store.appendEvent({ taskId: task.id, type: 'software-dev.review-requested', ts: Date.now(), payload: {} }));
    const inbox = (await store.listInbox('reviewer', organization.id));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'review-requested', actionable: true, unread: true });
    expect((await store.markInbox('reviewer', inbox[0]!.id, false))?.unread).toBe(false);

    (await store.appendEvent({ taskId: task.id, type: 'credential.approval-requested', ts: Date.now(),
      payload: { requestId: 'vreq_1', status: 'approval-needed' } }));
    expect((await store.listInbox('owner', organization.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: task.id, kind: 'approval-requested', actionable: true, unread: true }),
    ]));
    (await store.appendEvent({ taskId: task.id, type: 'credential.approval-resolved', ts: Date.now(),
      payload: { requestId: 'vreq_1', action: 'task', resumed: true } }));
    // An answered ask leaves the inbox entirely rather than lingering as a read row.
    expect((await store.listInbox('owner', organization.id)).find((item) => item.kind === 'approval-requested'))
      .toBeUndefined();
  });

  it('stores only an invitation hash and enforces email, expiry, and single use', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Invite test', ownerUserId: 'owner' }));
    const project = (await store.createProject('App', {}, organization.id));
    const { token } = (await store.createOrganizationInvitation({ organizationId: organization.id,
      email: 'new@example.com', authorization: { level: 'maintainer', scope: 'projects', projectIds: [project.id] },
      invitedBy: 'owner' }));
    const row = (await store.db.prepare('SELECT tokenHash FROM organization_invitations').get()) as any;
    expect(row.tokenHash).not.toContain(token);
    await expect((async () => (await store.acceptOrganizationInvitation(token, 'wrong', 'wrong@example.com')))()).rejects.toThrow(/different email/);
    expect((await store.acceptOrganizationInvitation(token, 'new', 'NEW@example.com'))).toMatchObject({
      role: 'member', profileId: 'maintainer',
      authorization: { level: 'maintainer', scope: 'projects', projectIds: [project.id] },
    });
    await expect((async () => (await store.acceptOrganizationInvitation(token, 'new', 'new@example.com')))()).rejects.toThrow(/already used/);
  });

  it('binds GitHub installation state to an organization member and consumes it once', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'GitHub', ownerUserId: 'owner' }));
    const state = (await store.createGithubInstallState(organization.id, 'owner'));
    const row = (await store.db.prepare('SELECT tokenHash FROM github_install_states').get()) as any;
    expect(row.tokenHash).not.toContain(state);
    expect((await store.consumeGithubInstallState(state, 'attacker'))).toBeUndefined();
    expect((await store.consumeGithubInstallState(state, 'owner'))).toEqual({ organizationId: organization.id });
    expect((await store.consumeGithubInstallState(state, 'owner'))).toBeUndefined();
    const profileState = (await store.createGithubInstallState(organization.id, 'owner', { returnTo: 'profile' }));
    expect((await store.consumeGithubInstallState(profileState, 'owner'))).toEqual({
      organizationId: organization.id,
      returnTo: 'profile',
    });
    const accountState = (await store.createGithubInstallState(organization.id, 'owner', { returnTo: 'profile',
      githubAccountId: '42', githubLogin: 'octocat', selectAccount: true }));
    expect((await store.consumeGithubInstallState(accountState, 'owner'))).toEqual({
      organizationId: organization.id, returnTo: 'profile', githubAccountId: '42', githubLogin: 'octocat', selectAccount: true,
    });
    await expect((async () => (await store.createGithubInstallState(organization.id, 'attacker')))()).rejects.toThrow(/not an organization member/);
  });

  it('enforces explicit all/quorum confirmation policies idempotently', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Review', ownerUserId: 'owner' }));
    for (const userId of ['a', 'b', 'outsider']) (await store.setOrganizationMembership(organization.id, userId, 'member'));
    const project = (await store.createProject('Review', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Review me', workflow: 'software-dev',
      workflowVersion: '1', params: { prompt: 'x' }, confirmationPolicy: {
        targets: [{ kind: 'user', userId: 'a' }, { kind: 'user', userId: 'b' }], rule: 'all',
      } }));
    (await store.beginConfirmationCycle(task.id, task.confirmationPolicy!));
    expect((await store.voteConfirmation(task.id, 'outsider')).authorized).toBe(false);
    expect((await store.voteConfirmation(task.id, 'a'))).toMatchObject({ authorized: true, satisfied: false, votes: 1, required: 2 });
    expect((await store.voteConfirmation(task.id, 'a')).votes).toBe(1);
    expect((await store.voteConfirmation(task.id, 'b'))).toMatchObject({ satisfied: true, votes: 2, required: 2 });
  });

  it('routes each human workflow gate to its declared people', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Routing', ownerUserId: 'owner' }));
    for (const userId of ['developer', 'designer', 'outsider'])
      (await store.setOrganizationMembership(organization.id, userId, 'member'));
    const project = (await store.createProject('Product', {}, organization.id));
    (await store.setProjectMembership(project.id, { kind: 'user', userId: 'developer' }, 'member'));
    const design = (await store.createTeam({ organizationId: organization.id, name: 'Design' }));
    expect((await store.createTeam({ organizationId: organization.id, name: 'Design' })).id).toBe(design.id);
    expect((await store.listTeams(organization.id))).toHaveLength(1);
    (await store.setTeamMembership(design.id, 'designer'));
    const task = (await store.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
      workflowVersion: '1', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    (await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review',
      status: 'waiting', messages: [], actions: [], state: {}, waitingFor: {
        kind: 'human', audience: ['@creator', '@project', `team:${design.id}`, 'user:outsider'],
      }, updatedAt: Date.now() }));

    expect((await store.humanAudience(task.id))).toEqual(expect.arrayContaining(['owner', 'developer', 'designer', 'outsider']));
    expect((await store.humanMayAct(task.id, 'designer'))).toBe(true);
    expect((await store.humanMayAct(task.id, 'unknown'))).toBe(false);
    expect((await store.humanAudience(task.id, ['@team:design']))).toEqual(['designer']);
    expect((await store.updateTeam(design.id, { name: 'Product Design' }))).toMatchObject({ name: 'Product Design', slug: 'product-design' });
    // Renaming a team must not strand workflows that already stored its old route.
    expect((await store.humanAudience(task.id, ['@team:design']))).toEqual(['designer']);
    expect((await store.humanAudience(task.id, ['@team:product-design']))).toEqual(['designer']);
    await expect((async () => (await store.deleteTeam(design.id)))()).rejects.toThrow(/still used/);

    const temporary = (await store.createTeam({ organizationId: organization.id, name: 'Temporary' }));
    (await store.setTeamMembership(temporary.id, 'designer'));
    (await store.deleteTeam(temporary.id));
    expect((await store.getTeam(temporary.id))).toBeUndefined();
    expect((await store.listTeamMemberships(temporary.id))).toEqual([]);

    const child = (await store.createTask({ projectId: project.id, title: 'Child', workflow: 'software-dev',
      workflowVersion: '1', params: { prompt: 'x' },
      createdBy: { kind: 'task-agent', taskId: task.id, role: 'do' } }));
    expect((await store.humanAudience(child.id, ['@creator']))).toEqual(['owner']);

    const automated = (await store.createTask({ projectId: project.id, title: 'Scheduled', workflow: 'software-dev',
      workflowVersion: '1', params: { prompt: 'x' } }));
    expect((await store.humanAudience(automated.id, ['@creator']))).toEqual(['owner']);
  });

  it('exports a complete redacted tenant and deletes it atomically', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Delete me', ownerUserId: 'owner' }));
    const project = (await store.createProject('Product', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Private task', workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'important customer data' } }));
    (await store.createOrganizationInvitation({ organizationId: organization.id, email: 'new@example.com', invitedBy: 'owner' }));
    (await store.setOrganizationIdentityPolicy({ organizationId: organization.id, oidcProviderId: 'enterprise' }));
    (await store.setOrganizationExecutionPolicy(organization.id, { worldProvider: 'e2b', network: { unrestricted: true } }));
    (await store.setSettings(`organization:${organization.id}`, 'software-dev', { confirm: { mode: 'auto' } }));
    (await store.rotateScimToken(organization.id));
    (await store.registerWorld({ version: 2, id: task.id, kind: 'memory', provider: 'memory', generation: 1,
      runnerPoolId: 'local', environmentDigest: 'test', root: '/opaque', branch: 'task/test', base: 'main', meta: {} }, project.id));
    (await store.createRunnerPool({ id: 'doomed-pool', organizationId: organization.id, name: 'Doomed', provider: 'e2b',
      mode: 'managed', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true }));
    (await store.createExecution({ id: 'doomed-exec', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, kind: 'terminal', label: 'Terminal',
      server: false, openUrls: [], state: 'running', heartbeatAt: 1, startedAt: 1 }));
    (await store.recordUsage({ id: 'doomed-usage', organizationId: organization.id, projectId: project.id, taskId: task.id,
      worldId: task.id, provider: 'e2b', kind: 'world.active', quantity: 1, unit: 'second', costMicros: 5,
      startedAt: 1, endedAt: 2, metadata: {} }));

    const exported = (await store.exportOrganization(organization.id)) as any;
    expect(exported.organization.name).toBe('Delete me');
    expect(exported.security).toMatchObject({ secretsIncluded: false });
    expect(exported.tables.tasks[0].title).toBe('Private task');
    expect(exported.tables.organization_invitations[0].tokenHash).toBeUndefined();
    expect(exported.identityPolicy.scimTokenId).toBeUndefined();
    expect(exported.executionPolicy).toMatchObject({ worldProvider: 'e2b', network: { unrestricted: true } });
    expect(exported.tables.settings).toHaveLength(1);
    expect(exported.tables.world_instances[0].handle).toMatchObject({ provider: 'memory', generation: 1 });
    expect(exported.tables.world_instances[0].handle.meta).toBeUndefined();

    (await store.deleteOrganization(organization.id));
    expect((await store.getOrganization(organization.id))).toBeUndefined();
    expect((await store.getProject(project.id))).toBeUndefined();
    expect((await store.getTask(task.id))).toBeUndefined();
    expect((await store.db.prepare('SELECT COUNT(*) n FROM world_instances').get())).toMatchObject({ n: 0 });
    expect((await store.kvGet(`organization-execution:${organization.id}`))).toBeUndefined();
    expect((await store.getRunnerPool('doomed-pool'))).toBeUndefined();
    expect((await store.execution('doomed-exec'))).toBeUndefined();
    expect((await store.usageSummary(organization.id)).events).toBe(0);
    await expect((async () => (await store.deleteOrganization('org_personal')))()).rejects.toThrow(/cannot be deleted/);
  });

  it('deletes every project-scoped durable record and revokes its credentials', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Lifecycle', ownerUserId: 'owner' }));
    const project = (await store.createProject('Disposable', { worldProvider: 'e2b' }, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Delete all of me', workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'customer data' } }));
    (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/workspace', branch: 'karmax/task', base: 'main', sealedProviderRef: 'opaque', meta: {} }, project.id));
    (await store.saveWorldCheckpoint({ id: 'checkpoint-1', worldId: task.id, generation: 1, projectId: project.id,
      runnerPoolId: 'pool-1', environmentDigest: 'image', repos: [],
      filesystemDelta: { objectKey: 'checkpoints/one', sha256: 'abc', bytes: 3 }, createdAt: 1 }));
    (await store.createRunnerPool({ id: 'pool-1', organizationId: organization.id, name: 'Cloud', provider: 'e2b',
      mode: 'managed', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true }));
    const lease = (await store.requestWorldLease({ runnerPoolId: 'pool-1', organizationId: organization.id,
      projectId: project.id, taskId: task.id, worldId: task.id }));
    (await store.createExecution({ id: 'execution-1', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, kind: 'terminal', label: 'Shell', server: false,
      openUrls: [], runnerLeaseId: lease.id }));
    (await store.appendExecutionFrame('execution-1', 'private output'));
    (await store.createPreviewLease({ id: 'preview-1', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, port: 3000, public: false, provider: 'e2b',
      runnerLeaseId: lease.id, createdBy: 'owner', createdAt: 1, expiresAt: Date.now() + 60_000 }));
    (await store.savePromotedArtifact({ id: 'artifact-1', organizationId: organization.id, projectId: project.id,
      taskId: task.id, objectKey: 'artifacts/one', sha256: 'def', bytes: 3, mediaType: 'text/plain',
      name: 'private.txt', createdAt: 1 }));
    (await store.recordUsage({ organizationId: organization.id, projectId: project.id, taskId: task.id,
      worldId: task.id, provider: 'e2b', kind: 'world.active', quantity: 1, unit: 'second', costMicros: 2,
      startedAt: 1, endedAt: 2, metadata: { private: true } }));
    (await store.grantAttachment('attachment-1', project.id));
    (await store.setSettings(project.id, 'software-dev', { secret: 'general' }));
    (await store.setSettings(`quick:${project.id}`, 'software-dev', { secret: 'quick' }));
    (await store.kvSet(`session:${task.id}:do`, 'session-secret'));
    (await store.kvSet(`turnsession:${task.id}#1`, 'turn-secret'));
    (await store.kvSet(`wfpin:${project.id}:software-dev`, '1.0.0'));
    (await store.setPrincipalGrant('user:owner', `project:${project.id}`, { profileId: 'developer' }));
    (await store.createCard({ id: 'card-1', provider: 'test', scope: 'project', scopeId: project.id,
      label: 'Project card', cap: 100, available: 100, createdAt: 1 }));
    const tokenAuthority = new TokenAuthority(store);
    const token = (await tokenAuthority.mint({ taskId: task.id, profileId: 'do', principal: 'user:owner',
      organizationId: organization.id, projectId: project.id, ceiling: ['task:read'], grantorCaps: ['task:read'] })).token;

    expect((await store.projectResources(project.id))).toMatchObject({
      objectKeys: expect.arrayContaining(['checkpoints/one', 'artifacts/one']),
      attachmentIds: ['attachment-1'], leases: [expect.objectContaining({ id: lease.id, provider: 'e2b' })],
    });
    (await store.deleteProject(project.id));

    expect((await store.getProject(project.id))).toBeUndefined();
    expect((await tokenAuthority.verify(token))).toBeUndefined();
    for (const table of ['tasks', 'task_lists', 'events', 'world_instances', 'world_checkpoints',
      'world_leases', 'promoted_artifacts', 'executions', 'execution_frames', 'preview_leases',
      'attachment_scopes', 'settings', 'cards', 'principal_grants'])
      expect((await store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get())).toMatchObject({ n: 0 });
    expect((await store.kvGet(`session:${task.id}:do`))).toBeUndefined();
    expect((await store.kvGet(`turnsession:${task.id}#1`))).toBeUndefined();
    expect((await store.kvGet(`wfpin:${project.id}:software-dev`))).toBeUndefined();
    expect((await store.db.prepare('SELECT projectId, taskId, worldId, metadata FROM usage_events').get()))
      .toMatchObject({ projectId: null, taskId: null, worldId: null, metadata: null });
  });
});

describe('DeliveryDispatcher error handling', () => {
  it('never leaks an unhandled rejection from its drain loop', async () => {
    // `drain()` CAN reject: claimDelivery() runs outside the per-item try (it is
    // the claim transaction itself) and rethrows after ROLLBACK. Both call sites
    // used a bare `void`, so a locked/corrupt database became an unhandled
    // rejection — a process-level failure for a retryable projection.
    const store = (await Store.create(':memory:'));
    const boom = new Error('database is locked');
    (store as any).claimDelivery = () => { throw boom; };

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    const errors: unknown[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const dispatcher = new DeliveryDispatcher(store, { browser: new BrowserDeliveryAdapter() }, undefined, 1);
      dispatcher.start();
      await new Promise((r) => setTimeout(r, 20));
      dispatcher.stop();
      // Give any pending microtask rejection a chance to surface.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.error = consoleError;
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0); // the failure is reported, not swallowed
  });
});
