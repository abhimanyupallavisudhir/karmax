import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { bootHarness, type Harness } from './helpers/harness.js';
import { newId } from '../src/util/id.js';
import { git, gitOrThrow } from '../src/world/git.js';
import type { WorldHandle } from '../src/world/types.js';

// Real Temporal, activities, Git and checkpoints (andhbhakt/video-explainers #1):
// a task started in a project without a repository, which gains one mid-task.
describe('a repository attached while a task runs without one', () => {
  let h: Harness;
  let dir: string;
  beforeAll(async () => {
    // Hosted credentials for an enrolled repository come from the GitHub App;
    // here the host's Git configuration (below) reaches the repository.
    h = await bootHarness('mock', undefined, { checkpoints: true, githubApp: {
      status: () => ({ userAuthorized: false, oauthConfigured: false }),
      brokerCredentials: async () => ({ env: {} }),
    } as any });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-adoption-wf-'));
    // GitHub's SSH address of the attached repository resolves to a local bare one.
    fs.writeFileSync(path.join(dir, 'gitconfig'), `[url "file://${dir}/"]\n\tinsteadOf = git@github.com:andhbhakt/\n`);
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'gitconfig');
  }, 60_000);
  afterAll(async () => {
    delete process.env.GIT_CONFIG_GLOBAL;
    await h?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const view = async (taskId: string) => h.client.workflow.getHandle(taskId).query<any>('view');

  async function start(workflow: 'software-dev' | 'just-do', prompt: string) {
    const project = await h.store.createProject(newId('Videos'), { worldProvider: 'worktree', defaultBase: 'main' });
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const task = await h.api.createTask(token, { projectId: project.id, workflow, params: { prompt } });
    await expect.poll(async () => (await view(task.id)).stage, { timeout: 30_000 }).toBe('review');
    return { project, task, token };
  }

  async function attachRepository(projectId: string, name: string) {
    const source = await h.makeRepo(name);
    await gitOrThrow(dir, ['clone', '-q', '--bare', source, path.join(dir, `${name}.git`)]);
    const project = (await h.store.getProject(projectId))!;
    const repository = await h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      owner: 'andhbhakt', name, sshUrl: `git@github.com:andhbhakt/${name}.git`, defaultBranch: 'main', private: true });
    await h.store.attachProjectRepository({ projectId, repositoryId: repository.id });
    return path.join(dir, `${name}.git`);
  }

  it('adopts it at the next turn, opens its proposal and lands it', async () => {
    const { project, task } = await start('software-dev', '@write render/video.txt :: rendered\n@review Rendered');
    expect((await view(task.id)).branch).toBeUndefined();
    const bare = await attachRepository(project.id, 'explainers');
    const firstRun = (await h.client.workflow.getHandle(task.id).describe()).runId;

    // Any message reaches the agent's next turn, where the world adopts the repository.
    await h.client.workflow.getHandle(task.id).signal('followUp', { id: 'attached', role: 'user', ts: Date.now(),
      text: 'I attached the explainers repository.' });
    await expect.poll(async () => (await h.client.workflow.getHandle(task.id).describe()).runId, { timeout: 60_000 }).not.toBe(firstRun);
    await expect.poll(async () => (await view(task.id)).messages.some((message: any) => message.id.startsWith('repos-')),
      { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => (await view(task.id)).agentTurn, { timeout: 60_000 }).toBeUndefined();
    await h.client.workflow.getHandle(task.id).signal('followUp', { id: 'move', role: 'user', ts: Date.now(),
      text: '@run mkdir -p explainers/media && mv render/video.txt explainers/media/ && cd explainers && git add -A && git commit -qm "Add video"\n@openpr' });
    await expect.poll(async () => {
      const current = await view(task.id);
      return current.messages.some((message: any) => message.text.includes('ran: mkdir -p explainers/media')) && current.stage;
    }, { timeout: 60_000 }).toBe('review');
    const review = await view(task.id);
    // A new run, a task with repositories: a branch, and Review of its proposal.
    expect(review.branch).toBe(`tavya/${task.id}`);
    const note = review.messages.find((message: any) => message.id.startsWith('repos-'));
    expect(note?.text).toContain('`explainers/`');
    expect(note?.text).toContain('`open_pr` now opens a pull request');
    expect(review.messages.map((message: any) => message.text).join('\n')).toContain('ran: mkdir -p explainers/media');
    const world = (await h.store.currentWorld(task.id)) as WorldHandle;
    expect(world.workdir).toBe(world.root);
    expect(world.repos?.map((repo) => repo.name)).toEqual(['explainers']);

    await h.client.workflow.getHandle(task.id).signal('confirm');
    await expect.poll(async () => (await view(task.id)).stage, { timeout: 60_000 }).toBe('done');
    const landed = await git(dir, ['--git-dir', bare, 'show', 'main:media/video.txt']);
    expect(landed.stdout.trim()).toBe('rendered');

    // Both runs replay against the code that recorded them.
    const workflowsPath = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
    await Worker.runReplayHistory({ workflowsPath }, await h.client.workflow.getHandle(task.id, firstRun).fetchHistory());
    await Worker.runReplayHistory({ workflowsPath }, await h.client.workflow.getHandle(task.id).fetchHistory());
  }, 180_000);

  it('keeps a repo-less task\'s files at Confirm, and Continue starts from them', async () => {
    const { task, token } = await start('software-dev', '@write render/video.txt :: rendered\n@review Rendered');
    const root = ((await h.store.currentWorld(task.id)) as WorldHandle).root;
    await h.client.workflow.getHandle(task.id).signal('confirm');
    expect(await h.client.workflow.getHandle(task.id).result()).toEqual({ stage: 'done' });
    const done = await view(task.id);
    expect(done.reviewInfo.summary).toMatch(/no repository merge required\. Saved its 1 file for 30 days: Continue starts from them\./);
    expect(fs.existsSync(root)).toBe(false);
    const saved = (await h.store.currentWorld(task.id))!;
    expect(saved.checkpointId).toBeTruthy();
    const history = await h.client.workflow.getHandle(task.id).fetchHistory();
    const scheduled = history.events!.flatMap((e) => e.activityTaskScheduledEventAttributes?.activityType?.name ?? []);
    expect(scheduled.indexOf('keepFinalWorkspace')).toBeLessThan(scheduled.indexOf('destroyWorld'));

    const next = await h.api.continueTask(token, task.id, { text: '@run cat render/video.txt\n@review Continued' });
    await expect.poll(async () => (await view(next.id).catch(() => undefined))?.stage, { timeout: 60_000 }).toBe('review');
    expect((await view(next.id)).messages.map((message: any) => message.text).join('\n')).toContain('ran: cat render/video.txt (exit 0)');
    await h.client.workflow.getHandle(next.id).signal('cancel');
  }, 180_000);

  it('saves a just-do task whose project gained a repository after it started', async () => {
    const { project, task } = await start('just-do', '@write reports/result.md :: reviewed report');
    await attachRepository(project.id, 'reports');
    await h.client.workflow.getHandle(task.id).signal('confirm');
    expect(await h.client.workflow.getHandle(task.id).result()).toEqual({ stage: 'done' });
    expect((await h.store.currentWorld(task.id))!.checkpointId).toBeTruthy();
  }, 120_000);
});
