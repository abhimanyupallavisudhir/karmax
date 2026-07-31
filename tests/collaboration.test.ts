import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { BrowserDeliveryAdapter, DeliveryDispatcher } from '../src/collaboration/delivery.js';

describe('organization and collaboration domain', () => {
  it('migrates installation records into a personal organization', () => {
    const store = new Store(':memory:');
    const personal = store.getOrganization('org_personal');
    expect(personal).toMatchObject({ slug: 'personal', kind: 'personal' });
    const project = store.createProject('Existing shape');
    expect(project.organizationId).toBe(personal!.id);
  });

  it('keeps membership, teams, repositories, and project access inside one organization', () => {
    const store = new Store(':memory:');
    const acme = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const other = store.createOrganization({ name: 'Other', ownerUserId: 'outsider' });
    store.setOrganizationMembership(acme.id, 'developer', 'member');
    const project = store.createProject('Product', { worldProvider: 'e2b' }, acme.id);
    const team = store.createTeam({ organizationId: acme.id, name: 'Platform' });
    store.setTeamMembership(team.id, 'developer');
    expect(() => store.setTeamMembership(team.id, 'outsider')).toThrow(/belong to the organization/);
    store.setProjectMembership(project.id, { kind: 'team', teamId: team.id }, 'member');

    store.setProjectMembership(project.id, { kind: 'organization', organizationId: acme.id }, 'member');
    expect(store.userIsProjectMember(project.id, 'owner')).toBe(true);
    expect(() => store.setProjectMembership(project.id, { kind: 'organization', organizationId: other.id }, 'member'))
      .toThrow(/another organization/);
    store.removeProjectMembership(project.id, { kind: 'organization', organizationId: acme.id });

    expect(store.userIsProjectMember(project.id, 'developer')).toBe(true);
    expect(() => store.setProjectMembership(project.id, { kind: 'user', userId: 'outsider' }, 'member'))
      .toThrow(/not a member/);

    const connection = store.upsertGitConnection({ organizationId: acme.id, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    expect(() => store.upsertGitConnection({ organizationId: other.id, provider: 'github',
      installationId: '42', accountLogin: 'acme' })).toThrow(/another organization/);
    const repository = store.upsertRepository({ organizationId: acme.id, provider: 'github', providerId: '100',
      owner: 'acme', name: 'product', sshUrl: 'git@github.com:acme/product.git', defaultBranch: 'main',
      private: true, gitConnectionId: connection.id });
    store.setSettings(project.id, 'software-dev', { repos: ['/stale/local/path'], remote: 'none' });
    store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id, baseBranch: 'main', targetBranch: 'main' });
    expect(store.getProject(project.id)?.config.repos).toEqual(['git@github.com:acme/product.git']);
    expect(store.getSettings(project.id, 'software-dev')).toMatchObject({ repos: ['git@github.com:acme/product.git'], remote: 'none' });
    expect(() => store.attachProjectRepository({ projectId: project.id, repositoryId:
      store.upsertRepository({ organizationId: other.id, provider: 'github', owner: 'other', name: 'secret',
        sshUrl: 'git@github.com:other/secret.git', defaultBranch: 'main', private: true }).id })).toThrow(/same organization/);
    store.setProjectMembership(project.id, { kind: 'user', userId: 'owner' }, 'owner');
    expect(() => store.setProjectMembership(project.id, { kind: 'user', userId: 'owner' }, 'member')).toThrow(/retain at least one owner/);
    expect(() => store.setOrganizationMembership(other.id, 'outsider', 'member')).toThrow(/retain at least one owner/);
  });

  it('keeps self-hosted repository sources at project scope instead of per workflow', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Local', ownerUserId: 'owner' });
    const project = store.createProject('App', {}, organization.id);
    store.setSettings(project.id, 'software-dev', { repos: ['/old'], remote: 'none' });
    store.setSettings(project.id, 'just-do', { repos: ['/also-old'] });
    store.setSettings(`quick:${project.id}`, 'software-dev', { repos: ['/stale-quick'] });
    store.setProjectRepositorySources(project.id, ['/work/app', '/work/app', ' git@github.com:acme/api.git ']);
    const expected = ['/work/app', 'git@github.com:acme/api.git'];
    expect(store.getProject(project.id)?.config.repos).toEqual(expected);
    expect(store.getSettings(project.id, 'software-dev')).toMatchObject({ repos: expected, remote: 'none' });
    expect(store.getSettings(project.id, 'just-do')).toMatchObject({ repos: expected });
    expect(store.getSettings(`quick:${project.id}`, 'software-dev')).toMatchObject({ repos: expected });
  });

  it('stores immutable responsibility, auto-subscribes participants, and resolves a per-user inbox', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Team', ownerUserId: 'owner' });
    store.setOrganizationMembership(organization.id, 'developer', 'member');
    store.setOrganizationMembership(organization.id, 'reviewer', 'member');
    const project = store.createProject('App', {}, organization.id);
    store.setProjectMembership(project.id, { kind: 'user', userId: 'developer' }, 'member');
    store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer');
    const task = store.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'ship it' }, createdBy: { kind: 'user', userId: 'owner' } });

    store.setTaskResponsibility(task.id, {
      assignee: { kind: 'user', userId: 'developer' },
      delegate: { kind: 'task-agent', taskId: task.id, role: 'do' },
      confirmationPolicy: { targets: [{ kind: 'project-role', projectId: project.id, role: 'reviewer' }], rule: 'any' },
    });
    expect(store.getTask(task.id)).toMatchObject({
      createdBy: { kind: 'user', userId: 'owner' }, assignee: { kind: 'user', userId: 'developer' },
    });
    expect(store.subscribersFor(task.id)).toEqual([
      { kind: 'user', userId: 'owner' }, { kind: 'user', userId: 'developer' },
    ]);
    expect(store.listInbox('developer', organization.id).map((x) => x.kind)).toEqual(['assigned']);

    store.appendEvent({ taskId: task.id, type: 'software-dev.review-requested', ts: Date.now(), payload: {} });
    const inbox = store.listInbox('reviewer', organization.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'review-requested', actionable: true, unread: true });
    expect(store.markInbox('reviewer', inbox[0]!.id, false)?.unread).toBe(false);

    store.appendEvent({ taskId: task.id, type: 'credential.approval-requested', ts: Date.now(),
      payload: { requestId: 'vreq_1', status: 'approval-needed' } });
    expect(store.listInbox('owner', organization.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: task.id, kind: 'approval-requested', actionable: true, unread: true }),
    ]));
    store.appendEvent({ taskId: task.id, type: 'credential.approval-resolved', ts: Date.now(),
      payload: { requestId: 'vreq_1', action: 'task', resumed: true } });
    expect(store.listInbox('owner', organization.id).find((item) => item.kind === 'approval-requested'))
      .toMatchObject({ actionable: false, unread: false });
  });

  it('stores only an invitation hash and enforces email, expiry, and single use', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Invite test', ownerUserId: 'owner' });
    const project = store.createProject('App', {}, organization.id);
    const { token } = store.createOrganizationInvitation({ organizationId: organization.id,
      email: 'new@example.com', authorization: { level: 'maintainer', scope: 'projects', projectIds: [project.id] },
      invitedBy: 'owner' });
    const row = store.db.prepare('SELECT tokenHash FROM organization_invitations').get() as any;
    expect(row.tokenHash).not.toContain(token);
    expect(() => store.acceptOrganizationInvitation(token, 'wrong', 'wrong@example.com')).toThrow(/different email/);
    expect(store.acceptOrganizationInvitation(token, 'new', 'NEW@example.com')).toMatchObject({
      role: 'member', profileId: 'maintainer',
      authorization: { level: 'maintainer', scope: 'projects', projectIds: [project.id] },
    });
    expect(() => store.acceptOrganizationInvitation(token, 'new', 'new@example.com')).toThrow(/already used/);
  });

  it('binds GitHub installation state to an organization member and consumes it once', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'GitHub', ownerUserId: 'owner' });
    const state = store.createGithubInstallState(organization.id, 'owner');
    const row = store.db.prepare('SELECT tokenHash FROM github_install_states').get() as any;
    expect(row.tokenHash).not.toContain(state);
    expect(store.consumeGithubInstallState(state, 'attacker')).toBeUndefined();
    expect(store.consumeGithubInstallState(state, 'owner')).toEqual({ organizationId: organization.id });
    expect(store.consumeGithubInstallState(state, 'owner')).toBeUndefined();
    expect(() => store.createGithubInstallState(organization.id, 'attacker')).toThrow(/not an organization member/);
  });

  it('enforces explicit all/quorum confirmation policies idempotently', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Review', ownerUserId: 'owner' });
    for (const userId of ['a', 'b', 'outsider']) store.setOrganizationMembership(organization.id, userId, 'member');
    const project = store.createProject('Review', {}, organization.id);
    const task = store.createTask({ projectId: project.id, title: 'Review me', workflow: 'software-dev',
      workflowVersion: '1', params: { prompt: 'x' }, confirmationPolicy: {
        targets: [{ kind: 'user', userId: 'a' }, { kind: 'user', userId: 'b' }], rule: 'all',
      } });
    store.beginConfirmationCycle(task.id, task.confirmationPolicy!);
    expect(store.voteConfirmation(task.id, 'outsider').authorized).toBe(false);
    expect(store.voteConfirmation(task.id, 'a')).toMatchObject({ authorized: true, satisfied: false, votes: 1, required: 2 });
    expect(store.voteConfirmation(task.id, 'a').votes).toBe(1);
    expect(store.voteConfirmation(task.id, 'b')).toMatchObject({ satisfied: true, votes: 2, required: 2 });
  });

  it('routes each human workflow gate to its declared people', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Routing', ownerUserId: 'owner' });
    for (const userId of ['developer', 'designer', 'outsider'])
      store.setOrganizationMembership(organization.id, userId, 'member');
    const project = store.createProject('Product', {}, organization.id);
    store.setProjectMembership(project.id, { kind: 'user', userId: 'developer' }, 'member');
    const design = store.createTeam({ organizationId: organization.id, name: 'Design' });
    expect(store.createTeam({ organizationId: organization.id, name: 'Design' }).id).toBe(design.id);
    expect(store.listTeams(organization.id)).toHaveLength(1);
    store.setTeamMembership(design.id, 'designer');
    const task = store.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
      workflowVersion: '1', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } });
    store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review',
      status: 'waiting', messages: [], actions: [], state: {}, waitingFor: {
        kind: 'human', audience: ['@creator', '@project', `team:${design.id}`, 'user:outsider'],
      }, updatedAt: Date.now() });

    expect(store.humanAudience(task.id)).toEqual(expect.arrayContaining(['owner', 'developer', 'designer', 'outsider']));
    expect(store.humanMayAct(task.id, 'designer')).toBe(true);
    expect(store.humanMayAct(task.id, 'unknown')).toBe(false);
    expect(store.humanAudience(task.id, ['@team:design'])).toEqual(['designer']);
    expect(store.updateTeam(design.id, { name: 'Product Design' })).toMatchObject({ name: 'Product Design', slug: 'product-design' });
    // Renaming a team must not strand workflows that already stored its old route.
    expect(store.humanAudience(task.id, ['@team:design'])).toEqual(['designer']);
    expect(store.humanAudience(task.id, ['@team:product-design'])).toEqual(['designer']);
    expect(() => store.deleteTeam(design.id)).toThrow(/still used/);

    const temporary = store.createTeam({ organizationId: organization.id, name: 'Temporary' });
    store.setTeamMembership(temporary.id, 'designer');
    store.deleteTeam(temporary.id);
    expect(store.getTeam(temporary.id)).toBeUndefined();
    expect(store.listTeamMemberships(temporary.id)).toEqual([]);

    const child = store.createTask({ projectId: project.id, title: 'Child', workflow: 'software-dev',
      workflowVersion: '1', params: { prompt: 'x' },
      createdBy: { kind: 'task-agent', taskId: task.id, role: 'do' } });
    expect(store.humanAudience(child.id, ['@creator'])).toEqual(['owner']);

    const automated = store.createTask({ projectId: project.id, title: 'Scheduled', workflow: 'software-dev',
      workflowVersion: '1', params: { prompt: 'x' } });
    expect(store.humanAudience(automated.id, ['@creator'])).toEqual(['owner']);
  });

  it('exports a complete redacted tenant and deletes it atomically', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Delete me', ownerUserId: 'owner' });
    const project = store.createProject('Product', {}, organization.id);
    const task = store.createTask({ projectId: project.id, title: 'Private task', workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'important customer data' } });
    store.createOrganizationInvitation({ organizationId: organization.id, email: 'new@example.com', invitedBy: 'owner' });
    store.setOrganizationIdentityPolicy({ organizationId: organization.id, oidcProviderId: 'enterprise' });
    store.setOrganizationExecutionPolicy(organization.id, { worldProvider: 'e2b', network: { unrestricted: true } });
    store.setSettings(`organization:${organization.id}`, 'software-dev', { confirm: { mode: 'auto' } });
    store.rotateScimToken(organization.id);
    store.registerWorld({ version: 2, id: task.id, kind: 'memory', provider: 'memory', generation: 1,
      runnerPoolId: 'local', environmentDigest: 'test', root: '/opaque', branch: 'task/test', base: 'main', meta: {} }, project.id);
    store.createRunnerPool({ id: 'doomed-pool', organizationId: organization.id, name: 'Doomed', provider: 'e2b',
      mode: 'managed', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
    store.createExecution({ id: 'doomed-exec', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, kind: 'terminal', label: 'Terminal',
      server: false, openUrls: [], state: 'running', heartbeatAt: 1, startedAt: 1 });
    store.recordUsage({ id: 'doomed-usage', organizationId: organization.id, projectId: project.id, taskId: task.id,
      worldId: task.id, provider: 'e2b', kind: 'world.active', quantity: 1, unit: 'second', costMicros: 5,
      startedAt: 1, endedAt: 2, metadata: {} });

    const exported = store.exportOrganization(organization.id) as any;
    expect(exported.organization.name).toBe('Delete me');
    expect(exported.tables.tasks[0].title).toBe('Private task');
    expect(exported.tables.organization_invitations[0].tokenHash).toBeUndefined();
    expect(exported.identityPolicy.scimTokenId).toBeUndefined();
    expect(exported.executionPolicy).toMatchObject({ worldProvider: 'e2b', network: { unrestricted: true } });
    expect(exported.tables.settings).toHaveLength(1);
    expect(exported.tables.world_instances[0].handle).toMatchObject({ provider: 'memory', generation: 1 });
    expect(exported.tables.world_instances[0].handle.meta).toBeUndefined();

    store.deleteOrganization(organization.id);
    expect(store.getOrganization(organization.id)).toBeUndefined();
    expect(store.getProject(project.id)).toBeUndefined();
    expect(store.getTask(task.id)).toBeUndefined();
    expect(store.db.prepare('SELECT COUNT(*) n FROM world_instances').get()).toMatchObject({ n: 0 });
    expect(store.kvGet(`organization-execution:${organization.id}`)).toBeUndefined();
    expect(store.getRunnerPool('doomed-pool')).toBeUndefined();
    expect(store.execution('doomed-exec')).toBeUndefined();
    expect(store.usageSummary(organization.id).events).toBe(0);
    expect(() => store.deleteOrganization('org_personal')).toThrow(/cannot be deleted/);
  });

  it('deletes every project-scoped durable record and revokes its credentials', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Lifecycle', ownerUserId: 'owner' });
    const project = store.createProject('Disposable', { worldProvider: 'e2b' }, organization.id);
    const task = store.createTask({ projectId: project.id, title: 'Delete all of me', workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'customer data' } });
    store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/workspace', branch: 'karmax/task', base: 'main', sealedProviderRef: 'opaque', meta: {} }, project.id);
    store.saveWorldCheckpoint({ id: 'checkpoint-1', worldId: task.id, generation: 1, projectId: project.id,
      runnerPoolId: 'pool-1', environmentDigest: 'image', repos: [],
      filesystemDelta: { objectKey: 'checkpoints/one', sha256: 'abc', bytes: 3 }, createdAt: 1 });
    store.createRunnerPool({ id: 'pool-1', organizationId: organization.id, name: 'Cloud', provider: 'e2b',
      mode: 'managed', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
    const lease = store.requestWorldLease({ runnerPoolId: 'pool-1', organizationId: organization.id,
      projectId: project.id, taskId: task.id, worldId: task.id });
    store.createExecution({ id: 'execution-1', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, kind: 'terminal', label: 'Shell', server: false,
      openUrls: [], runnerLeaseId: lease.id });
    store.appendExecutionFrame('execution-1', 'private output');
    store.createPreviewLease({ id: 'preview-1', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, port: 3000, public: false, provider: 'e2b',
      runnerLeaseId: lease.id, createdBy: 'owner', createdAt: 1, expiresAt: Date.now() + 60_000 });
    store.savePromotedArtifact({ id: 'artifact-1', organizationId: organization.id, projectId: project.id,
      taskId: task.id, objectKey: 'artifacts/one', sha256: 'def', bytes: 3, mediaType: 'text/plain',
      name: 'private.txt', createdAt: 1 });
    store.recordUsage({ organizationId: organization.id, projectId: project.id, taskId: task.id,
      worldId: task.id, provider: 'e2b', kind: 'world.active', quantity: 1, unit: 'second', costMicros: 2,
      startedAt: 1, endedAt: 2, metadata: { private: true } });
    store.grantAttachment('attachment-1', project.id);
    store.setSettings(project.id, 'software-dev', { secret: 'general' });
    store.setSettings(`quick:${project.id}`, 'software-dev', { secret: 'quick' });
    store.kvSet(`session:${task.id}:do`, 'session-secret');
    store.kvSet(`turnsession:${task.id}#1`, 'turn-secret');
    store.kvSet(`wfpin:${project.id}:software-dev`, '1.0.0');
    store.setPrincipalGrant('user:owner', `project:${project.id}`, { profileId: 'developer' });
    store.createCard({ id: 'card-1', provider: 'test', scope: 'project', scopeId: project.id,
      label: 'Project card', cap: 100, available: 100, createdAt: 1 });
    const tokenAuthority = new TokenAuthority(store);
    const token = tokenAuthority.mint({ taskId: task.id, profileId: 'do', principal: 'user:owner',
      organizationId: organization.id, projectId: project.id, ceiling: ['task:read'], grantorCaps: ['task:read'] }).token;

    expect(store.projectResources(project.id)).toMatchObject({
      objectKeys: expect.arrayContaining(['checkpoints/one', 'artifacts/one']),
      attachmentIds: ['attachment-1'], leases: [expect.objectContaining({ id: lease.id, provider: 'e2b' })],
    });
    store.deleteProject(project.id);

    expect(store.getProject(project.id)).toBeUndefined();
    expect(tokenAuthority.verify(token)).toBeUndefined();
    for (const table of ['tasks', 'task_lists', 'events', 'world_instances', 'world_checkpoints',
      'world_leases', 'promoted_artifacts', 'executions', 'execution_frames', 'preview_leases',
      'attachment_scopes', 'settings', 'cards', 'principal_grants'])
      expect(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toMatchObject({ n: 0 });
    expect(store.kvGet(`session:${task.id}:do`)).toBeUndefined();
    expect(store.kvGet(`turnsession:${task.id}#1`)).toBeUndefined();
    expect(store.kvGet(`wfpin:${project.id}:software-dev`)).toBeUndefined();
    expect(store.db.prepare('SELECT projectId, taskId, worldId, metadata FROM usage_events').get())
      .toMatchObject({ projectId: null, taskId: null, worldId: null, metadata: null });
  });
});

describe('DeliveryDispatcher error handling', () => {
  it('never leaks an unhandled rejection from its drain loop', async () => {
    // `drain()` CAN reject: claimDelivery() runs outside the per-item try (it is
    // the claim transaction itself) and rethrows after ROLLBACK. Both call sites
    // used a bare `void`, so a locked/corrupt database became an unhandled
    // rejection — a process-level failure for a retryable projection.
    const store = new Store(':memory:');
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
