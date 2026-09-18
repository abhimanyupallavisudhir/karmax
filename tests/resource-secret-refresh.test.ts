import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import type { World } from '../src/world/types.js';

describe('existing world secret refresh', () => {
  let dir: string, store: Store, broker: CredentialBroker, resources: ProjectResourceService, world: World;
  let project: ReturnType<Store['createProject']>;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-secret-refresh-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    await gitOrThrow(repo, ['commit', '--allow-empty', '-qm', 'base']);
    store = new Store(':memory:'); project = store.createProject('Secrets', { repos: [repo] });
    const task = store.createTask({ projectId: project.id, title: 'Consumer', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } });
    broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = store.registerWorld(world.handle, project.id) as typeof world.handle;
  });
  afterEach(async () => {
    await world?.destroy(); store?.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  function add(name = 'REFRESH_TEST_TOKEN', projectId = project.id) {
    const credential = `resource:test:${name}`; broker.registerHandle(credential, 'fixture-value');
    return store.createResourceAttachment({ organizationId: project.organizationId!, projectId, name,
      driver: 'secret@1', target: { kind: 'environment', name }, access: 'read', isolation: 'fork',
      source: {}, credentialHandles: [credential], publish: 'discard' });
  }
  const present = async (opened: World) => (await opened.exec('node', ['-e',
    'process.stdout.write(String(Boolean(process.env.REFRESH_TEST_TOKEN)))'])).stdout;

  it('delivers late environment secrets on reopen, without changing already opened environments or Git', async () => {
    const previous = await resources.prepare(world);
    const secret = add();
    expect(await present(previous)).toBe('false');
    const refreshed = await resources.prepare(world);
    expect(await present(refreshed)).toBe('true');
    expect(await present(previous)).toBe('false');
    store.updateResourceAttachment(secret.id, { enabled: false });
    expect(await present(await resources.prepare(world))).toBe('false');
    // A previously opened process environment is a snapshot, not revocable memory.
    expect(await present(refreshed)).toBe('true');
    store.updateResourceAttachment(secret.id, { enabled: true, target: { kind: 'environment', name: 'RENAMED_TOKEN' } });
    expect(resources.environmentFor((await resources.prepare(world)).handle)).toEqual({ RENAMED_TOKEN: 'fixture-value' });
    store.deleteResourceAttachment(secret.id);
    expect(resources.environmentFor((await resources.prepare(world)).handle)).toEqual({});
    expect((await world.exec('git', ['status', '--porcelain'])).stdout).toBe('');
    expect(JSON.stringify(store.currentWorld(world.handle.id))).not.toContain('fixture-value');
  });

  it('does not enroll another project, disabled secrets, files, or snapshots on reopen', async () => {
    const other = store.createProject('Other'); add('FOREIGN_TOKEN', other.id);
    const disabled = add('DISABLED_TOKEN'); store.updateResourceAttachment(disabled.id, { enabled: false });
    const file = add('FILE_TOKEN'); store.updateResourceAttachment(file.id, { target: { kind: 'path', path: '.private-key' } });
    store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id, name: 'Data',
      driver: 'volume@1', target: { kind: 'path', path: 'data' }, access: 'write', isolation: 'fork',
      source: {}, credentialHandles: [], publish: 'review' });
    await resources.prepare(world);
    expect(store.listResourceLeases(world.handle.id)).toEqual([]);
    expect(resources.environmentFor(world.handle)).toEqual({});
  });

  it('retries a broker failure without persisting values or silently skipping the secret', async () => {
    const secret = add(); broker.deleteHandle(secret.credentialHandles[0]!);
    await expect(resources.prepare(world)).rejects.toThrow();
    expect(store.listResourceLeases(world.handle.id)).toEqual([]);
    broker.registerHandle(secret.credentialHandles[0]!, 'fixture-value');
    expect(await present(await resources.prepare(world))).toBe('true');
    expect(JSON.stringify(store.auditSince())).not.toContain('fixture-value');
    expect(JSON.stringify(store.listResourceLeases(world.handle.id))).not.toContain('fixture-value');
  });

  it('does not renew released leases or enroll into a released or stale world generation', async () => {
    const secret = add(); await resources.prepare(world);
    const lease = store.listResourceLeases(world.handle.id)[0]!;
    expect(lease.attachmentId).toBe(secret.id);
    store.updateResourceLease(lease.id, 'released');
    await resources.prepare(world);
    expect(resources.environmentFor(world.handle)).toEqual({});
    add('AFTER_RELEASE'); store.setWorldState(world.handle, 'released');
    await resources.prepare(world);
    expect(store.listResourceLeases(world.handle.id)).toHaveLength(1);
    store.registerWorld({ ...world.handle, generation: 2 }, project.id);
    await resources.prepare(world);
    expect(store.listResourceLeases(world.handle.id)).toHaveLength(1);
  });
});
