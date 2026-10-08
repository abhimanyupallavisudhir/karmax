// Preloaded into every Node process of the app container under load test
// (NODE_OPTIONS=--import=/loadtest/probe.mjs, see sut-setup.sh), so the
// gateway and the activity worker report their own heap without any change to
// the app. Every LOADTEST_PROBE_MS (default 5 s) each process appends one line
// to $LOADTEST_PROBE_DIR/<role>-<pid>.jsonl: memory, V8 heap limits, event-loop
// delay and GC pause time over the interval. The timer is unref'd, so the probe
// never keeps a process alive, and it writes synchronously so a process that is
// about to die of heap exhaustion still leaves its last sample.
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

const dir = process.env.LOADTEST_PROBE_DIR || '/loadtest/probe';
const every = Number(process.env.LOADTEST_PROBE_MS) || 5000;
const script = process.argv[1] ?? '';
// npm, npx and the tsx launcher also run src/main.ts by name, but only as an
// argument; the process whose own script it is, is the gateway.
const role = /activity-worker-main\.ts$/.test(script) ? 'worker'
  : /src[\\/]main\.ts$/.test(script) ? 'gateway' : 'other';

// Wrappers (npm, the tsx launcher) and helper processes have nothing to report.
if (role !== 'other') {
  let file;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${role}-${process.pid}.jsonl`);
  } catch { file = undefined; }
  if (file) {
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    let gcMs = 0, gcCount = 0, majorMs = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          gcMs += entry.duration; gcCount++;
          // kind 2 is a major (mark-compact) collection.
          if (entry.detail?.kind === 2) majorMs += entry.duration;
        }
      }).observe({ entryTypes: ['gc'] });
    } catch { /* gc entries unavailable */ }
    const sample = () => {
      const memory = process.memoryUsage();
      const heap = v8.getHeapStatistics();
      const line = {
        t: Date.now(), role, pid: process.pid,
        rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
        external: memory.external, arrayBuffers: memory.arrayBuffers,
        heapLimit: heap.heap_size_limit, mallocked: heap.malloced_memory,
        eldP50: loop.percentile(50) / 1e6, eldP99: loop.percentile(99) / 1e6, eldMax: loop.max / 1e6,
        gcMs: Math.round(gcMs), gcCount, majorGcMs: Math.round(majorMs),
      };
      loop.reset(); gcMs = 0; gcCount = 0; majorMs = 0;
      try { fs.appendFileSync(file, `${JSON.stringify(line)}\n`); } catch { /* disk full: keep running */ }
    };
    setInterval(sample, every).unref();
    process.on('exit', sample);
  }
}
