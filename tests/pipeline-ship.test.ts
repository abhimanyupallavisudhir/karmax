import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { ensureProjectWikiRepository } from '../src/wiki/repository.js';
import { worldRepoTarget } from '../src/world/types.js';
import { MERGE_QUEUE_WORKFLOW, SIG_ENQUEUE, SIG_RELEASE, mergeQueueId } from '../src/coordinators/names.js';

/**
 * Several branches per task (SPEC §11.1): ONE agent in ONE world, a checkout
 * per branch, and every branch landing as its own pull request on its own
 * timing. `open_pr({branch})` opens (or updates) one branch's pull request
 * while the agent keeps working; `open_pr` alone means it is finished. Each pull
 * request is a sub-task that reviews and lands a snapshot of the branch from a
 * worktree in the task's world — no second sandbox, no second agent: changes a
 * pull request needs come back to the one agent. The task is done once its
 * agent has finished and every pull request has settled.
 *
 * Real Temporal + git, mock agent. `@ship <name>` is `open_pr({ branch: name })`.
 */
describe('software-dev: every branch of a task lands as its own pull request', () => {
  let h: Harness;
  beforeAll(async () => { h = await bootHarness(); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  const view = (handle: { query: (name: string) => Promise<unknown> }) => handle.query('view') as Promise<any>;
  /** A task of a real project, so its pull requests are made and routed from records as in the product. */
  const start = async (repo: string, prompt: string) => {
    const config = { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false, multiPr: true };
    const project = await h.store.createProject(`Ship ${path.basename(repo)}`, config);
    const task = await h.store.createTask({ projectId: project.id, title: 'Docs and a feature', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt, multiPr: true }, createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.30.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{ taskId: task.id, projectId: project.id, title: task.title, prompt, base: 'main', target: 'main', project: config }],
    });
    return { taskId: task.id, handle };
  };
  /** The task's `n`th pull request, once it waits for a person's Review. */
  const pullRequest = async (handle: any, n: number) => {
    await expect.poll(async () => (await view(handle)).subTasks?.length ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
    const childId = (await view(handle)).subTasks[n - 1] as string;
    const child = h.client.workflow.getHandle(childId);
    await expect.poll(async () => { const v = await view(child); return `${v.stage}/${v.waitingFor?.kind}`; },
      { timeout: 30_000 }).toBe('review/human');
    return { childId, child };
  };
  const said = async (handle: any) => (await view(handle)).messages
    .filter((m: any) => m.role === 'agent').map((m: any) => m.text).join('\n');
  // Commit to the docs branch, as an agent must before its pull request opens.
  const docsCommit = "@run cd ../docs && mkdir -p docs && echo '# Guide' > docs/guide.md && git add -A && git commit -qm docs";

  it('one agent, one world: a pull request lands while the agent keeps working, then its last one', async () => {
    const repo = await h.makeRepo('ship-while-working');
    const gate = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-gate-')), 'go');
    const { taskId, handle } = await start(repo, [
      '@branch docs',
      docsCommit,
      '@ship docs',
      // The agent keeps working in the same turn while the docs pull request is reviewed.
      `@run while [ ! -f ${gate} ]; do sleep 0.2; done`,
      '@write feature.js :: export const feature = 1;',
      '@run git add -A && git commit -qm feature',
    ].join('\n'));
    try {
      const { childId, child } = await pullRequest(handle, 1);
      const pr = await view(child);
      expect(pr.branch).toBe(`tavya/${childId}`);
      expect(pr.targetBranch).toBe('main');
      expect(pr.parentTaskId).toBe(taskId);
      // It lands from a worktree in the task's own world: no world of its own.
      expect(pr.world.id).toBe(taskId);
      expect(pr.world.repos.map((r: any) => r.name)).toEqual(['docs']);
      expect(pr.world.repos[0].root).toContain(path.join('.karmax-injection', 'pull-requests', childId));
      expect(await h.store.currentWorld(childId)).toBeFalsy();
      // It is part of its task, not a task: no number, no row in the task list.
      expect((await h.store.getTask(childId))?.num ?? undefined).toBeUndefined();
      expect((await h.store.listTasksAsync((await h.store.getTask(taskId))!.projectId, false)).map((t) => t.id)).toEqual([taskId]);

      // The agent is still working.
      const parent = await view(handle);
      expect(parent.stage).toBe('do');
      expect(parent.agentTurn?.state).toBe('running');
      expect(parent.shipments).toEqual([expect.objectContaining({ checkout: 'docs', childTaskId: childId, state: 'open' })]);

      // The reviewer approves it; it lands while the agent still works.
      await child.signal('confirm');
      expect((await child.result()).stage).toBe('done');
      expect((await git(repo, ['show', 'main:docs/guide.md'])).stdout).toContain('# Guide');
      // Its snapshot worktree is gone from the world; its branch stays.
      const snapshot = pr.world.repos[0].root as string;
      expect(fs.existsSync(snapshot)).toBe(false);
      expect((await git(repo, ['worktree', 'list'])).stdout).not.toContain(snapshot);
      expect((await git(repo, ['rev-parse', '--verify', `tavya/${childId}`])).code).toBe(0);
      expect(await h.store.eventsOfType(taskId, 'pull-request.cleanup-failed')).toEqual([]);
      expect((await git(repo, ['log', '--oneline', 'main'])).stdout).toContain(`merge tavya/${childId} into main`);
      expect((await view(handle)).agentTurn?.state).toBe('running');

      // The agent finishes: the rest of its work — its own branch — goes
      // through the task's own Review, not as another pull request of its own.
      fs.writeFileSync(gate, '');
      await expect.poll(async () => { const v = await view(handle); return `${v.stage}/${v.waitingFor?.kind}`; },
        { timeout: 30_000 }).toBe('review/human');
      expect((await view(handle)).subTasks).toHaveLength(1);
      // Its Review is of its own work only: docs landed already.
      expect((await view(handle)).checkouts.map((c: any) => c.name)).not.toContain('docs');
      await handle.signal('confirm');
      expect((await handle.result()).stage).toBe('done');
      expect((await git(repo, ['show', 'main:feature.js'])).stdout).toContain('feature');
      expect((await git(repo, ['log', '--oneline', 'main'])).stdout).toContain(`merge tavya/${taskId} into main`);
      expect((await view(handle)).shipments.map((s: any) => s.state)).toEqual(['landed']);
      // Its branches stayed in its world throughout.
      expect((await view(handle)).checkouts.map((c: any) => c.name)).toContain('docs');
    } finally { fs.writeFileSync(gate, ''); }
  }, 150_000);

  it('a change Review asks for is made by the same agent in its own checkout, and the pull request lands with it', async () => {
    const repo = await h.makeRepo('ship-revise');
    const { taskId, handle } = await start(repo, ['@branch docs', docsCommit, '@ship docs', '@incomplete'].join('\n'));
    const { child } = await pullRequest(handle, 1);

    // The reviewer asks the pull request for more. It has no agent: the task's
    // agent gets the request, makes the change in its docs checkout and opens
    // the pull request again.
    await child.signal('followUp', { id: 'rv1', role: 'user', ts: 0, text: [
      "@run cd ../docs && echo '# FAQ' > docs/faq.md && git add -A && git commit -qm faq",
      '@ship docs',
      '@incomplete',
    ].join('\n') });
    await expect.poll(async () => (await view(handle)).messages.some((m: any) => m.role === 'user'
      && m.text.startsWith('Changes are needed in the pull request for "docs"')), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => said(handle), { timeout: 30_000 }).toMatch(/shipped: docs as /g);
    // Still one pull request, back at Review with the new commit.
    const { child: again } = await pullRequest(handle, 1);
    expect((await view(handle)).subTasks).toHaveLength(1);
    expect((await h.store.eventsOfType(taskId, 'agent.output')).some((e) => String(e.payload.text).includes('echo \'# FAQ\''))).toBe(true);
    await again.signal('confirm');
    expect((await again.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:docs/faq.md'])).code).toBe(0);
    expect((await git(repo, ['show', 'main:docs/guide.md'])).code).toBe(0);

    // Finishing with nothing new: no more pull requests, and the task is done.
    await handle.signal('followUp', { id: 'f1', role: 'user', ts: 0, text: 'That is all.' });
    expect((await handle.result()).stage).toBe('done');
    expect((await view(handle)).subTasks).toHaveLength(1);
  }, 150_000);

  it('opening a pull request again before Review updates it; after it lands, the branch opens a new one', async () => {
    const repo = await h.makeRepo('ship-again');
    const { handle } = await start(repo, [
      '@branch docs',
      docsCommit,
      '@ship docs',
      "@run cd ../docs && echo more >> docs/guide.md && git commit -qam more",
      '@ship docs',
      '@incomplete',
    ].join('\n'));
    await expect.poll(async () => said(handle), { timeout: 30_000 }).toMatch(/shipped: docs as .*\n.*\n.*shipped: docs as /);
    expect((await view(handle)).subTasks).toHaveLength(1);
    // Review is of the commit the agent opened it at last.
    const docsBranch = (await view(handle)).checkouts.find((c: any) => c.name === 'docs').branch;
    const head = (await git(repo, ['rev-parse', docsBranch])).stdout.trim();
    await expect.poll(async () => (await h.store.eventsOfType((await view(handle)).taskId, 'pull-request.snapshot'))
      .some((event) => (event.payload as any).head === head), { timeout: 30_000 }).toBe(true);
    const { child } = await pullRequest(handle, 1);
    await child.signal('confirm');
    expect((await child.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:docs/guide.md'])).stdout).toContain('more');

    // Later in the same session the agent adds to the branch: it must take in
    // what landed first, and then it is a new pull request.
    await handle.signal('followUp', { id: 'f1', role: 'user', ts: 0, text: [
      "@run cd ../docs && echo faq > faq.md && git add -A && git commit -qm faq",
      '@ship docs',
      '@incomplete',
    ].join('\n') });
    await expect.poll(async () => said(handle), { timeout: 30_000 }).toMatch(/ship refused: bring "docs" up to date with main/);
    await handle.signal('followUp', { id: 'f2', role: 'user', ts: 0, text: [
      '@run cd ../docs && git merge -q --no-edit main',
      '@ship docs',
      '@incomplete',
    ].join('\n') });
    const { child: second } = await pullRequest(handle, 2);
    await second.signal('confirm');
    expect((await second.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:faq.md'])).code).toBe(0);
    await handle.signal('cancel');
    await handle.result();
  }, 150_000);

  it('a pull request closed without landing leaves the world, and its branch is not proposed again unchanged', async () => {
    const repo = await h.makeRepo('ship-cancelled');
    const { taskId, handle } = await start(repo, ['@branch docs', docsCommit, '@ship docs', '@incomplete'].join('\n'));
    const { childId, child } = await pullRequest(handle, 1);
    const snapshot = (await view(child)).world.repos[0].root as string;
    expect(fs.existsSync(snapshot)).toBe(true);
    await child.signal('cancel');
    expect((await child.result()).stage).toBe('cancelled');
    expect(fs.existsSync(snapshot)).toBe(false);
    expect((await git(repo, ['worktree', 'list'])).stdout).not.toContain(snapshot);
    expect(await h.store.eventsOfType(taskId, 'pull-request.cleanup-failed')).toEqual([]);
    // The agent is told; when it finishes, the unchanged branch is not reopened.
    await expect.poll(async () => (await view(handle)).messages.some((m: any) => m.role === 'user'
      && m.text.includes(`(sub-task ${childId}) closed without landing`)), { timeout: 30_000 }).toBe(true);
    expect((await handle.result()).stage).toBe('done');
    expect((await view(handle)).subTasks).toHaveLength(1);
    expect((await git(repo, ['show', 'main:docs/guide.md'])).code).not.toBe(0);
  }, 120_000);

  it('Finish replaces Cancel once something landed: unapproved pull requests close, a landing one lands, then done', async () => {
    const repo = await h.makeRepo('ship-finish');
    const { handle } = await start(repo, ['@branch docs', docsCommit, '@ship docs', '@incomplete'].join('\n'));
    // Something else holds the merge slot, so an approved pull request waits in
    // its landing for as long as the test likes.
    const domain = `${repo}:main`;
    const holder = `holder-${path.basename(repo)}`;
    const queue = (signal: string) => h.client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
      workflowId: mergeQueueId(domain), taskQueue: TASK_QUEUE, args: [{ domain }], signal, signalArgs: [{ taskId: holder }] });
    const { child: docs } = await pullRequest(handle, 1);
    const actions = async () => ((await view(handle)).actions as any[]).map((action) => action.name);
    expect(await actions()).toContain('cancel');
    expect(await actions()).not.toContain('finish');
    await docs.signal('confirm');
    expect((await docs.result()).stage).toBe('done');
    await expect.poll(actions, { timeout: 30_000 }).toContain('finish');
    expect(await actions()).not.toContain('cancel');

    // Two more pull requests: api is approved and waits in its landing; cli
    // waits for its Review.
    await handle.signal('followUp', { id: 'f1', role: 'user', ts: 0, text: [
      '@branch api',
      "@run cd ../api && echo 'export const api = 1;' > api.js && git add -A && git commit -qm api",
      '@ship api',
      '@branch cli',
      "@run cd ../cli && echo 'export const cli = 1;' > cli.js && git add -A && git commit -qm cli",
      '@ship cli',
      '@incomplete',
    ].join('\n') });
    const { child: api } = await pullRequest(handle, 2);
    const { child: cli } = await pullRequest(handle, 3);
    const holding = await h.client.workflow.start('pingWorkflow', { taskQueue: TASK_QUEUE, workflowId: holder, args: ['hold'] });
    try {
      await queue(SIG_ENQUEUE);
      await expect.poll(async () => ((await h.client.workflow.getHandle(mergeQueueId(domain)).query('queue')) as any).current,
        { timeout: 20_000 }).toBe(holder);
      await api.signal('confirm');
      await expect.poll(async () => (await view(api)).stage, { timeout: 30_000 }).toBe('merge');

      await handle.signal('finish');
      // The unapproved one closes; the task waits for the landing one, and says so.
      expect((await cli.result()).stage).toBe('cancelled');
      await expect.poll(async () => (await view(handle)).waitingFor?.detail, { timeout: 30_000 })
        .toMatch(/Finishing: waiting for the pull request for "api" to land or close/);
      expect((await view(handle)).status).not.toBe('done');
      expect((await view(api)).stage).toBe('merge');

      await queue(SIG_RELEASE);
      expect((await api.result()).stage).toBe('done');
      expect((await handle.result()).stage).toBe('done');
      expect((await git(repo, ['show', 'main:api.js'])).code).toBe(0);
      expect((await git(repo, ['show', 'main:cli.js'])).code).not.toBe(0);
      expect((await view(handle)).reviewInfo?.summary).toMatch(/Landed: "docs", "api"\. Closed without landing: "cli"\./);
    } finally {
      await queue(SIG_RELEASE).catch(() => undefined);
      await holding.signal('finish').catch(() => undefined);
    }
  }, 180_000);

  it('finishing waits for the pull requests still open, then proposes the rest through the task\'s own Review', async () => {
    const repo = await h.makeRepo('ship-done-waits');
    const { taskId, handle } = await start(repo, [
      '@branch docs',
      docsCommit,
      '@ship docs',
      '@write feature.js :: export const feature = 1;',
      '@run git add -A && git commit -qm feature',
    ].join('\n'));
    const { child: docs } = await pullRequest(handle, 1);
    // The agent finished while docs is in review: the task waits for it, and says so.
    await expect.poll(async () => (await view(handle)).waitingFor?.detail, { timeout: 30_000 })
      .toBe('Waiting for the pull request for "docs" to land');
    expect((await view(handle)).stage).toBe('do');
    await docs.signal('confirm');
    expect((await docs.result()).stage).toBe('done');
    await expect.poll(async () => { const v = await view(handle); return `${v.stage}/${v.waitingFor?.kind}`; },
      { timeout: 30_000 }).toBe('review/human');
    expect((await view(handle)).subTasks).toHaveLength(1);
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:docs/guide.md'])).code).toBe(0);
    expect((await git(repo, ['show', 'main:feature.js'])).code).toBe(0);
    expect((await git(repo, ['log', '--oneline', 'main'])).stdout).toContain(`merge tavya/${taskId} into main`);
  }, 150_000);

  it('a task across several repositories lands them together through one Review (task #644)', async () => {
    const front = await h.makeRepo('ship-together-front');
    const back = await h.makeRepo('ship-together-back');
    const config = { repos: [front, back], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false, multiPr: true };
    const project = await h.store.createProject('Ship together', config);
    const prompt = [
      `@write ${path.basename(front)}/client.js :: export const call = 1;`,
      `@write ${path.basename(back)}/server.js :: export const serve = 1;`,
      `@run cd ../${path.basename(front)} && git add -A && git commit -qm client && cd ../${path.basename(back)} && git add -A && git commit -qm server`,
    ].join('\n');
    const task = await h.store.createTask({ projectId: project.id, title: 'Across repositories', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt, multiPr: true }, createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.30.0', { taskQueue: TASK_QUEUE, workflowId: task.id,
      args: [{ taskId: task.id, projectId: project.id, title: task.title, prompt, base: 'main', target: 'main', project: config }] });
    await expect.poll(async () => { const v = await view(handle); return `${v.stage}/${v.waitingFor?.kind}`; },
      { timeout: 30_000 }).toBe('review/human');
    expect((await view(handle)).subTasks ?? []).toHaveLength(0);
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(front, ['show', 'main:client.js'])).code).toBe(0);
    expect((await git(back, ['show', 'main:server.js'])).code).toBe(0);
    expect((await view(handle)).shipments ?? []).toHaveLength(0);
  }, 120_000);

  it('a sub-task\'s wiki pages land on its parent\'s wiki branch, and reach wiki main only through the parent\'s wiki pull request (pramana#39)', async () => {
    const repo = await h.makeRepo('ship-subtask-wiki');
    // Commit a page in this world's project-wiki checkout (a sibling of the code checkout).
    const note = (name: string) => `@run for d in ../*/; do case "$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" in */wiki/project/*) mkdir -p "$d/memories/${name}" && printf 'from ${name}' > "$d/memories/${name}/MEMORY.md" && git -C "$d" add -A && git -C "$d" commit -qm ${name};; esac; done`;
    const { taskId, handle } = await start(repo, `${note('parent')}\n@subtask Child :: ${note('child')}\n@incomplete`);
    const wiki = ensureProjectWikiRepository(h.contentDir, (await h.store.getTask(taskId))!.projectId);
    const parentBranch = `tavya/${taskId}`;
    try {
      // The sub-task (not a pull request of the parent) stacks its wiki on the parent's branch…
      await expect.poll(async () => (await view(handle)).subTasks?.length ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      const childId = (await view(handle)).subTasks[0] as string;
      const child = h.client.workflow.getHandle(childId);
      await expect.poll(async () => {
        const checkout = ((await view(child)).state?.recoveryWorld?.repos ?? []).find((r: any) => r.role === 'project-wiki');
        return checkout && [checkout.base, worldRepoTarget(checkout, '')];
      }, { timeout: 30_000 }).toEqual([parentBranch, parentBranch]);
      // …and lands there once approved, wherever its own pull requests are.
      for (let n = 0; n < 20 && (await view(child)).stage !== 'done'; n++) {
        const v = await view(child);
        const open = v.subTasks?.length ? v.subTasks.map((id: string) => h.client.workflow.getHandle(id)) : [child];
        for (const pr of open) {
          const pv = await view(pr).catch(() => undefined);
          if (pv?.stage === 'review' && pv.waitingFor?.kind === 'human') await pr.signal('confirm');
          if (pv?.stage === 'review' && pv.waitingFor?.kind === 'parent') await handle.signal('followUp', { id: `r${n}`, role: 'user', text: '@respond confirm', ts: 0 });
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      expect((await view(child)).stage).toBe('done');
      expect((await git(wiki, ['show', `${parentBranch}:memories/child/MEMORY.md`])).stdout).toContain('from child');
      expect((await git(wiki, ['show', 'main:memories/child/MEMORY.md'])).code).not.toBe(0);
      expect((await git(wiki, ['show', 'main:memories/parent/MEMORY.md'])).code).not.toBe(0);

      // The parent finishes: its wiki goes to main through the parent's own
      // Review, carrying both pages — not as a pull request of its own.
      await handle.signal('followUp', { id: 'done', role: 'user', text: '@openpr', ts: 0 });
      await expect.poll(async () => { const v = await view(handle); return `${v.stage}/${v.waitingFor?.kind}`; },
        { timeout: 60_000 }).toBe('review/human');
      await handle.signal('confirm');
      expect((await handle.result()).stage).toBe('done');
      expect((await view(handle)).shipments ?? []).toHaveLength(0);
      expect((await git(wiki, ['show', 'main:memories/parent/MEMORY.md'])).stdout).toContain('from parent');
      expect((await git(wiki, ['show', 'main:memories/child/MEMORY.md'])).stdout).toContain('from child');
    } finally {
      await handle.signal('cancel').catch(() => undefined);
    }
  }, 180_000);

  it('refuses what cannot open, and tells the agent why', async () => {
    const repo = await h.makeRepo('ship-refusals');
    const { handle } = await start(repo, [
      '@branch docs',
      '@run cd ../docs && echo draft > draft.md',
      '@ship docs',                      // uncommitted work
      '@branch empty',
      '@ship empty',                     // nothing to propose
      '@ship nope',                      // no such branch
      '@incomplete',
    ].join('\n'));
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 30_000 }).toBe('human');
    const text = await said(handle);
    expect(text).toMatch(/ship refused: .*docs.*uncommitted/i);
    expect(text).toMatch(/ship refused: .*empty.*no commits/i);
    expect(text).toMatch(/ship refused: .*no branch named "nope"/i);
    expect((await view(handle)).subTasks ?? []).toHaveLength(0);
    await handle.signal('cancel');
    await handle.result();
  }, 90_000);
});
