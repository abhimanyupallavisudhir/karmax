import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { continuesInNewTask } from '../src/domain/forks.js';
import type { AuthorizationSelection } from '../src/domain/types.js';

/**
 * Once a person confirmed a task's proposal it lands exactly as approved, and
 * talking to its agent carries the work on in a new task that forks the agent
 * (wiki features/continue-after-confirm) instead of pulling the proposal back
 * to Do or being dropped when it lands.
 */
async function fixture() {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('owner'));
  const project = (await store.createProject('Continue'));
  const authorization = (await AuthorizationService.create(store));
  (await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' }));
  const tokens = new TokenAuthority(store);
  const tokenFor = async (principal: string, extra = ['use-credential:item:cred_safe']) => (await tokens.mintPrincipal(
    principal, [...(await authorization.capabilities('user:owner', project.id, 'org_personal')), ...extra],
    project.id, undefined, 'org_personal',
  )).token;
  const signals: unknown[][] = [];
  const started: string[] = [];
  const client = { workflow: {
    getHandle: () => ({ signal: async (...args: unknown[]) => { signals.push(args); }, executeUpdate: async () => undefined }),
    start: async (_type: string, options: { workflowId: string }) => { started.push(options.workflowId); return {}; },
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const maintainer: AuthorizationSelection = { level: 'maintainer', scope: 'projects', projectIds: [project.id] };
  const grant = await authorization.taskGrant('user:owner', project.id, maintainer);
  const source = (await store.createTask({
    projectId: project.id, title: 'Source', workflow: 'software-dev', workflowVersion: '1.30.0',
    createdBy: { kind: 'user', userId: 'owner' },
    params: { prompt: 'first piece', target: 'release', computer: { cpu: 4, memoryMb: 8192 },
      'agent:do': { provider: 'mock', model: 'm1' }, 'agent:agent-1': { provider: 'mock' },
      confirm: { layers: [{ kind: 'human', audience: ['@creator'] }] },
      _authorization: { ...grant, capabilities: [...grant.capabilities, 'use-credential:item:cred_safe'], principal: 'user:owner' } },
  }));
  (await store.kvSet(`session:${source.id}:do`, 'source-session'));
  const landed = { taskId: source.id, title: 'Source', workflow: 'software-dev', stage: 'done', status: 'done',
    branch: `tavya/${source.id}`, targetBranch: 'release', messages: [{ id: 'm0', role: 'user', text: 'first piece', ts: 1 }],
    actions: [], state: {}, updatedAt: 2,
    participants: [{ key: 'do', label: 'Agent', role: 'do', state: 'idle', messages: 1 },
      { key: 'agent-1', label: 'Agent 1', role: 'agent', state: 'idle', messages: 0 }] } as any;
  return { store, project, api, tokenFor, source, signals, started, landed };
}

describe('continue after Confirm', () => {
  it('applies to a confirmed proposal landing on its own, or landed', () => {
    const task = { workflow: 'software-dev' };
    const merge = (over: Record<string, unknown> = {}) => ({ stage: 'merge', status: 'waiting', ...over });
    expect(continuesInNewTask(task, merge({ waitingFor: { kind: 'github' } }))).toBe(true);
    expect(continuesInNewTask(task, merge({ status: 'active' }))).toBe(true);
    expect(continuesInNewTask(task, { stage: 'done', status: 'done' })).toBe(true);
    // Landing waits on people: a message is about this proposal (a repair).
    expect(continuesInNewTask(task, merge({ waitingFor: { kind: 'human' } }))).toBe(false);
    expect(continuesInNewTask(task, merge({ status: 'blocked' }))).toBe(false);
    expect(continuesInNewTask(task, merge({ status: 'failed' }))).toBe(false);
    // Not confirmed yet, or not finished on its own.
    for (const stage of ['do', 'pr', 'review', 'escalated']) expect(continuesInNewTask(task, { stage, status: 'waiting' })).toBe(false);
    expect(continuesInNewTask(task, { stage: 'done', status: 'done', state: { manuallyDoneFrom: 'review' } })).toBe(false);
    expect(continuesInNewTask(task, { stage: 'cancelled', status: 'cancelled' })).toBe(false);
    // A sub-task's work belongs to its parent; a command task has no agent; other workflows have no fork.
    expect(continuesInNewTask({ ...task, parentTaskId: 'task_parent' }, { stage: 'done', status: 'done' })).toBe(false);
    expect(continuesInNewTask({ ...task, params: { command: 'make' } }, { stage: 'done', status: 'done' })).toBe(false);
    expect(continuesInNewTask({ workflow: 'merge-only' }, { stage: 'done', status: 'done' })).toBe(false);
    expect(continuesInNewTask(task, undefined)).toBe(false);
  });

  it('a person’s message to a landed task’s agent starts a task that forks it, with the same settings and grants', async () => {
    const f = await fixture();
    await f.store.saveView(f.source.id, f.landed);
    const owner = await f.tokenFor('user:owner');
    // The page offers it.
    const view = await f.api.getTaskView(owner, f.source.id);
    expect(view?.actions).toContainEqual(expect.objectContaining({ name: 'followUp', label: 'Continue' }));

    const posted = await f.api.postTaskMessage(owner, f.source.id, { text: 'Now the next piece', to: ['agent:do'] });
    expect(posted.message).toBeUndefined();
    const next = (await f.store.getTask(posted.continuedIn!.id))!;
    expect(posted.continuedIn).toEqual({ id: next.id, num: next.num, title: 'Now the next piece' });
    expect(f.started).toEqual([next.id]);
    expect(f.signals).toEqual([]);
    expect(next.params).toMatchObject({
      prompt: 'Now the next piece', target: 'release', base: 'release', computer: { cpu: 4, memoryMb: 8192 },
      'agent:do': { provider: 'mock', model: 'm1', resumeFrom: { taskId: f.source.id, role: 'do' } },
      confirm: { layers: [{ kind: 'human', audience: ['@creator'] }] },
    });
    // Agents called in with @ were the source's; the continuation starts with its own agent.
    expect(next.params['agent:agent-1']).toBeUndefined();
    expect(next.params._authorization).toMatchObject({ level: 'maintainer' });
    expect((next.params._authorization as { capabilities: string[] }).capabilities).toContain('use-credential:item:cred_safe');
    // It is listed among the source's forks.
    expect((await f.api.getTaskView(owner, f.source.id))?.forkSummaries?.map((fork) => fork.id)).toEqual([next.id]);
    // The legacy single-agent route continues too.
    const legacy = await f.api.messageAgent(owner, f.source.id, 'And one more', 'do');
    expect(legacy.message).toBeUndefined();
    expect(legacy.continuedIn?.title).toBe('And one more');
    // Someone who cannot grant what the agent had is refused, not given less.
    await expect(f.api.postTaskMessage(await f.tokenFor('user:owner', []), f.source.id, { text: 'More' }))
      .rejects.toThrow(/cannot grant/);
    expect(f.started).toHaveLength(2);
    await f.store.close();
  });

  // andhbhakt.com#5 (2026-10-17): the source was archived when it finished, its
  // continuation copied `archived` and started out archived, and so never
  // showed in its creator's default list while it waited on them.
  it('a continuation starts out unarchived, though its finished source was archived', async () => {
    const f = await fixture();
    await f.store.saveView(f.source.id, f.landed);
    expect((await f.store.getTask(f.source.id))?.params.archived).toBe(true);
    const owner = await f.tokenFor('user:owner');
    const posted = await f.api.postTaskMessage(owner, f.source.id, { text: 'Now the next piece' });
    const next = (await f.store.getTask(posted.continuedIn!.id))!;
    expect(next.params.archived).toBeUndefined();
    // Nor can any caller create a task that starts out archived.
    const created = await f.api.createTask(owner, { projectId: f.project.id, workflow: 'software-dev',
      params: { prompt: 'x', archived: true } });
    expect((await f.store.getTask(created.id))?.params.archived).toBeUndefined();
    await f.store.close();
  });

  // dharma-artha-maxxer, funding-analysis#1 (2026-10-26): a task keeps the
  // payment defaults it started with. A card was added to the organization
  // since, so the copied policy no longer matched the defaults, and Continue
  // asked an Administrator, who cannot move money, for payment:write.
  it('a continuation spends under the project’s current payment defaults, unless a payments manager continues it', async () => {
    const f = await fixture();
    await f.store.updateTaskParams(f.source.id, { ...f.source.params, paymentPolicy: { cardIds: [], budget: 0, currency: 'usd' } });
    await f.store.saveView(f.source.id, f.landed);
    await f.store.createCard({ id: 'card-1', provider: 'test', scope: 'organization', scopeId: 'org_personal',
      label: 'Card', cap: 10_000, available: 10_000, currency: 'usd', createdAt: Date.now() });
    const defaults = { cardIds: ['card-1'], budget: 0, currency: 'usd' };

    const member = await f.tokenFor('user:owner');
    const continued = await f.api.postTaskMessage(member, f.source.id, { text: 'Now the next piece' });
    expect((await f.store.getTask(continued.continuedIn!.id))?.params.paymentPolicy).toEqual(defaults);

    // Someone who may set budgets keeps the one the source ran under.
    const manager = await f.tokenFor('user:owner', ['use-credential:item:cred_safe', 'payment:write']);
    const kept = await f.api.postTaskMessage(manager, f.source.id, { text: 'And the one after' });
    expect((await f.store.getTask(kept.continuedIn!.id))?.params.paymentPolicy).toEqual({ cardIds: [], budget: 0, currency: 'usd' });
    await f.store.close();
  });

  it('while the approved proposal lands, the continuation starts from its unlanded branch', async () => {
    const f = await fixture();
    await f.store.saveView(f.source.id, { ...f.landed, stage: 'merge', status: 'waiting', waitingFor: { kind: 'github', detail: 'CI' } });
    const posted = await f.api.postTaskMessage(await f.tokenFor('user:owner'), f.source.id, { text: 'Meanwhile, the next piece' });
    const next = (await f.store.getTask(posted.continuedIn!.id))!;
    expect(next.params.base).toBe(`tavya/${f.source.id}`);
    expect(next.params._forkWorld).toMatchObject({ taskId: f.source.id, unpublished: true });
    expect(f.signals).toEqual([]);
    await f.store.close();
  });

  it('leaves everything else as it was: other agents, people waits, and events the platform delivers', async () => {
    const f = await fixture();
    const owner = await f.tokenFor('user:owner');
    // Landing waits on a person: the message goes to the agent, as that wait says.
    await f.store.saveView(f.source.id, { ...f.landed, stage: 'merge', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'], detail: 'Send guidance to the Do agent.' }, actions: [] });
    expect((await f.api.getTaskView(owner, f.source.id))?.actions.some((action) => action.label === 'Continue')).toBe(false);
    expect((await f.api.postTaskMessage(owner, f.source.id, { text: 'Fix the lockfile' })).continuedIn).toBeUndefined();
    expect(f.signals).toHaveLength(1);
    // While it lands: a message only for another agent, and a platform event, are not continuations.
    await f.store.saveView(f.source.id, { ...f.landed, stage: 'merge', status: 'waiting', waitingFor: { kind: 'github' } });
    expect((await f.api.postTaskMessage(owner, f.source.id, { text: 'Look', to: ['agent:agent-1'] })).continuedIn).toBeUndefined();
    const system = await f.tokenFor('system:triggers');
    expect((await f.api.postTaskMessage(system, f.source.id, { text: 'An event' })).continuedIn).toBeUndefined();
    expect(f.started).toEqual([]);
    await expect(f.api.continueTask(owner, f.source.id, { text: '   ' })).rejects.toThrow(/needs text/);
    await f.store.saveView(f.source.id, { ...f.landed, stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } });
    await expect(f.api.continueTask(owner, f.source.id, { text: 'go' })).rejects.toThrow(/confirmed/);
    await f.store.close();
  });
});
