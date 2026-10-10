import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
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

/** Each test runs real restic several times, as jobs in worlds: ~10-25 s on a
 * 2-CPU host, and CI runners are up to twice as slow. */
const REAL_RESTIC_MS = 120_000;

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
  // Through this server, whose relay buffers each upload, with restic's few connections.
  const commands = fs.readdirSync(path.join(world.handle.root, SYSTEM_JOB_ROOT))
    .map((id) => fs.readFileSync(path.join(world.handle.root, SYSTEM_JOB_ROOT, id, 'command'), 'utf8')).filter((command) => /\bbackup\b/.test(command));
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) expect(command).toContain('rest.connections=8');
  // Its jobs are the platform's own, apart from the agent's.
  expect(fs.readdirSync(path.join(world.handle.root, SYSTEM_JOB_ROOT)).length).toBeGreaterThan(0);
  expect(await listJobs(world)).toEqual([]);
  void progress;
}, REAL_RESTIC_MS);

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
}, REAL_RESTIC_MS);

it('merges a newer publication into a remote world, restoring only what changed there', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'seed.txt', data: Buffer.from('seed') },
    { path: 'old/gone.txt', data: Buffer.from('x') }]);
  const ocr = await f.sandbox('W2 OCR');
  const translations = await f.sandbox('W7 translations');
  const byId = new Map([[ocr.world.handle.id, ocr.world], [translations.world.handle.id, translations.world]]);
  vi.spyOn(f.worlds, 'open').mockImplementation(async (handle) => byId.get(handle.id)!);
  for (const { task, world } of [ocr, translations]) {
    world.handle = await f.resources.materialize(f.project.id, task.id, world, 1);
    world.handle = (await f.store.registerWorld(world.handle, f.project.id)) as typeof world.handle;
  }
  fs.mkdirSync(path.join(ocr.world.handle.root, 'data/ocr'));
  fs.writeFileSync(path.join(ocr.world.handle.root, 'data/ocr/page 1*.txt'), 'ocr');
  fs.rmSync(path.join(ocr.world.handle.root, 'data/old'), { recursive: true });
  fs.writeFileSync(path.join(translations.world.handle.root, 'data/translated.txt'), 'translated');
  const first = await f.resources.promote(ocr.task.id, f.attachment.id);
  const combined = await f.resources.promote(translations.task.id, f.attachment.id);

  expect(combined.revision.parentRevisionId).toBe(first.revision.id);
  const verified = await f.resources.verifyRevision(f.project.id, f.attachment.id, combined.revision.id, 0, 100);
  expect(verified.files.map((file) => file.path).sort()).toEqual(['ocr/page 1*.txt', 'seed.txt', 'translated.txt']);
  const root = translations.world.handle.root;
  expect(fs.readFileSync(path.join(root, 'data/ocr/page 1*.txt'), 'utf8')).toBe('ocr');
  expect(fs.existsSync(path.join(root, 'data/old'))).toBe(false);
  // restic fetched only the other task's file, as a job in that world.
  const restores = fs.readdirSync(path.join(root, SYSTEM_JOB_ROOT))
    .map((id) => fs.readFileSync(path.join(root, SYSTEM_JOB_ROOT, id, 'command'), 'utf8')).filter((command) => /\brestore\b/.test(command));
  expect(restores.filter((command) => command.includes('--include-file'))).toHaveLength(1);
}, REAL_RESTIC_MS);

// pramana#3 (2026-10-08): W2 handed its parent 706,916 new OCR files, nearly
// all in two new directories. The merge gave restic one --include pattern per
// file, and restic tests every node of the snapshot against every pattern
// (~5×10¹¹ matches): the restore made no measurable progress for hours, and a
// follow-up waited behind it. Each deploy restarted the worker, and the retry
// started a second restore beside the one the dead attempt left running.

/** The pattern lists a merge handed restic in `world`, by flag. */
function patternLists(world: World) {
  const lists: Array<{ flag: string; patterns: string[] }> = [];
  const write = world.writeFile.bind(world);
  vi.spyOn(world, 'writeFile').mockImplementation(async (file, data) => {
    const flag = /\/merge-[^/]+\/(include|exclude)$/.exec(file)?.[1];
    if (flag) lists.push({ flag, patterns: String(data).split('\n').filter(Boolean) });
    return write(file, data);
  });
  return lists;
}

