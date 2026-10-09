/** Joins what one load-test run recorded into a per-step table:
 *
 *    node --experimental-strip-types benchmarks/load/report.ts RESULTS_DIR [--compare OTHER_DIR]
 *
 *  Reads RESULTS_DIR/steps.jsonl (driver.ts), raw/samples.jsonl.gz (collector.ts),
 *  raw/probe.tgz (probe.mjs), run.json and cost.json, and writes
 *  RESULTS_DIR/summary.json and RESULTS_DIR/report.md. Each step is judged on
 *  its steady window: after its new tenants were set up, while the whole
 *  population ran. With --compare, report.md also lists the steps both runs
 *  reached side by side.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

type Json = any;
const dir = process.argv[2];
if (!dir) throw new Error('usage: report.ts RESULTS_DIR [--compare OTHER_DIR]');
const compareAt = process.argv.indexOf('--compare');
const compareDir = compareAt > 0 ? process.argv[compareAt + 1] : undefined;

const jsonl = (text: string): Json[] => text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const readMaybe = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const max = (values: number[]) => values.length ? Math.max(...values) : undefined;
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
const round = (value: number | undefined, digits = 0) => value === undefined || !Number.isFinite(value) ? undefined : Math.round(value * 10 ** digits) / 10 ** digits;
const mb = (value: number | undefined) => value === undefined ? undefined : Math.round(value / 1048576);
const finite = (values: Array<number | undefined>) => values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

// ---------------------------------------------------------------- Prometheus text

interface Sample { name: string; labels: string; value: number }
function parseProm(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (m) out.push({ name: m[1]!, labels: m[2] ?? '', value: Number(m[3]) });
  }
  return out;
}

/** p50/p95 of a Prometheus histogram family between two scrapes, all label sets summed. */
function histogramDelta(first: Sample[], last: Sample[], family: string) {
  const buckets = (samples: Sample[]) => {
    const byLe = new Map<number, number>();
    for (const s of samples) {
      if (s.name !== `${family}_bucket`) continue;
      const le = /le="([^"]+)"/.exec(s.labels)?.[1];
      if (!le) continue;
      const bound = le === '+Inf' ? Infinity : Number(le);
      byLe.set(bound, (byLe.get(bound) ?? 0) + s.value);
    }
    return byLe;
  };
  const a = buckets(first), b = buckets(last);
  const bounds = [...b.keys()].sort((x, y) => x - y);
  const delta = bounds.map((bound) => ({ bound, count: (b.get(bound) ?? 0) - (a.get(bound) ?? 0) }));
  const total = delta.at(-1)?.count ?? 0;
  if (total <= 0) return undefined;
  const quantile = (q: number) => {
    const target = q * total;
    let previous = { bound: 0, count: 0 };
    for (const entry of delta) {
      if (entry.count >= target) {
        if (!Number.isFinite(entry.bound)) return previous.bound;
        const span = entry.count - previous.count || 1;
        return previous.bound + (entry.bound - previous.bound) * ((target - previous.count) / span);
      }
      previous = entry;
    }
    return previous.bound;
  };
  const sum = (samples: Sample[]) => samples.filter((s) => s.name === `${family}_sum`).reduce((acc, s) => acc + s.value, 0);
  return { count: total, mean: (sum(last) - sum(first)) / total, p50: quantile(0.5), p95: quantile(0.95) };
}

// ---------------------------------------------------------------- inputs

function load(resultsDir: string) {
  const steps = jsonl(readMaybe(path.join(resultsDir, 'steps.jsonl')));
  const samplesFile = path.join(resultsDir, 'raw', 'samples.jsonl.gz');
  const samples = fs.existsSync(samplesFile) ? jsonl(zlib.gunzipSync(fs.readFileSync(samplesFile)).toString('utf8')) : [];
  const probes: Json[] = [];
  const probeArchive = path.join(resultsDir, 'raw', 'probe.tgz');
  if (fs.existsSync(probeArchive)) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    execFileSync('tar', ['xzf', probeArchive, '-C', scratch]);
    const probeDir = path.join(scratch, 'probe');
    for (const file of fs.existsSync(probeDir) ? fs.readdirSync(probeDir) : []) probes.push(...jsonl(fs.readFileSync(path.join(probeDir, file), 'utf8')));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const run = JSON.parse(readMaybe(path.join(resultsDir, 'run.json')) || '{}');
  const cost = JSON.parse(readMaybe(path.join(resultsDir, 'cost.json')) || '{}');
  return { steps, samples, probes, run, cost };
}

// ---------------------------------------------------------------- per step

