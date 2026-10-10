import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { git } from '../src/world/git.js';
import type { TaskView } from '../src/domain/types.js';

/**
 * Tasks whose Do runs the task's own command instead of an agent (software-dev
 * 1.28; wiki features/events-and-automations), on real Temporal and
 * git with the mock agent standing by for a hand-off.
 */
describe('task commands (real Temporal + git)', () => {
  let h: Harness;
  let repo: string;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    h = await bootHarness('mock');
    repo = await h.makeRepo('command-repo');
    projectId = (await h.store.createProject('Commands', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' })).id;
    token = (await h.tokens.mintPrincipal('user:a', ['*'], projectId)).token;
  }, 90_000);
  afterAll(async () => { await h?.stop(); });

  const view = (taskId: string) => h.client.workflow.getHandle(taskId).query<TaskView>('view');
  const settle = (taskId: string, accept: (v: TaskView) => boolean) =>
    expect.poll(async () => { const v = await view(taskId).catch(() => undefined); return v && accept(v) ? v : undefined; },
      { timeout: 60_000, interval: 250 }).toBeTruthy().then(() => view(taskId));
  const create = (title: string, params: Record<string, unknown>) =>
    h.api.createTask(token, { projectId, title, prompt: title, params });
  const agentTurns = async (taskId: string) => (await h.store.eventsSince(taskId, 0)).filter((e) => e.type === 'turn.start' || e.type === 'agent.turn.started').length;

  it('finishes by itself when the command succeeds and changes nothing, without an agent', async () => {
    const task = await create('Check', { command: 'test -n "$KARMAX_TOKEN" && test -n "$KARMAX_GATEWAY_URL" && command -v tavya && echo all-good' });
    const done = await settle(task.id, (v) => v.status === 'done');
    expect(done.workflow).toBe('software-dev');
    const report = done.messages.find((m) => m.role === 'system' && m.text.includes('exited 0'));
    expect(report?.text).toContain('all-good');
    expect(done.reviewInfo?.summary).toMatch(/^No file changes detected/);
    expect(await agentTurns(task.id)).toBe(0);
    expect((await h.store.eventsSince(task.id, 0)).map((e) => e.type)).toEqual(expect.arrayContaining(['command.started', 'command.done', 'token.minted']));
  }, 120_000);

  it('sends the changes it made to Review, then lands them', async () => {
    const task = await create('Generate', { command: 'mkdir -p gen && echo "generated" > gen/out.txt' });
    const review = await settle(task.id, (v) => v.stage === 'review' && v.status === 'waiting');
    expect(review.reviewInfo?.changedFiles).toEqual(['gen/out.txt']);
    await h.client.workflow.getHandle(task.id).signal('confirm');
    await settle(task.id, (v) => v.status === 'done');
    expect((await git(repo, ['show', 'main:gen/out.txt'])).stdout.trim()).toBe('generated');
    expect(await agentTurns(task.id)).toBe(0);
  }, 120_000);

  it('fails the task when the command fails, with its output', async () => {
    const task = await create('Broken', { command: 'echo "it broke" >&2; exit 3' });
    const failed = await settle(task.id, (v) => v.status === 'failed');
    expect(failed.reviewInfo?.summary).toBe('The command exited 3.');
    expect(failed.messages.at(-1)?.text).toContain('it broke');
    expect(await agentTurns(task.id)).toBe(0);
  }, 120_000);

  it('hands a failed command to the agent when the task says so', async () => {
    const task = await create('Self-healing', { command: 'exit 7', onCommandFailure: 'agent' });
    const after = await settle(task.id, (v) => v.messages.some((m) => m.role === 'agent'));
    const handoff = after.messages.find((m) => m.role === 'user' && m.text.includes('exited 7'));
    expect(handoff?.text).toMatch(/Find and fix the cause/);
    expect(after.status).not.toBe('failed');
  }, 120_000);

  it('gives a run started by an event its event in $TAVYA_EVENT', async () => {
    const series = await create('On order', { command: 'cp "$TAVYA_EVENT" event.json', repeatable: true,
      triggers: [{ kind: 'event', type: 'orders.created', recurring: true }] });
    const { TriggerScheduler, createTriggerFire } = await import('../src/platform/trigger-scheduler.js');
    const scheduler = new TriggerScheduler({ store: h.store, bus: h.bus, fire: createTriggerFire(h.api, h.tokens), inboxSweepMs: 0, reconcileMs: 0 });
    h.api.setTriggerArmer(scheduler);
    await scheduler.start();
    try {
      await h.api.emitProjectEvent(token, projectId, { type: 'orders.created', key: 'o-1', payload: { id: 1, total: 42 } });
      await scheduler.drain();
      const run = (await h.store.listTasks(projectId)).find((t) => t.params?.runOf === series.id)!;
      expect(run).toBeTruthy();
      const review = await settle(run.id, (v) => v.stage === 'review');
      expect(review.reviewInfo?.changedFiles).toEqual(['event.json']);
      const copied = JSON.parse(fs.readFileSync(path.join(review.worldPath!, 'event.json'), 'utf8'));
      expect(copied).toMatchObject({ type: 'orders.created', key: 'o-1', payload: { id: 1, total: 42 } });
    } finally {
      await scheduler.stop();
    }
  }, 120_000);
});
