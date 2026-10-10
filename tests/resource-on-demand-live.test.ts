import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { E2BWorldProvider } from '../src/world/e2b.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { storedRef } from '../src/world/restic-engine.js';
import type { World } from '../src/world/types.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * On-demand resources end to end in real E2B worlds (wiki
 * features/resource-storage): a multi-GB resource, one part fetched and
 * edited in a sandbox, parked, restored into a new sandbox, published; the
 * published version must hold every part the worlds never fetched byte for
 * byte.
 *
 * The repository server runs in this process, reached by the sandboxes at
 * KARMAX_LIVE_PUBLIC_URL (for a test run inside an E2B sandbox:
 * `https://<port>-$E2B_SANDBOX_ID.e2b.app`, with KARMAX_LIVE_PORT=<port>).
 * Needs KARMAX_RUN_LIVE=1 and E2B_API_KEY; it spends sandbox time and
 * deletes what it creates. KARMAX_LIVE_DATA_GB sizes the resource (default 3).
 */
const run = liveEnabled() && Boolean(process.env.E2B_API_KEY) && Boolean(process.env.KARMAX_LIVE_PUBLIC_URL);
const GB = Number(process.env.KARMAX_LIVE_DATA_GB ?? 3);
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined); });

const sha = (file: string) => execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0]!;
const log = (message: string) => console.log(`[on-demand live ${new Date().toISOString().slice(11, 19)}] ${message}`);

