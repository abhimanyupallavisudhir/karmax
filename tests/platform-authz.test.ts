import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { KarmaxApi, CapabilityError, NotFoundError } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { WorldRegistry } from '../src/world/registry.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';

/**
 * Service-layer authorization scope, exercised directly against KarmaxApi (no
 * Temporal, no gateway).
 *
 * The class of bug covered here: a `require(token, tool)` call that omits the
 * `{ projectId, taskId }` scope. `TokenAuthority.check` can only enforce a
 * token's project/organization scope when it is GIVEN one to compare against —
 * with no scope the tenant guard is inert and a capability the caller legitimately
 * holds inside its own project silently applies to every project of every
 * organization on the installation.
 */
describe('KarmaxApi cross-project / cross-tenant scope', () => {
  let store: Store;
  let tokens: TokenAuthority;
  let api: KarmaxApi;
  let contentDir: string;
  /** Two projects in two different organizations. */
  let mine: string;
  let theirs: string;
  /** A token scoped to `mine` carrying the full task capability set. */
  let token: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tokens = new TokenAuthority();
    contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-authz-'));
    const acme = store.createOrganization({ name: 'Acme', ownerUserId: 'a' });
    const other = store.createOrganization({ name: 'Other', ownerUserId: 'b' });
    mine = store.createProject('Mine', {}, acme.id).id;
    theirs = store.createProject('Theirs', {}, other.id).id;
    api = new KarmaxApi({ store, client: {} as any, taskQueue: 'karmax', tokens, contentDir, worlds: new WorldRegistry() });
    // `task:*` is exactly what the built-in `developer` profile carries.
    token = tokens.mintPrincipal('user:a', ['task:*', 'queue:read'], mine, 60_000, acme.id).token;
  });
  afterEach(() => { fs.rmSync(contentDir, { recursive: true, force: true }); });

  const denied = async (fn: () => Promise<unknown>) => {
    await expect(fn()).rejects.toBeInstanceOf(CapabilityError);
  };

  /** The mechanism every case below depends on: an omitted scope is not a
   *  partial check, it is NO check. Pinning it here so the reason these
   *  `require` calls must pass `{ projectId }` cannot be lost. */
  it('passes a scoped token unconditionally when the check is given no scope', () => {
    expect(tokens.check(token, 'task:edit').ok).toBe(true);
    expect(tokens.check(token, 'task:edit', { projectId: theirs }).ok).toBe(false);
  });

  /**
   * `/api/tags/:id` and `/api/views/:id` carry no project in the path, so
   * `updateTag`/`deleteTag`/`updateView`/`reorderView`/`deleteView` used to call
   * `require` with NO scope at all — any `task:edit` token could rename or delete
   * another tenant's tag or saved view, and `describe_platform` advertises the
   * routes.
   */
  it('refuses to mutate another project’s tag through its bare id', async () => {
    const foreign = store.createTag({ projectId: theirs, name: 'security' });
    const own = store.createTag({ projectId: mine, name: 'bug' });

    await denied(() => api.updateTag(token, foreign.id, { name: 'pwned' }));
    await denied(() => api.deleteTag(token, foreign.id));
    await denied(() => api.createTag(token, { projectId: theirs, name: 'smuggled' }));

    expect(store.getTag(foreign.id)?.name).toBe('security');
    expect(store.listTags(theirs)).toHaveLength(1);
    // The same capability still works inside the token's own project.
    await expect(api.updateTag(token, own.id, { name: 'defect' })).resolves.toMatchObject({ name: 'defect' });
  });

  it('refuses to mutate another project’s saved view through its bare id', async () => {
    const foreign = store.createView({ projectId: theirs, name: 'Theirs', query: {} as any });
    const own = store.createView({ projectId: mine, name: 'Mine', query: {} as any });

    await denied(() => api.updateView(token, foreign.id, { name: 'pwned' }));
    await denied(() => api.reorderView(token, foreign.id, 0));
    await denied(() => api.deleteView(token, foreign.id));
    await denied(() => api.createView(token, { projectId: theirs, name: 'smuggled', query: {} as any }));
    await denied(() => api.listViews(token, theirs));

    expect(store.getView(foreign.id)?.name).toBe('Theirs');
    await expect(api.updateView(token, own.id, { name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed' });
  });

  /** The task-shaped siblings that also omitted their scope. */
  it('refuses task lifecycle operations against another project’s task', async () => {
    const foreign = store.createTask({ projectId: theirs, title: 'Theirs', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x', triggers: [{ kind: 'schedule', cron: '0 3 * * *' }], triggerState: 'armed' } as any });

    await denied(() => api.setTaskTags(token, foreign.id, []));
    await denied(() => api.cancelTrigger(token, foreign.id));
    await denied(() => api.updateArmedParams(token, foreign.id, { prompt: 'pwned' }));
    await denied(() => api.spawnRun(token, foreign.id));
    await denied(() => api.addAttempt(token, foreign.id));
    await denied(() => api.fireTriggeredTask(token, foreign.id, 'self'));

    // Nothing was mutated on the way to the refusal.
    expect(store.getTask(foreign.id)?.params.prompt).toBe('x');
    expect(store.getTask(foreign.id)?.params.triggerState).toBe('armed');
  });

  /**
   * `resumeFrom.taskId` makes the activity runtime load ANOTHER task's provider
   * session and splice its transcript into the new agent's messages. `createTask`
   * only ever checked `create_task` on the *new* task's project, so a token with
   * `task:create` in its own project could replay any conversation from any other
   * project or organization into an agent it controls.
   */
  it('authorizes agent resumeFrom against the SOURCE task’s project', async () => {
    const foreign = store.createTask({ projectId: theirs, title: 'Secret work', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'confidential' } as any });
    const own = store.createTask({ projectId: mine, title: 'Mine', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x', draft: true } as any });

    await denied(() => api.createTask(token, { projectId: mine, title: 'Exfiltrate', prompt: 'go',
      params: { 'agent:do': { resumeFrom: { taskId: foreign.id, role: 'do' } } } }));
    await denied(() => api.updateArmedParams(token, own.id,
      { prompt: 'go', 'agent:do': { resumeFrom: { taskId: foreign.id, role: 'do' } } }));

    // Nothing was created before the refusal.
    expect(store.listTasks(mine).map((t) => t.title)).toEqual(['Mine']);
    // A resume pointer at an unknown task is a 404, not a silent pass-through.
    await expect(api.createTask(token, { projectId: mine, title: 'Ghost', prompt: 'go',
      params: { 'agent:do': { resumeFrom: { taskId: 'task_missing' } } } })).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * The host agent queue is a queue surface. It asked for `get_task` while the
   * gateway route (after the fix) asks for `queue:read`/`queue:write`, and
   * `setAgentCapacity` took no token and performed no check at all.
   */
  it('binds the agent queue to the queue capabilities and checks capacity writes', async () => {
    const queueless = tokens.mintPrincipal('user:c', ['task:*'], mine, 60_000).token;
    await denied(() => api.agentQueueView(queueless));
    // `queue:read` alone is enough — it does not need task capabilities.
    const reader = tokens.mintPrincipal('user:d', ['queue:read'], mine, 60_000).token;
    await expect(api.agentQueueView(reader)).resolves.toMatchObject({ capacity: 3 });

    await denied(() => api.setAgentCapacity(reader, 4));
  });

  /** A merge-queue domain spans projects; an unscoped read leaked their ids. */
  it('filters the merge queue to the token’s project when none is named', async () => {
    const ours = store.createTask({ projectId: mine, title: 'Ours', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    const foreign = store.createTask({ projectId: theirs, title: 'Theirs', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    const scoped = new KarmaxApi({
      store, tokens, taskQueue: 'karmax', contentDir, worlds: new WorldRegistry(),
      client: { workflow: { getHandle: () => ({ query: async () => ({ queue: [ours.id, foreign.id], current: foreign.id }) }) } } as any,
    });
    // No projectId argument: the token's own project is the default.
    await expect(scoped.queueView(token, 'domain')).resolves.toEqual({ queue: [ours.id] });
  });

  /**
   * A multi-repo task takes ONE merge slot PER REPO. The guard used to compare
   * the requested domain against `state.mergeDomain`, which is only the FIRST of
   * them — so reordering the task's own second repo domain was rejected outright.
   * The complete `mergeDomains` list is now authoritative when the view carries
   * it, and the known-partial singular no longer acts as an exclusive whitelist.
   */
  it('lets a multi-repo task be reordered in any domain it actually holds', async () => {
    const signals: string[] = [];
    const queued = new KarmaxApi({
      store, tokens, taskQueue: 'karmax', contentDir, worlds: new WorldRegistry(),
      client: { workflow: { signalWithStart: async (_wf: unknown, o: any) => { signals.push(o.args[0].domain); } } } as any,
    });
    const queueToken = tokens.mintPrincipal('user:e', ['task:*', 'queue:write'], mine, 60_000).token;
    const task = store.createTask({ projectId: mine, title: 'Two repos', workflow: 'software-dev', workflowVersion: '1.9.0', params: { prompt: 'x' } as any });
    store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'merge', status: 'waiting',
      messages: [], transcripts: [], actions: [], updatedAt: 1,
      state: { mergeDomain: 'app:main', mergeDomains: ['app:main', 'wiki:main'] },
    } as any);

    await queued.reorderQueue(queueToken, 'app:main', task.id);
    await queued.reorderQueue(queueToken, 'wiki:main', task.id); // the second repo — used to throw
    expect(signals).toEqual(['app:main', 'wiki:main']);

    await expect(queued.reorderQueue(queueToken, 'unrelated:main', task.id))
      .rejects.toThrow(/not in that merge queue domain/);
  });

  /**
   * `create_task` with tags/priority applied them as follow-up `setTaskPriority`
   * / `tagTask` calls, both of which need `task:edit`. The bundled Do role holds
   * `task:read` and NOT `task:edit` (`src/contrib/manifests.ts`), so the routine
   * case — an agent creating a tagged sub-task — created the task and *then*
   * threw a permission error, leaving a half-built task with its metadata
   * silently missing. Creating a task with its metadata is one act of creation.
   */
  it('creates a tagged, prioritised task with only task:create (no task:edit)', async () => {
    // Exactly the Do role's task capabilities: read and create, no edit.
    const organizationId = store.getProject(mine)!.organizationId;
    const doToken = tokens.mintPrincipal('task:t1', ['task:read', 'task:create'], mine, 60_000, organizationId).token;
    const task = await api.createTask(doToken, {
      projectId: mine, title: 'Tagged', prompt: 'x', draft: true,
      priority: 3, tags: ['bug', 'search'],
    });

    expect(store.getTask(task.id)!.params.priority).toBe(3);
    const byId = new Map(store.listTags(mine).map((t) => [t.id, t]));
    expect(store.tagsFor(task.id).map((id) => byId.get(id)!.name).sort()).toEqual(['bug', 'search']);
  });

  it('pins the active personal GitHub account when a human creates a task', async () => {
    let active = '42';
    const accountApi = new KarmaxApi({ store, client: {} as any, taskQueue: 'karmax', tokens, contentDir,
      worlds: new WorldRegistry(), githubApp: { activeUserAccountId: () => active } as any });
    const first = await accountApi.createTask(token, { projectId: mine, prompt: 'first', draft: true });
    active = '99';
    const second = await accountApi.createTask(token, { projectId: mine, prompt: 'second', draft: true });
    expect(store.getTask(first.id)?.params._githubAccountId).toBe('42');
    expect(store.getTask(second.id)?.params._githubAccountId).toBe('99');
  });

  it('backfills verified delegation when a human elevates an existing task and never does so for automation', async () => {
    const organizationId = store.getProject(mine)!.organizationId!;
    let active = '99';
    const liveUpdates: any[] = [];
    const authorization = new AuthorizationService(store);
    authorization.grant('root', { principalId: 'user:a', scopeKey: projectScope(mine), profileId: 'maintainer' });
    const delegatedApi = new KarmaxApi({ store,
      client: { workflow: { getHandle: () => ({ executeUpdate: async (name: string, input: unknown) => {
        liveUpdates.push({ name, input }); return { applied: true };
      } }) } } as any,
      taskQueue: 'karmax', tokens, contentDir,
      worlds: new WorldRegistry(), authorization,
      githubApp: { activeUserAccountId: () => active } as any });
    const human = tokens.mintPrincipal('user:a', ['*'], mine, 60_000, organizationId);
    const legacy = store.createTask({
      projectId: mine, title: 'Existing user task', workflow: 'software-dev', workflowVersion: '1.0.0',
      createdBy: { kind: 'user', userId: 'a' },
      params: { prompt: 'create a repository', _githubAccountId: '42',
        _authorization: { profileId: 'developer', capabilities: ['task:*'], principal: 'user:a' } } as any,
    });

    const elevated = await delegatedApi.setTaskAuthorization(human.token, legacy.id, 'maintainer');
    const elevatedAuthorization = elevated.params._authorization as any;
    expect(liveUpdates).toEqual([expect.objectContaining({ name: 'updateAuthorization',
      input: { args: [expect.objectContaining({ grant: expect.arrayContaining(['repository:write']) })] } })]);
    expect(elevatedAuthorization.capabilities).toContain('repository:write');
    expect(elevatedAuthorization.delegationId).toMatch(/^dlg_/);
    // The user has since selected account 99, but this task remains bound to the
    // authority-owned account 42 that was pinned when its intent was created.
    expect(elevated.params._githubAccountId).toBe('42');
    const resumed = tokens.mint({
      taskId: legacy.id, profileId: 'do', role: 'do', principal: 'user:a',
      projectId: mine, organizationId,
      ceiling: ['repository:write'], grantorCaps: elevatedAuthorization.capabilities,
      delegationId: elevatedAuthorization.delegationId,
    });
    expect(resumed.record).toMatchObject({
      caps: ['repository:write'],
      humanSubject: { kind: 'user', userId: 'a', presence: 'delegated',
        externalIdentities: { githubAccountId: '42' } },
      externalIdentities: { githubAccountId: '42' },
    });

    active = '100';
    const autonomousTask = store.createTask({
      projectId: mine, title: 'Autonomous task', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'create a repository', draft: true,
        _authorization: { profileId: 'developer', capabilities: ['task:*'], principal: 'system:scheduler' } } as any,
    });
    const autonomous = tokens.mintPrincipal('system:scheduler', ['*'], mine, 60_000, organizationId);
    const autonomousUpdate = await delegatedApi.setTaskAuthorization(autonomous.token, autonomousTask.id, 'maintainer');
    const autonomousAuthorization = autonomousUpdate.params._authorization as any;
    expect(autonomousAuthorization.capabilities).toContain('repository:write');
    expect(autonomousAuthorization.delegationId).toBeUndefined();
    expect(autonomousUpdate.params._githubAccountId).toBeUndefined();
    const autonomousRetry = tokens.mint({
      taskId: autonomousTask.id, profileId: 'do', role: 'do', principal: 'system:scheduler',
      projectId: mine, organizationId,
      ceiling: ['repository:write'], grantorCaps: autonomousAuthorization.capabilities,
    });
    expect(autonomousRetry.record.caps).toEqual(['repository:write']);
    expect(autonomousRetry.record.humanSubject).toBeUndefined();
  });

  it('uses durable Administrator scope beyond a project-bound browser token', async () => {
    const organizationId = store.getProject(mine)!.organizationId!;
    const authorization = new AuthorizationService(store);
    authorization.grant('root', {
      principalId: 'user:a', scopeKey: organizationScope(organizationId), profileId: 'administrator',
    });
    const delegatedApi = new KarmaxApi({
      store, client: {} as any, taskQueue: 'karmax', tokens, contentDir,
      worlds: new WorldRegistry(), authorization,
    });
    // Browser requests are deliberately pinned to the project in the current
    // route even when the signed-in human has a durable organization grant.
    const human = tokens.mintPrincipal('user:a', ['*'], mine, 60_000, organizationId);
    const draft = await delegatedApi.createTask(human.token, {
      projectId: mine, title: 'Cross-project investigation', prompt: 'inspect a sibling project', draft: true,
      authorization: { level: 'developer', scope: 'projects', projectIds: [mine] },
    });
    const projectAuthorization = draft.params._authorization as any;

    const elevated = await delegatedApi.setTaskAuthorization(human.token, draft.id, {
      level: 'administrator', scope: 'organization',
    });
    const administratorAuthorization = elevated.params._authorization as any;

    expect(administratorAuthorization).toMatchObject({
      level: 'administrator', scope: 'organization', organizationId,
    });
    expect(administratorAuthorization.delegationId).toMatch(/^dlg_/);
    expect(administratorAuthorization.delegationId).not.toBe(projectAuthorization.delegationId);
    expect(() => tokens.mint({
      taskId: draft.id, profileId: 'do', role: 'do', principal: 'user:a', organizationId,
      ceiling: ['task:read'], grantorCaps: administratorAuthorization.capabilities,
      delegationId: administratorAuthorization.delegationId,
    })).not.toThrow();

    const direct = await delegatedApi.createTask(human.token, {
      projectId: mine, title: 'Direct Administrator task', prompt: 'inspect a sibling project', draft: true,
      authorization: { level: 'administrator', scope: 'organization' },
    });
    const directAuthorization = direct.params._authorization as any;
    expect(directAuthorization.delegationId).toMatch(/^dlg_/);
    expect(() => tokens.mint({
      taskId: direct.id, profileId: 'do', role: 'do', principal: 'user:a', organizationId,
      ceiling: ['task:read'], grantorCaps: directAuthorization.capabilities,
      delegationId: directAuthorization.delegationId,
    })).not.toThrow();
  });

  it('stores explicit multi-project and organization authorization on tasks and refuses over-granting', async () => {
    const organization = store.getProject(mine)!.organizationId!;
    const sibling = store.createProject('Sibling', {}, organization).id;
    const authorization = new AuthorizationService(store);
    authorization.grant('root', { principalId: 'user:a', scopeKey: 'global', profileId: 'god' });
    const globalToken = tokens.mintPrincipal('user:a', ['*']).token;
    const scopedApi = new KarmaxApi({
      store, tokens, authorization, contentDir, worlds: new WorldRegistry(), client: {} as any, taskQueue: 'karmax',
    });

    const projects = await scopedApi.createTask(globalToken, {
      projectId: mine, title: 'Across two projects', prompt: 'x', draft: true,
      authorization: { level: 'developer', scope: 'projects', projectIds: [mine, sibling] },
    });
    expect(projects.params._authorization).toMatchObject({
      level: 'developer', scope: 'projects', projectIds: [mine, sibling], attenuated: false,
    });

    const admin = await scopedApi.createTask(globalToken, {
      projectId: mine, title: 'Organization administrator', prompt: 'x', draft: true,
      authorization: { level: 'administrator', scope: 'organization' },
    });
    expect(admin.params._authorization).toMatchObject({
      level: 'administrator', scope: 'organization', organizationId: organization, attenuated: false,
    });

    authorization.revoke('root', 'user:a', 'global');
    authorization.grant('root', { principalId: 'user:a', scopeKey: projectScope(mine), profileId: 'developer' });
    await expect(scopedApi.createTask(token, {
      projectId: mine, title: 'Over-grant', prompt: 'x', draft: true,
      authorization: { level: 'developer', scope: 'organization' },
    })).rejects.toThrow(/cannot grant/i);
  });

  /** An omitted scope is NO scope (see the first test): a missing task must be
   *  refused outright, not silently no-op through an inert tenant guard. */
  it('refuses a priority write against a task that does not exist', async () => {
    await expect(api.setTaskPriority(token, 'task_missing', 2)).rejects.toBeInstanceOf(NotFoundError);
  });
});