async function siblings(f: Awaited<ReturnType<typeof fixture>>) {
  const ocr = await f.sandbox('W2 OCR');
  const translations = await f.sandbox('W7 translations');
  const byId = new Map([[ocr.world.handle.id, ocr.world], [translations.world.handle.id, translations.world]]);
  vi.spyOn(f.worlds, 'open').mockImplementation(async (handle) => byId.get(handle.id)!);
  for (const { task, world } of [ocr, translations]) {
    world.handle = await f.resources.materialize(f.project.id, task.id, world, 1);
    world.handle = (await f.store.registerWorld(world.handle, f.project.id)) as typeof world.handle;
  }
  const put = (world: World, file: string, text: string) => {
    const full = path.join(world.handle.root, 'data', file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  const tree = (world: World) => {
    const root = path.join(world.handle.root, 'data');
    return Object.fromEntries((fs.readdirSync(root, { recursive: true }) as string[]).sort()
      .filter((file) => fs.statSync(path.join(root, file)).isFile()).map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  };
  return { ocr, translations, put, tree };
}

it('merges a whole new tree with one restic pattern for it, not one per file', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'seed.txt', data: Buffer.from('seed') },
    { path: 'pages/1.txt', data: Buffer.from('page') }]);
  const { ocr, translations, put, tree } = await siblings(f);
  for (let i = 0; i < 3_000; i++) put(ocr.world, `ocr/_engines/e${i % 7}/p${i}.txt`, `ocr ${i}`);
  put(ocr.world, 'pages/1.txt', 'page, corrected');
  put(ocr.world, 'pages/2.txt', 'a new page beside an old one');
  put(translations.world, 'mt/a.txt', 'translated');
  await f.resources.promote(ocr.task.id, f.attachment.id);
  const lists = patternLists(translations.world);
  await f.resources.promote(translations.task.id, f.attachment.id);

  expect(lists).toEqual([{ flag: 'include', patterns: ['/ocr', '/pages/1.txt', '/pages/2.txt'] }]);
  const merged = tree(translations.world);
  expect(Object.keys(merged)).toHaveLength(3_000 + 4);
  expect(merged).toMatchObject({ 'seed.txt': 'seed', 'pages/1.txt': 'page, corrected', 'pages/2.txt': 'a new page beside an old one',
    'mt/a.txt': 'translated', 'ocr/_engines/e3/p2999.txt': 'ocr 2999' });
}, REAL_RESTIC_MS);

it('merges many changed files by restoring everything but the few this world changed itself', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'seed.txt', data: Buffer.from('seed') },
    { path: 'old/gone.txt', data: Buffer.from('x') },
    ...Array.from({ length: 1_200 }, (_, i) => ({ path: `pages/${i}.txt`, data: Buffer.from(`page ${i}`) }))]);
  const { ocr, translations, put, tree } = await siblings(f);
  for (let i = 0; i < 1_200; i++) put(ocr.world, `pages/${i}.txt`, `page ${i}, re-OCRed`);
  put(ocr.world, 'mt/b.txt', 'from ocr'); // a directory both sides add
  put(translations.world, 'seed.txt', 'seed, edited here');
  put(translations.world, 'mt/a.txt', 'translated');
  fs.rmSync(path.join(translations.world.handle.root, 'data/old'), { recursive: true });
  await f.resources.promote(ocr.task.id, f.attachment.id);
  const lists = patternLists(translations.world);
  await f.resources.promote(translations.task.id, f.attachment.id);

  expect(lists).toEqual([{ flag: 'exclude', patterns: ['/mt/a.txt', '/old', '/seed.txt'] }]);
  expect(tree(translations.world)).toEqual({ 'seed.txt': 'seed, edited here', 'mt/a.txt': 'translated', 'mt/b.txt': 'from ocr',
    ...Object.fromEntries(Array.from({ length: 1_200 }, (_, i) => [`pages/${i}.txt`, `page ${i}, re-OCRed`])) });
  expect(fs.existsSync(path.join(translations.world.handle.root, 'data/old'))).toBe(false);
}, REAL_RESTIC_MS);

it('stops the restic job a dead attempt left running before starting a different one under its key', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'seed.txt', data: Buffer.from('seed') }]);
  const { world } = await f.sandbox('Retry');
  fs.mkdirSync(path.join(world.handle.root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(world.handle.root, 'data/a.txt'), 'a');
  const repository = await f.resources.restic.current(f.attachment);
  // The worker running an earlier attempt died; its restic (other arguments) still runs.
  const { startJob, jobStatuses } = await import('../src/world/jobs.js');
  const stale = await startJob(world, { command: 'sleep 120', cwd: world.handle.root, root: SYSTEM_JOB_ROOT });
  await f.store.kvSet(`restic-job:${world.handle.id}:save:1:0`, JSON.stringify({ job: stale.id, generation: 1, digest: 'earlier', at: Date.now() }));

  await f.resources.restic.backup({ world: world as World, path: path.join(world.handle.root, 'data') }, repository, { key: 'save:1', quota: false });
  expect((await jobStatuses(world, [stale.id], { root: SYSTEM_JOB_ROOT }))[0]?.state).not.toBe('running');
}, REAL_RESTIC_MS);

