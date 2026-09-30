import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import type { AgentAdapter } from '../src/agent/types.js';

// Task 385 (2026-09-26): a turn was retried after its first attempt had already
// injected four mid-turn messages and called open_pr. The retry was told only
// "you were interrupted", so the workflow re-sent those messages as a whole new
// turn and the PR request was lost with the attempt. Real Temporal activity
// retry, real workflow; only model inference is simulated.
describe('turn journal across an interrupted activity attempt', () => {
  let h: Harness;
  const calls: Array<{ messages: string[]; session?: string }> = [];
  let followUpSent = false;

  const adapter: AgentAdapter = {
    provider: 'claude',
    async runTurn(input, ctx) {
      calls.push({ messages: input.messages.map((m) => m.text), session: input.session });
      if (calls.length === 1) {
        ctx.onSession?.('session-1');
        // Wait for the person's mid-turn message and inject it into the live session.
        let injected = false;
        for (let i = 0; i < 200 && !injected; i++) {
          const news = await ctx.pullFollowUps!(input.messages.length);
          if (news.length) {
            ctx.followUpsDelivered?.(input.messages.length + news.length);
            injected = true;
          } else await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(injected).toBe(true);
        await ctx.openPr();
        // The host drops mid-turn: a retryable infrastructure failure.
        throw new Error('fetch failed');
      }
      return { termination: { kind: 'success', status: 'success' }, session: input.session ?? 'session-1',
        output: 'Answered the follow-up and opened the PR.', delivered: input.messages.length };
    },
  };

  beforeAll(async () => { h = await bootHarness('claude', adapter); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  it('keeps the open_pr request and the mid-turn delivery of the replaced attempt', async () => {
    const repo = await h.makeRepo('journal');
    const project = (await h.store.createProject('Journal', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const task = await h.api.createTask(token, { projectId: project.id, title: 'Journal', prompt: 'Do the work.',
      params: { 'agent:do': { provider: 'claude', model: 'claude-fable-5-1' } } });
    const view = () => h.client.workflow.getHandle(task.id).query('view') as Promise<any>;

    await expect.poll(() => calls.length, { timeout: 30_000 }).toBe(1);
    await h.api.signalTask(token, task.id, 'followUp', 'Also check the other thing.');
    followUpSent = true;

    await expect.poll(async () => (await view()).stage, { timeout: 60_000 }).toBe('review');
    expect(followUpSent).toBe(true);
    // Exactly one retry, resumed from the interrupted session, and no third turn
    // re-sending the follow-up.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.session).toBe('session-1');
    expect(calls[1]!.messages).toEqual([expect.stringMatching(/interrupted mid-run/)]);
    const texts = ((await view()).messages as Array<{ role: string; text: string }>).map((m) => `${m.role}:${m.text}`);
    expect(texts.filter((t) => t === 'user:Also check the other thing.')).toHaveLength(1);
    expect(texts.at(-1)).toBe('agent:Answered the follow-up and opened the PR.');
    expect((await h.store.eventsSince(task.id, 0)).some((e) => e.type === 'turn.resumed')).toBe(true);
    // No wall-clock cap: only the heartbeat timeout decides that a turn is dead.
    const history = await h.client.workflow.getHandle(task.id).fetchHistory();
    const scheduled = (history.events ?? []).map((event: any) => event.activityTaskScheduledEventAttributes)
      .filter((attributes: any) => attributes?.activityType?.name === 'runAgentTurn');
    expect(scheduled.length).toBeGreaterThan(0);
    for (const attributes of scheduled) {
      expect(Number(attributes.startToCloseTimeout.seconds)).toBe(30 * 24 * 3600);
      expect(Number(attributes.heartbeatTimeout.seconds)).toBe(120);
    }
    await h.api.signalTask(token, task.id, 'cancel');
  }, 120_000);
});
