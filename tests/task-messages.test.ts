import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Harness } from './helpers/harness.js';
import { bootPipelineHarness, pipelineGates, stopPipelineHarness, view } from './helpers/pipeline-harness.js';

/**
 * The conversation API people and agents share (software-dev 1.27): a message
 * names its recipients — agents of the task are called, people are notified —
 * and an agent's `notify` and a person's follow-up are the same operation.
 * Escalating a request the task already waits on redirects it.
 */
describe('task messages, mentions, notify and escalation (real Temporal + git, mock agent)', () => {
  let h: Harness;
  const gates = pipelineGates();
  let human: string;
  let organizationId: string;
  beforeAll(async () => {
    h = await bootPipelineHarness(gates);
    human = (await h.tokens.mintPrincipal('user:a', ['*'])).token;
    organizationId = (await h.store.listOrganizations()).find((o) => o.kind === 'personal')?.id ?? 'org_personal';
    await h.store.setOrganizationMembership(organizationId, 'b', 'member');
  }, 60_000);
  afterAll(() => stopPipelineHarness(h, gates));

  const project = async (name: string) => h.store.createProject(name, {
    repos: [await h.makeRepo(name)], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false,
  });
  const inbox = async (userId: string, taskId: string) => (await h.store.listInbox(userId, organizationId))
    .filter((row) => row.taskId === taskId).map((row) => ({ kind: row.kind, actionable: row.actionable }));

  it('calls a new agent into a task at Review, which answers its caller there', async () => {
    const p = await project('messages-call');
    const task = await h.api.createTask(human, { projectId: p.id, workflow: 'software-dev', prompt: 'Do.\n@write a.txt :: x' });
    const handle = h.client.workflow.getHandle(task.id);
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');

    await expect(h.api.postTaskMessage(human, task.id, { text: 'hi', to: ['agent:agent-1'] }))
      .rejects.toThrow(/not an agent on this task/);
    await expect(h.api.postTaskMessage(human, task.id, { text: 'hi', to: ['agent:agent-7'], agents: { 'agent-7': { provider: 'mock' } } }))
      .rejects.toThrow(/use agent-1/);

    const posted = await h.api.postTaskMessage(human, task.id, {
      text: 'Check this.\n@heard', to: ['agent:agent-1'], agents: { 'agent-1': { provider: 'mock' } },
    });
    expect(posted.message).toMatchObject({ author: 'user:a', to: ['agent:agent-1'] });
    expect((await h.store.getTask(task.id))?.params['agent:agent-1']).toMatchObject({ provider: 'mock' });
    await expect.poll(async () => (await view(handle)).messages.find((m: any) => m.author === 'agent-1'), { timeout: 20_000 })
      .toMatchObject({ role: 'agent', to: ['user:a'] });
    const v = await view(handle);
    expect(v.stage).toBe('review');
    // The caller is told the agent answered. They are already asked to review
    // this task, and a mention never displaces that stronger ask.
    await expect.poll(async () => (await h.store.eventsOfType(task.id, ['task.mentioned'])).map((e: any) => e.payload.recipients), { timeout: 10_000 })
      .toContainEqual(['user:a']);
    expect(await inbox('a', task.id)).toEqual([{ kind: 'review-requested', actionable: true }]);
  });

  it('mentions people without waking the agent, and answering a mention discharges it', async () => {
    const p = await project('messages-mention');
    const task = await h.api.createTask(human, { projectId: p.id, workflow: 'software-dev', prompt: 'Do.\n@write a.txt :: x' });
    const handle = h.client.workflow.getHandle(task.id);
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    const agentMessages = (await view(handle)).messages.filter((m: any) => m.role === 'agent').length;

    await expect(h.api.postTaskMessage(human, task.id, { text: 'hi', to: ['user:nobody'] })).rejects.toThrow(/does not resolve/);
    await h.api.postTaskMessage(human, task.id, { text: 'Bea, have a look', to: ['user:b'] });
    await expect.poll(() => inbox('b', task.id), { timeout: 10_000 }).toContainEqual({ kind: 'mentioned', actionable: true });
    await expect.poll(async () => (await view(handle)).messages.some((m: any) => m.text === 'Bea, have a look'), { timeout: 10_000 }).toBe(true);
    const v = await view(handle);
    expect(v.stage).toBe('review');
    expect(v.messages.filter((m: any) => m.role === 'agent')).toHaveLength(agentMessages);

    const bea = (await h.tokens.mintPrincipal('user:b', ['*'])).token;
    await h.api.postTaskMessage(bea, task.id, { text: 'Looks fine to me.', to: ['user:a'] });
    await expect.poll(() => inbox('b', task.id), { timeout: 10_000 }).not.toContainEqual({ kind: 'mentioned', actionable: true });
  });

  it("an agent's notify tells people now and is said in the conversation", async () => {
    const p = await project('messages-notify');
    const task = await h.api.createTask(human, { projectId: p.id, workflow: 'software-dev', prompt: 'Do.\n@write a.txt :: x' });
    const handle = h.client.workflow.getHandle(task.id);
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    const agent = (await h.tokens.mint({ taskId: task.id, profileId: 'do', role: 'do', participant: 'do', principal: 'user:a',
      projectId: p.id, ceiling: ['*'], grantorCaps: ['*'] })).token;
    await h.api.notify(agent, { to: ['user:b'], message: 'Deploy window starts at 3.' });
    await expect.poll(() => inbox('b', task.id), { timeout: 10_000 }).toContainEqual({ kind: 'mentioned', actionable: true });
    await expect.poll(async () => (await view(handle)).messages.find((m: any) => m.text === 'Deploy window starts at 3.'), { timeout: 10_000 })
      .toMatchObject({ role: 'agent', author: 'do', to: ['user:b'] });
  });

  it('escalating a request the task waits on redirects it, without replacing the run', async () => {
    const p = await project('messages-escalate');
    const task = await h.api.createTask(human, { projectId: p.id, workflow: 'software-dev', prompt: 'Which colour?\n@incomplete' });
    const handle = h.client.workflow.getHandle(task.id);
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 20_000 }).toBe('human');
    const runId = (await handle.describe()).runId;
    await h.api.escalateToHuman(human, { taskId: task.id, audience: ['user:b'], message: 'Bea knows the brand colours.' });
    await expect.poll(async () => (await view(handle)).waitingFor, { timeout: 10_000 })
      .toMatchObject({ kind: 'human', audience: ['user:b'], detail: 'Bea knows the brand colours.' });
    expect((await handle.describe()).runId).toBe(runId);
    await expect.poll(() => inbox('b', task.id), { timeout: 10_000 }).toContainEqual({ kind: 'escalated', actionable: true });
    // An unrelated task's agent may not redirect it.
    const other = await h.api.createTask(human, { projectId: p.id, workflow: 'software-dev', prompt: 'Other.\n@incomplete' });
    const stranger = (await h.tokens.mint({ taskId: other.id, profileId: 'do', role: 'do', principal: 'user:a',
      projectId: p.id, ceiling: ['*'], grantorCaps: ['*'] })).token;
    await expect(h.api.escalateToHuman(stranger, { taskId: task.id, audience: ['user:a'], message: 'x' }))
      .rejects.toThrow(/own task or a request from its sub-task/);
  });
});
