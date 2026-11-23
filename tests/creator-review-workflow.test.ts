import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { bootPipelineHarness, pipelineGates, stopPipelineHarness, input, view } from './helpers/pipeline-harness.js';

/**
 * A task an agent created is reviewed by that agent (ConfirmLayer.live): by the
 * agent itself while its task still works — asked in its conversation, deciding
 * with respond_to_sub_task, as a parent reviews its sub-task — and by a fork of
 * it once its task no longer works. Never by the person the agent works for.
 */
describe('Review by the agent that created the task (real Temporal + git, mock agent)', () => {
  let h: Harness;
  const gates = pipelineGates();
  beforeAll(async () => { h = await bootPipelineHarness(gates); }, 60_000);
  afterAll(() => stopPipelineHarness(h, gates));

  async function tasks(name: string) {
    const repo = await h.makeRepo(name);
    const project = await h.store.createProject(name, { repos: [repo], defaultBase: 'main', defaultTarget: 'main' });
    const creator = await h.store.createTask({ projectId: project.id, title: 'Creator', workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: 'x' } });
    const created = await h.store.createTask({ projectId: project.id, title: 'Created', workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: 'x' },
      createdBy: { kind: 'task-agent', taskId: creator.id, role: 'do' } });
    return { repo, project, creator, created };
  }
  const startCreated = (t: Awaited<ReturnType<typeof tasks>>, extra: Record<string, unknown> = {}) =>
    h.client.workflow.start('softwareDev@1.30.0', { taskQueue: TASK_QUEUE, workflowId: t.created.id, args: [{
      ...input({ taskId: t.created.id, projectId: t.project.id, repo: t.repo, title: 'Created', prompt: 'Build it.\n@write a.txt :: one' }),
      confirm: { layers: [{ kind: 'agent', provider: 'mock', resumeFrom: { taskId: t.creator.id, role: 'do' }, live: true, prompt: '@confirm confirm' }] },
      ...extra,
    }] });
  const startCreator = (t: Awaited<ReturnType<typeof tasks>>) =>
    h.client.workflow.start('softwareDev@1.30.0', { taskQueue: TASK_QUEUE, workflowId: t.creator.id, args: [{
      ...input({ taskId: t.creator.id, projectId: t.project.id, repo: t.repo, title: 'Creator', prompt: 'Coordinate.\n@pause 30' }), waitMinuteMs: 60_000,
    }] });
  const asks = (v: any, taskId: string) => v.messages.filter((m: any) => m.author === `task:${taskId}`);

  it('asks the working creator, takes its requested changes, then its approval; the person is never asked', async () => {
    const t = await tasks('creator-live');
    const creator = await startCreator(t);
    await expect.poll(async () => (await h.store.getTask(t.creator.id))?.lastView?.waitingFor?.kind, { timeout: 20_000 }).toBe('timer');
    const created = await startCreated(t);
    try {
      await expect.poll(async () => (await view(created)).waitingFor, { timeout: 30_000 })
        .toMatchObject({ kind: 'confirm', reviewerTask: t.creator.id });
      const waiting = await view(created);
      expect(waiting.stage).toBe('review');
      expect(waiting.waitingFor.detail).toMatch(/^Task #\d+ reviews it$/);
      // The creator's agent was asked in its own conversation, by the created task.
      await expect.poll(async () => asks(await view(creator), t.created.id).length, { timeout: 10_000 }).toBe(1);
      const [ask] = asks(await view(creator), t.created.id);
      expect(ask.to).toEqual(['agent:do']);
      expect(ask.text).toContain('"Created", which you created, is ready for your review');
      expect(ask.text).toContain(`respond_to_sub_task (child_task_id: "${t.created.id}")`);

      // It asks for a change (and works on): the created task's agent gets it from the creator, and asks again.
      await creator.signal('followUp', { id: 'c1', role: 'user', ts: Date.now(), text: `@respond comment ${t.created.id} :: Also write b.txt\n@pause 30` });
      await expect.poll(async () => asks(await view(creator), t.created.id).length, { timeout: 30_000 }).toBe(2);
      const revised = await view(created);
      const request = revised.messages.find((m: any) => m.author === `task:${t.creator.id}`);
      expect(request).toMatchObject({ role: 'user', text: 'Also write b.txt' });
      expect(request.authorLabel).toMatch(/^Task #\d+$/);

      await expect.poll(async () => (await view(created)).waitingFor?.reviewerTask, { timeout: 30_000 }).toBe(t.creator.id);
      await creator.signal('followUp', { id: 'c2', role: 'user', ts: Date.now(), text: `@respond confirm ${t.created.id}` });
      expect((await created.result()).stage).toBe('done');
      const done = await view(created);
      expect(done.messages.some((m: any) => m.role === 'system' && /^Task #\d+ approved it\.$/.test(m.text))).toBe(true);
      // No Reviewer ran here, and nobody was waited on as a person.
      expect(done.messages.some((m: any) => m.author === 'confirm')).toBe(false);
      const humanWaits = (await h.store.eventsOfType(t.created.id, 'view.updated')).filter((e: any) => e.payload?.waitingFor === 'human');
      expect(humanWaits).toEqual([]);
    } finally {
      await created.signal('cancel').catch(() => undefined);
      await creator.signal('cancel').catch(() => undefined);
    }
  }, 150_000);

  it('a fork of the creator reviews when its task has finished, or stops working while asked', async () => {
    // Finished before the Review: the fork reviews at once.
    const finished = await tasks('creator-finished');
    await h.store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ stage: 'done', status: 'done' }), finished.creator.id);
    const first = await startCreated(finished);
    expect((await first.result()).stage).toBe('done');
    const v = await view(first);
    expect(v.participants.find((p: any) => p.key === 'confirm')?.spec).toMatchObject({ resumeFrom: { taskId: finished.creator.id } });
    expect(v.messages.some((m: any) => m.author === 'confirm')).toBe(true);

    // Stops working while asked: the next check hands the Review to a fork.
    const stopped = await tasks('creator-stops');
    const creator = await startCreator(stopped);
    await expect.poll(async () => (await h.store.getTask(stopped.creator.id))?.lastView?.waitingFor?.kind, { timeout: 20_000 }).toBe('timer');
    const second = await startCreated(stopped, { liveReviewCheckMs: 1_000 });
    try {
      await expect.poll(async () => (await view(second)).waitingFor?.reviewerTask, { timeout: 30_000 }).toBe(stopped.creator.id);
      await creator.signal('cancel');
      expect((await second.result()).stage).toBe('done');
      const after = await view(second);
      expect(after.messages.some((m: any) => m.role === 'system' && /stopped working before it answered, so a fork of its agent reviews/.test(m.text))).toBe(true);
      expect(after.messages.some((m: any) => m.author === 'confirm')).toBe(true);
    } finally {
      await second.signal('cancel').catch(() => undefined);
    }
  }, 150_000);

  it('a person may still approve while the creator is asked', async () => {
    const t = await tasks('creator-person');
    const creator = await startCreator(t);
    await expect.poll(async () => (await h.store.getTask(t.creator.id))?.lastView?.waitingFor?.kind, { timeout: 20_000 }).toBe('timer');
    const created = await startCreated(t);
    try {
      await expect.poll(async () => (await view(created)).waitingFor?.reviewerTask, { timeout: 30_000 }).toBe(t.creator.id);
      await created.signal('confirm');
      expect((await created.result()).stage).toBe('done');
      // No Reviewer ran: the person's approval passed the step.
      expect((await view(created)).messages.some((m: any) => m.author === 'confirm')).toBe(false);
    } finally {
      await created.signal('cancel').catch(() => undefined);
      await creator.signal('cancel').catch(() => undefined);
    }
  }, 120_000);
});
