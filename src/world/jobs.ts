import crypto from 'node:crypto';
import path from 'node:path';
import type { World, WorldProcess } from './types.js';
import { worldWorkingDirectory } from './types.js';
import { ensureWorldExcluded } from './secret-exclude.js';

/**
 * Durable jobs: long commands an agent needs the result of (a render, a build,
 * a training run) that must outlive the agent's turn.
 *
 * Anything an agent starts from its own shell belongs to its turn: ending or
 * retrying the turn stops it (local custody sweep, the remote pidfile reaper,
 * or Claude Code itself). A job is instead started by karmax through the
 * provider-neutral world API, in its own session, and every fact about it
 * lives in files inside the world:
 *
 *   .karmax-injection/jobs/<id>/command   the command, run with `bash`
 *                               cwd       where it runs
 *                               pid       session leader (= process group)
 *                               pidstart  /proc start tick, a PID-reuse guard
 *                               log       stdout + stderr
 *                               started   epoch seconds
 *                               ended     epoch seconds, once it exits
 *                               exit      exit code, written last
 *
 * So any later activity — after a worker restart, a sandbox pause, or a new
 * turn — can learn its state with one `exec`, for every world kind alike.
 * `.karmax-injection/` is excluded from git and from checkpoints.
 */

export const JOB_ROOT = '.karmax-injection/jobs';
const JOB_ID = /^job-[a-f0-9]{8}$/;

export type JobState = 'running' | 'exited' | 'lost' | 'missing';

export interface JobStatus {
  id: string;
  state: JobState;
  exitCode?: number;
  command?: string;
  startedAt?: number;
  endedAt?: number;
  /** World path of the job's combined output. */
  log: string;
  /** Last lines of the log, when requested. */
  tail?: string;
}

export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID.test(value);
}

/** World path of a job's directory (as the agent sees it). */
export function jobDirectory(world: Pick<World, 'handle'>, id: string): string {
  return path.posix.join(world.handle.root.replace(/\\/g, '/'), JOB_ROOT, id);
}

// `alive DIR` — true while the job's session leader is the very process that
// was started (a recycled pid has a different start tick).
const ALIVE = `alive() { p=$(cat "$1/pid" 2>/dev/null) || return 1; [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  want=$(cat "$1/pidstart" 2>/dev/null); [ -z "$want" ] && return 0
  now=$(cut -d' ' -f22 "/proc/$p/stat" 2>/dev/null); [ -z "$now" ] || [ "$now" = "$want" ]; }`;

// Started with cwd = world root, so every path is root-relative: the same
// script works on the host, in a container (root mounted elsewhere), and in a
// remote sandbox.
const LAUNCH = `set -e
id=$1; cwd=$2; d=${JOB_ROOT}/$id
mkdir -p "$d"; d=$(cd "$d" && pwd)
cat > "$d/command"
printf '%s\\n' "$cwd" > "$d/cwd"; date +%s > "$d/started"
cd -- "$cwd"
setsid bash -c 'd=$1; echo $$ > "$d/pid.tmp"; cut -d" " -f22 /proc/$$/stat > "$d/pidstart" 2>/dev/null || true
  mv -f "$d/pid.tmp" "$d/pid"
  bash "$d/command" > "$d/log" 2>&1 < /dev/null; c=$?
  date +%s > "$d/ended"; echo "$c" > "$d/exit.tmp"; mv -f "$d/exit.tmp" "$d/exit"' karmax-job "$d" > /dev/null 2>&1 < /dev/null &
i=0; while [ ! -s "$d/pid" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i+1)); done
[ -s "$d/pid" ]`;

/** Start `command` as a durable job. `cwd` is relative to the agent's working
 * directory unless absolute. `env` carries the project's work secrets. */
