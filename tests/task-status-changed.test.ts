import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Store } from '../src/store/db.js';
import { storeBackends } from './helpers/store-backends.js';

/**
 * Task lists are ordered by when a task last changed status (stage, status, or
 * what it is waiting for), so a task that has just reached Review or Needs input
 * rises to the top. The store stamps that time when it saves a view; a view that
 * only re-ticks (an agent turn starting, a wait's detail) is not a status change.
 */
afterEach(() => { vi.restoreAllMocks(); });

const view = (taskId: string, patch: Record<string, unknown>) => ({ taskId, title: taskId, workflow: 'software-dev',
  stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 7, ...patch }) as any;

describe.each(storeBackends)('status change time ($name)', ({ open }) => {
  it('is stamped when the stage, status or wait kind changes, and nothing else', async () => {
    const store = await open();
    const project = await store.createProject('App');
    const task = await store.createTask({ projectId: project.id, title: 't', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 't' } });
    const changedAt = async () => (await store.getTask(task.id))!.statusChangedAt;
    const save = async (at: number, patch: Record<string, unknown>) => {
      vi.spyOn(Date, 'now').mockReturnValue(at);
      await store.saveView(task.id, view(task.id, patch));
    };
    expect(await changedAt()).toBeUndefined();

    await save(1_000, {});
    expect(await changedAt()).toBe(1_000);
    await save(2_000, { agentTurn: { state: 'running', role: 'do' } });
    await save(3_000, { waitingFor: { kind: 'job', detail: 'a', until: 5 } });
    expect(await changedAt()).toBe(3_000);
    await save(4_000, { waitingFor: { kind: 'job', detail: 'b', until: 6 } });
    expect(await changedAt()).toBe(3_000);
    await save(5_000, { status: 'waiting', waitingFor: { kind: 'human' } });
    await save(6_000, { status: 'waiting', waitingFor: { kind: 'human' }, agentTurn: { state: 'idle', role: 'do' } });
    expect(await changedAt()).toBe(5_000);
    await save(7_000, { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } });
    expect(await changedAt()).toBe(7_000);

    // Every list read carries it.
    const summaries = await store.listTaskSummaries(project.id);
    const pages: number[] = [];
    for await (const page of store.taskReadPages(project.id)) pages.push(...page.map((t) => t.statusChangedAt!));
    expect(summaries.map((t) => t.statusChangedAt)).toEqual([7_000]);
    expect(pages).toEqual([7_000]);
    expect((await store.taskSummaryPage(project.id)).tasks.map((t) => t.statusChangedAt)).toEqual([7_000]);
  });
});

describe('status change time migration', () => {
  it('backfills from the last lifecycle event that changed the status', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-status-changed-'));
    const dbPath = path.join(dir, 'karmax.db');
    try {
      const legacy = await Store.create(dbPath);
      const project = await legacy.createProject('Legacy');
      const make = (title: string) => legacy.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 't' } });
      const moved = await make('moved'), idle = await make('idle');
      const lifecycle = (ts: number, payload: Record<string, unknown>) => legacy.appendEvent({ taskId: moved.id, type: 'view.updated', ts,
        payload: { stage: 'do', status: 'active', waitingFor: null, agentTurn: null, ...payload } });
      await lifecycle(100, {});
      await lifecycle(200, { agentTurn: 'running' });
      await lifecycle(300, { status: 'waiting', waitingFor: 'human' });
      await lifecycle(400, { status: 'waiting', waitingFor: 'human', waitingDetail: 'again' });
      await legacy.db.exec('ALTER TABLE tasks DROP COLUMN statusChangedAt');
      await legacy.close();

      const migrated = await Store.create(dbPath);
      expect((await migrated.getTask(moved.id))!.statusChangedAt).toBe(300);
      expect((await migrated.getTask(idle.id))!.statusChangedAt).toBeUndefined();
      await migrated.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