it('gives a retried merge the same restore command, so the retry finds the restore still running', async () => {
  const f = await fixture();
  const first = await f.resources.importFiles(f.attachment.id, [{ path: 'seed.txt', data: Buffer.from('seed') }]);
  const { world } = await f.sandbox('Retry merge');
  world.handle = await f.resources.materialize(f.project.id, (await f.store.listTasks(f.project.id))[0]!.id, world, 1);
  const repository = await f.resources.restic.current(f.attachment);
  const snapshot = JSON.parse(first.sealedRef!).snapshot as string;
  const place = { world: world as World, path: path.join(world.handle.root, 'data') };
  const change = { paths: ['seed.txt'], deletions: [], removedDirectories: [], addedDirectories: [] };
  fs.rmSync(path.join(world.handle.root, 'data/seed.txt'));
  await f.resources.restic.applyPaths(place, repository, snapshot, change, { key: 'deliver:1:merge' });
  fs.rmSync(path.join(world.handle.root, 'data/seed.txt'));
  await f.resources.restic.applyPaths(place, repository, snapshot, change, { key: 'deliver:1:merge' });
  const restores = fs.readdirSync(path.join(world.handle.root, SYSTEM_JOB_ROOT))
    .map((id) => fs.readFileSync(path.join(world.handle.root, SYSTEM_JOB_ROOT, id, 'command'), 'utf8')).filter((command) => /\brestore\b.*--include-file/.test(command));
  expect(restores).toHaveLength(2);
  expect(restores[1]).toBe(restores[0]);
  expect(fs.readFileSync(path.join(world.handle.root, 'data/seed.txt'), 'utf8')).toBe('seed');
}, REAL_RESTIC_MS);

// On demand (wiki features/resource-storage): the remote world gets the listing
// and `tavya-data`, whose restic fetches through the public route with a read
// grant; saves back up only the parts it holds, as jobs there.
it('fetches and saves parts of an on-demand resource in a remote world, keeping every part it never fetched', async () => {
  const f = await fixture();
  await f.store.updateResourceAttachment(f.attachment.id, { onDemand: true });
  const pages = Array.from({ length: 20 }, (_, i) => ({ path: `ocr/${i}.txt`, data: crypto.randomBytes(2000 + i) }));
  const first = await f.resources.importFiles(f.attachment.id, [...pages, { path: 'mt/a.txt', data: Buffer.from('mt') },
    { path: 'big/blob.bin', data: crypto.randomBytes(4 * 1024 * 1024) }, { path: 'README', data: Buffer.from('top') }]);
  const { task, world } = await f.sandbox('On demand');
  world.handle = await f.resources.materialize(f.project.id, task.id, world, 1);
  world.handle = (await f.store.registerWorld(world.handle, f.project.id)) as typeof world.handle;
  expect(fs.readdirSync(path.join(world.handle.root, 'data'))).toEqual([]);
  const grant = JSON.parse(fs.readFileSync(path.join(world.handle.root, `.karmax-injection/data/${f.attachment.id}/grant.json`), 'utf8'));
  expect(grant.env.RESTIC_REPOSITORY).toMatch(new RegExp(`^rest:${f.gatewayUrl}/resource-repositories/`));
  expect(fs.statSync(path.join(world.handle.root, `.karmax-injection/data/${f.attachment.id}/grant.json`)).mode & 0o777).toBe(0o600);

  const tool = path.join(world.handle.root, '.karmax-injection/bin/tavya-data');
  const run = (...args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(tool, args, { cwd: world.handle.root });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });
  expect(await run('get', 'data/ocr')).toMatchObject({ code: 0 });
  fs.writeFileSync(path.join(world.handle.root, 'data/ocr/0.txt'), 'corrected');
  // A file written into a part never fetched joins it.
  fs.mkdirSync(path.join(world.handle.root, 'data/mt'));
  fs.writeFileSync(path.join(world.handle.root, 'data/mt/b.txt'), 'new');
  expect(await f.resources.summarize(task.id, f.attachment.id)).toMatchObject({ added: 1, modified: 1, deleted: 0 });
  const promoted = await f.resources.promote(task.id, f.attachment.id);
  const parts = JSON.parse((await f.store.getResourceRevision(promoted.revision.id))!.sealedRef).parts;
  const before = JSON.parse((await f.store.getResourceRevision(first.id))!.sealedRef).parts;
  expect(parts.big).toEqual(before.big);
  expect(parts['.']).toEqual(before['.']);
  expect(fs.existsSync(path.join(world.handle.root, 'data/big'))).toBe(false);
  const verified = await f.resources.verifyRevision(f.project.id, f.attachment.id, promoted.revision.id, 0, 1000);
  expect(verified.status).toBe('complete');
  expect(verified.files.map((file) => file.path).sort()).toEqual([...pages.map((page) => page.path), 'README', 'big/blob.bin', 'mt/a.txt', 'mt/b.txt'].sort());
}, REAL_RESTIC_MS);
