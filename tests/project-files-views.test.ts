import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { StorageLocationService } from '../src/store/storage-locations.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { ProjectFiles, type FileNode } from '../src/world/project-files.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import type { WorldHandle } from '../src/world/types.js';

// A task's files in the project Files page (wiki features/project-files): read
// live while its world runs, else from its last save (each checkout's commit
// plus the uncommitted files its checkpoint holds) without opening the world.
// A real worktree world, a real chunked checkpoint, real Git.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-views-')); dirs.push(dir);
  const repo = path.join(dir, 'app');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  await gitOrThrow(repo, ['init', '-qb', 'main']); await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# App\n');
  fs.writeFileSync(path.join(repo, 'src/old.ts'), 'export const old = 1;\n');
  fs.writeFileSync(path.join(repo, 'src/kept.ts'), 'export const kept = 1;\n');
  await gitOrThrow(repo, ['add', '.']); await gitOrThrow(repo, ['commit', '-qm', 'init']);
  const store = await Store.create(':memory:');
  const project = await store.createProject('Views', { repos: [repo], defaultBase: 'main', worldProvider: 'worktree' });
  const task = await store.createTask({ projectId: project.id, title: 'Rewrite the app', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
  const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const locations = new StorageLocationService(store, objects, broker);
  await locations.ensureManaged(project.organizationId!);
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker, locations), broker, undefined, locations);
  const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources);
  const world = await worlds.create('worktree', { taskId: task.id, repos: [repo], base: 'main' });
  world.handle.meta = { projectId: project.id };
  world.handle = await store.registerWorld(world.handle, project.id) as WorldHandle;
  const root = world.handle.root;
  // The agent's work: a commit, then uncommitted changes of every kind.
  fs.writeFileSync(path.join(root, 'src/committed.ts'), 'export const committed = true;\n');
  await gitOrThrow(root, ['add', '.']); await gitOrThrow(root, ['commit', '-qm', 'agent work']);
  fs.writeFileSync(path.join(root, 'README.md'), '# App, rewritten\n');
  fs.rmSync(path.join(root, 'src/old.ts'));
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'notes/plan.md'), 'step one\n');
  const workspaces = { project: async () => ({ version: 1, organization: { id: '', name: '' }, project: { id: project.id, name: 'Views' },
    directory: 'views', workdir: '.', repositories: [], resources: [], secrets: [{ id: 's', name: 'creds', file: 'creds.json', configured: true }], install: [] }) as any };
  const view = { kind: 'task' as const, taskId: task.id };
  return { dir, repo, store, project, task, world, root, checkpoints, workspaces, view };
}

const names = (node: FileNode) => (node.entries ?? []).map((entry) => entry.name);
const read = (files: ProjectFiles, projectId: string, file: string, view: any) => files.open(projectId, file, { data: true, view }, async (opened) => {
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  await opened.done;
  return Buffer.concat(chunks).toString('utf8');
});

