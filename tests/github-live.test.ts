import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git, gitOrThrow } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { GithubPrApi, githubSlug } from '../src/integrations/github-pr.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * The pull-request integration against **real GitHub**. `github-pr.test.ts` and
 * `github-pr-pipeline.test.ts` validate the same flow against a stub endpoint;
 * this one validates it against api.github.com, which is what catches API drift,
 * auth problems, and the behaviors a stub cannot fake — GitHub deciding on its
 * own that a PR is `merged` once its commits reach the base branch, its 422 on a
 * duplicate head, and whether the branch push actually authenticates.
 *
 * It requires `KARMAX_RUN_LIVE=1` and a GitHub token
 * (same switch as `live-agent.test.ts` / `cloud-live.test.ts`). It touches a real
 * account: one dedicated **private** repository, reused across runs and left in
 * place (deleting it would need a `delete_repo` token scope this deliberately
 * does not ask for). Each run cleans up after itself — the task branch is
 * deleted and no pull request is left open.
 */

const pexec = promisify(execFile);
const REPO_NAME = 'karmax-e2e-tests';
const skipLive = !liveEnabled();

/** The host's GitHub token, however it is stored (env, then the `gh` login). */
async function hostToken(): Promise<string | undefined> {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try { return (await pexec('gh', ['auth', 'token'], { timeout: 15_000 })).stdout.trim() || undefined; }
  catch { return undefined; }
}

const token = skipLive ? undefined : await hostToken();