export async function startJob(world: World, spec: { command: string; cwd?: string; env?: Record<string, string> }): Promise<JobStatus> {
  const command = spec.command.trim();
  if (!command) throw new Error('command is required');
  const workdir = worldWorkingDirectory(world.handle).replace(/\\/g, '/');
  const cwd = spec.cwd ? (path.posix.isAbsolute(spec.cwd) ? spec.cwd : path.posix.join(workdir, spec.cwd)) : workdir;
  // The launcher runs from the world root, which a container maps elsewhere:
  // express a cwd inside the world relative to that root.
  const root = world.handle.root.replace(/\\/g, '/').replace(/\/+$/, '');
  const inside = path.posix.relative(root, cwd);
  const launchCwd = !inside ? '.' : inside.startsWith('..') || path.posix.isAbsolute(inside) ? cwd : inside;
  await ensureWorldExcluded(world, '.karmax-injection').catch(() => {});
  const id = `job-${crypto.randomBytes(4).toString('hex')}`;
  const result = await world.exec('bash', ['-c', LAUNCH, 'karmax-job-launch', id, launchCwd], {
    cwd: world.handle.root, input: `${command}\n`, timeoutMs: 30_000, ...(spec.env ? { env: spec.env } : {}),
  });
  if (result.code !== 0) throw new Error(`could not start job: ${(result.stderr || result.stdout).trim().slice(0, 500) || `exit ${result.code}`}`);
  return { id, state: 'running', command, log: `${jobDirectory(world, id)}/log` };
}

const STATUS = `${ALIVE}
b=$1; lines=$2; shift 2
for id in "$@"; do d=${JOB_ROOT}/$id
  if [ ! -d "$d" ]; then printf '%s %s missing\\n' "$b" "$id"; continue; fi
  if [ -f "$d/exit" ]; then s="exited $(cat "$d/exit")"; elif alive "$d"; then s=running; else s=lost; fi
  printf '%s %s %s %s %s\\n' "$b" "$id" "$s" "$(cat "$d/started" 2>/dev/null)" "$(cat "$d/ended" 2>/dev/null)"
  head -c 300 "$d/command" 2>/dev/null | head -n 1; echo
  if [ "$lines" -gt 0 ] && [ -f "$d/log" ]; then tail -c 6000 "$d/log" | tail -n "$lines"; fi
done
printf '%s end\\n' "$b"`;

