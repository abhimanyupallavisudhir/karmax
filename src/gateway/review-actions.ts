import { ExecutionOutput } from './execution-output.js';
import type { TaskSecrets } from '../autonomy/task-secrets.js';
import { AsyncInterval } from '../util/async-interval.js';
import * as __asyncCollections from '../util/async-collections.js';
import type { WorldHandle, WorldProcess } from '../world/types.js';
import { WorldRegistry } from '../world/registry.js';
import type { Store } from '../store/db.js';
import type { RunnerPoolService } from '../world/runners.js';
import { newId } from '../util/id.js';
import { hashPreviewToken, newPreviewToken, previewLeaseUrl } from './previews.js';
import { reclaimPorts } from '../world/reclaim-ports.js';

/**
 * Runs a review "run" action's command in the task's on-disk world and streams
 * its output to the UI (SPEC §5.5 — click-to-verify affordances).
 *
 * This lives in the gateway, NOT the Temporal workflow: a human clicking "Run"
 * is a live, out-of-band action (like the existing `/ws/terminal` PTY), not a
 * durable step of the task. The command is never taken from the client — the
 * gateway looks it up from the task's stored `reviewInfo.actions` by index, so
 * only agent-authored commands can be run. Long-lived servers keep running until
 * stopped; short commands exit on their own. Output is kept in a bounded ring so
 * a late-attaching client still sees what happened.
 */

const MAX_OUTPUT = 200_000; // ring-buffer cap per process (chars)
const KILL_GRACE_MS = 3000;

export type ActionListener = (chunk: string, done: boolean, code: number | null) => void;

export interface RunningAction {
  procId: string;
  taskId: string;
  label: string;
  command: string;
  server: boolean;
  openUrls: string[];
  startedAt: number;
  output: string;
  exitCode: number | null;
  running: boolean;
  process: WorldProcess;
  listeners: Set<ActionListener>;
  runnerLeaseId?: string;
  leaseReleased?: boolean;
  provider: string;
  previewLeaseIds: string[];
  world: WorldHandle;
  /** What the task received, scrubbed from stored and replayed output (SS-3). */
  secrets?: TaskSecrets;
}

export interface ActionStatus {
  procId: string;
  taskId: string;
  label: string;
  command: string;
  server: boolean;
  openUrls: string[];
  startedAt: number;
  output: string;
  exitCode: number | null;
  running: boolean;
}

export class ReviewActionRunner {
  private procs = new Map<string, RunningAction>();
  private commandPoll: AsyncInterval;
  private output = new Map<string, ExecutionOutput>();
  private endings = new Map<string, Promise<void>>();
  private cancelled = new Set<string>();

  constructor(private worlds: WorldRegistry, private store: Store, private runners?: RunnerPoolService,
    private access?: import('../world/access.js').WorldAccessService,
    private resources?: import('../world/resources.js').ProjectResourceService,
    private secretsFor?: (taskId: string) => Promise<TaskSecrets>) {
    this.commandPoll = new AsyncInterval(async () => {
      for (const rec of this.procs.values()) {
        if (!rec.running) continue;
        (await this.store.heartbeatExecution(rec.procId));
        if ((await this.store.execution(rec.procId))?.state === 'stop-requested') await rec.process.kill('SIGTERM');
      }
    }, 1_000);
    this.commandPoll.unref();
  }

