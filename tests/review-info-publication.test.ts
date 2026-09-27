import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { runTurn } from '../src/agent/runtime.js';
import { KarmaxApi } from '../src/platform/api.js';
import type { TaskView } from '../src/domain/types.js';

const attachment = { caption: 'Read the security challenge', actions: [
  { kind: 'open' as const, label: 'View challenge', target: 'review-artifacts/challenge.png' },
] };

describe('review info before turn completion', () => {
  it('persists the tool result before cancellation and keeps snapshot/live/action/recovery views consistent', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Review publication'));
    const task = (await store.createTask({ projectId: project.id, title: 'Challenge', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' } }));
    const original: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow,
      stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 1,
      reviewInfo: { caption: 'Old caption', actions: [], changedFiles: ['existing.txt'] } };
    (await store.saveView(task.id, original));
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any, ctx: any) {
      const handlers = platformToolHandlers(input.world, ctx);
      expect(await handlers.create_review_info!({ caption: attachment.caption })).toBe('review info recorded');
      expect(await handlers.create_review_info!({ actions: attachment.actions })).toBe('review info recorded');
      expect((await store.getTask(task.id))?.lastView?.reviewInfo).toMatchObject(attachment);
      throw new Error('turn stopped for human escalation');
    } }]]) as any;
    const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'mock') });
    try {
      await expect(core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`,
        agentSlotGranted: true, worldHandle: world.handle, messages: [],
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {},
          workflow: 'software-dev', agents: { do: { provider: 'mock' } } },
      } as any)).rejects.toThrow('turn stopped for human escalation');
      expect((await store.db.prepare("SELECT seq FROM events WHERE taskId=? AND type='review.updated'").get(task.id))).toBeTruthy();
      // The workflow has not received TurnResult and may publish its stale frame.
      await core.publishView(task.id, original);
      expect((await store.getTask(task.id))?.lastView?.reviewInfo).toMatchObject({ ...attachment, changedFiles: ['existing.txt'] });
      const api = new KarmaxApi({ store, client: { workflow: { getHandle: () => ({ query: async () => original }) } },
        tokens: { check: () => ({ ok: true, payload: {} }) } } as any);
      // Both the drawer and review-action endpoint use getTaskView; the latter queries live.
      expect((await api.getTaskView('test', task.id))?.reviewInfo).toMatchObject(attachment);
      expect((await api.getTaskView('test', task.id, { live: true }))?.reviewInfo).toMatchObject(attachment);
      const recovery = await (api as any).transitionSourceView((await store.getTask(task.id)));
      expect(recovery.reviewInfo).toMatchObject(attachment);
      await core.publishView(task.id, { ...recovery, status: 'waiting', state: { humanPauseOrigin: 'do' },
        waitingFor: { kind: 'human', audience: ['@creator'], detail: 'Read challenge' } });
      expect((await store.kvGet(`pending-review:${task.id}`))).toBeUndefined();
      // Once incorporated, later workflow changes are not masked by an old overlay.
      await core.publishView(task.id, { ...recovery, reviewInfo: { caption: 'Finished', actions: [] } });
      expect((await store.getTask(task.id))?.lastView?.reviewInfo?.caption).toBe('Finished');
      (await store.checkpointReviewInfo(task.id, attachment));
      (await store.deleteTask(task.id));
      expect((await store.kvGet(`pending-review:${task.id}`))).toBeUndefined();
    } finally { await world.destroy(); (await store.close()); }
  });

  it('awaits persistence and propagates failures instead of acknowledging a lost attachment', async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => { release = resolve; });
    const handlers = platformToolHandlers({} as any, { createReviewInfo: () => persisted } as any);
    let acknowledged = false;
    const request = handlers.create_review_info!(attachment).then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    release(); await request;
    expect(acknowledged).toBe(true);
    const failing = platformToolHandlers({} as any, { createReviewInfo: async () => { throw new Error('storage unavailable'); } } as any);
    await expect(failing.create_review_info!(attachment)).rejects.toThrow('storage unavailable');
  });
});

/**
 * PL-4 / UI-2: review info is agent-authored, rendered as clickable links and
 * buttons in the console, and carried in every TurnResult into workflow
 * history. The tool boundary bounds its size, accepts only the run/open
 * affordances it advertises, and only http(s) links.
 */
describe('create_review_info validation', () => {
  async function attempt(...calls: Record<string, unknown>[]) {
    const results: string[] = [];
    const published: any[] = [];
    const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any, ctx: any) {
      const handlers = platformToolHandlers(input.world, ctx);
      for (const call of calls) results.push(await handlers.create_review_info!(call));
      return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'done' };
    } }]]) as any;
    const turn = await runTurn({ profile: { id: 'mock', provider: 'mock' }, world: {} as any,
      messages: [{ id: 'm', role: 'user', text: 'x', ts: 0 }], systemPrompt: '', role: 'do' } as any,
    { adapters, onReviewInfo: (info) => { published.push(info); } });
    return { results, published, reviewInfo: turn.reviewInfo };
  }

  it('rejects non-http(s) link, URL and open-target schemes', async () => {
    for (const call of [
      { links: [{ label: 'Docs', url: 'javascript:alert(document.cookie)' }] },
      { links: [{ label: 'Docs', url: 'data:text/html,<script>alert(1)</script>' }] },
      { actions: [{ kind: 'open', label: 'Report', target: 'javascript:alert(1)' }] },
      { actions: [{ kind: 'run', label: 'Serve', command: 'npm start', server: true, openUrls: ['vbscript:x'] }] },
    ]) {
      const { results, reviewInfo } = await attempt(call);
      expect(results[0]).toMatch(/^review info rejected: /);
      expect(reviewInfo).toBeUndefined();
    }
    const { results, reviewInfo } = await attempt({
      links: [{ label: 'Docs', url: 'https://example.com/docs' }],
      actions: [{ kind: 'open', label: 'Report', target: 'reports/out.html' },
        { kind: 'run', label: 'Serve', command: 'npm start', server: true, openUrls: ['http://localhost:3000/'] }],
    });
    expect(results).toEqual(['review info recorded']);
    expect(reviewInfo?.links).toHaveLength(1);
    expect(reviewInfo?.actions).toHaveLength(2);
  });

  it('accepts only the run/open affordances the tool advertises, with their own fields', async () => {
    const { results } = await attempt({ actions: [{ kind: 'payment', label: 'View report', requestId: 'spend_1', operation: 'approve' }] });
    expect(results[0]).toMatch(/^review info rejected: /);
    const { reviewInfo } = await attempt({ actions: [{ kind: 'open', label: 'Report', target: 'r.pdf', requestId: 'spend_1', operation: 'approve' }] });
    expect(reviewInfo?.actions).toEqual([{ kind: 'open', label: 'Report', target: 'r.pdf' }]);
  });

  it('bounds html, diff, links and the accumulated action list', async () => {
    const big = 'x'.repeat(200 * 1024);
    for (const call of [{ html: big }, { diff: big },
      { links: Array.from({ length: 50 }, (_, i) => ({ label: `L${i}`, url: `https://e.com/${i}` })) },
      { actions: [{ kind: 'run', label: 'Huge', command: big }] }]) {
      const { results, reviewInfo } = await attempt(call);
      expect(results[0]).toMatch(/^review info rejected: /);
      expect(reviewInfo).toBeUndefined();
    }
    // Actions accumulate across calls; the cap applies to the total.
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'open', label: `Open ${i}`, target: `f${i}.pdf` }));
    const { results, reviewInfo, published } = await attempt({ actions: many }, { actions: many });
    expect(results).toEqual(['review info recorded', expect.stringMatching(/^review info rejected: .*actions/)]);
    expect(reviewInfo?.actions).toHaveLength(12);
    expect(published).toHaveLength(1);
  });
});