/** One round trip for every job's state (and, with `tailLines`, its last output). */
export async function jobStatuses(world: World, ids: string[], opts: { tailLines?: number } = {}): Promise<JobStatus[]> {
  const valid = ids.filter(isJobId);
  const out = new Map<string, JobStatus>();
  for (const id of ids) if (!isJobId(id)) out.set(id, { id, state: 'missing', log: '' });
  if (valid.length) {
    const boundary = `@@karmax-job-${crypto.randomBytes(6).toString('hex')}`;
    const result = await world.exec('bash', ['-c', STATUS, 'karmax-job-status', boundary, String(Math.max(0, opts.tailLines ?? 0)), ...valid],
      { cwd: world.handle.root, timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`could not read job status: ${(result.stderr || result.stdout).trim().slice(0, 300) || `exit ${result.code}`}`);
    let current: JobStatus | undefined;
    let body: string[] = [];
    const flush = () => {
      if (!current) return;
      const [command, ...tail] = body;
      if (command) current.command = command;
      const text = tail.join('\n').replace(/^\n+/, '').trimEnd();
      if (opts.tailLines && text) current.tail = text;
      out.set(current.id, current);
      current = undefined;
      body = [];
    };
    for (const line of result.stdout.split('\n')) {
      if (!line.startsWith(`${boundary} `)) { if (current) body.push(line); continue; }
      flush();
      const [id, state, ...rest] = line.slice(boundary.length + 1).split(' ');
      if (id === 'end') break;
      if (!id || !isJobId(id)) continue;
      const log = `${jobDirectory(world, id)}/log`;
      if (state === 'missing') { out.set(id, { id, state: 'missing', log }); continue; }
      const numbers = rest.map((value) => (value ? Number(value) : NaN));
      if (state === 'exited') {
        const [exitCode, started, ended] = numbers;
        current = { id, state: 'exited', log, exitCode, ...(Number.isFinite(started) ? { startedAt: started! * 1000 } : {}),
          ...(Number.isFinite(ended) ? { endedAt: ended! * 1000 } : {}) };
      } else {
        const [started] = numbers;
        current = { id, state: state === 'running' ? 'running' : 'lost', log,
          ...(Number.isFinite(started) ? { startedAt: started! * 1000 } : {}) };
      }
    }
    flush();
  }
  return ids.map((id) => out.get(id) ?? { id, state: 'missing', log: '' });
}

/** Every job ever started in this world. */
export async function listJobs(world: World): Promise<string[]> {
  const result = await world.exec('bash', ['-c', `ls -1 ${JOB_ROOT} 2>/dev/null || true`], { cwd: world.handle.root, timeoutMs: 30_000 });
  return result.stdout.split('\n').map((line) => line.trim()).filter(isJobId);
}

const STOP = `${ALIVE}
live=""
for id in "$@"; do d=${JOB_ROOT}/$id; [ -f "$d/exit" ] && continue
  if alive "$d"; then p=$(cat "$d/pid"); kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true; live="$live $id"; fi
done
i=0; while [ -n "$live" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); next=""
  for id in $live; do alive "${JOB_ROOT}/$id" && next="$next $id"; done; live=$next; done
for id in $live; do p=$(cat "${JOB_ROOT}/$id/pid"); kill -KILL -- "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true; done`;

/** Stop jobs (all of this world's by default): SIGTERM the job's process
 * group, then SIGKILL whatever is left after five seconds. */
export async function stopJobs(world: World, ids?: string[]): Promise<void> {
  const targets = (ids ?? (await listJobs(world))).filter(isJobId);
  if (!targets.length) return;
  await world.exec('bash', ['-c', STOP, 'karmax-job-stop', ...targets], { cwd: world.handle.root, timeoutMs: 30_000 });
}

/**
 * A small in-world process that exits once every listed job has exited, or
 * after `seconds`. Running it through `startProcess` is what keeps a cloud
 * sandbox awake while nothing else is happening in it: providers refresh their
 * idle lease for as long as a started process is open.
 */
export function startJobWaiter(world: World, ids: string[], seconds: number): Promise<WorldProcess> {
  const valid = ids.filter(isJobId).join(' ');
  const secs = Math.max(1, Math.floor(seconds));
  return world.startProcess({
    cwd: world.handle.root,
    command: `${ALIVE}
end=$(( $(date +%s) + ${secs} ))
while [ "$(date +%s)" -lt "$end" ]; do live=0
  for id in ${valid}; do d=${JOB_ROOT}/$id; [ -f "$d/exit" ] && continue; alive "$d" && live=1; done
  [ "$live" = 0 ] && exit 0; sleep 5; done`,
  });
}

/** Human-readable duration for resume messages. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

/** What the agent is told about its jobs when it resumes. */
export function describeJobs(jobs: JobStatus[], now = Date.now()): string {
  return jobs.map((job) => {
    const took = job.startedAt !== undefined ? formatDuration((job.endedAt ?? now) - job.startedAt) : undefined;
    const head = job.state === 'exited'
      ? `Job ${job.id} exited with code ${job.exitCode}${took ? ` after ${took}` : ''}.`
      : job.state === 'running'
        ? `Job ${job.id} is still running${took ? ` (${took} so far)` : ''}.`
        : job.state === 'lost'
          ? `Job ${job.id} stopped without recording an exit code (its world was restarted or the process was killed).`
          : `Job ${job.id} was not found in this world.`;
    const lines = [head];
    if (job.command) lines.push(`Command: ${job.command}`);
    if (job.log) lines.push(`Log: ${job.log}`);
    if (job.tail) lines.push(`Last output:\n${job.tail}`);
    return lines.join('\n');
  }).join('\n\n');
}