describe.skipIf(skipLive || !token)('GitHub pull requests against real GitHub', () => {
  let h: Harness;
  let dir: string;
  let slug: string;
  /** The fixture's own default branch — discovered, never assumed: a repo made
   *  on a host whose `init.defaultBranch` is `master` has no `main` at all. */
  let mainBranch: string;
  let api: GithubPrApi;
  const branches: string[] = [];

  /** The dedicated private test repository, created on first use. Returns its
   *  `owner/name` and guarantees a default branch with at least one commit. */
  async function ensureTestRepo(): Promise<string> {
    const login = (await pexec('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
    const full = `${login}/${REPO_NAME}`;
    try {
      await pexec('gh', ['repo', 'view', full], { timeout: 30_000 });
    } catch {
      await pexec('gh', ['repo', 'create', full, '--private', '--add-readme',
        '--description', 'Disposable fixture for karmax live PR tests. Safe to delete.'], { timeout: 60_000 });
    }
    return full;
  }

  beforeAll(async () => {
    process.env.GH_TOKEN = token!;
    slug = await ensureTestRepo();
    mainBranch = (await pexec('gh', ['repo', 'view', slug, '--json', 'defaultBranchRef',
      '--jq', '.defaultBranchRef.name'], { timeout: 30_000 })).stdout.trim();
    expect(mainBranch).toBeTruthy();
    expect(githubSlug(`git@github.com:${slug}.git`)).toBe(slug);
    api = new GithubPrApi(token!);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-gh-live-'));
    h = await bootHarness('mock');
  }, 240_000);

  afterAll(async () => {
    // Never leave the fixture repo dirty: close any PR this run opened and drop
    // its branch, so a rerun starts from the same state.
    for (const branch of branches) {
      const pr = await api.findByHead(slug, branch).catch(() => undefined);
      if (pr && pr.state === 'open') await api.update(slug, pr.number, { state: 'closed' }).catch(() => undefined);
      await pexec('gh', ['api', '-X', 'DELETE', `/repos/${slug}/git/refs/heads/${branch}`], { timeout: 30_000 })
        .catch(() => undefined);
    }
    delete process.env.GH_TOKEN;
    await h?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  /** A clone of the fixture repo, which is what the task's world branches from —
   *  so `origin` is the real GitHub remote and every push is a real push. */
  async function cloneFixture(name: string): Promise<string> {
    const local = path.join(dir, name);
    await gitOrThrow(dir, ['clone', '-q', `git@github.com:${slug}.git`, local]);
    await git(local, ['config', 'user.name', 'karmax-live-test']);
    await git(local, ['config', 'user.email', 'karmax-live-test@localhost']);
    return local;
  }

  it('opens, updates and closes a real pull request through the REST client', async () => {
    const local = await cloneFixture('client');
    const branch = `tavya/${newId('task')}`;
    branches.push(branch);
    await gitOrThrow(local, ['checkout', '-q', '-b', branch]);
    fs.writeFileSync(path.join(local, `${branch.split('/')[1]}.txt`), 'client round-trip\n');
    await gitOrThrow(local, ['add', '-A']);
    await gitOrThrow(local, ['commit', '-q', '-m', 'karmax live client test']);
    await gitOrThrow(local, ['push', '-q', '-u', 'origin', branch]);

    const opened = await api.openOrUpdate(slug, { head: branch, base: mainBranch, title: 'karmax live: client', body: 'first' });
    expect(opened.created).toBe(true);
    expect(opened.pr.state).toBe('open');
    expect(opened.pr.head).toBe(branch);

    // The idempotency guarantee, against GitHub's real 422 on a duplicate head:
    // the second call must adopt and update the same PR, never open a second.
    const again = await api.openOrUpdate(slug, { head: branch, base: mainBranch, title: 'karmax live: client (v2)', body: 'second' });
    expect(again.created).toBe(false);
    expect(again.pr.number).toBe(opened.pr.number);
    expect(again.pr.title).toBe('karmax live: client (v2)');

    await api.comment(slug, opened.pr.number, 'karmax live test comment');
    await api.update(slug, opened.pr.number, { state: 'closed' });
    expect((await api.get(slug, opened.pr.number)).state).toBe('closed');

    // A closed-unmerged PR is reopened rather than duplicated: the task is live again.
    const reopened = await api.openOrUpdate(slug, { head: branch, base: mainBranch, title: 'karmax live: client', body: 'third' });
    expect(reopened.created).toBe(false);
    expect(reopened.pr.number).toBe(opened.pr.number);
    expect(reopened.pr.state).toBe('open');
  }, 180_000);

  it('runs the whole PR stage against GitHub: branch pushed, PR opened, reconciled after the merge', async () => {
    const local = await cloneFixture('pipeline');
    const taskId = newId('task');
    const branch = `tavya/${taskId}`;
    branches.push(branch);
    const file = `${taskId}.js`;

    const handle = await h.client.workflow.start('softwareDev@1.8.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId,
        projectId: 'p1',
        title: `karmax live: ${taskId}`,
        // A competent Do agent commits its own work (wiki plans/PLAN-git-config §2.2), which
        // is what gives the PR stage something to propose.
        prompt: `Implement it.\n@write ${file} :: export const live = true;\n`
          + `@run git add -A && git commit -q -m "karmax live: add ${file}"\n`
          + `@review Added ${file} in a live PR test.`,
        base: mainBranch,
        target: mainBranch,
        project: { repos: [local], defaultBase: mainBranch, defaultTarget: mainBranch, remote: 'pr' },
      }],
    });

    await expect.poll(async () => (await handle.query('view') as any).stage, { timeout: 60_000 }).toBe('review');
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');

    const view = await handle.query('view') as any;
    expect(view.prs).toHaveLength(1);
    const ref = view.prs[0];
    expect(ref.slug).toBe(slug);

    // The pull request really exists on GitHub, headed by the task branch…
    const live = await api.get(slug, ref.number);
    expect(live.head).toBe(branch);
    expect(live.base).toBe(mainBranch);
    expect(live.title).toBe(`karmax live: ${taskId}`);
    // …the task branch really reached origin…
    const remoteBranch = await pexec('gh', ['api', `/repos/${slug}/git/refs/heads/${branch}`, '--jq', '.ref']);
    expect(remoteBranch.stdout.trim()).toBe(`refs/heads/${branch}`);
    // …the work really landed on the default branch…
    const onMain = await pexec('gh', ['api', `/repos/${slug}/contents/${file}?ref=${mainBranch}`, '--jq', '.name']);
    expect(onMain.stdout.trim()).toBe(file);
    // …and the PR was reconciled with that outcome rather than left dangling.
    // GitHub marks it merged by itself once the commits reach the base; either way it
    // must end up not-open, with karmax's outcome comment on it.
    expect(live.state).toBe('closed');
    expect(ref.state).toBe('closed');
    const comments = await pexec('gh', ['api', `/repos/${slug}/issues/${ref.number}/comments`, '--jq', '.[].body']);
    expect(comments.stdout).toMatch(/tavya/i);
    expect(comments.stdout).toContain(mainBranch);
  }, 300_000);
});