function stepRow(step: Json, samples: Json[], probes: Json[]) {
  const from = Date.parse(step.steadyFrom), to = Date.parse(step.endedAt);
  const inWindow = (kind: string) => samples.filter((s) => s.kind === kind && s.t >= from && s.t <= to).map((s) => s.data);
  const host = inWindow('host');
  const docker = inWindow('docker');
  const pg = inWindow('postgres');
  const metrics = samples.filter((s) => s.kind === 'metrics' && s.t >= from && s.t <= to);
  const temporal = inWindow('temporal');
  const server = samples.filter((s) => s.kind === 'temporal-server' && s.t >= from && s.t <= to);
  const steady = step.steady ?? {};
  const m = steady.metrics ?? {};
  const c = steady.counts ?? {};
  const requests = c.requests ?? 0;
  const failures = (c.serverErrors ?? 0) + (c.networkErrors ?? 0) + (c.timeouts ?? 0);

  const container = (name: string, field: string) => finite(docker.map((d) => d.containers?.[name]?.[field]));
  const role = (name: string) => probes.filter((p) => p.role === name && p.t >= from && p.t <= to);
  const gateway = role('gateway'), worker = role('worker');
  const gcShare = (rows: Json[]) => {
    const pids = new Set(rows.map((r) => r.pid));
    const seconds = (to - from) / 1000;
    return pids.size ? rows.reduce((sum, r) => sum + (r.gcMs ?? 0), 0) / 1000 / seconds / pids.size : undefined;
  };

  // App gauges: every series named like a database, lock, loop or memory measure.
  const appGauges: Record<string, number> = {};
  for (const scrape of metrics) for (const s of parseProm(scrape.data.text)) {
    if (!/database|lock|event_loop|inflight|rss|heap/.test(s.name) || s.name.endsWith('_bucket') || s.name.endsWith('_count')) continue;
    const key = `${s.name}${s.labels}`;
    appGauges[key] = Math.max(appGauges[key] ?? -Infinity, s.value);
  }
  const scrapeMs = finite(metrics.map((s) => s.data.scrapeMs));

  // The server's matching histograms between the window's first and last
  // scrape: every family summed, and schedule-to-start (the task-queue latency)
  // per task type. Backlog age and count are gauges: the window's maximum.
  const serverLatency: Record<string, Json> = {};
  const scheduleToStart: Record<string, Json> = {};
  const parsedServer = server.map((sample) => parseProm(sample.data.lines.join('\n')));
  if (parsedServer.length >= 2) {
    const first = parsedServer[0]!, last = parsedServer.at(-1)!;
    const summary = (h: ReturnType<typeof histogramDelta>) => h && ({ count: h.count, meanMs: round(h.mean * 1000, 1), p50Ms: round(h.p50 * 1000, 1), p95Ms: round(h.p95 * 1000, 1) });
    const families = new Set(last.filter((s) => s.name.endsWith('_bucket')).map((s) => s.name.slice(0, -'_bucket'.length)));
    for (const family of families) {
      const h = summary(histogramDelta(first, last, family));
      if (h) serverLatency[family] = h;
    }
    for (const type of ['Workflow', 'Activity']) {
      const only = (samples: Sample[]) => samples.filter((s) => s.labels.includes(`task_type="${type}"`) && s.labels.includes('taskqueue="karmax"'));
      const h = summary(histogramDelta(only(first), only(last), 'task_schedule_to_start_latency'));
      if (h) scheduleToStart[type.toLowerCase()] = h;
    }
  }
  const karmaxQueue = (name: string) => finite(parsedServer.flatMap((samples) => samples
    .filter((s) => s.name === name && s.labels.includes('taskqueue="karmax"') && s.labels.includes('namespace="karmax"')).map((s) => s.value)));

  const connections = pg.map((p) => Object.values(p.connections ?? {}).reduce((a: number, b) => a + Number(b), 0) as number);
  const karmaxConnections = pg.map((p) => Object.entries(p.connections ?? {}).filter(([k]) => k.startsWith('karmax:')).reduce((a, [, b]) => a + Number(b), 0));
  const commits = pg.map((p) => Number(p.databases?.karmax?.commit ?? 0));
  const commitRate = commits.length >= 2 ? (commits.at(-1)! - commits[0]!) / ((to - from) / 1000) : undefined;

  return {
    step: step.step, tenants: step.tenants, teams: step.teams, people: step.people, sockets: step.sockets,
    openTasks: step.trackedTasks?.total, tasksInTurn: step.trackedTasks?.turn, tasksAtReview: step.trackedTasks?.review,
    runningWorkflows: max(finite(temporal.map((t) => Number(t.running?.count)))),
    sandboxes: step.sandboxes, setupSeconds: step.setupSeconds, failedSetups: step.failedSetups,
    requestsPerSecond: steady.requestsPerSecond, requests, errorRatePct: requests ? round((100 * failures) / requests, 2) : undefined,
    rateLimited: c.rateLimited ?? 0, clientErrors: c.clientErrors ?? 0,
    api: m['api *'], eventLag: m['event lag'], turnOverhead: m['turn overhead'], firstTurn: m['turn first total'],
    approveToDone: m['approve to done'], cancelToCancelled: m['cancel to cancelled'], wsConnect: m['ws connect'],
    tenantSetup: step.setup?.metrics?.['tenant setup'],
    tasks: { created: c.tasksCreated ?? 0, turns: c.turnsCompleted ?? 0, done: c.tasksDone ?? 0, cancelled: c.tasksCancelled ?? 0,
      failed: c.tasksFailed ?? 0, stuck: c.tasksStuck ?? 0, followUps: c.followUps ?? 0, resourceSaves: c.resourceSaves ?? 0 },
    sockets_: { opens: c.socketOpens ?? 0, refused: c.socketRefused ?? 0, failures: c.socketFailures ?? 0, drops: c.socketDrops ?? 0,
      closes: Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('socketClosed'))), events: c.eventsReceived ?? 0 },
    slowestRoutes: Object.entries(m).filter(([k]) => k.startsWith('api ') && k !== 'api *')
      .sort((a: Json, b: Json) => (b[1]?.p95 ?? 0) - (a[1]?.p95 ?? 0)).slice(0, 6).map(([k, v]: Json) => ({ route: k.slice(4), ...v })),
    hostCpuPct: { mean: round(mean(finite(host.map((h) => h.cpu ? h.cpu.user + h.cpu.system : undefined)))), max: round(max(finite(host.map((h) => h.cpu ? h.cpu.user + h.cpu.system : undefined)))),
      steal: round(max(finite(host.map((h) => h.cpu?.steal))), 1), iowait: round(max(finite(host.map((h) => h.cpu?.iowait))), 1) },
    load1Max: round(max(finite(host.map((h) => h.load?.[0]))), 2),
    hostMemAvailableMinMb: mb(Math.min(...finite(host.map((h) => h.memAvailable)))),
    containers: Object.fromEntries(['app', 'postgresql', 'temporal', 'caddy'].map((name) => [name, {
      cpuMeanPct: round(mean(container(name, 'cpu'))), cpuMaxPct: round(max(container(name, 'cpu'))),
      memMaxMb: mb(max(container(name, 'mem'))), memLimitMb: mb(max(container(name, 'memLimit'))) }])),
    appRestarts: max(finite(docker.map((d) => d.states?.app?.restarts))), appOomKilled: docker.some((d) => d.states?.app?.oomKilled),
    gateway: { heapUsedMaxMb: mb(max(finite(gateway.map((p) => p.heapUsed)))), heapLimitMb: mb(max(finite(gateway.map((p) => p.heapLimit)))),
      rssMaxMb: mb(max(finite(gateway.map((p) => p.rss)))), eldP99MaxMs: round(max(finite(gateway.map((p) => p.eldP99))), 1),
      eldMaxMs: round(max(finite(gateway.map((p) => p.eldMax)))), cpuMeanPct: round(mean(finite(gateway.map((p) => p.cpuPct)))), gcPct: round(100 * (gcShare(gateway) ?? NaN), 1), pids: new Set(gateway.map((p) => p.pid)).size },
    worker: { heapUsedMaxMb: mb(max(finite(worker.map((p) => p.heapUsed)))), heapLimitMb: mb(max(finite(worker.map((p) => p.heapLimit)))),
      rssMaxMb: mb(max(finite(worker.map((p) => p.rss)))), eldP99MaxMs: round(max(finite(worker.map((p) => p.eldP99))), 1),
      eldMaxMs: round(max(finite(worker.map((p) => p.eldMax)))), cpuMeanPct: round(mean(finite(worker.map((p) => p.cpuPct)))), gcPct: round(100 * (gcShare(worker) ?? NaN), 1), pids: new Set(worker.map((p) => p.pid)).size },
    postgres: {
      connectionsMax: max(connections), karmaxConnectionsMax: max(karmaxConnections), maxConnections: pg[0]?.maxConnections,
      lockWaitersMax: max(finite(pg.map((p) => p.lockWaiting))), advisoryWaitersMax: max(finite(pg.map((p) => p.advisoryWaiting))),
      advisoryWaitersMean: round(mean(finite(pg.map((p) => p.advisoryWaiting))), 2),
      advisoryWaitMaxMs: max(finite(pg.map((p) => p.advisoryWaitMaxMs))), longestXactMs: max(finite(pg.map((p) => p.longestXactMs))),
      karmaxCommitsPerSecond: round(commitRate, 1),
      karmaxDbMb: mb(max(finite(pg.map((p) => p.databases?.karmax?.sizeBytes)))),
    },
    appGauges,
    metricsScrapeMaxMs: max(scrapeMs),
    temporal: {
      backlogAgeMaxMs: round((max(karmaxQueue('approximate_backlog_age_seconds')) ?? NaN) * 1000),
      backlogCountMax: max(karmaxQueue('approximate_backlog_count')),
      scheduleToStart,
      serverLatency,
    },
    broken: step.broken ?? [],
    errorSamples: (steady.errors ?? []).slice(0, 8),
  };
}

