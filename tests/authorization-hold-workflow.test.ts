import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TASK_QUEUE } from '../src/temporal/config.js';

/**
 * Task #716: an agent asked for a task it could not fully authorize, and it sat
 * as a draft. Now it is asked to run and it runs: the request goes out with the
 * task, nothing starts while it waits, and approval starts the real workflow
 * (wiki SPEC §8.2). A dependency it names is armed once approved.
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

  it('starts its workflow only once approved, without its creator asking again', async () => {
    const repo = await h.makeRepo('authorization-hold');
    const organization = await h.store.createOrganization({ name: 'Hold', ownerUserId: 'owner' });
    const project = await h.store.createProject('Hold', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
      organization.id);
    const authorization = await AuthorizationService.create(h.store);
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
    await h.store.setOrganizationMembership(organization.id, 'dev', 'member');
    await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
    const api = new KarmaxApi({ store: h.store, client: h.client, taskQueue: TASK_QUEUE, tokens: h.tokens, authorization,
      contentDir: h.contentDir, defaultAgentProvider: 'mock', bus: h.bus, worlds: h.worlds, broker: h.broker });
    const creator = await h.store.createTask({ projectId: project.id, title: 'Creator', workflow: 'software-dev',
      workflowVersion: '1.4.0', createdBy: { kind: 'user', userId: 'dev' }, params: { prompt: 'work' } });
    const held = [...await authorization.capabilities('user:dev', project.id, organization.id)];
    const agent = (await h.tokens.mint({ taskId: creator.id, profileId: 'do', role: 'do', principal: `task-agent:${creator.id}:do`,
      projectId: project.id, organizationId: organization.id, ceiling: held, grantorCaps: held })).token;
    const owner = (await h.tokens.mintPrincipal('user:owner',
      await authorization.capabilities('user:owner', project.id, organization.id), project.id, undefined, organization.id)).token;
    const ran = async (taskId: string) => (await h.store.eventsSince(taskId, 0)).some((event) => event.type === 'turn.prompt');

    const task = await api.createTask(agent, { projectId: project.id, workflow: 'just-do', title: 'Deploy',
      prompt: '@write deployed.txt :: yes', params: { 'agent:do': { provider: 'mock' } },
      authorization: { level: 'maintainer', scope: 'projects', projectIds: [project.id] }, holdForAuthorization: true,
      authorizationReason: 'It deploys.' });
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
});
