import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { newId } from '../src/util/id.js';

// Real Temporal, activities and git, the mock agent. auto-rubric#2: a later
// turn's create_review_info replaced every action earlier turns had attached.
// Review keeps what an earlier turn attached until the agent removes it.
describe('review info across a task\'s turns', () => {
  let h: Harness;
  beforeAll(async () => { h = await bootHarness('mock'); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  const view = async (taskId: string) => h.client.workflow.getHandle(taskId).query<any>('view');
  const labels = (current: any) => (current.reviewInfo?.actions ?? []).map((action: any) => action.label);

  for (const workflow of ['software-dev', 'just-do']) {
    it(`${workflow}: a follow-up's attachment adds to Review, keeping earlier actions and caption`, async () => {
      const repo = await h.makeRepo(`review-turns-${workflow}`);
      const project = await h.store.createProject(newId('Review turns'), { repos: [repo], worldProvider: 'worktree', defaultBase: 'main' });
      const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
      const task = await h.api.createTask(token, { projectId: project.id, workflow, params: {
        prompt: '@write a.txt :: first\n@openaction First chart :: a.txt\n@runaction Serve :: cat a.txt\n@review Check the charts',
      } });
      await expect.poll(async () => labels(await view(task.id)), { timeout: 30_000 }).toEqual(['First chart', 'Serve']);
      await expect.poll(async () => (await view(task.id)).stage, { timeout: 30_000 }).toBe('review');

      await h.client.workflow.getHandle(task.id).signal('followUp', { id: 'f1', role: 'user', ts: Date.now(),
        text: '@write b.txt :: second\n@openaction Second chart :: b.txt' }, 'do');
      // The second turn's attachment shows — and the first turn's stay.
      await expect.poll(async () => labels(await view(task.id)), { timeout: 30_000 }).toContain('Second chart');
      await expect.poll(async () => (await view(task.id)).stage, { timeout: 30_000 }).toBe('review');
      const after = await view(task.id);
      expect(labels(after)).toEqual(['First chart', 'Serve', 'Second chart']);
      expect(after.reviewInfo.caption).toBe('Check the charts');
      // What the console reads — the stored view — agrees with the workflow.
      const stored = (await h.store.getTask(task.id))?.lastView;
      expect(labels(stored)).toEqual(['First chart', 'Serve', 'Second chart']);

      await h.client.workflow.getHandle(task.id).signal('cancel');
      await h.client.workflow.getHandle(task.id).result().catch(() => undefined);
    }, 120_000);
  }
});