it('shows a parked task as it was last saved, without opening its world', async () => {
  const f = await fixture();
  await f.checkpoints.checkpoint(f.world.handle);
  await f.store.setWorldState(f.world.handle, 'parked');
  // No way to open a world: a parked task must not need one.
  const files = new ProjectFiles({ store: f.store, workspaces: f.workspaces, gitCredential: async () => ({}), checkpoints: f.checkpoints });
  const root = await files.stat(f.project.id, '', { data: true, view: f.view });
  expect(root.view).toMatchObject({ kind: 'task', id: f.task.id, title: 'Rewrite the app', mode: 'saved', savedAt: expect.any(Number) });
  // The commit's files, the saved edit, the deletion and the new folder.
  expect(names(root)).toEqual(['notes', 'src', 'README.md']);
  expect(names(await files.stat(f.project.id, 'src', { data: true, view: f.view }))).toEqual(['committed.ts', 'kept.ts']);
  expect(await read(files, f.project.id, 'README.md', f.view)).toBe('# App, rewritten\n');
  expect(await read(files, f.project.id, 'notes/plan.md', f.view)).toBe('step one\n');
  expect(await read(files, f.project.id, 'src/committed.ts', f.view)).toBe('export const committed = true;\n');
  await expect(files.stat(f.project.id, 'src/old.ts', { data: true, view: f.view })).rejects.toThrow(/Nothing at src\/old.ts/);
  expect((await files.stat(f.project.id, 'README.md', { data: true, view: f.view })).source).toMatchObject({ kind: 'repository', changed: true });

  // The wiki reads a parked task's checkout the same way (its saved copy, on disk).
  const latest = (await f.store.latestWorldCheckpoint(f.world.handle.id))!;
  await f.store.saveWorldCheckpoint({ ...latest, id: `${latest.id}-wiki`, createdAt: latest.createdAt + 1,
    repos: latest.repos.map((repo) => ({ ...repo, role: 'project-wiki' as const })) });
  const copy = path.join(f.dir, 'wiki-copy');
  expect(await files.copySavedCheckout(f.task.id, 'project-wiki', copy)).toBe(true);
  expect(fs.readFileSync(path.join(copy, 'README.md'), 'utf8')).toBe('# App, rewritten\n');
  expect(fs.readFileSync(path.join(copy, 'notes/plan.md'), 'utf8')).toBe('step one\n');
  expect(fs.existsSync(path.join(copy, 'src/old.ts'))).toBe(false);
  expect(fs.readFileSync(path.join(copy, 'src/committed.ts'), 'utf8')).toBe('export const committed = true;\n');
});

it('reads a running task live, hiding tavya’s folder, Git, .env and secret files, and never leaving the world', async () => {
  const f = await fixture();
  fs.mkdirSync(path.join(f.root, '.karmax-injection'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.karmax-injection/token'), 'secret');
  fs.writeFileSync(path.join(f.root, '.env'), 'API_KEY=secret\n');
  fs.writeFileSync(path.join(f.root, 'creds.json'), '{"secret":1}');
  fs.writeFileSync(path.join(f.root, 'just-written.txt'), 'fresh\n');
  const outside = path.join(f.dir, 'outside.txt');
  fs.writeFileSync(outside, 'host file');
  fs.symlinkSync(f.dir, path.join(f.root, 'escape'));
  let opened = 0;
  const files = new ProjectFiles({ store: f.store, workspaces: f.workspaces, gitCredential: async () => ({}), checkpoints: f.checkpoints,
    openWorld: async () => { opened++; return { world: f.world, release: async () => {} }; } });
  const root = await files.stat(f.project.id, '', { data: true, view: f.view });
  expect(root.view).toMatchObject({ mode: 'live' });
  expect(names(root)).toEqual(['notes', 'src', 'escape', 'just-written.txt', 'README.md']);
  expect(root.entries!.find((entry) => entry.name === 'escape')).toMatchObject({ kind: 'symlink' });
  expect(await read(files, f.project.id, 'just-written.txt', f.view)).toBe('fresh\n');
  for (const hidden of ['.karmax-injection/token', '.env', 'creds.json', '.git/config', 'escape/outside.txt'])
    await expect(files.stat(f.project.id, hidden, { data: true, view: f.view }), hidden).rejects.toThrow(/Nothing at/);
  await expect(read(files, f.project.id, 'escape/outside.txt', f.view)).rejects.toThrow(/Nothing at/);
  expect(opened).toBeGreaterThan(0);
});

it('shows a task that never saved its world by its branch, else its base', async () => {
  const f = await fixture();
  // The worktree world shares the repository's refs, so its branch is "published" here.
  execFileSync('git', ['update-ref', `refs/heads/${f.world.handle.branch}`, 'HEAD'], { cwd: f.root });
  await f.store.setWorldState(f.world.handle, 'parked');
  const files = new ProjectFiles({ store: f.store, workspaces: f.workspaces, gitCredential: async () => ({}) });
  const root = await files.stat(f.project.id, '', { data: true, view: f.view });
  expect(root.view).toMatchObject({ mode: 'published' });
  expect(names(await files.stat(f.project.id, 'src', { data: true, view: f.view }))).toEqual(['committed.ts', 'kept.ts', 'old.ts']);
});
