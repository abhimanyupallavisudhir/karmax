import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git, gitOrThrow } from '../src/world/git.js';

// pramana#56 end to end: real Temporal, worktree worlds holding a writable
// resource saved by real restic, and three tasks that forked the same
// version. A file two of them changed in different places merges line by
// line; a file both changed on the same line goes to the agent, both at
// Confirm (the other task published after this one's Review) and before
// Review (it published while this one worked). Nobody presses Retry.

let h: Harness;
beforeAll(async () => { h = await bootHarness('mock'); }, 60_000);
afterAll(async () => { await h?.stop(); });

const view = (handle: { query<T>(name: string): Promise<T> }) => handle.query<any>('view');
const lines = (...values: string[]) => values.map((value) => `${value}\n`).join('');

it('combines conflicting resource files through the agent, at Confirm and before Review', async () => {
  const repo = await h.makeRepo('resource-conflict');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'raw_data/\n');
  await git(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-qm', 'ignore the data']);
  const project = await h.store.createProject('resource-conflict', { repos: [repo] });
  const data = await h.store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Raw data', driver: 'volume@1', target: { kind: 'path', path: 'raw_data' }, access: 'write',
    isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
  await h.resources.importFiles(data.id, [
    { path: 'index.txt', data: Buffer.from(lines('v1')) },
    { path: 'notes.txt', data: Buffer.from(lines('a', 'b', 'c', 'd', 'e')) },
  ]);
  const gate = path.join(repo, '..', `resource-conflict-go-${Date.now()}`);
  const start = async (title: string, steps: string[]) => {
    const prompt = [...steps, `@write ${title}.txt :: ${title}`, `@run git add ${title}.txt && git commit -qm ${title}`].join('\n');
    const task = await h.store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt } });
    const handle = await h.client.workflow.start('softwareDev@1.30.0', {
      taskQueue: TASK_QUEUE, workflowId: task.id,
      args: [{ taskId: task.id, projectId: project.id, title, prompt, base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }],
    });
    return { task, handle };
  };
  const inReview = (handle: any) => expect.poll(async () => {
    const current = await view(handle);
    return `${current.stage}/${current.waitingFor?.kind}`;
  }, { timeout: 120_000 }).toBe('review/human');
  const done = (handle: any) => expect.poll(async () => (await view(handle)).stage, { timeout: 180_000 }).toBe('done');
  const published = async () => {
    const revision = (await h.store.getResourceAttachment(data.id))!.currentRevisionId!;
    const files = (await h.resources.verifyRevision(project.id, data.id, revision, 0, 100)).files;
    const reader = (await h.store.getResourceRevision(revision))!;
    return { revision: reader, paths: files.map((file) => file.path).sort() };
  };
  const contents = async () => {
    // What a new task would get.
    const reader = await start('reader', []);
    await inReview(reader.handle);
    const world = (await h.store.currentWorld(reader.task.id))!;
    const root = path.join(world.workdir ?? world.root, 'raw_data');
    const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
    const out = { index: read('index.txt'), notes: read('notes.txt') };
    await reader.handle.signal('cancel');
    return out;
  };

  const confirmLater = await start('confirm-later', ['@write raw_data/index.txt ::two\\n', '@write raw_data/notes.txt ::a\\nb\\nc\\nd\\nE\\n']);
  const reviewLater = await start('review-later', [`@run while [ ! -e ${gate} ]; do sleep 0.2; done`, '@write raw_data/index.txt ::three\\n']);
  await inReview(confirmLater.handle);
  // Both have forked v1. A third task publishes first.
  const first = await start('first', ['@write raw_data/index.txt ::one\\n', '@write raw_data/notes.txt ::A\\nb\\nc\\nd\\ne\\n']);
  await inReview(first.handle);
  await first.handle.signal('confirm');
  await done(first.handle);

  // At Confirm: notes.txt merges line by line, index.txt goes to the agent.
  await confirmLater.handle.signal('confirm');
  await done(confirmLater.handle);
  const confirmed = await view(confirmLater.handle);
  const asked = confirmed.messages.find((m: any) => m.text.startsWith('This task is confirmed, but publishing its resources needs you first.'));
  expect(asked?.text).toContain('- index.txt (both edited it; the line merge conflicts)');
  expect(asked?.text).not.toContain('notes.txt');
  expect(confirmed.messages.some((m: any) => m.role === 'agent' && /combined resource files/.test(m.text))).toBe(true);
  expect(confirmed.messages.some((m: any) => /Could not publish resources/.test(m.text ?? ''))).toBe(false);
  expect(await contents()).toEqual({ index: lines('one'), notes: lines('A', 'b', 'c', 'd', 'E') });

  // Before Review: the other task's version is merged in first; its conflict goes to the agent.
  fs.writeFileSync(gate, '');
  await inReview(reviewLater.handle);
  const reviewed = await view(reviewLater.handle);
  const before = reviewed.messages.find((m: any) => m.text.startsWith('Before Review, newer published versions'));
  expect(before?.text).toContain('- index.txt (both edited it; the line merge conflicts)');
  const world = (await h.store.currentWorld(reviewLater.task.id))!;
  const root = path.join(world.workdir ?? world.root, 'raw_data');
  expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe(lines('A', 'b', 'c', 'd', 'E'));
  const head = (await published()).revision.id;
  await reviewLater.handle.signal('confirm');
  await done(reviewLater.handle);
  // It took the other version: nothing of its own was left to publish.
  expect((await published()).revision.id).toBe(head);
  expect((await published()).paths).toEqual(['index.txt', 'notes.txt']);
}, 600_000);
