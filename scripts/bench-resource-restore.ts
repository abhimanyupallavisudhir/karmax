#!/usr/bin/env -S npx tsx
// World setup of a project with many small single-file resources (personal-website
// #7: 489 of them), measured on this host against a world that behaves like a
// remote sandbox: restic runs in it as platform jobs, fetched from the gateway.
//
//   npx tsx scripts/bench-resource-restore.ts [--resources 500] [--exec-ms 250] [--http-ms 150] [--fixture DIR]
//
// --exec-ms delays every command karmax runs in the world (E2B's control plane,
// an ocean away from the app host); --http-ms delays every request restic in
// the world makes to the repository server (the Cloudflare edge to tavya, an
// ocean the other way). The fixture (store, vault, objects) is built once into
// --fixture and reused: importing 500 resources takes minutes. --fast-keys
// first gives every repository its fast key (restic-keys.ts), as upkeep does
// for repositories made before them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
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
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import { findFreePortFrom } from '../src/util/ports.js';

const { values } = parseArgs({ options: {
  resources: { type: 'string', default: '500' }, 'exec-ms': { type: 'string', default: '250' },
  'http-ms': { type: 'string', default: '150' }, 'fast-keys': { type: 'boolean', default: false }, fixture: { type: 'string', default: path.join(os.tmpdir(), 'karmax-bench-restore') },
} });
const count = Number(values.resources);
const execMs = Number(values['exec-ms']);
const httpMs = Number(values['http-ms']);
const dir = path.resolve(values.fixture!);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A file's content, the same on every run: sizes from 200 B to ~600 KB, a few of 4 MB. */
const contentOf = (i: number) => {
  const size = i % 97 === 0 ? 4 * 1024 * 1024 : 200 + ((i * 7919) % 600_000);
  const out = Buffer.alloc(size);
  for (let at = 0, n = 0; at < size; at += 32, n++) crypto.createHash('sha256').update(`${i}:${n}`).digest().copy(out, at);
  return out;
};

const fresh = !fs.existsSync(path.join(dir, 'fixture.json'));
fs.mkdirSync(dir, { recursive: true });
const store = await Store.create(path.join(dir, 'store.db'));
const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
const objects = new LocalObjectStore(path.join(dir, 'objects'));
const worlds = new WorldRegistry();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-bench-world-'));
worlds.register(new WorktreeProvider(path.join(scratch, 'worlds')));
let worldUrl = '';
const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker,
  undefined, undefined, { world: () => worldUrl });
const tokens = new TokenAuthority();
const client = { workflow: { getHandle: () => ({}) } } as never;
const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'bench', resources });
const gateway = await Gateway.create({ api, store, tokens, client, worlds, taskQueue: 'bench', resources, broker,
  bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), staticDir: 'web',
  agentInfo: { provider: 'mock', reason: 'restore benchmark' } });
const server = await gateway.listen(await findFreePortFrom(49_700));
const target = new URL(server.url);

// restic in the world reaches the server through this, one ocean away.
let requests = 0;
const proxy = http.createServer((req, res) => {
  requests++;
  setTimeout(() => {
    const upstream = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers },
      (answer) => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  }, httpMs);
});
proxy.keepAliveTimeout = 60_000;
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
worldUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

let fixture: { projectId: string; repo: string };
if (fresh) {
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo, { recursive: true });
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'site/\n');
  await gitOrThrow(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-qm', 'base']);
  const project = await store.createProject('Many small resources', { repos: [repo] });
  const started = Date.now();
  for (let i = 0; i < count; i++) {
    const attachment = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: `site/assets/${i}.bin`, driver: 'object-tree@1', target: { kind: 'path', path: `site/assets/${i}.bin` },
      access: i % 5 ? 'write' : 'read', isolation: 'fork', source: { shape: 'file' }, credentialHandles: [], publish: i % 5 ? 'review' : 'discard' });
    await resources.importFiles(attachment.id, [{ path: `${i}.bin`, data: contentOf(i) }]);
    if (i % 50 === 49) console.log(`imported ${i + 1}/${count} (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  fixture = { projectId: project.id, repo };
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(fixture));
} else fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));

const attachments = await store.listResourceAttachments(fixture.projectId);
if (values['fast-keys']) {
  const keying = Date.now();
  let added = 0;
  for (const attachment of attachments)
    if (await resources.restic.addFastKey(resources.restic.repository(attachment, undefined))) added++;
  console.log(`fast keys: ${added} added in ${Math.round((Date.now() - keying) / 100) / 10} s`);
}
const task = await store.createTask({ projectId: fixture.projectId, title: 'Bench', workflow: 'software-dev', workflowVersion: '1.26.0',
  params: { prompt: 'bench' } });
const world = await worlds.create('worktree', { taskId: task.id, repo: fixture.repo, base: 'main' });
world.handle = { ...world.handle, kind: 'e2b' };
let execs = 0;
const exec = world.exec.bind(world);
world.exec = async (...args) => { execs++; await sleep(execMs); return exec(...args); };
let resticRuns = 0;
const counted = path.join(scratch, 'restic-runs');
// Every restic the world starts leaves a line here (the binary is wrapped once fetched).
const wrap = setInterval(() => {
  const bin = path.join(world.handle.root, '.karmax-injection/bin');
  for (const name of fs.existsSync(bin) ? fs.readdirSync(bin) : []) {
    if (!/^restic-\d/.test(name) || fs.existsSync(path.join(bin, `.real-${name}`))) continue;
    fs.renameSync(path.join(bin, name), path.join(bin, `.real-${name}`));
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho x >> ${counted}\nexec ${path.join(bin, `.real-${name}`)} "$@"\n`, { mode: 0o755 });
  }
}, 5);

console.log(`${attachments.length} resources; ${execMs} ms per world command, ${httpMs} ms per restic request`);
const started = Date.now();
await resources.materialize(fixture.projectId, task.id, world, 1);
const elapsed = Date.now() - started;
clearInterval(wrap);
resticRuns = fs.existsSync(counted) ? fs.readFileSync(counted, 'utf8').split('\n').filter(Boolean).length : 0;

let wrong = 0;
for (const attachment of attachments) {
  const file = path.join(world.handle.root, (attachment.target as { path: string }).path);
  const i = Number(/(\d+)\.bin$/.exec(file)![1]);
  if (!fs.existsSync(file) || !contentOf(i).equals(fs.readFileSync(file))) wrong++;
}
const events = await store.eventsOfTypes(task.id, ['world.resource-restoring', 'world.resource-restored']);
const leases = (await store.listResourceLeases(world.handle.id)).filter((lease) => lease.state === 'active');
console.log(JSON.stringify({ resources: attachments.length, seconds: Math.round(elapsed / 100) / 10, worldCommands: execs,
  resticRuns, resticRequests: requests, events: events.length, activeLeases: leases.length, wrongFiles: wrong }));
await world.destroy().catch(() => undefined);
server.close(); proxy.close(); store.close();
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(wrong ? 1 : 0);
