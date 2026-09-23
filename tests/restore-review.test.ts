import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { worldRepos, type WorldHandle } from '../src/world/types.js';

let h: Harness;
let base: string;
let token: string;
const headers = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
beforeAll(async () => {
  h = await bootHarness();
  base = (await h.startGateway()).url;
  token = ((await (await fetch(`${base}/api/session`)).json()) as any).token;
}, 60_000);
afterAll(async () => { await h?.stop(); });

it('restores Review over HTTP while the cancelled Temporal execution is still closing', async () => {
  const repo = await h.makeRepo('restore-review');
  const project = await h.store.createProject('Restore Review', {
    repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false,
  });
  const created = await fetch(`${base}/api/projects/${project.id}/tasks`, {
    method: 'POST', headers: headers(), body: JSON.stringify({
      title: 'Preserve my proposal', workflow: 'software-dev',
      prompt: '@write preserved.txt :: preserved proposal\n@review ready for review',
    }),
  });
  expect(created.status).toBe(200);
  const task = await created.json() as any;
  const current = async () => (await h.store.getTask(task.id))!;
  await expect.poll(async () => (await current()).lastView?.stage, { timeout: 20_000 }).toBe('review');
  const before = (await current()).lastView!;
  const originalRun = (await h.client.workflow.getHandle(task.id).describe()).runId;
  const original = h.client.workflow.getHandle(task.id, originalRun);

  // Hold the publication activity after the terminal snapshot is durable but
  // before cleanup/closure. This reproduces a slow cloud checkpoint without a
  // real cloud account or timing-dependent sleeps.
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const published = new Promise<void>(resolve => { entered = resolve; });
  const saveView = h.store.saveView.bind(h.store);
  const save = vi.spyOn(h.store, 'saveView').mockImplementation(async (...args) => {
    const result = await saveView(...args);
    if (args[0] === task.id && args[1].status === 'cancelled') { entered(); await gate; }
    return result;
  });
  const start = vi.spyOn(h.client.workflow, 'start');
  let restore: Promise<Response> | undefined;
  try {
    const cancelled = await fetch(`${base}/api/tasks/${task.id}/signal`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ signal: 'cancel' }),
    });
    expect(cancelled.status).toBe(200);
    await published;
    expect((await original.describe()).status.name).toBe('RUNNING');
    restore = fetch(`${base}/api/tasks/${task.id}/stage`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ target: 'review' }),
    });
    let replied = false;
    void restore.then(() => { replied = true; });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(replied).toBe(false);
    expect(start).not.toHaveBeenCalled();
    release();
    expect((await restore).status).toBe(200);
    await expect.poll(async () => (await current()).lastView?.stage, { timeout: 20_000 }).toBe('review');
    expect((await original.describe()).status.name).toBe('COMPLETED');
    const restored = await current();
    expect(restored.params._workflowRunId).not.toBe(originalRun);
    expect(restored.lastView!.messages).toEqual(before.messages);
    expect(restored.lastView!.reviewInfo?.changedFiles).toContain('preserved.txt');
    expect(fs.readFileSync(path.join(worldRepos(restored.lastView!.world as WorldHandle).find(repo => !repo.role)!.root, 'preserved.txt'), 'utf8')).toContain('preserved proposal');
    expect(start).toHaveBeenCalledOnce();
  } finally {
    release();
    await restore;
    save.mockRestore();
    start.mockRestore();
    await h.client.workflow.getHandle(task.id).signal('cancel');
    await h.client.workflow.getHandle(task.id).result();
  }
}, 60_000);
