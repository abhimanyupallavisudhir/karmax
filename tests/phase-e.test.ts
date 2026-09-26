import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { bootHarness, Harness } from './helpers/harness.js';
import { git, gitOrThrow, ensureIdentity, defaultBranch } from '../src/world/git.js';
import { reconcileTasks } from '../src/platform/reconcile.js';
import { WorkflowFailedError } from '@temporalio/client';
import { TerminatedFailure } from '@temporalio/common';
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
  it('reads only unsettled attempt metadata without conversations', async () => {
    const store = await Store.create(':memory:');
    const p = await store.createProject('P', {});
    const live = await store.createTask({ projectId: p.id, title: 'Live', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    const done = await store.createTask({ projectId: p.id, title: 'Done', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    const draft = await store.createTask({ projectId: p.id, title: 'Draft', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture', draft: true } });
    await store.saveView(done.id, { taskId: done.id, title: done.title, workflow: done.workflow,
      stage: 'done', status: 'done', messages: [], actions: [], state: {}, updatedAt: 1 });
    const sql: string[] = [];
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((query: string) => { sql.push(query); return prepare(query); }) as typeof store.db.prepare;
    try {
      expect((await store.listReconciliationCandidates(p.id)).map((task) => task.id)).toEqual([live.id]);
      expect(sql.some((query) => /FROM tasks WHERE projectId=\?/.test(query) && !/SELECT \*/.test(query)
        && !/conversation/.test(query.toLowerCase()))).toBe(true);
    } finally { await store.close(); }
  });

  it('bounds concurrent workflow describes during reconciliation', async () => {
    const store = await Store.create(':memory:');
    const p = await store.createProject('P', {});
    for (let i = 0; i < 12; i++) await store.createTask({ projectId: p.id, title: `T${i}`,
      workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    let active = 0, peak = 0;
    const client: any = { workflow: { getHandle: () => ({ describe: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { status: { name: 'RUNNING' } };
    } }) } };
    try {
      expect((await reconcileTasks(store, client)).checked).toBe(12);
      expect(peak).toBe(8);
    } finally { await store.close(); }
  });

  it('preserves the server termination reason without fetching the full history', async () => {
    const store = (await Store.create(':memory:'));
    const p = (await store.createProject('P', {}));
    const t = (await store.createTask({ projectId: p.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: 'x' } }));
    (await store.saveView(t.id, { taskId: t.id, title: 'T', workflow: 'software-dev', stage: 'merge', status: 'active',
      messages: [], actions: [], state: {}, updatedAt: 0 }));
    const handles: (string | undefined)[] = [];
    const client: any = { workflow: { getHandle: (_id: string, runId?: string) => {
      handles.push(runId);
      return {
        describe: async () => ({ status: { name: 'TERMINATED' }, runId: 'terminated-run' }),
        result: async () => { throw new WorkflowFailedError('Workflow execution failed',
          new TerminatedFailure('Workflow history size exceeds limit.'), 'NON_RETRYABLE_FAILURE'); },
      };
    } } };
    try {
      expect((await reconcileTasks(store, client)).settled).toBe(1);
      expect(handles).toEqual([undefined, 'terminated-run']);
      expect((await store.getTask(t.id))?.lastView?.error).toBe('workflow terminated: Workflow history size exceeds limit.');
    } finally { (await store.close()); }
  });

  it('marks a non-terminal task whose workflow is gone as failed', async () => {
    const store = (await Store.create(':memory:'));
    const p = (await store.createProject('P', {}));
    const t = (await store.createTask({ projectId: p.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    (await store.saveView(t.id, { taskId: t.id, title: 'T', workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 0 }));
    const fakeClient: any = { workflow: { getHandle: () => ({ describe: async () => { throw new Error('not found'); } }) } };
    const r = await reconcileTasks(store, fakeClient);
    expect(r.settled).toBe(1);
    expect((await store.getTask(t.id))!.lastView!.status).toBe('failed');
  });

  it('reconciles every attempt execution, including non-principal siblings', async () => {
    const store = (await Store.create(':memory:'));
    const p = (await store.createProject('P', {}));
    const first = (await store.createTask({ projectId: p.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const second = (await store.createTask({ projectId: p.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'y' }, intentId: first.intentId }));
    for (const t of [first, second]) {
      (await store.saveView(t.id, { taskId: t.id, title: 'T', workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 0 }));
    }
    const fakeClient: any = { workflow: { getHandle: () => ({ describe: async () => { throw new Error('not found'); } }) } };
    const r = await reconcileTasks(store, fakeClient);
    expect(r.settled).toBe(2);
    expect((await store.getTask(first.id))!.lastView!.status).toBe('failed');
    expect((await store.getTask(second.id))!.lastView!.status).toBe('failed');
  });

  it('settles a running Setup whose live workflow already received cancellation', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Hosted', ownerUserId: 'owner' }));
    const p = (await store.createProject('P', {}, organization.id));
    const t = (await store.createTask({ projectId: p.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.25.0', params: { prompt: 'x' } }));
    const setup = { taskId: t.id, title: 'T', workflow: 'software-dev', stage: 'setup' as const,
      status: 'active' as const, messages: [], actions: [], state: {}, updatedAt: 0 };
    (await store.saveView(t.id, setup));
    (await store.createRunnerPool({ id: 'pool', organizationId: organization.id, name: 'Pool', provider: 'e2b',
      mode: 'managed', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true }));
    const lease = (await store.requestWorldLease({ runnerPoolId: 'pool', organizationId: organization.id,
      projectId: p.id, taskId: t.id, worldId: t.id }));
    const terminated: string[] = [];
    const fakeClient: any = { workflow: { getHandle: () => ({
      describe: async () => ({ status: { name: 'RUNNING' } }),
      query: async () => ({ ...setup, state: { cancelled: true } }),
      terminate: async (reason: string) => { terminated.push(reason); },
    }) } };

    const r = await reconcileTasks(store, fakeClient);

    expect(r.settled).toBe(1);
    expect(terminated).toEqual(['cancelled Setup did not settle']);
    expect((await store.getTask(t.id))?.lastView).toMatchObject({ stage: 'cancelled', status: 'cancelled' });
    expect((await store.worldLease(lease.id))?.state).toBe('released');
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
    // Open PR requires a clean committed proposal, so the file is tracked by the
    // time Review describes the exact proposed head.
    expect(v.reviewInfo.changedFiles).toEqual(expect.arrayContaining(['feature.js']));
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
