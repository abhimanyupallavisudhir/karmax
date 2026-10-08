/** Samples the system under load on the app's own host (benchmarks/load/sut-setup.sh
 *  starts it) and appends one JSON line per sample to --out:
 *
 *    host      CPU (user/system/iowait/steal), load, memory            every --every s
 *    docker    per-container CPU, memory, restarts, OOM kills          every --every s
 *    postgres  connections by database/state, lock waiters, the global
 *              Store lock (pg_advisory_xact_lock) waiters and their
 *              longest wait, commits/rollbacks/deadlocks               every --every s
 *    metrics   the app's /api/metrics (Prometheus text, as the
 *              installation administrator)                             every 2×--every s
 *    temporal  task-queue backlog (count and age) for workflow and
 *              activity tasks; running workflow count                  every 3×--every s
 *    temporal-server  the server's Prometheus metrics (matching and
 *              persistence latencies), filtered                        every 3×--every s
 *
 *  Process heap comes from probe.mjs inside the app container, not from here.
 *
 *    node --experimental-strip-types benchmarks/load/collector.ts --out samples.jsonl \
 *      --admin-email E --admin-password P --origin https://loadtest.invalid [--every 5]
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}
const out = option('out');
const every = Number(option('every', '5')) * 1000;
const origin = new URL(option('origin'));
const app = option('app', 'http://127.0.0.1:4505');
const adminEmail = option('admin-email');
const adminPassword = option('admin-password');
const project = option('compose-project', 'karmax');
const temporalMetrics = option('temporal-metrics', 'http://127.0.0.1:8000/metrics');

const write = (kind: string, data: unknown) =>
  fs.appendFileSync(out, `${JSON.stringify({ t: Date.now(), kind, data })}\n`);

function run(command: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`${command} ${args.slice(0, 3).join(' ')}: ${error.message} ${stderr}`.slice(0, 400))) : resolve(stdout));
  });
}

// ---------------------------------------------------------------- host

let lastCpu: number[] | undefined;
function host() {
  const fields = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal
  const previous = lastCpu;
  lastCpu = fields;
  const meminfo = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n')
    .map((line) => /^(\w+):\s+(\d+)/.exec(line)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], Number(m[2]) * 1024]));
  const load = fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number);
  let cpu: Record<string, number> | undefined;
  if (previous) {
    const delta = fields.map((value, at) => value - (previous[at] ?? 0));
    const total = delta.slice(0, 8).reduce((a, b) => a + b, 0) || 1;
    const pct = (at: number) => Math.round((delta[at]! / total) * 1000) / 10;
    cpu = { user: pct(0) + pct(1), system: pct(2) + pct(5) + pct(6), idle: pct(3), iowait: pct(4), steal: pct(7) };
  }
  write('host', { cpu, load, memTotal: meminfo.MemTotal, memAvailable: meminfo.MemAvailable, swapUsed: (meminfo.SwapTotal ?? 0) - (meminfo.SwapFree ?? 0) });
}

// ---------------------------------------------------------------- docker

const bytes = (text: string): number => {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/.exec(text.trim());
  if (!m) return 0;
  const unit = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[m[2]!] ?? 1;
  return Math.round(Number(m[1]) * unit);
};
async function dockerStats() {
  const text = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
  const containers: Record<string, unknown> = {};
  for (const line of text.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line) as Record<string, string>;
    const name = (entry.Name ?? '').replace(new RegExp(`^${project}-`), '').replace(/-1$/, '');
    const [used = '', limit = ''] = (entry.MemUsage ?? '').split('/');
    containers[name] = { cpu: Number((entry.CPUPerc ?? '0').replace('%', '')), mem: bytes(used), memLimit: bytes(limit), pids: Number(entry.PIDs ?? 0) };
  }
  const ids = (await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).split('\n').filter(Boolean);
  const states: Record<string, unknown> = {};
  if (ids.length) {
    const inspected = JSON.parse(await run('docker', ['inspect', ...ids])) as Array<Record<string, any>>;
    for (const c of inspected) states[String(c.Name).replace(/^\//, '').replace(new RegExp(`^${project}-`), '').replace(/-1$/, '')] =
      { running: c.State?.Running, restarts: c.RestartCount, oomKilled: c.State?.OOMKilled, startedAt: c.State?.StartedAt, exitCode: c.State?.ExitCode, health: c.State?.Health?.Status };
  }
  write('docker', { containers, states });
}

// ---------------------------------------------------------------- postgres

const PG_QUERY = `
select json_build_object(
  'connections', (select coalesce(json_object_agg(k, n), '{}'::json) from (
      select coalesce(datname, '-') || ':' || coalesce(usename, '-') || ':' || coalesce(state, '-') as k, count(*) as n
      from pg_stat_activity where backend_type = 'client backend' group by 1) s),
  'maxConnections', current_setting('max_connections')::int,
  'lockWaiting', (select count(*) from pg_stat_activity where wait_event_type = 'Lock'),
  'advisoryWaiting', (select count(*) from pg_locks where locktype = 'advisory' and not granted),
  'advisoryHeld', (select count(*) from pg_locks where locktype = 'advisory' and granted),
  'advisoryWaitMaxMs', (select coalesce(round(max(extract(epoch from clock_timestamp() - a.query_start)) * 1000), 0)
      from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and not l.granted),
  'lockWaitMaxMs', (select coalesce(round(max(extract(epoch from clock_timestamp() - query_start)) * 1000), 0)
      from pg_stat_activity where wait_event_type = 'Lock'),
  'longestXactMs', (select coalesce(round(max(extract(epoch from clock_timestamp() - xact_start)) * 1000), 0)
      from pg_stat_activity where datname = 'karmax' and xact_start is not null),
  'databases', (select json_object_agg(datname, json_build_object('commit', xact_commit, 'rollback', xact_rollback,
      'deadlocks', deadlocks, 'blksRead', blks_read, 'tupInserted', tup_inserted, 'tupUpdated', tup_updated,
      'sizeBytes', pg_database_size(datname)))
      from pg_stat_database where datname in ('karmax', 'temporal', 'temporal_visibility'))
)`;
async function postgres() {
  const text = await run('docker', ['exec', `${project}-postgresql-1`, 'psql', '-U', 'temporal', '-d', 'postgres', '-Atqc', PG_QUERY]);
  write('postgres', JSON.parse(text));
}

// ---------------------------------------------------------------- app metrics

let cookie = '';
async function login() {
  const response = await fetch(`${app}/api/login`, {
    method: 'POST', redirect: 'manual',
    headers: { host: origin.host, origin: origin.origin, 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!response.ok) throw new Error(`admin login: ${response.status}`);
  cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
async function appMetrics() {
  if (!cookie) await login();
  const started = Date.now();
  let response = await fetch(`${app}/api/metrics`, { headers: { host: origin.host, 'x-forwarded-proto': 'https', cookie }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) { await login(); response = await fetch(`${app}/api/metrics`, { headers: { host: origin.host, 'x-forwarded-proto': 'https', cookie } }); }
  const text = await response.text();
  if (!response.ok) throw new Error(`/api/metrics: ${response.status} ${text.slice(0, 200)}`);
  write('metrics', { scrapeMs: Date.now() - started, text });
}

// ---------------------------------------------------------------- temporal

const TCTL = 'loadtest-temporal-cli';
async function temporalCli(args: string[]): Promise<string> {
  return run('docker', ['exec', TCTL, 'temporal', ...args, '--address', 'temporal:7233', '--namespace', 'karmax'], 30_000);
}
async function temporal() {
  const data: Record<string, unknown> = {};
  try {
    data.taskQueue = JSON.parse(await temporalCli(['task-queue', 'describe', '--task-queue', 'karmax', '--report-stats', '-o', 'json']));
  } catch (error) {
    // Older CLIs have no --report-stats; describe still lists pollers.
    data.taskQueueError = error instanceof Error ? error.message : String(error);
  }
  try {
    data.running = JSON.parse(await temporalCli(['workflow', 'count', '--query', 'ExecutionStatus="Running"', '-o', 'json']));
  } catch (error) { data.runningError = error instanceof Error ? error.message : String(error); }
  write('temporal', data);
}
const KEEP_SERVER_METRIC = /^(task_schedule_to_start_latency|asyncmatch_latency|syncmatch_latency|poll_success|poll_success_sync|poll_timeouts|task_dispatch_latency|approximate_backlog|persistence_latency|persistence_errors|service_errors|lease_requests|workflow_task_attempt|task_latency|schedule_to_start|activity_task_schedule_to_start|no_poller_tasks|local_to_remote_matches|resource_exhausted)/;
async function temporalServer() {
  const response = await fetch(temporalMetrics, { signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  const kept = text.split('\n').filter((line) => line && !line.startsWith('#') && KEEP_SERVER_METRIC.test(line)
    // Only the histograms' totals and the latency buckets that matter.
    && (!line.includes('_bucket{') || /le="(0\.05|0\.1|0\.25|0\.5|1|2|5|10|\+Inf)"/.test(line)));
  write('temporal-server', { lines: kept });
}

// ---------------------------------------------------------------- loop

async function guarded(name: string, task: () => Promise<void> | void) {
  try { await task(); } catch (error) { write('collector-error', { source: name, message: error instanceof Error ? error.message : String(error) }); }
}

async function ensureTemporalCli() {
  const running = await run('docker', ['ps', '-q', '--filter', `name=^${TCTL}$`]).catch(() => '');
  if (running.trim()) return;
  await run('docker', ['rm', '-f', TCTL]).catch(() => '');
  const image = (await run('docker', ['inspect', '-f', '{{.Config.Image}}', `${project}-temporal-1`])).trim().replace('temporalio/server', 'temporalio/admin-tools');
  await run('docker', ['run', '-d', '--name', TCTL, '--label', 'loadtest=1', '--network', `${project}_default`, '--memory', '256m',
    '--entrypoint', 'sleep', image, 'infinity'], 120_000);
}

let tick = 0;
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
await guarded('temporal-cli', ensureTemporalCli);
write('collector-start', { every, app, origin: origin.origin });
while (!stopping) {
  const started = Date.now();
  host();
  const work: Array<Promise<void>> = [guarded('docker', dockerStats), guarded('postgres', postgres)];
  if (tick % 2 === 0) work.push(guarded('metrics', appMetrics));
  if (tick % 3 === 0) work.push(guarded('temporal', temporal), guarded('temporal-server', temporalServer));
  await Promise.all(work);
  tick++;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, every - (Date.now() - started))));
}
write('collector-stop', {});