// ---------------------------------------------------------------- report

const fmt = (value: unknown) => value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value)) ? '–' : String(value);
const pct = (p: Json) => p ? `${fmt(p.p50)} / ${fmt(p.p95)} / ${fmt(p.p99)}` : '–';
const s = (ms: number | undefined) => ms === undefined ? '–' : (ms / 1000).toFixed(1);

function table(rows: Json[]) {
  const lines = [
    '| step | tenants (people) | open tasks | running wf | req/s | API ms p50/p95/p99 | errors % | event lag ms p50/p95/p99 | turn overhead s p50/p95 | gateway heap / RSS MB | worker heap / RSS MB | worker loop p99 ms | app mem MB | host CPU % mean/max | PG conns | advisory waiters max | advisory wait max ms | Temporal backlog age ms | schedule-to-start p95 ms wf / act |',
    '|---:|---:|---:|---:|---:|---|---:|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---|',
  ];
  for (const r of rows) lines.push(`| ${r.step} | ${r.tenants} (${r.people}) | ${fmt(r.openTasks)} | ${fmt(r.runningWorkflows)} | ${fmt(r.requestsPerSecond)} | ${pct(r.api)} | ${fmt(r.errorRatePct)} | ${pct(r.eventLag)} | ${s(r.turnOverhead?.p50)} / ${s(r.turnOverhead?.p95)} | ${fmt(r.gateway.heapUsedMaxMb)} / ${fmt(r.gateway.rssMaxMb)} | ${fmt(r.worker.heapUsedMaxMb)} / ${fmt(r.worker.rssMaxMb)} | ${fmt(r.worker.eldP99MaxMs)} | ${fmt(r.containers.app.memMaxMb)} | ${fmt(r.hostCpuPct.mean)} / ${fmt(r.hostCpuPct.max)} | ${fmt(r.postgres.connectionsMax)} | ${fmt(r.postgres.advisoryWaitersMax)} | ${fmt(r.postgres.advisoryWaitMaxMs)} | ${fmt(r.temporal.backlogAgeMaxMs)} | ${fmt(r.temporal.scheduleToStart.workflow?.p95Ms)} / ${fmt(r.temporal.scheduleToStart.activity?.p95Ms)} |`);
  return lines.join('\n');
}

