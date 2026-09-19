/** Isolated read-path baseline; never opens the application's database or home.
 * Run: npx tsx benchmarks/read-capacity.ts
 * This measures store allocation/query costs, not end-to-end production latency. */
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Store } from '../src/store/db.js';
import { DurableEventFanout } from '../src/gateway/fanout.js';
import { KarmaxBus } from '../src/contrib/bus.js';

const store = new Store(':memory:');
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const project = store.createProject('Isolated capacity fixture');
const count = 1000;
const text = 'fixture '.repeat(8192); // 64 KiB per task, ~64 MiB of conversations
const ids: string[] = [];
try {
  for (let i = 0; i < count; i++) {
    const task = store.createTask({ projectId: project.id, title: `Fixture ${i}`, workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'fixture', draft: true, archived: i < 800 } });
    ids.push(task.id);
    store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do',
      status: 'active', actions: [], state: {}, updatedAt: 1,
      messages: [{ id: 'fixture', text, role: 'agent', ts: 1 }] });
  }
  async function measure(read: () => unknown | Promise<unknown>) {
    const durations: number[] = [];
    for (let i = 0; i < 12; i++) {
      await yieldTurn();
      const start = performance.now();
      const result = await read();
      durations.push(performance.now() - start);
      if (!result) throw Error('missing fixture result');
    }
    durations.sort((a, b) => a - b);
    return { p50Ms: durations[6], p95Ms: durations[11] };
  }
  const fullHydration = await measure(() => store.listTasks(project.id).filter(task => !task.params.archived));
  const compactAll = await measure(() => store.listTaskSummaries(project.id).filter(task => !task.params.archived));
  const activePage = await measure(() => store.taskSummaryPage(project.id));
  const bus = new KarmaxBus();
  const fanout = new DurableEventFanout(store, bus, 60_000);
  let received = 0;
  for (let i = 0; i < 20; i++) fanout.on(() => { received++; });
  for (let i = 0; i < 1000; i++) store.db.prepare('INSERT INTO events (taskId,type,ts,payload) VALUES (?,?,?,?)')
    .run(ids[i % ids.length]!, 'fixture', i, '{}');
  const start = performance.now();
  bus.emit({ type: 'fixture', taskId: ids[0]!, ts: 1, payload: {} });
  try {
    while (received < 20_000) {
      if (performance.now() - start > 10_000) throw Error('fanout did not complete');
      await yieldTurn();
    }
    console.log(JSON.stringify({ fixture: { tasks: count, active: 200, conversationBytesEach: text.length,
      events: 1000, subscribers: 20, samples: 12 }, fullHydration, compactAll, activePage,
      fanoutMs: performance.now() - start, delivered: received,
      eventLoopP99Ms: delay.percentile(99) / 1e6, peakRssBytes: process.resourceUsage().maxRSS * 1024 }, null, 2));
  } finally { fanout.close(); }
} finally { delay.disable(); store.close(); }
