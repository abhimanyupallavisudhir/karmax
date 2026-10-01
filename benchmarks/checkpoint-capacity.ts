/** Peak memory and event-loop stalls of a chunked checkpoint capture and
 * restore, against a local world. Usage: tsx benchmarks/checkpoint-capacity.ts [MiB]
 * Run it at two sizes: peak RSS should stay flat as the file grows. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';

const mib = Number(process.argv[2] ?? 256);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-capacity-'));
let peakRss = process.memoryUsage().rss, maxStallMs = 0;
const stalls: number[] = [];
async function measure<T>(operation: () => Promise<T>) {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxStallMs = Math.max(maxStallMs, now - last - 10);
    if (now - last - 10 > 100) stalls.push(Math.round(now - last - 10));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    last = now;
  }, 10);
  const start = performance.now();
  try { return { value: await operation(), durationMs: Math.round(performance.now() - start) }; }
  finally { clearInterval(timer); }
}
try {
  const store = await Store.create(':memory:');
  const project = await store.createProject('Capacity');
  const task = await store.createTask({ projectId: project.id, title: 'Capacity', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'benchmark' } });
  const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const service = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')),
    new CredentialBroker(new Vault(path.join(dir, 'vault'))));
  const world = await worlds.create('worktree', { taskId: task.id, base: 'main' });
  world.handle.meta = { projectId: project.id };
  world.handle = await store.registerWorld(world.handle, project.id) as typeof world.handle;
  const file = fs.openSync(path.join(world.handle.root, 'large.bin'), 'w');
  for (let written = 0; written < mib; written += 16) fs.writeSync(file, crypto.randomBytes(16 * 1024 * 1024));
  fs.closeSync(file);
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(world.handle.root, `source-${i}.ts`), `export const v${i} = ${'x'.repeat(2000)};\n`);
  peakRss = process.memoryUsage().rss;
  const baselineRss = peakRss;
  const capture = await measure(() => service.checkpoint(world.handle));
  await world.destroy();
  const restore = await measure(() => service.restore(capture.value.id, 'worktree'));
  console.log(JSON.stringify({ fixture: { largeFileMiB: mib, smallFiles: 2000 },
    captureMs: capture.durationMs, restoreMs: restore.durationMs, maxStallMs: Math.round(maxStallMs), stallsOver100Ms: stalls,
    baselineRssMiB: Math.round(baselineRss / 2 ** 20), peakRssMiB: Math.round(peakRss / 2 ** 20),
    storedObjects: capture.value.filesystemDelta }, null, 2));
  await store.close();
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
