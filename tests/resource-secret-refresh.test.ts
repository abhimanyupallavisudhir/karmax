import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { resourceSecretHandle } from '../src/domain/resource-drivers.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import type { World } from '../src/world/types.js';

describe('existing world secret refresh', () => {
  let dir: string, store: Store, broker: CredentialBroker, resources: ProjectResourceService, world: World;
  let project: Awaited<ReturnType<Store['createProject']>>;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-secret-refresh-'));
    const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    await gitOrThrow(repo, ['commit', '--allow-empty', '-qm', 'base']);
    store = (await Store.create(':memory:')); project = (await store.createProject('Secrets', { repos: [repo] }));
    const task = (await store.createTask({ projectId: project.id, title: 'Consumer', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } }));
    broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
  });
  afterEach(async () => {
    await world?.destroy(); (await store?.close()); fs.rmSync(dir, { recursive: true, force: true });
  });
  async function add(name = 'REFRESH_TEST_TOKEN', projectId = project.id) {
    const id = `resource_${name.toLowerCase()}`, credential = resourceSecretHandle(id);
    (await broker.registerHandle(credential, 'fixture-value'));
    return (await store.createResourceAttachment({ id, organizationId: project.organizationId!, projectId, name,
      driver: 'secret@1', target: { kind: 'environment', name }, access: 'read', isolation: 'fork',
      source: {}, credentialHandles: [credential], publish: 'discard' }));
  }
  const present = async (opened: World) => (await opened.exec('node', ['-e',
    'process.stdout.write(String(Boolean(process.env.REFRESH_TEST_TOKEN)))'])).stdout;

  it('delivers late environment secrets on reopen, without changing already opened environments or Git', async () => {
    const previous = await resources.prepare(world);
    const secret = (await add());
    expect(await present(previous)).toBe('false');
    const refreshed = await resources.prepare(world);
    expect(await present(refreshed)).toBe('true');
    expect(await present(previous)).toBe('false');
    (await store.updateResourceAttachment(secret.id, { enabled: false }));
    expect(await present(await resources.prepare(world))).toBe('false');
    // A previously opened process environment is a snapshot, not revocable memory.
    expect(await present(refreshed)).toBe('true');
    (await store.updateResourceAttachment(secret.id, { enabled: true, target: { kind: 'environment', name: 'RENAMED_TOKEN' } }));
    expect((await resources.environmentFor((await resources.prepare(world)).handle))).toEqual({ RENAMED_TOKEN: 'fixture-value' });
    (await store.deleteResourceAttachment(secret.id));
    expect((await resources.environmentFor((await resources.prepare(world)).handle))).toEqual({});
    expect((await world.exec('git', ['status', '--porcelain'])).stdout).toBe('');
    expect(JSON.stringify((await store.currentWorld(world.handle.id)))).not.toContain('fixture-value');
  });

  it('does not enroll another project, disabled secrets, or snapshots on reopen', async () => {
    const other = (await store.createProject('Other')); (await add('FOREIGN_TOKEN', other.id));
    const disabled = (await add('DISABLED_TOKEN')); (await store.updateResourceAttachment(disabled.id, { enabled: false }));
    (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id, name: 'Data',
      driver: 'volume@1', target: { kind: 'path', path: 'data' }, access: 'write', isolation: 'fork',
      source: {}, credentialHandles: [], publish: 'review' }));
    await resources.prepare(world);
    expect((await store.listResourceLeases(world.handle.id))).toEqual([]);
    expect((await resources.environmentFor(world.handle))).toEqual({});
    expect(fs.existsSync(path.join(world.handle.root, 'data'))).toBe(false);
  });

  async function addFile(name = 'FILE_TOKEN', file = '.private-key') {
    const secret = await add(name);
    return (await store.updateResourceAttachment(secret.id, { target: { kind: 'path', path: file } }));
  }
  const fileAt = (file = '.private-key') => path.join(world.handle.root, file);

  it('delivers late file secrets on reopen as private, Git-excluded projections that are never task output', async () => {
    const secret = await addFile();
    await resources.prepare(world);
    expect(fs.readFileSync(fileAt(), 'utf8')).toBe('fixture-value');
    expect(fs.statSync(fileAt()).mode & 0o777).toBe(0o600);
    expect((await world.exec('git', ['status', '--porcelain'])).stdout).toBe('');
    // Checkpoints and forks skip recorded projections; the value itself is never persisted.
    const current = (await store.currentWorld(world.handle.id))!;
    expect((current.meta?.resourceProjections as any)?.[secret.id]?.target).toBe('.private-key');
    expect(JSON.stringify(current)).not.toContain('fixture-value');
    await resources.prepare(world);
    expect((await store.listResourceLeases(world.handle.id))).toHaveLength(1);
    await resources.scrubSecrets(world.handle, world);
    expect(fs.existsSync(fileAt())).toBe(false);
  });

  it('avoids rewriting unchanged secrets on reopen and restores scrubbed files (WD-19)', async () => {
    const secret = await addFile();
    const write = vi.spyOn(world, 'writeFile');
    await resources.prepare(world);
    await resources.prepare(world);
    expect(write).toHaveBeenCalledTimes(1);
    await resources.scrubSecrets(world.handle, world);
    await resources.prepare(world);
    expect(write).toHaveBeenCalledTimes(2);
    await broker.registerHandle(secret.credentialHandles[0]!, 'rotated');
    await resources.prepare(world);
    expect(write).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(fileAt(), 'utf8')).toBe('rotated');
  });

  it('keeps a running agent current without reopening: adds, rotates and withdraws secrets', async () => {
    const opened = await resources.prepare(world);
    expect(await resources.refresh(opened)).toEqual({});
    const token = await add();
    const file = await addFile();
    expect(await resources.refresh(opened)).toEqual({ REFRESH_TEST_TOKEN: 'fixture-value' });
    expect(fs.readFileSync(fileAt(), 'utf8')).toBe('fixture-value');
    // An unchanged project value does not clobber the agent's own edits...
    fs.writeFileSync(fileAt(), 'agent edit');
    await resources.refresh(opened);
    expect(fs.readFileSync(fileAt(), 'utf8')).toBe('agent edit');
    // ...but a rotation in project settings reaches the running agent.
    (await broker.registerHandle(file.credentialHandles[0]!, 'rotated-file'));
    (await broker.registerHandle(token.credentialHandles[0]!, 'rotated-env'));
    expect(await resources.refresh(opened)).toEqual({ REFRESH_TEST_TOKEN: 'rotated-env' });
    expect(fs.readFileSync(fileAt(), 'utf8')).toBe('rotated-file');
    (await store.updateResourceAttachment(token.id, { enabled: false }));
    expect(await resources.refresh(opened)).toEqual({});
    expect((await store.listResourceLeases(world.handle.id))).toHaveLength(2);
    expect((await world.exec('git', ['status', '--porcelain'])).stdout).toBe('');
  });

  it('retries a broker failure without persisting values or silently skipping the secret', async () => {
    const secret = (await add()); (await broker.deleteHandle(secret.credentialHandles[0]!));
    await expect(resources.prepare(world)).rejects.toThrow();
    expect((await store.listResourceLeases(world.handle.id))).toEqual([]);
    (await broker.registerHandle(secret.credentialHandles[0]!, 'fixture-value'));
    expect(await present(await resources.prepare(world))).toBe('true');
    expect(JSON.stringify((await store.auditSince()))).not.toContain('fixture-value');
    expect(JSON.stringify((await store.listResourceLeases(world.handle.id)))).not.toContain('fixture-value');
  });

  it('does not renew released leases or enroll into a released or stale world generation', async () => {
    const secret = (await add()); await resources.prepare(world);
    const lease = (await store.listResourceLeases(world.handle.id))[0]!;
    expect(lease.attachmentId).toBe(secret.id);
    (await store.updateResourceLease(lease.id, 'released'));
    await resources.prepare(world);
    expect((await resources.environmentFor(world.handle))).toEqual({});
    (await add('AFTER_RELEASE')); (await store.setWorldState(world.handle, 'released'));
    await resources.prepare(world);
    expect((await store.listResourceLeases(world.handle.id))).toHaveLength(1);
    (await store.registerWorld({ ...world.handle, generation: 2 }, project.id));
    await resources.prepare(world);
    expect((await store.listResourceLeases(world.handle.id))).toHaveLength(1);
  });
});
