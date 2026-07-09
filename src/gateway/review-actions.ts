import { spawn, type ChildProcess } from 'node:child_process';

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
  child: ChildProcess;
  listeners: Set<ActionListener>;
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
  private seq = 0;

  start(opts: {
    taskId: string;
    cwd: string;
    label: string;
    command: string;
    server?: boolean;
    openUrls?: string[];
  }): RunningAction {
    const procId = `ra_${this.seq++}_${opts.taskId.slice(0, 8)}`;
    // detached so the child is its own process group leader — killing the group
    // (`-pid`) reaps grandchildren too (a dev server that forks workers).
    const child = spawn('bash', ['-lc', opts.command], {
      cwd: opts.cwd,
      env: { ...process.env },
      detached: true,
    });
    const rec: RunningAction = {
      procId,
      taskId: opts.taskId,
      label: opts.label,
      command: opts.command,
      server: !!opts.server,
      openUrls: opts.openUrls ?? [],
      startedAt: Date.now(),
      output: '',
      exitCode: null,
      running: true,
      child,
      listeners: new Set(),
    };
    const append = (buf: unknown) => {
      const s = String(buf);
      rec.output = (rec.output + s).slice(-MAX_OUTPUT);
      for (const l of rec.listeners) l(s, false, null);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => {
      append(`\n[spawn error] ${e.message}\n`);
      rec.running = false;
      rec.exitCode = rec.exitCode ?? -1;
      for (const l of rec.listeners) l('', true, rec.exitCode);
    });
    child.on('exit', (code, sig) => {
      rec.running = false;
      rec.exitCode = code ?? (sig ? -1 : 0);
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
    return r ? toStatus(r) : undefined;
  }

  listFor(taskId: string): ActionStatus[] {
    return [...this.procs.values()].filter((p) => p.taskId === taskId).map(toStatus);
  }

  /** Subscribe to live output; returns an unsubscribe fn. Emits nothing historical
   *  — the caller sends `rec.output` first, then attaches for the live tail. */
  attach(procId: string, listener: ActionListener): () => void {
    const rec = this.procs.get(procId);
    if (!rec) return () => {};
    rec.listeners.add(listener);
    return () => rec.listeners.delete(listener);
  }

  stop(procId: string): boolean {
    const rec = this.procs.get(procId);
    if (!rec || !rec.running) return false;
    killTree(rec.child, 'SIGTERM');
    setTimeout(() => {
      if (rec.running) killTree(rec.child, 'SIGKILL');
    }, KILL_GRACE_MS).unref?.();
    return true;
  }

  /** Kill everything — called on gateway shutdown so no dev server is orphaned. */
  stopAll(): void {
    for (const rec of this.procs.values()) if (rec.running) killTree(rec.child, 'SIGKILL');
    this.procs.clear();
  }
}

function toStatus(r: RunningAction): ActionStatus {
  const { child: _c, listeners: _l, ...rest } = r;
  return rest;
}

function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Negative pid → the whole process group (child was spawned detached).
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}
