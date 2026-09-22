/** Native PostgreSQL liveness probe. Uses a disposable loopback database only:
 * KARMAX_BENCHMARK_POSTGRES_URL=postgres://... node --import tsx benchmarks/native-async-capacity.ts
 * This exercises the Store through a tiny HTTP fixture, not the production
 * gateway/auth stack. It makes no claim about production end-to-end latency. */
import http from 'node:http';
import { once } from 'node:events';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Store } from '../src/store/db.js';

const target = process.env.KARMAX_BENCHMARK_POSTGRES_URL;
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname))
  throw new Error('set KARMAX_BENCHMARK_POSTGRES_URL to a disposable loopback PostgreSQL database');
const store = await Store.create(target);
const project = await store.createProject(`Async capacity fixture ${Date.now()}`);
const delay = monitorEventLoopDelay({ resolution: 5 });
let server: http.Server | undefined;
let stall: Promise<unknown> | undefined;
try {
  for (let i = 0; i < 200; i++) await store.createTask({ projectId: project.id, title: `Fixture ${i}`,
    workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'fixture', draft: true } });
  server = http.createServer((_request, response) => {
    void store.taskSummaryPage(project.id).then(page => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(page));
    }, () => { response.writeHead(503); response.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  await (await fetch(endpoint)).arrayBuffer();
  let started!: () => void;
  const inTransaction = new Promise<void>(resolve => { started = resolve; });
  let completed = false;
  delay.enable();
  const began = performance.now();
  stall = store.db.transaction(async () => {
    started();
    await store.db.prepare('SELECT pg_sleep(0.5)').get();
  }).then(() => { completed = true; });
  await inTransaction;
  let completedWhileStalled = 0;
  const latencies = await Promise.all(Array.from({ length: 40 }, async () => {
    const start = performance.now();
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
    await response.arrayBuffer();
    if (!completed) completedWhileStalled++;
    return performance.now() - start;
  }));
  await stall;
  latencies.sort((a, b) => a - b);
  console.log(JSON.stringify({ fixture: { tasks: 200, concurrentReads: 40, databaseStallMs: 500 },
    completedWhileStalled, totalMs: performance.now() - began,
    requestP50Ms: latencies[20], requestP95Ms: latencies[38], requestMaxMs: latencies[39],
    eventLoopP99Ms: delay.percentile(99) / 1e6, eventLoopMaxMs: delay.max / 1e6,
    database: store.db.stats }, null, 2));
} finally {
  delay.disable();
  await stall?.catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await store.deleteProject(project.id);
  await store.close();
}