  async start(opts: {
    taskId: string;
    world: WorldHandle;
    label: string;
    command: string;
    server?: boolean;
    openUrls?: string[];
    /** `command`: one command run with `tavya exec`, not a review action. */
    kind?: 'review-action' | 'command';
    cwd?: string;
  }): Promise<RunningAction> {
    const procId = newId('execution');
    const secrets = await this.secretsFor?.(opts.taskId);
    const scrub = async (text: string) => secrets ? (await secrets.refresh()).scrub(text) : text;
    const task = (await this.store.getTask(opts.taskId));
    const project = task ? (await this.store.getProject(task.projectId)) : undefined;
    if (!task || !project?.organizationId) throw new Error('review execution has no owning project');
    let runnerLeaseId: string | undefined;
    if (this.worlds.get(opts.world.kind).capabilities?.remote && this.runners) {
      runnerLeaseId = (await this.runners.acquire({ project, taskId: opts.taskId, worldId: opts.world.id,
        provider: opts.world.kind })).leaseId;
    }
    const previewLeaseIds: string[] = [];
    let openUrls: string[];
    try {
      openUrls = (await __asyncCollections.map((opts.openUrls ?? []), async (url) => (await reviewUrl(
        this.store, opts.taskId, opts.world, url, previewLeaseIds,
      ))));
      const durableOpenUrls = openUrls.map(redactPreviewToken);
      (await this.store.createExecution({ id: procId, organizationId: project.organizationId, projectId: project.id,
        taskId: opts.taskId, worldId: opts.world.id, generation: opts.world.generation ?? 1,
        kind: opts.kind ?? 'review-action', label: opts.label, command: opts.command, server: !!opts.server,
        openUrls: durableOpenUrls, runnerLeaseId }));
    } catch (error) {
      if (runnerLeaseId && this.access) await this.access.releaseLeaseAndParkIfIdle(opts.world, runnerLeaseId);
      else if (runnerLeaseId) (await this.runners?.release(runnerLeaseId, opts.world.kind));
      for (const id of previewLeaseIds) (await this.store.revokePreviewLease(id));
      throw error;
    }
    let process: WorldProcess;
    let notice = '';
    try {
      const opened = await this.worlds.open(opts.world);
      const world = this.resources ? await this.resources.prepare(opened) : opened;
      // A server owns the ports it declares. In an isolated world, a listener
      // already there is a leftover (usually the agent's own check of this
      // server), and it would make this start fail with EADDRINUSE (task 364).
      if (opts.server && this.worlds.get(opts.world.kind).capabilities?.remote) {
        const ports = (opts.openUrls ?? []).map(loopbackPort).filter((port): port is number => port !== undefined);
        for (const stopped of await reclaimPorts(world, ports).catch(() => []))
          notice += `Stopped an earlier process on port ${stopped.port}: ${stopped.command || `pid ${stopped.pid}`}\n`;
        if (notice) (await this.store.appendExecutionFrame(procId, (await scrub(notice)), 'system'));
      }
      process = await world.startProcess({ command: opts.command, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    } catch (error) {
      (await this.store.appendExecutionFrame(procId, (await scrub(`${error instanceof Error ? error.message : String(error)}\n`)), 'system'));
      (await this.store.finishExecution(procId, null, 'failed'));
      if (runnerLeaseId && this.access) await this.access.releaseLeaseAndParkIfIdle(opts.world, runnerLeaseId);
      else if (runnerLeaseId) (await this.runners?.release(runnerLeaseId, opts.world.kind));
      for (const id of previewLeaseIds) (await this.store.revokePreviewLease(id));
      throw error;
    }
    (await this.store.setExecutionRunning(procId));
    const rec: RunningAction = {
      procId,
      taskId: opts.taskId,
      label: opts.label,
      command: opts.command,
      server: !!opts.server,
      openUrls,
      startedAt: Date.now(),
      output: notice,
      exitCode: null,
      running: true,
      process,
      listeners: new Set(),
      runnerLeaseId,
      provider: opts.world.kind,
      previewLeaseIds,
      world: opts.world,
      ...(secrets ? { secrets } : {}),
    };
    const output = new ExecutionOutput(data => this.store.appendExecutionFrame(procId, data), undefined, secrets);
    this.output.set(procId, output);
    this.procs.set(procId, rec);
    process.onOutput(buf => {
      const data = String(buf);
      rec.output = (rec.output + data).slice(-MAX_OUTPUT);
      output.append(data);
      this.notify(rec, data, false);
    });
    process.onExit(code => {
      void this.finishAction(rec, code).catch(error => console.error('[review] execution completion failed:', error));
    });
    return rec;
  }

  get(procId: string): RunningAction | undefined {
    return this.procs.get(procId);
  }

  async status(procId: string): Promise<ActionStatus | undefined> {
    const r = this.procs.get(procId);
    // The live ring is replayed to whoever attaches later: scrub it like the frames.
    if (r) return { ...toStatus(r), ...(r.secrets ? { output: (await r.secrets.refresh()).scrub(r.output) } : {}) };
    const durable = (await this.store.execution(procId));
    if (!durable) return undefined;
    return {
      procId: durable.id, taskId: durable.taskId, label: durable.label, command: durable.command ?? '',
      server: durable.server, openUrls: durable.openUrls, startedAt: durable.startedAt,
      output: (await this.store.executionFrames(procId)).map((frame) => frame.data).join('').slice(-MAX_OUTPUT),
      exitCode: durable.exitCode ?? null,
      running: ['starting', 'running', 'stop-requested'].includes(durable.state),
    };
  }

  async listFor(taskId: string): Promise<ActionStatus[]> {
    return (await __asyncCollections.map((await this.store.listExecutions(taskId)).filter((execution) => execution.kind === 'review-action'), async (execution) => (await this.status(execution.id))!)).filter(Boolean);
  }

  /** Subscribe to live output; returns an unsubscribe fn. Emits nothing historical
   *  — the caller sends `rec.output` first, then attaches for the live tail. */
  async attach(procId: string, listener: ActionListener): Promise<() => void> {
    const rec = this.procs.get(procId);
    if (rec) {
      rec.listeners.add(listener);
      return () => rec.listeners.delete(listener);
    }
    let seq = (await this.store.executionFrames(procId)).at(-1)?.seq ?? 0;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      for (const frame of (await this.store.executionFrames(procId, seq))) { seq = frame.seq; listener(frame.data, false, null); }
      const execution = (await this.store.execution(procId));
      if (!execution || !['starting', 'running', 'stop-requested'].includes(execution.state)) {
        listener('', true, execution?.exitCode ?? null);
        stopped = true;
        void timer.stop();
      }
    };
    const timer = new AsyncInterval(poll, 500);
    timer.unref();
    (await poll());
    return () => { stopped = true; void timer.stop(); };
  }

  async stop(procId: string): Promise<boolean> {
    const requested = (await this.store.requestExecutionStop(procId));
    const rec = this.procs.get(procId);
    if (!rec || !rec.running) return requested;
    await rec.process.kill('SIGTERM');
    setTimeout(() => {
      if (rec.running) void Promise.resolve(rec.process.kill('SIGKILL')).catch(error => console.error('[review] process stop failed:', error));
    }, KILL_GRACE_MS).unref?.();
    return requested;
  }

  /** Kill everything and drain accepted output before closing the Store. */
  async stopAll(): Promise<void> {
    await this.commandPoll.stop();
    for (const rec of [...this.procs.values()]) if (rec.running) {
      this.cancelled.add(rec.procId);
      await rec.process.kill('SIGKILL');
      await this.finishAction(rec, null, 'cancelled');
    }
    await Promise.all([...this.endings.values()]);
  }

  private notify(rec: RunningAction, data: string, done: boolean): void {
    for (const listener of rec.listeners) {
      try { listener(data, done, done ? rec.exitCode : null); }
      catch (error) { console.error('[review] output listener failed:', error); }
    }
  }

  private finishAction(rec: RunningAction, code: number | null, state?: 'cancelled'): Promise<void> {
    const previous = this.endings.get(rec.procId);
    if (previous) return previous;
    if (!this.procs.has(rec.procId)) return Promise.resolve();
    rec.running = false;
    rec.exitCode = code;
    const work = (async () => {
      let outputFailed = false;
      try { await this.output.get(rec.procId)?.close(); }
      catch {
        outputFailed = true;
        const notice = '\n[Output could not be saved for reconnect.]\n';
        rec.output = (rec.output + notice).slice(-MAX_OUTPUT);
        this.notify(rec, notice, false);
      }
      try { await this.store.finishExecution(rec.procId, code, outputFailed ? 'failed' : state ?? (this.cancelled.has(rec.procId) ? 'cancelled' : undefined)); }
      finally {
        // Publishing command completion must not wait for remote sandbox parking.
        // Shutdown still awaits this ending promise, including lease cleanup.
        this.procs.delete(rec.procId);
        this.output.delete(rec.procId);
        this.cancelled.delete(rec.procId);
        this.notify(rec, '', true);
        rec.listeners.clear();
        try { await this.releaseLease(rec, rec.provider); }
        finally { await this.revokePreviews(rec); }
      }
    })();
    this.endings.set(rec.procId, work);
    // Observe both branches without creating an unhandled rejected finally promise.
    void work.then(() => this.endings.delete(rec.procId), () => this.endings.delete(rec.procId));
    return work;
  }

  private async releaseLease(rec: RunningAction, provider: string): Promise<void> {
    if (!rec.runnerLeaseId || rec.leaseReleased) return;
    rec.leaseReleased = true;
    if (this.access) await this.access.releaseLeaseAndParkIfIdle(rec.world, rec.runnerLeaseId);
    else (await this.runners?.release(rec.runnerLeaseId, provider));
  }

  private async revokePreviews(rec: RunningAction): Promise<void> {
    for (const id of rec.previewLeaseIds.splice(0)) (await this.store.revokePreviewLease(id));
  }
}

/** Localhost in a cloud world means that world's loopback, not the browser's.
 * Route it through karmax's authenticated preview proxy. */
async function reviewUrl(store: Store, taskId: string, world: WorldHandle, value: string, leases: string[]): Promise<string> {
  if (['worktree', 'container', 'memory'].includes(world.kind)) return value;
  try {
    const port = loopbackPort(value);
    if (port === undefined) return value;
    const url = new URL(value);
    const task = (await store.getTask(taskId));
    const project = task ? (await store.getProject(task.projectId)) : undefined;
    if (!task || !project?.organizationId) return value;
    const token = newPreviewToken();
    const lease = (await store.createPreviewLease({ id: newId('preview'), organizationId: project.organizationId,
      projectId: project.id, taskId, worldId: world.id, generation: world.generation ?? 1, port,
      public: false, tokenHash: hashPreviewToken(token), provider: world.kind,
      createdBy: 'system:review-action', createdAt: Date.now(),
      expiresAt: Date.now() + reviewPreviewTtlMs() }));
    leases.push(lease.id);
    return previewLeaseUrl(lease.id, `${url.pathname}${url.search}`, token);
  } catch {
    return value;
  }
}

/** The port of a URL on the world's own loopback, which is what a review
 * server's `openUrls` name. */
function loopbackPort(value: string): number | undefined {
  try {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname)) return undefined;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
  } catch { return undefined; }
}

function redactPreviewToken(value: string): string {
  try {
    const url = new URL(value, 'http://localhost');
    url.searchParams.delete('token');
    return value.startsWith('http') ? url.toString() : `${url.pathname}${url.search}`;
  } catch { return value; }
}

function reviewPreviewTtlMs(): number {
  const value = Number(process.env.KARMAX_REVIEW_PREVIEW_TTL_MS);
  return Number.isFinite(value) && value >= 60_000 ? Math.min(value, 24 * 60 * 60_000) : 8 * 60 * 60_000;
}

function toStatus(r: RunningAction): ActionStatus {
  const { process: _p, listeners: _l, runnerLeaseId: _r, leaseReleased: _x, provider: _provider, world: _world,
    previewLeaseIds: _previewLeaseIds, secrets: _secrets, ...rest } = r;
  return rest;
}