const { steps, samples, probes, run, cost } = load(dir);
const rows = steps.map((step) => stepRow(step, samples, probes));
const wall = rows.find((r) => r.broken.length);
const restarts = (roleName: string) => new Set(probes.filter((p) => p.role === roleName).map((p) => p.pid)).size;
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ run, cost, steps: rows }, null, 1));

const md: string[] = [];
md.push(`# Load test ${run.label ?? ''} — ${run.sha?.slice(0, 10) ?? ''}`, '');
md.push(`Run \`${run.runId}\`, ${run.ref} (\`${run.sha}\`), ${run.region}: system under test ${run.sutType}, worlds and load generator ${run.worldType}, `
  + `${run.worldRttMs} ms added to every E2B round trip, ${run.holdSeconds} s held per step. Cost **$${fmt(cost.totalUsd)}**. `
  + `Gateway processes seen: ${restarts('gateway')}, worker processes seen: ${restarts('worker')} (more than one means a restart).`, '');
md.push(wall
  ? `**First wall: step ${wall.step}, ${wall.tenants} tenants / ${wall.people} people / ${fmt(wall.openTasks)} open tasks** — ${wall.broken.join('; ')}.`
  : `No step broke a limit (the ramp ended at ${rows.at(-1)?.tenants ?? 0} tenants).`, '');
md.push('Steady window of each step (after its new tenants were set up). Latencies are as the load generator saw them through the HTTPS edge.', '');
md.push(table(rows), '');
for (const r of rows) {
  md.push(`<details><summary>Step ${r.step}: ${r.tenants} tenants${r.broken.length ? ' — broke' : ''}</summary>`, '', '```json', JSON.stringify(r, null, 1), '```', '</details>', '');
}
if (compareDir) {
  const other = load(compareDir);
  const otherRows = other.steps.map((step) => stepRow(step, other.samples, other.probes));
  md.push(`## Compared with ${other.run.label} (\`${other.run.sha?.slice(0, 10)}\`)`, '', table(otherRows), '');
}
fs.writeFileSync(path.join(dir, 'report.md'), `${md.join('\n')}\n`);
console.log(md.slice(0, 8).join('\n'));
console.log(table(rows));
