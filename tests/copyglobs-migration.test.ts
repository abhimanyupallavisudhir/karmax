import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';

describe('typed copyGlobs migration', () => {
  it('replaces copied host files with secret attachments and file-shaped immutable revisions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-copyglobs-migration-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'app.txt'), 'tracked\n');
    await git(repo, ['add', 'app.txt']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    fs.writeFileSync(path.join(repo, '.env'), 'DATABASE_URL=postgres://private\nMODEL_TOKEN=\"token-value\"\n');
    fs.writeFileSync(path.join(repo, 'service-account.json'), '{"private_key":"secret-json"}');
    fs.writeFileSync(path.join(repo, 'weights.bin'), Buffer.from([0, 1, 2, 3, 255]));

    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Legacy state', {
      repos: [repo], copyGlobs: ['.env', '*.json', 'weights.bin'], defaultBase: 'main',
    }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);

    const result = await resources.migrateCopyGlobs(project);
    expect(result).toMatchObject({
      environmentSecrets: ['DATABASE_URL', 'MODEL_TOKEN'],
      fileSecrets: ['service-account.json'],
      data: ['weights.bin'],
      skipped: [],
    });
    expect((await store.getProject(project.id))?.config.copyGlobs).toEqual([]);
    const attachments = (await store.listResourceAttachments(project.id));
    expect(attachments).toHaveLength(4);
    const weights = attachments.find((attachment) => attachment.target.kind === 'path'
      && attachment.target.path === 'weights.bin')!;
    expect(weights.source.shape).toBe('file');
    expect(weights.currentRevisionId).toBeTruthy();

    const task = (await store.createTask({ projectId: project.id, title: 'Consume migrated state',
      workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'use it' } }));
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    expect(await world.readFile('service-account.json')).toContain('secret-json');
    expect([...await world.readFileBuffer('weights.bin')]).toEqual([0, 1, 2, 3, 255]);
    const runtime = (await resources.withEnvironment(world));
    expect((await runtime.exec('bash', ['-lc', 'printf "%s|%s" "$DATABASE_URL" "$MODEL_TOKEN"'])).stdout)
      .toBe('postgres://private|token-value');
    expect(JSON.stringify(world.handle)).not.toContain('private');
    expect(JSON.stringify(world.handle)).not.toContain('token-value');
    expect((await world.exec('git', ['status', '--porcelain'])).stdout.trim()).toBe('');

    await resources.release(world.handle);
    await world.destroy();
    await resources.deleteProject(project.id);
    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('streams oversized matches instead of reading them into control-plane memory for classification', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-copyglobs-stream-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'app.txt'), 'tracked\n');
    await git(repo, ['add', 'app.txt']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const oversized = path.join(repo, '.env.large');
    fs.writeFileSync(oversized, Buffer.alloc(128 * 1024, 'x'));

    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Large legacy state', {
      repos: [repo], copyGlobs: ['.env.large'], defaultBase: 'main',
    }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const resources = new ProjectResourceService(store, new WorldRegistry(),
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const originalRead = fs.readFileSync.bind(fs);
    const fullRead = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (path.resolve(String(file)) === path.resolve(oversized))
        throw new Error('migration attempted an unbounded whole-file read');
      return originalRead(file, ...(args as []));
    }) as typeof fs.readFileSync);
    try {
      const result = await resources.migrateCopyGlobs(project);
      expect(result.data).toEqual(['.env.large']);
      expect(result.environmentSecrets).toEqual([]);
      const attachment = (await store.listResourceAttachments(project.id))
        .find((candidate) => candidate.target.kind === 'path' && candidate.target.path === '.env.large')!;
      expect((await store.getResourceRevision(attachment.currentRevisionId!))?.bytes).toBe(128 * 1024);
      expect(fullRead).not.toHaveBeenCalledWith(oversized);
    } finally {
      fullRead.mockRestore();
      await resources.deleteProject(project.id);
      (await store.close());
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
