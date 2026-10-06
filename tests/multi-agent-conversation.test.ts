import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { newId } from '../src/util/id.js';
import { bootPipelineHarness, pipelineGates, stopPipelineHarness, input, view } from './helpers/pipeline-harness.js';

/**
 * software-dev 1.27: one conversation with several agents. The Responder, the
 * Reviewers and agents called in with @ all speak in the task's one thread, each
 * reading it as it happened (the other speakers labelled) — never a templated
 * digest — and only one works at a time.
 */
describe('software-dev 1.27: one conversation, several agents (real Temporal + git, mock agent)', () => {
  let h: Harness;
  const gates = pipelineGates();
  beforeAll(async () => { h = await bootPipelineHarness(gates); }, 60_000);
  afterAll(() => stopPipelineHarness(h, gates));

  const start = (taskId: string, args: Record<string, unknown>) => h.client.workflow.start('softwareDev@1.27.0', {
    taskQueue: TASK_QUEUE, workflowId: taskId, args: [args],
  });
  const authored = (v: any) => v.messages.map((m: any) => (m.role === 'agent' ? (m.author ?? 'do') : m.role));

  it('the Agent asks, the Responder answers in the thread, the Reviewer reads both and confirms', async () => {
    const repo = await h.makeRepo('conversation');
    const taskId = newId('task');
    const handle = await start(taskId, {
      ...input({ taskId, repo, title: 'Conversation', prompt: 'Start.\n@write a.txt :: one\n@incomplete' }),
      responder: { kind: 'agent', provider: 'mock', prompt: '@heard' },
      confirm: { layers: [{ kind: 'agent', provider: 'mock', prompt: '@heard\n@confirm confirm' }] },
    });
    expect((await handle.result()).stage).toBe('done');
    const v = await view(handle);
    // One thread: the request, the Agent, the Responder's answer, the Agent again
    // (the mock also commits after its first Open PR is refused), the Reviewer.
    const speakers = authored(v);
    expect(speakers.slice(0, 4)).toEqual(['user', 'do', 'responder', 'do']);
    expect(speakers.at(-1)).toBe('confirm');
    const answer = v.messages.find((m: any) => m.author === 'responder');
    const review = v.messages.find((m: any) => m.author === 'confirm');
    expect(answer.to).toEqual(['agent:do']);
    // Each agent read the others as labelled input, not a template.
    expect(answer.text).toContain('heard: user: Start. | user: Agent: wrote a.txt');
    expect(review.text).toContain('user: Responder: heard:');
    expect(review.text).not.toContain('Recap: the task');
    expect(v.participants.map((p: any) => [p.key, p.label, p.messages])).toEqual([
      ['do', 'Agent', speakers.filter((a: string) => a === 'do').length], ['responder', 'Responder', 1], ['confirm', 'Reviewer', 1],
    ]);
    // No separate transcripts for the Responder or Reviewer any more.
    expect(v.transcripts.map((t: any) => t.role)).toEqual(['do']);
  });

  it('an agent called in at Review answers whoever called it and leaves the task in Review', async () => {
    const repo = await h.makeRepo('called-in');
    const taskId = newId('task');
    const handle = await start(taskId, input({ taskId, repo, title: 'CalledIn', prompt: 'Do.\n@write a.txt :: one' }));
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    const mainTurns = authored(await view(handle)).filter((a: string) => a === 'do').length;
    await handle.executeUpdate('updateParams', { args: [{ 'agent:agent-1': { provider: 'mock' } }] });
    await handle.signal('followUp', { id: 'u-call', role: 'user', author: 'user:ann', authorLabel: 'Ann', ts: Date.now(),
      text: 'Please look.\n@heard', to: ['agent:agent-1'] });
    await expect.poll(async () => authored(await view(handle)), { timeout: 20_000 }).toContain('agent-1');
    const v = await view(handle);
    expect(v.stage).toBe('review');
    expect(v.status).toBe('waiting');
    expect(v.waitingFor).toMatchObject({ kind: 'human' });
    const reply = v.messages.find((m: any) => m.author === 'agent-1');
    expect(reply.text).toContain('user: Ann: Please look.');
    expect(reply.to).toEqual(['user:ann']);
    // The main agent was not woken.
    expect(authored(v).filter((a: string) => a === 'do')).toHaveLength(mainTurns);
    expect(v.participants.find((p: any) => p.key === 'agent-1')).toMatchObject({ label: 'Agent 1', role: 'agent', state: 'idle' });
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
  });

  it('an agent called while the Agent works waits for its turn to end, and does not wake the Agent', async () => {
    const repo = await h.makeRepo('queued');
    const taskId = newId('task');
    const handle = await start(taskId, input({ taskId, repo, title: 'Queued', prompt: 'Work.\n@sleep 2500\n@write a.txt :: x' }));
    await expect.poll(async () => (await view(handle)).agentTurn?.state, { timeout: 20_000 }).toBe('running');
    await handle.executeUpdate('updateParams', { args: [{ 'agent:agent-1': { provider: 'mock' } }] });
    await handle.signal('followUp', { id: 'u-queue', role: 'user', ts: Date.now(), text: 'Have a look.\n@heard', to: ['agent:agent-1'] });
    await expect.poll(async () => (await view(handle)).participants?.find((p: any) => p.key === 'agent-1')?.state, { timeout: 10_000 })
      .toBe('queued');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await expect.poll(async () => authored(await view(handle)), { timeout: 20_000 }).toContain('agent-1');
    const v = await view(handle);
    // The Agent's reply answers only what it was given; the message for Agent 1
    // follows it, then Agent 1's answer, before anything else happens. The
    // message for Agent 1 never woke the Agent (the rest is its Open PR repair).
    expect(authored(v).slice(0, 4)).toEqual(['user', 'do', 'user', 'agent-1']);
    expect(v.messages[1].text).toContain('wrote a.txt');
    expect(v.messages[1].text).not.toContain('Have a look');
    expect(v.messages.slice(4).every((m: any) => m.author !== 'agent-1' && !m.text.includes('Have a look'))).toBe(true);
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
  });

  it('a failure automatic recovery cannot fix keeps its stage and asks the task’s people, not an Escalated stage', async () => {
    const repo = await h.makeRepo('failing');
    const taskId = newId('task');
    const handle = await start(taskId, input({ taskId, repo, title: 'Failing', prompt: '@failworld the compiler exploded', resolveAgentEnabled: false }));
    await expect.poll(async () => (await view(handle)).status, { timeout: 30_000 }).toBe('blocked');
    const v = await view(handle);
    expect(v.stage).toBe('do');
    expect(v.waitingFor).toMatchObject({ kind: 'human', reason: 'error', audience: ['@creator'] });
    expect(v.error).toContain('the compiler exploded');
    expect(v.actions.map((a: any) => a.name)).toContain('retry');
    await handle.signal('cancel');
    await handle.result();
  });

  it('escalating a pending request redirects it to other people without interrupting the task', async () => {
    const repo = await h.makeRepo('redirect');
    const taskId = newId('task');
    const handle = await start(taskId, input({ taskId, repo, title: 'Redirect', prompt: 'Which colour?\n@incomplete' }));
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 20_000 }).toBe('human');
    await handle.signal('reroute', { audience: ['user:bea'], detail: 'Bea knows the brand colours.' });
    await expect.poll(async () => (await view(handle)).waitingFor, { timeout: 10_000 })
      .toMatchObject({ kind: 'human', audience: ['user:bea'], detail: 'Bea knows the brand colours.' });
    await handle.signal('followUp', { id: 'u-answer', role: 'user', author: 'user:bea', ts: Date.now(), text: 'Blue.' });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    await handle.signal('cancel');
    await handle.result();
  });
});
