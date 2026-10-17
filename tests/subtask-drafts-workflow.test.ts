import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { taskBranch } from '../src/domain/brand.js';

// Draft sub-tasks through the real workflow and gateway: an agent saves
// sub-tasks with create_sub_task `draft: true` (nothing starts), then starts
// them when it chooses with queue_task, or a person runs one. Either way the
// parent prepares and starts it, off its own branch, as a sub-task its agent
// asks for (pramana#59: more sub-tasks than a Hetzner project's CPU limit).

describe('draft sub-tasks', () => {
  let h: Harness;
  let gateway: Awaited<ReturnType<Harness['startGateway']>>;
  let token: string;
  let projectId: string;
  const previous = { url: process.env.KARMAX_GATEWAY_URL, floor: process.env.KARMAX_AGENT_MIN_FREE_MB, load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR };
  const view = (taskId: string) => h.client.workflow.getHandle(taskId).query('view') as Promise<any>;
  const agentTexts = async (taskId: string) => ((await view(taskId)).messages as { role: string; text: string }[])
    .filter((message) => message.role === 'agent').map((message) => message.text).join('\n');
  const running = (taskId: string) => h.client.workflow.getHandle(taskId).describe().then(() => true, () => false);
  const drafts = async (parentId: string) => (await h.store.childTasks(parentId)).sort((a, b) => a.title.localeCompare(b.title));

  async function startParent(title: string, prompt: string) {
    const task = await h.api.createTask(token, { projectId, title, draft: true, params: { 'agent:do': { provider: 'mock' } }, prompt } as any);
    await h.api.queueTask(token, task.id);
    return task.id;
  }

  beforeAll(async () => {
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    h = await bootHarness('mock');
    gateway = await h.startGateway();
    process.env.KARMAX_GATEWAY_URL = gateway.internalUrl;
    const repo = await h.makeRepo('subtask-drafts');
    projectId = (await h.store.createProject('Sub-task drafts', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false })).id;
    token = (await h.tokens.mintPrincipal('user:a', ['*'], projectId)).token;
  }, 90_000);

  afterAll(async () => {
    await h?.stop();
    for (const [name, value] of [['KARMAX_GATEWAY_URL', previous.url], ['KARMAX_AGENT_MIN_FREE_MB', previous.floor],
      ['KARMAX_AGENT_MAX_LOAD_FACTOR', previous.load]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('an agent saves drafts that do not start; it starts one with queue_task and a person runs the other', async () => {
    const parentId = await startParent('Parent', [
      '@draftsubtask First :: @run grep -q "later work" plan.txt',
      '@draftsubtask Second :: @write second.txt :: two',
      '@pause 60',
    ].join('\n'));
    try {
      await vi.waitFor(async () => expect(await drafts(parentId)).toHaveLength(2), { timeout: 30_000, interval: 250 });
      await vi.waitFor(async () => expect((await view(parentId)).waitingFor?.kind).toBe('timer'), { timeout: 30_000, interval: 250 });
      const [first, second] = await drafts(parentId);
      // Saved, not started: no number, no workflow, nothing the parent waits on.
      for (const draft of [first!, second!]) {
        expect(draft.params.draft).toBe(true);
        expect(draft.num).toBeUndefined();
        expect(await running(draft.id)).toBe(false);
      }
      expect(first!.params.prompt).toBe('@run grep -q "later work" plan.txt');
      expect((await view(parentId)).subTasks ?? []).toEqual([]);
      expect(await agentTexts(parentId)).toContain(`draft sub-task ${first!.id} saved, not started`);
      // The parent's Sub-tasks panel shows them as drafts.
      const summaries = (await h.api.getTaskView(token, parentId) as any).subTaskSummaries;
      expect(summaries.map((s: any) => [s.title, s.lastView?.state])).toEqual([
        ['First', { draft: true }], ['Second', { draft: true }]]);

      // The agent starts one: at its turn's end, off its work as it is then.
      await h.api.signalTask(token, parentId, 'followUp', `@write plan.txt :: later work\n@queue ${first!.id}\n@pause 60`);
      await vi.waitFor(async () => expect((await view(parentId)).subTasks).toEqual([first!.id]), { timeout: 30_000, interval: 250 });
      expect(await agentTexts(parentId)).toContain(`queued ${first!.id}: it starts when its parent task's agent ends its turn`);
      const started = (await h.store.getTask(first!.id))!;
      expect(started.params.draft).toBe(false);
      expect(started.num).toEqual(expect.any(Number));
      expect(started.params.base).toBe(taskBranch(parentId));
      await vi.waitFor(async () => expect(await agentTexts(first!.id)).toContain('ran: grep -q "later work" plan.txt (exit 0)'), { timeout: 30_000, interval: 250 });
      expect((await h.store.getTask(second!.id))!.params.draft).toBe(true);

      // A person runs the other while the parent waits: the parent hears who
      // queued it, and starts it.
      await h.api.queueTask(token, second!.id);
      await vi.waitFor(async () => expect((await view(parentId)).subTasks).toEqual([first!.id, second!.id]), { timeout: 30_000, interval: 250 });
      expect(((await view(parentId)).messages as { role: string; text: string }[])
        .some((m) => m.role === 'user' && m.text.startsWith(`Queued your draft sub-task "Second" (${second!.id})`))).toBe(true);
      await vi.waitFor(async () => expect(await agentTexts(second!.id)).toContain('wrote second.txt'), { timeout: 30_000, interval: 250 });
    } finally {
      await h.client.workflow.getHandle(parentId).signal('cancel').catch(() => undefined);
    }
  }, 150_000);

  it('a draft cannot start once its parent has ended, and an ended task takes no new drafts', async () => {
    const parentId = await startParent('Ended parent', ['@draftsubtask Late :: @write late.txt :: x', '@pause 60'].join('\n'));
    await vi.waitFor(async () => expect(await drafts(parentId)).toHaveLength(1), { timeout: 30_000, interval: 250 });
    const [late] = await drafts(parentId);
    await h.client.workflow.getHandle(parentId).signal('cancel');
    await vi.waitFor(async () => expect((await h.store.getTask(parentId))?.lastView?.status).toBe('cancelled'), { timeout: 30_000, interval: 250 });
    await expect(h.api.queueTask(token, late!.id)).rejects.toThrow(/its parent task has ended/);
    expect((await h.store.getTask(late!.id))!.params.draft).toBe(true);
    expect(await running(late!.id)).toBe(false);
    await expect(h.api.createSubTaskDraft(token, parentId, { title: 'Too late', prompt: 'x' })).rejects.toThrow(/its parent task has ended/);
  }, 90_000);

  it('a parent outside Do refuses to start a draft until it works again', async () => {
    const parentId = await startParent('Reviewing parent', '@draftsubtask Later :: @write later.txt :: x');
    await vi.waitFor(async () => expect((await view(parentId)).stage).toBe('review'), { timeout: 30_000, interval: 250 });
    const [later] = await drafts(parentId);
    await expect(h.api.queueTask(token, later!.id)).rejects.toThrow(/its parent task is in Review; a sub-task starts only while its parent works \(Do\)/);
    expect((await h.store.getTask(later!.id))!.params.draft).toBe(true);
    await h.client.workflow.getHandle(parentId).signal('cancel').catch(() => undefined);
  }, 90_000);

  it('people save draft sub-tasks too, with agent fields only', async () => {
    const parentId = await startParent('Planned parent', '@pause 60');
    await vi.waitFor(async () => expect((await view(parentId)).waitingFor?.kind).toBe('timer'), { timeout: 30_000, interval: 250 });
    const response = await fetch(`${gateway.url}/api/tasks/${parentId}/sub-tasks`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Planned', prompt: '@write planned.txt :: p', params: { 'agent:do': { provider: 'mock', model: 'm' } } }),
    });
    expect(response.status).toBe(200);
    const planned = await response.json() as any;
    expect(planned).toMatchObject({ parentTaskId: parentId, title: 'Planned', params: { draft: true, 'agent:do': { provider: 'mock', model: 'm' } } });
    const refused = await fetch(`${gateway.url}/api/tasks/${parentId}/sub-tasks`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Bad', prompt: 'x', params: { base: 'main' } }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json() as any).error).toMatch(/"base" cannot be set on a sub-task/);
    await h.client.workflow.getHandle(parentId).signal('cancel').catch(() => undefined);
  }, 90_000);
});
