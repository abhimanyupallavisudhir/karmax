import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { bootHarness, Harness } from './helpers/harness.js';
import { git, gitOrThrow, ensureIdentity, defaultBranch } from '../src/world/git.js';
import { reconcileTasks } from '../src/platform/reconcile.js';
import { Store } from '../src/store/db.js';

describe('defaultBranch detection', () => {
  it("returns the repo's real default branch", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-db-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'trunk']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'x'), '1');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    expect(await defaultBranch(repo)).toBe('trunk');
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe('reconcileTasks (settle lost workflows on restart)', () => {
  it('marks a non-terminal task whose workflow is gone as failed', async () => {
    const store = new Store(':memory:');
    const p = store.createProject('P', {});
    const t = store.createTask({ projectId: p.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
    store.saveView(t.id, { taskId: t.id, title: 'T', workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 0 });
    const fakeClient: any = { workflow: { getHandle: () => ({ describe: async () => { throw new Error('not found'); } }) } };
    const r = await reconcileTasks(store, fakeClient);
    expect(r.settled).toBe(1);
    expect(store.getTask(t.id)!.lastView!.status).toBe('failed');
  });

  it('reconciles every attempt execution, including non-principal siblings', async () => {
    const store = new Store(':memory:');
    const p = store.createProject('P', {});
    const first = store.createTask({ projectId: p.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const second = store.createTask({ projectId: p.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'y' }, intentId: first.intentId });
    for (const t of [first, second]) {
      store.saveView(t.id, { taskId: t.id, title: 'T', workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 0 });
    }
    const fakeClient: any = { workflow: { getHandle: () => ({ describe: async () => { throw new Error('not found'); } }) } };
    const r = await reconcileTasks(store, fakeClient);
    expect(r.settled).toBe(2);
    expect(store.getTask(first.id)!.lastView!.status).toBe('failed');
    expect(store.getTask(second.id)!.lastView!.status).toBe('failed');
  });
});

describe('default branch + auto-review (real Temporal + git)', () => {
  let h: Harness;
  let base: string;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const J = (r: Response) => r.json() as Promise<any>;
  beforeAll(async () => {
    h = await bootHarness('mock');
    const gw = await h.startGateway();
    base = gw.url;
    token = ((await (await fetch(`${base}/api/session`)).json()) as any).token;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('detects the default branch, lands work there, and auto-builds review (files + agent msg)', async () => {
    // a repo whose default branch is "trunk", with NO base/target configured
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pe-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'trunk']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# pe\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    const project = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(), body: JSON.stringify({ name: 'PE', config: { repos: [repo] } }) }).then(J);
    const task = await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ workflow: 'software-dev', params: { prompt: '@write feature.js :: export const z = 42;\n@review wrote feature' } }),
    }).then(J);

    let v: any;
    for (let i = 0; i < 60; i++) {
      v = await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() }).then(J);
      if (v?.stage === 'review') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(v.stage).toBe('review');
    expect(v.targetBranch).toBe('trunk'); // detected, not "main"
    // auto-review attached from git — changed files only; diffs are intentionally
    // no longer part of the review packet (reviewers use the terminal / transcripts).
    expect(v.reviewInfo.changedFiles).toEqual(expect.arrayContaining(['feature.js (new)']));
    expect(v.reviewInfo.diff).toBeUndefined();
    // the agent's reply is in the conversation thread
    expect(v.messages.some((m: any) => m.role === 'agent')).toBe(true);
    // per-role transcripts are exposed (Phase 1): the Do conversation is always present
    expect(v.transcripts?.some((t: any) => t.role === 'do')).toBe(true);

    await fetch(`${base}/api/tasks/${task.id}/signal`, { method: 'POST', headers: auth(), body: JSON.stringify({ signal: 'confirm' }) });
    for (let i = 0; i < 60; i++) {
      v = await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() }).then(J);
      if (v?.stage === 'done') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const onTrunk = await git(repo, ['show', 'trunk:feature.js']);
    expect(onTrunk.stdout).toContain('export const z = 42');
    expect((await git(repo, ['rev-parse', '--verify', 'main'])).code).not.toBe(0); // no phantom "main"
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
