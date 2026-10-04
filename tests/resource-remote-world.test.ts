import { afterEach, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { SYSTEM_JOB_ROOT, listJobs } from '../src/world/jobs.js';
import { RESTIC_VERSION } from '../src/world/restic.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import type { World } from '../src/world/types.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/**
 * A world that says it is a remote sandbox (an E2B one) but runs its commands
 * on this host: everything restic does there goes the remote way, as a durable
 * job in the world, with the binary fetched from the gateway's public route.
 */
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-resources-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'data/\n');
  await gitOrThrow(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-qm', 'base']);
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Remote', { repos: [repo] });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  let gatewayUrl = '';
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker,
    undefined, undefined, { world: () => gatewayUrl });
  const tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', resources });
  const gateway = await Gateway.create({ api, store, tokens, client, worlds, taskQueue: 'test', resources, broker,
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), staticDir: 'web',
    agentInfo: { provider: 'mock', reason: 'remote resource test' } });
  const server = await gateway.listen(await findFreePortFrom(49_900));
  cleanups.push(() => server.close());
  gatewayUrl = server.url;
  const attachment = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Data', driver: 'volume@1', target: { kind: 'path', path: 'data' }, access: 'write', isolation: 'fork',
    source: {}, credentialHandles: [], publish: 'review' });
  const sandbox = async (title: string) => {
    const task = await store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.26.0',
      params: { prompt: title } });
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    cleanups.push(() => world.destroy());
    world.handle = { ...world.handle, kind: 'e2b' };
    vi.spyOn(worlds, 'open').mockResolvedValue(world);
    return { task, world };
  };
  return { dir, store, project, resources, attachment, sandbox, worlds, gatewayUrl };
}

it('restores into and saves from a remote world with restic running there as a durable job', async () => {
  const f = await fixture();
  const corpus = Array.from({ length: 50 }, (_, i) => ({ path: `pages/${i}.txt`, data: crypto.randomBytes(1000 + i) }));
  const first = await f.resources.importFiles(f.attachment.id, [...corpus, { path: 'big.bin', data: crypto.randomBytes(6 * 1024 * 1024) }]);
  const { task, world } = await f.sandbox('Remote work');

  world.handle = await f.resources.materialize(f.project.id, task.id, world, 1);
  world.handle = (await f.store.registerWorld(world.handle, f.project.id)) as typeof world.handle;
  // restic came from the gateway, checked against its pinned digest, and ran as a platform job.
  expect(fs.existsSync(path.join(world.handle.root, `.karmax-injection/bin/restic-${RESTIC_VERSION}`))).toBe(true);
  expect(await listJobs(world)).toEqual([]); // the agent's own jobs: none of ours
  expect(fs.readFileSync(path.join(world.handle.root, 'data/pages/7.txt'))).toEqual(corpus[7]!.data);

  fs.writeFileSync(path.join(world.handle.root, 'data/pages/7.txt'), 'rewritten page');
  fs.writeFileSync(path.join(world.handle.root, 'data/new.txt'), 'a new page');
  const progress: number[] = [];
  const summary = await f.resources.summarize(task.id, f.attachment.id);
  expect(summary).toMatchObject({ added: 1, modified: 1, deleted: 0 });
  const promoted = await f.resources.promote(task.id, f.attachment.id);
  expect(promoted.revision).toMatchObject({ engine: 'restic@1', parentRevisionId: first.id, files: 52 });
  const verified = await f.resources.verifyRevision(f.project.id, f.attachment.id, promoted.revision.id, 0, 1000);
  expect(verified.status).toBe('complete');
  expect(verified.files.find((file) => file.path === 'pages/7.txt')?.sha256)
    .toBe(crypto.createHash('sha256').update('rewritten page').digest('hex'));
  // Its jobs are the platform's own, apart from the agent's.
  expect(fs.readdirSync(path.join(world.handle.root, SYSTEM_JOB_ROOT)).length).toBeGreaterThan(0);
  expect(await listJobs(world)).toEqual([]);
  void progress;
});

it('reattaches to its save still running in the world instead of starting another', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'seed.txt', data: Buffer.from('seed') }]);
  const { world } = await f.sandbox('Reattach');
  fs.mkdirSync(path.join(world.handle.root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(world.handle.root, 'data/big.bin'), crypto.randomBytes(20 * 1024 * 1024));
  const repository = await f.resources.restic.current(f.attachment);
  const place = { world: world as World, path: path.join(world.handle.root, 'data') };
  // A worker restart retries the activity while restic is still running: the
  // retry finds the job by its key and waits for the same save.
  const [a, b] = await Promise.all([
    f.resources.restic.backup(place, repository, { key: 'save:1', quota: false }),
    (async () => {
      // A retry comes once the first attempt has stopped heartbeating: its job is recorded by then.
      while (!(await f.store.kvEntries(`restic-job:${world.handle.id}:save:1:0`)).length) await new Promise((r) => setTimeout(r, 50));
      return f.resources.restic.backup(place, repository, { key: 'save:1', quota: false });
    })(),
  ]);
  expect(b.snapshot).toBe(a.snapshot);
  // One save ran, not two: a single snapshot in the repository besides the seed's.
  expect(await f.store.listRepositoryFiles(repository.name, 'snapshots')).toHaveLength(2);
});
