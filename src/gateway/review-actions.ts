import type { WorldHandle, WorldProcess } from '../world/types.js';
import { WorldRegistry } from '../world/registry.js';
import type { Store } from '../store/db.js';
import type { RunnerPoolService } from '../world/runners.js';
import { newId } from '../util/id.js';
import { hashPreviewToken, newPreviewToken, previewLeaseUrl } from './previews.js';

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
  private commandPoll: NodeJS.Timeout;

  constructor(private worlds: WorldRegistry, private store: Store, private runners?: RunnerPoolService) {
    this.commandPoll = setInterval(() => {
      for (const rec of this.procs.values()) {
        this.store.heartbeatExecution(rec.procId);
        if (this.store.execution(rec.procId)?.state === 'stop-requested' && rec.running) void rec.process.kill('SIGTERM');
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
  }): Promise<RunningAction> {
    const procId = newId('execution');
    const task = this.store.getTask(opts.taskId);
    const project = task ? this.store.getProject(task.projectId) : undefined;
    if (!task || !project?.organizationId) throw new Error('review execution has no owning project');
    let runnerLeaseId: string | undefined;
    if (this.worlds.get(opts.world.kind).capabilities?.remote && this.runners) {
      runnerLeaseId = (await this.runners.acquire({ project, taskId: opts.taskId, worldId: opts.world.id,
        provider: opts.world.kind })).leaseId;
    }
    const previewLeaseIds: string[] = [];
    let openUrls: string[];
    try {
      openUrls = (opts.openUrls ?? []).map((url) => reviewUrl(
        this.store, opts.taskId, opts.world, url, previewLeaseIds,
      ));
      const durableOpenUrls = openUrls.map(redactPreviewToken);
      this.store.createExecution({ id: procId, organizationId: project.organizationId, projectId: project.id,
        taskId: opts.taskId, worldId: opts.world.id, generation: opts.world.generation ?? 1,
        kind: 'review-action', label: opts.label, command: opts.command, server: !!opts.server,
        openUrls: durableOpenUrls, runnerLeaseId });
    } catch (error) {
      if (runnerLeaseId) this.runners?.release(runnerLeaseId, opts.world.kind);
      for (const id of previewLeaseIds) this.store.revokePreviewLease(id);
      throw error;
    }
    let process: WorldProcess;
    try {
      const world = await this.worlds.open(opts.world);
      process = await world.startProcess({ command: opts.command });
    } catch (error) {
      this.store.appendExecutionFrame(procId, `${error instanceof Error ? error.message : String(error)}\n`, 'system');
      this.store.finishExecution(procId, null, 'failed');
      if (runnerLeaseId) this.runners?.release(runnerLeaseId, opts.world.kind);
      for (const id of previewLeaseIds) this.store.revokePreviewLease(id);
      throw error;
    }
    this.store.setExecutionRunning(procId);
    const rec: RunningAction = {
      procId,
      taskId: opts.taskId,
      label: opts.label,
      command: opts.command,
      server: !!opts.server,
      openUrls,
      startedAt: Date.now(),
      output: '',
      exitCode: null,
      running: true,
      process,
      listeners: new Set(),
      runnerLeaseId,
      provider: opts.world.kind,
      previewLeaseIds,
    };
    const append = (buf: unknown) => {
      const s = String(buf);
      rec.output = (rec.output + s).slice(-MAX_OUTPUT);
      this.store.appendExecutionFrame(procId, s);
      for (const l of rec.listeners) l(s, false, null);
    };
    process.onOutput(append);
    process.onExit((code) => {
      rec.running = false;
      rec.exitCode = code;
      this.store.finishExecution(procId, code);
      this.releaseLease(rec, opts.world.kind);
      this.revokePreviews(rec);
      for (const l of rec.listeners) l('', true, rec.exitCode);
    });
    this.procs.set(procId, rec);
    return rec;
  }

  get(procId: string): RunningAction | undefined {
    return this.procs.get(procId);
  }

  status(procId: string): ActionStatus | undefined {
    const r = this.procs.get(procId);
    if (r) return toStatus(r);
    const durable = this.store.execution(procId);
    if (!durable) return undefined;
    return {
      procId: durable.id, taskId: durable.taskId, label: durable.label, command: durable.command ?? '',
      server: durable.server, openUrls: durable.openUrls, startedAt: durable.startedAt,
      output: this.store.executionFrames(procId).map((frame) => frame.data).join('').slice(-MAX_OUTPUT),
      exitCode: durable.exitCode ?? null,
      running: ['starting', 'running', 'stop-requested'].includes(durable.state),
    };
  }

  listFor(taskId: string): ActionStatus[] {
    return this.store.listExecutions(taskId).filter((execution) => execution.kind === 'review-action')
      .map((execution) => this.status(execution.id)!).filter(Boolean);
  }

  /** Subscribe to live output; returns an unsubscribe fn. Emits nothing historical
   *  — the caller sends `rec.output` first, then attaches for the live tail. */
  attach(procId: string, listener: ActionListener): () => void {
    const rec = this.procs.get(procId);
    if (rec) {
      rec.listeners.add(listener);
      return () => rec.listeners.delete(listener);
    }
    let seq = this.store.executionFrames(procId).at(-1)?.seq ?? 0;
    let stopped = false;
    const poll = () => {
      if (stopped) return;
      for (const frame of this.store.executionFrames(procId, seq)) { seq = frame.seq; listener(frame.data, false, null); }
      const execution = this.store.execution(procId);
      if (!execution || !['starting', 'running', 'stop-requested'].includes(execution.state)) {
        listener('', true, execution?.exitCode ?? null);
        stopped = true;
        clearInterval(timer);
      }
    };
    const timer = setInterval(poll, 500);
    timer.unref();
    poll();
    return () => { stopped = true; clearInterval(timer); };
  }

  stop(procId: string): boolean {
    const requested = this.store.requestExecutionStop(procId);
    const rec = this.procs.get(procId);
    if (!rec || !rec.running) return requested;
    void rec.process.kill('SIGTERM');
    setTimeout(() => {
      if (rec.running) void rec.process.kill('SIGKILL');
    }, KILL_GRACE_MS).unref?.();
    return requested;
  }

  /** Kill everything — called on gateway shutdown so no dev server is orphaned. */
  stopAll(): void {
    clearInterval(this.commandPoll);
    for (const rec of this.procs.values()) if (rec.running) {
      this.store.finishExecution(rec.procId, null, 'cancelled');
      void rec.process.kill('SIGKILL');
      this.releaseLease(rec, rec.provider);
      this.revokePreviews(rec);
    }
    this.procs.clear();
  }

  private releaseLease(rec: RunningAction, provider: string): void {
    if (!rec.runnerLeaseId || rec.leaseReleased) return;
    rec.leaseReleased = true;
    this.runners?.release(rec.runnerLeaseId, provider);
  }

  private revokePreviews(rec: RunningAction): void {
    for (const id of rec.previewLeaseIds.splice(0)) this.store.revokePreviewLease(id);
  }
}

/** Localhost in a cloud world means that world's loopback, not the browser's.
 * Route it through karmax's authenticated preview proxy. */
function reviewUrl(store: Store, taskId: string, world: WorldHandle, value: string, leases: string[]): string {
  if (['worktree', 'container', 'memory'].includes(world.kind)) return value;
  try {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) return value;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return value;
    const task = store.getTask(taskId);
    const project = task ? store.getProject(task.projectId) : undefined;
    if (!task || !project?.organizationId) return value;
    const token = newPreviewToken();
    const lease = store.createPreviewLease({ id: newId('preview'), organizationId: project.organizationId,
      projectId: project.id, taskId, worldId: world.id, generation: world.generation ?? 1, port,
      public: false, tokenHash: hashPreviewToken(token), provider: world.kind,
      createdBy: 'system:review-action', createdAt: Date.now(),
      expiresAt: Date.now() + reviewPreviewTtlMs() });
    leases.push(lease.id);
    return previewLeaseUrl(lease.id, `${url.pathname}${url.search}`, token);
  } catch {
    return value;
  }
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
  const { process: _p, listeners: _l, runnerLeaseId: _r, leaseReleased: _x, provider: _provider,
    previewLeaseIds: _previewLeaseIds, ...rest } = r;
  return rest;
}