describe.skipIf(!run)('on-demand resources in real E2B worlds', () => {
  it('fetches one part of a multi-GB resource, edits it, parks, restores, publishes, and keeps every other part byte for byte', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-on-demand-live-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    // The resource: three big folders of incompressible data, many small files, and top-level files.
    const source = path.join(dir, 'raw_data');
    const big = Math.max(1, Math.round((GB * 1000) / 3 / 200)); // 200 MB files per big folder
    for (const folder of ['ocr', 'gretil', 'mt']) {
      fs.mkdirSync(path.join(source, folder), { recursive: true });
      for (let i = 0; i < big; i++)
        execFileSync('bash', ['-c', `head -c 200000000 /dev/urandom > ${path.join(source, folder, `vol-${i}.bin`)}`]);
    }
    fs.mkdirSync(path.join(source, 'pages'), { recursive: true });
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(source, 'pages', `p-${i}.txt`), crypto.randomBytes(20_000));
    fs.writeFileSync(path.join(source, 'README.md'), 'per-source folders\n');
    const expected = new Map<string, string>();
    for (const entry of fs.readdirSync(source, { recursive: true, withFileTypes: true }))
      if (entry.isFile()) expected.set(path.relative(source, path.join(entry.parentPath, entry.name)), sha(path.join(entry.parentPath, entry.name)));
    const totalBytes = Number(execFileSync('du', ['-sb', source], { encoding: 'utf8' }).split('\t')[0]);
    log(`resource: ${(totalBytes / 1e9).toFixed(2)} GB, ${expected.size} files`);

    const store = await Store.create(':memory:');
    cleanups.push(() => store.close());
    const project = await store.createProject('Pramana-like');
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const worlds = new WorldRegistry();
    const e2b = new E2BWorldProvider();
    worlds.register(e2b);
    const publicUrl = process.env.KARMAX_LIVE_PUBLIC_URL!.replace(/\/+$/, '');
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker),
      broker, undefined, undefined, { world: () => publicUrl, objects: new LocalObjectStore(path.join(dir, 'objects')) });
    const tokens = new TokenAuthority();
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', resources });
    const gateway = await Gateway.create({ api, store, tokens, client, worlds, taskQueue: 'test', resources, broker,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), staticDir: 'web',
      agentInfo: { provider: 'mock', reason: 'on-demand live test' } });
    process.env.KARMAX_HOST = '0.0.0.0';
    const server = await gateway.listen(Number(process.env.KARMAX_LIVE_PORT ?? 49_950));
    cleanups.push(() => server.close());
    log(`repository server on ${server.url}, reached by worlds at ${publicUrl}`);

    const data = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'raw_data', driver: 'volume@1', target: { kind: 'path', path: 'raw_data' }, access: 'write', isolation: 'fork',
      source: {}, credentialHandles: [], publish: 'review', onDemand: true });
    let started = Date.now();
    const first = await resources.importDirectory(data.id, source);
    log(`imported in ${((Date.now() - started) / 1000).toFixed(0)} s as parts ${Object.keys(storedRef(first).parts!).join(', ')}`);
    const firstParts = storedRef(first).parts!;

    const task = await store.createTask({ projectId: project.id, title: 'OCR cleanup', workflow: 'software-dev', workflowVersion: '1.26.0',
      params: { prompt: 'clean the OCR' } });
    const open = async (generation: number, revisions: Record<string, string> = {}) => {
      // Allowed to reach the repository server, as worlds reach the public gateway (publicGatewayDomains).
      const world = await e2b.create({ taskId: task.id, base: 'main', network: { allowDomains: [new URL(publicUrl).hostname] } });
      cleanups.push(() => world.destroy());
      world.handle = await resources.materialize(project.id, task.id, world, generation, revisions);
      world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
      return world;
    };
    const exec = async (world: World, command: string) => {
      const result = await world.exec('bash', ['-lc', command], { cwd: world.handle.root, timeoutMs: 30 * 60_000 });
      if (result.code !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
      return result.stdout;
    };
    const tool = `${'$'}PWD/.karmax-injection/bin/tavya-data`;

    started = Date.now();
    const world = await open(1);
    log(`world 1 (${world.handle.id}) materialized in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    expect(Number((await exec(world, 'du -sb raw_data')).split('\t')[0])).toBeLessThan(100_000);
    const listing = await exec(world, `${tool} ls`);
    log(listing);
    expect(listing).toMatch(/raw_data {2}[\d.]+ GB in 5 parts, 0 B on this disk/);

    started = Date.now();
    log(await exec(world, `${tool} get raw_data/mt 2>&1 | tail -3`));
    log(`fetched mt (${(firstParts.mt!.bytes / 1e6).toFixed(0)} MB) in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    expect((await exec(world, 'ls raw_data')).trim().split('\n')).toEqual(['mt']);
    expect((await exec(world, 'sha256sum raw_data/mt/vol-0.bin')).split(' ')[0]).toBe(expected.get('mt/vol-0.bin'));
    // Edit the part: one file changed, one added, one deleted.
    await exec(world, 'echo cleaned >> raw_data/mt/vol-0.bin && echo new > raw_data/mt/notes.txt'
      + (big > 1 ? ' && rm raw_data/mt/vol-1.bin' : ''));
    const edited = (await exec(world, 'sha256sum raw_data/mt/vol-0.bin')).split(' ')[0]!;

    started = Date.now();
    const [parked] = await resources.checkpoint(world.handle);
    const capture = (await store.getResourceRevision(parked!.revisionId))!;
    log(`parked in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    for (const name of ['ocr', 'gretil', 'pages', '.']) expect(storedRef(capture).parts![name]).toEqual(firstParts[name]);
    expect(storedRef(capture).parts!.mt!.snapshot).not.toBe(firstParts.mt!.snapshot);
    await resources.release(world.handle);
    await world.destroy();

    started = Date.now();
    const restored = await open(2, { [data.id]: capture.id });
    log(`world 2 (${restored.handle.id}) restored from the park in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    expect((await exec(restored, 'ls raw_data')).trim().split('\n')).toEqual(['mt']);
    expect((await exec(restored, 'sha256sum raw_data/mt/vol-0.bin')).split(' ')[0]).toBe(edited);
    expect(await exec(restored, `${tool} ls`)).toMatch(/mt\/.*here/);
    expect(await resources.summarize(task.id, data.id)).toMatchObject({ added: 1, modified: 1, deleted: big > 1 ? 1 : 0 });

    started = Date.now();
    await resources.beginReview(task.id, 'live');
    await resources.settleReview(task.id);
    const published = (await store.getResourceRevision((await store.getResourceAttachment(data.id))!.currentRevisionId!))!;
    log(`published in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    expect(published.parentRevisionId).toBe(first.id);
    const parts = storedRef(published).parts!;
    for (const name of ['ocr', 'gretil', 'pages', '.']) expect(parts[name]).toEqual(firstParts[name]);

    // Byte for byte: every file read back from storage and hashed.
    started = Date.now();
    const files = new Map<string, string>();
    for (let offset: number | undefined = 0; offset !== undefined;) {
      const page = await resources.verifyRevision(project.id, data.id, published.id, offset, 1000);
      expect(page.status).not.toBe('failed');
      for (const file of page.files) files.set(file.path, file.sha256);
      offset = page.nextOffset;
    }
    log(`verified ${files.size} files in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    const want = new Map(expected);
    want.set('mt/vol-0.bin', edited);
    want.set('mt/notes.txt', crypto.createHash('sha256').update('new\n').digest('hex'));
    if (big > 1) want.delete('mt/vol-1.bin');
    expect(Object.fromEntries([...files].sort())).toEqual(Object.fromEntries([...want].sort()));
    await resources.release(restored.handle);
  }, 60 * 60_000);
});
