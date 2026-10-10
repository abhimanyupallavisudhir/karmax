// Preloaded into every Node process of the app container under load test
// (NODE_OPTIONS=--import=/loadtest/probe.mjs, see sut-setup.sh), so the
// gateway and the activity worker report their own heap without any change to
// the app. Every LOADTEST_PROBE_MS (default 5 s) each process appends one line
// to $LOADTEST_PROBE_DIR/<role>-<pid>.jsonl: memory, V8 heap limits, event-loop
// delay and GC pause time over the interval. The timer is unref'd, so the probe
// never keeps a process alive, and it writes synchronously so a process that is
// about to die of heap exhaustion still leaves its last sample.
//
// Every LOADTEST_PROFILE_EVERY_MS (default 2 min; 0 disables) it also records
// a LOADTEST_PROFILE_MS (default 20 s) CPU profile of its main thread with the
// in-process inspector, keeps the profile (<role>-<pid>-<t>.cpuprofile) and
// appends a summary to <role>-<pid>.profile.jsonl: self time by module (a
// source file, or a package under node_modules) and the hottest functions, so
// a report can say what a saturated process spends its core on. Only ever on
// a load-test copy, never production (wiki ops/performance-history).
import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import v8 from 'node:v8';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

const dir = process.env.LOADTEST_PROBE_DIR || '/loadtest/probe';
const every = Number(process.env.LOADTEST_PROBE_MS) || 5000;
const script = process.argv[1] ?? '';
// npm, npx and the tsx launcher also run src/main.ts by name, but only as an
// argument; the process whose own script it is, is the gateway.
const role = script.endsWith('activity-worker-main.ts') ? 'worker'
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
    let cpu = process.cpuUsage(), cpuAt = performance.now();
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
        // CPU this process used over the interval, in percent of one core.
        cpuPct: Math.round(((process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000 / (performance.now() - cpuAt)) * 1000) / 10,
      };
      cpu = process.cpuUsage(); cpuAt = performance.now();
      loop.reset(); gcMs = 0; gcCount = 0; majorMs = 0;
      try { fs.appendFileSync(file, `${JSON.stringify(line)}\n`); } catch { /* disk full: keep running */ }
    };
    setInterval(sample, every).unref();
    process.on('exit', sample);
    const profileEvery = Number(process.env.LOADTEST_PROFILE_EVERY_MS ?? 120_000);
    const profileFor = Number(process.env.LOADTEST_PROFILE_MS) || 20_000;
    if (profileEvery > 0) setInterval(() => profile(dir, role, profileFor), profileEvery).unref();
  }
}

/** Where a call frame's code lives: a package, a source file, or the runtime. */
function moduleOf(url) {
  if (!url) return '(runtime)';
  const modules = url.lastIndexOf('node_modules/');
  if (modules >= 0) {
    const rest = url.slice(modules + 'node_modules/'.length).split('/');
    return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  }
  if (url.startsWith('node:')) return url;
  const source = url.indexOf('/src/');
  return source >= 0 ? url.slice(source + 1) : url.replace(/^file:\/\//, '');
}

function profile(dir, role, ms) {
  const session = new inspector.Session();
  const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  const started = Date.now();
  (async () => {
    session.connect();
    await post('Profiler.enable');
    await post('Profiler.start');
    await new Promise((resolve) => setTimeout(resolve, ms).unref());
    const { profile } = await post('Profiler.stop');
    const deltas = profile.timeDeltas ?? [];
    const self = new Map();
    for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (deltas[i] ?? 0));
    const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
    const byModule = new Map(), byFunction = new Map();
    for (const node of profile.nodes) {
      const us = self.get(node.id) ?? 0;
      if (!us) continue;
      const frame = node.callFrame;
      const module = frame.functionName === '(idle)' || frame.functionName === '(program)' || frame.functionName === '(garbage collector)'
        ? frame.functionName : moduleOf(frame.url);
      byModule.set(module, (byModule.get(module) ?? 0) + us);
      const fn = `${frame.functionName || '(anonymous)'} ${moduleOf(frame.url)}:${frame.lineNumber + 1}`;
      byFunction.set(fn, (byFunction.get(fn) ?? 0) + us);
    }
    const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([name, us]) => ({ name, ms: Math.round(us / 1000), pct: Math.round((us / total) * 1000) / 10 }));
    fs.writeFileSync(path.join(dir, `${role}-${process.pid}-${started}.cpuprofile`), JSON.stringify(profile));
    fs.appendFileSync(path.join(dir, `${role}-${process.pid}.profile.jsonl`), `${JSON.stringify({
      t: started, until: Date.now(), role, pid: process.pid, sampledMs: Math.round(total / 1000),
      modules: top(byModule, 25), functions: top(byFunction, 40) })}\n`);
  })().catch(() => { /* a profile is best effort */ }).finally(() => { try { session.disconnect(); } catch { /* closed */ } });
}
