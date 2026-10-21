import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TASK_QUEUE } from '../src/temporal/config.js';

/**
 * Task #716: an agent asked for a task it could not fully authorize, and it sat
 * as a draft. Now it is asked to run and it runs: the request goes out with the
 * task, nothing starts while it waits, and approval starts the real workflow
 * (wiki SPEC §8.2). A denial is told at once to the agent that created it.
 */
describe('a task waiting for approval', () => {
  let h: Harness;
  const previous = { floor: process.env.KARMAX_AGENT_MIN_FREE_MB, load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR };

  beforeAll(async () => {
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    h = await bootHarness('mock');
  }, 120_000);

  afterAll(async () => {
    await h?.stop();
    for (const [name, value] of [['KARMAX_AGENT_MIN_FREE_MB', previous.floor], ['KARMAX_AGENT_MAX_LOAD_FACTOR', previous.load]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  /** A project with a developer and its owner, an API that enforces authorization
   * on the harness's worker, and tokens for either person or for the agent of a
   * task the developer created. */
  async function fixture(name: string) {
    const repo = await h.makeRepo(name);
    const organization = await h.store.createOrganization({ name, ownerUserId: 'owner' });
    const project = await h.store.createProject(name, { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
      organization.id);
    const authorization = await AuthorizationService.create(h.store);
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
    await h.store.setOrganizationMembership(organization.id, 'dev', 'member');
    await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
    const api = new KarmaxApi({ store: h.store, client: h.client, taskQueue: TASK_QUEUE, tokens: h.tokens, authorization,
      contentDir: h.contentDir, defaultAgentProvider: 'mock', bus: h.bus, worlds: h.worlds, broker: h.broker });
    const person = async (userId: string) => (await h.tokens.mintPrincipal(`user:${userId}`,
      await authorization.capabilities(`user:${userId}`, project.id, organization.id), project.id, undefined, organization.id)).token;
    const agentOf = async (creatorId: string) => {
      const held = [...await authorization.capabilities('user:dev', project.id, organization.id)];
      return (await h.tokens.mint({ taskId: creatorId, profileId: 'do', role: 'do', principal: `task-agent:${creatorId}:do`,
        projectId: project.id, organizationId: organization.id, ceiling: held, grantorCaps: held })).token;
    };
    const maintainer = { level: 'maintainer', scope: 'projects' as const, projectIds: [project.id] };
    return { organization, project, api, person, agentOf, maintainer };
  }
  const turns = async (taskId: string) => (await h.store.eventsSince(taskId, 0)).filter((event) => event.type === 'turn.prompt').length;

  it('starts its workflow only once approved, without its creator asking again', async () => {
    const { organization, project, api, person, agentOf, maintainer } = await fixture('authorization-hold');
    const creator = await h.store.createTask({ projectId: project.id, title: 'Creator', workflow: 'software-dev',
      workflowVersion: '1.4.0', createdBy: { kind: 'user', userId: 'dev' }, params: { prompt: 'work' } });
    const agent = await agentOf(creator.id);
    const owner = await person('owner');
    const ran = async (taskId: string) => (await turns(taskId)) > 0;

    const task = await api.createTask(agent, { projectId: project.id, workflow: 'just-do', title: 'Deploy',
      prompt: '@write deployed.txt :: yes', params: { 'agent:do': { provider: 'mock' } },
      authorization: maintainer, holdForAuthorization: true, authorizationReason: 'It deploys.' });
    expect(task.authorizationRequest).toBeDefined();
    expect(task.num).toEqual(expect.any(Number));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await ran(task.id)).toBe(false);
    expect((await h.store.getTask(task.id))!.lastView).toBeUndefined();

    await api.resolveAuthorizationRequest(owner, { organizationId: organization.id, requestId: task.authorizationRequest!.id, action: 'approve' });
    await vi.waitFor(async () => expect(await ran(task.id)).toBe(true), { timeout: 60_000, interval: 250 });
    // It did the work it waited to be allowed to do, and asks for Review.
    await vi.waitFor(async () => expect((await h.store.getTask(task.id))!.lastView).toMatchObject({ stage: 'review',
      reviewInfo: { summary: 'wrote deployed.txt' } }), { timeout: 60_000, interval: 250 });
    expect((await h.store.getTask(task.id))!.params).toMatchObject({ draft: false, _awaitingApproval: null,
      _authorization: { level: 'maintainer', profileAttenuated: false } });
  }, 180_000);

  it('tells the running agent that created it when it is denied, and wakes it', async () => {
    const { organization, project, api, person, agentOf, maintainer } = await fixture('authorization-denied');
    const creator = await api.createTask(await person('dev'), { projectId: project.id, workflow: 'software-dev', title: 'Creator',
      prompt: '@pause 60', params: { 'agent:do': { provider: 'mock' } } });
    await vi.waitFor(async () => expect((await h.store.getTask(creator.id))!.lastView?.waitingFor?.kind).toBe('timer'),
      { timeout: 60_000, interval: 250 });
    const before = await turns(creator.id);

    const task = await api.createTask(await agentOf(creator.id), { projectId: project.id, workflow: 'just-do', title: 'Deploy',
      prompt: 'deploy', authorization: maintainer, holdForAuthorization: true });
    await api.resolveAuthorizationRequest(await person('owner'), { organizationId: organization.id,
      requestId: task.authorizationRequest!.id, action: 'deny' });

    await vi.waitFor(async () => expect(await turns(creator.id)).toBeGreaterThan(before), { timeout: 60_000, interval: 250 });
    const told = (await h.store.getTask(creator.id))!.lastView?.messages?.find((message) => message.author === `task:${task.id}`);
    expect(told).toMatchObject({ authorLabel: `Task #${task.num}` });
    expect(told!.text).toMatch(/denied the maintainer authorization .* did not start/);
    expect((await h.store.getTask(task.id))!.params).toMatchObject({ draft: true, _awaitingApproval: null });
    expect(await turns(task.id)).toBe(0);
  }, 180_000);
});
