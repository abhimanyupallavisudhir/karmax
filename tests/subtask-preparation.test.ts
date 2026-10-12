import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { ResourceKeptChangingError } from '../src/world/resource-conflict.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import type { WorldHandle } from '../src/world/types.js';

// pramana#22: creating a sub-task saves the parent's writable project data
// first. A process writing into it made that save fail ("kept changing")
// without saying what changed, and the timeout then failed the parent.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function parentWithData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-subtask-save-'));
  const store = await Store.create(':memory:');
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const project = await store.createProject('Corpus');
  const task = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const resources = new ProjectResourceService(store, worlds,
    new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
  const attachment = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Raw data', driver: 'volume@1', target: { kind: 'path', path: 'raw_data' }, access: 'write',
    isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
  await resources.importFiles(attachment.id, Array.from({ length: 20 }, (_, i) => ({ path: `page-${i}.txt`, data: Buffer.from(`page ${i}\n`) })));
  const world = await worlds.create('worktree', { taskId: task.id, base: 'main' });
  cleanups.push(() => world.destroy());
  world.handle = await resources.materialize(project.id, task.id, world);
  const handle = (await store.registerWorld(world.handle, project.id)) as WorldHandle;
  const data = path.join(handle.root, 'raw_data');
  /** A process appending to `files` of the resource until stopped. */
  const writer = (files: string[]) => {
    let n = 0;
    const timer = setInterval(() => { for (const file of files) fs.appendFileSync(path.join(data, file), `line ${n++}\n`); }, 15);
    const stop = () => clearInterval(timer);
    cleanups.push(stop);
    return stop;
  };
  return { store, project, task, worlds, resources, attachment, handle, data, writer };
}

it('names what kept changing during the save, and points at an open SQLite database', async () => {
  const f = await parentWithData();
  fs.writeFileSync(path.join(f.data, 'corpus.sqlite'), 'db');
  const stop = f.writer(['corpus.sqlite-wal', 'corpus.sqlite-shm']);
  const error = await f.resources.snapshotForks(f.handle).then(() => undefined, (e) => e);
  stop();
  expect(error).toBeInstanceOf(ResourceKeptChangingError);
  expect(error.paths).toEqual(expect.arrayContaining(['corpus.sqlite-wal', 'corpus.sqlite-shm']));
  expect(error.paths).not.toContain('corpus.sqlite');
  expect(error.message).toMatch(/^raw_data kept changing while it was being saved: 2 files changed between saves \(corpus\.sqlite-(wal|shm), corpus\.sqlite-(wal|shm)\)\./);
  expect(error.message).toMatch(/SQLite database/);
  expect(error.message).toMatch(/-wal/);

  // With the writer stopped, the same save goes through.
  const saved = await f.resources.snapshotForks(f.handle);
  expect(Object.keys(saved)).toEqual([f.attachment.id]);
});

it('says a server or job is writing when the changing files are not a database\'s', async () => {
  const f = await parentWithData();
  const stop = f.writer(['logs.txt', ...Array.from({ length: 7 }, (_, i) => `out-${i}.jsonl`)]);
  const error = await f.resources.snapshotForks(f.handle).then(() => undefined, (e) => e);
  stop();
  expect(error).toBeInstanceOf(ResourceKeptChangingError);
  // The first few, and how many in all.
  expect(error.message).toMatch(/: 8 files changed between saves \([^)]*, …\)/);
  expect(error.message).toMatch(/a server or job/);
  expect(error.message).not.toMatch(/SQLite/);
});

it('reports progress while the parent\'s data is saved for a sub-task', async () => {
  const f = await parentWithData();
  fs.writeFileSync(path.join(f.data, 'page-0.txt'), 'changed\n');
  const progress: unknown[] = [];
  const checkContinue = vi.fn(async () => undefined);
  await f.resources.snapshotForks(f.handle, { checkContinue, onProgress: (p) => progress.push(p) });
  expect(progress.at(-1)).toMatchObject({ path: 'raw_data', files: 20, totalFiles: 20 });
  expect(checkContinue).toHaveBeenCalled();
});

function activityContext(heartbeat = vi.fn()) {
  const controller = new AbortController();
  vi.spyOn(Context, 'current').mockImplementation(() => ({
    info: { activityId: 'prepare', attempt: 1, workflowExecution: { workflowId: 'parent', runId: 'run-1' } },
    heartbeat, cancellationSignal: controller.signal,
  }) as any);
  return heartbeat;
}

it('prepareChildTask heartbeats the save\'s progress and creates nothing when it fails', async () => {
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Corpus');
  const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev', workflowVersion: '1', params: { prompt: 'fixture' } });
  const handle = { id: parent.id, kind: 'worktree', root: '/tmp/world', branch: `karmax/${parent.id}`, base: 'main', meta: { projectId: project.id } };
  await store.registerWorld(handle as any, project.id);
  const heartbeat = activityContext();
  const snapshotForks = vi.fn(async (_handle: unknown, work?: { onProgress?: (p: object) => void }) => {
    work?.onProgress?.({ path: 'raw_data', files: 5, totalFiles: 10, bytes: 5e9, totalBytes: 9.6e9 });
    throw new ResourceKeptChangingError('raw_data', ['server.log'], 1);
  });
  const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(),
    profiles: new ProfileResolver(store, 'mock'), resources: { snapshotForks } as any });
  const failure = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id, title: 'Child', prompt: 'work',
    base: 'main', target: 'main', parentBranch: handle.branch, project: {}, profiles: {} } as any).then(() => undefined, (e) => e);
  // Saving again at once would find the writer still running: the agent is told instead.
  expect(failure).toBeInstanceOf(ApplicationFailure);
  expect(failure).toMatchObject({ type: 'resource-kept-changing', nonRetryable: true });
  expect(failure.message).toMatch(/raw_data kept changing .*server\.log/);
  expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({ progress: expect.objectContaining({ bytes: 5e9, totalBytes: 9.6e9 }) }));
  expect(await store.childTasks(parent.id)).toEqual([]);
  // The task's activity shows how far the save got, as staging does.
  await expect.poll(async () => (await store.eventsOfType(parent.id, 'staging.progress')).length > 0).toBe(true);
});

it('tells the agent beforehand that create_sub_task saves its writable data first', async () => {
  const { TOOL_SCHEMAS } = await import('../src/agent/tools.js');
  const tool = TOOL_SCHEMAS.find((schema) => schema.name === 'create_sub_task')!;
  expect(tool.description).toMatch(/saves this task's writable project data/);
  expect(tool.description).toMatch(/stop anything writing into it/);
  const { assemblePrompt } = await import('../src/agent/prompt.js');
  const prompt = assemblePrompt({ profile: { id: 'do', name: 'Do', provider: 'claude', role: 'do', capabilities: [] } as any, role: 'do',
    task: { taskId: 't', projectId: 'p', title: 'Corpus', prompt: 'work' } as any,
    world: { kind: 'worktree', id: 't', root: '/w/t', branch: 'tavya/t', base: 'main' } as any });
  expect(prompt).toMatch(/- create_sub_task\(title, prompt, params\?\):[^\n]*saves this task's writable project data/);
});
