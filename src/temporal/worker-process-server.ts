import fs from 'node:fs';
import { Worker as Guardian } from 'node:worker_threads';
import type { WorkerManager } from './worker-pool.js';
import type { ExternalWorkflowRef } from '../packages/bundle.js';
import type { WorkerProcessRequest, WorkerProcessReply, WorkerProcessNotice } from './worker-process.js';

export interface WorkerProcessRuntime {
  worker: Pick<WorkerManager, 'start' | 'refresh' | 'stop'>;
  close(): Promise<void>;
}

/** A separate event loop enforces parent lifetime even if provider parsing
 * wedges the activity thread. PID start time prevents mistaking a recycled PID
 * for the original supervisor. This guard intentionally fails closed on Linux. */
function watchParent(): Guardian {
  if (process.platform !== 'linux') throw new Error('supervised workers require Linux');
  const parent = process.ppid;
  const stat = fs.readFileSync(`/proc/${parent}/stat`, 'utf8');
  const identity = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  const guardian = new Guardian(`
    const fs = require('node:fs');
    const { workerData } = require('node:worker_threads');
    function check() {
      try {
        const stat = fs.readFileSync('/proc/' + workerData.parent + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/);
        if (fields[19] === workerData.identity && fields[0] !== 'Z') return;
      } catch {}
      process.kill(workerData.child, 'SIGKILL');
    }
    check();
    setInterval(check, 100);
  `, { eval: true, workerData: { parent, identity, child: process.pid } });
  guardian.on('error', () => process.kill(process.pid, 'SIGKILL'));
  guardian.unref();
  return guardian;
}

let eventsAnnounced = false;
/** Tell the supervisor that events were committed here, so its relay delivers
 * them now instead of at its next poll (LT-15). One notice per burst. */
export function announceEventsAppended(): void {
  if (eventsAnnounced || !process.send || !process.connected) return;
  eventsAnnounced = true;
  setImmediate(() => {
    eventsAnnounced = false;
    if (!process.connected) return;
    const notice: WorkerProcessNotice = { type: 'worker.events' };
    process.send!(notice, () => { /* a lost hint is recovered by polling */ });
  });
}

/** Trusted child entrypoints install this before constructing runtime services.
 * No application state is opened until the supervisor sends its start request.
 * The factory must clean up partial initialization if it throws.
 */
export function serveWorkerProcess(create: () => Promise<WorkerProcessRuntime>, options: { stopTimeoutMs?: number } = {}): void {
  if (!process.send || !process.connected) throw new Error('worker entrypoint requires a supervisor IPC channel');
  // Mirror the primary process backstop: an isolated rejected promise must not
  // terminate every unrelated activity hosted by this worker. Synchronous
  // uncaught exceptions still use Node's normal crash/restart behavior.
  process.on('unhandledRejection', reason => {
    console.error('unhandled rejection (worker kept running):', reason instanceof Error ? reason.stack ?? reason.message : reason);
  });
  const guardian = watchParent();
  let runtime: WorkerProcessRuntime | undefined;
  let started = false;
  let closing = false;
  let pending = 0;
  let queue = Promise.resolve();
  let shutdown: Promise<void> | undefined;
  const reply = (id: number, ok: boolean, error?: string): Promise<void> => new Promise(resolve => {
    if (!process.connected) return resolve();
    const response: WorkerProcessReply = { type: 'worker.reply', id, ok, ...(error ? { error } : {}) };
    process.send!(response, () => resolve());
  });
  const drain = () => shutdown ??= (async () => {
    // If the worker cannot drain, process termination owns cleanup. Do not
    // close its Store/client while activities may still be using them.
    await runtime?.worker.stop();
    await runtime?.close();
  })();
  const deadline = () => {
    const timer = setTimeout(() => process.kill(process.pid, 'SIGKILL'), options.stopTimeoutMs ?? 3_000);
    timer.unref();
  };
  const stop = () => {
    if (closing) return;
    closing = true;
    deadline();
    void queue.finally(drain).then(() => process.exit(0), () => process.exit(1));
  };
  process.once('disconnect', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.on('message', (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const request = value as Partial<WorkerProcessRequest>;
    if (request.type !== 'worker.request' || !Number.isSafeInteger(request.id)
      || !['start', 'refresh', 'stop', 'ping'].includes(String(request.action))) return;
    const id = request.id!;
    if (closing || (pending >= 16 && request.action !== 'stop')) { void reply(id, false, 'worker is not accepting commands'); return; }
    if (request.action === 'ping') {
      void reply(id, !!runtime, runtime ? undefined : 'worker is not started');
      return;
    }
    if (request.action !== 'stop' && (!Array.isArray(request.packages) || request.packages.some(ref =>
      !ref || typeof ref.type !== 'string' || typeof ref.entryFile !== 'string'))) {
      void reply(id, false, 'invalid workflow package references'); return;
    }
    if (request.action === 'stop') { closing = true; deadline(); }
    pending++;
    queue = queue.then(async () => {
      let exitCode = 0;
      try {
        if (request.action === 'start') {
          if (started) throw new Error('worker already started');
          started = true;
          runtime = await create();
          await runtime.worker.start(request.packages as ExternalWorkflowRef[]);
        } else if (request.action === 'refresh') {
          if (!runtime) throw new Error('worker is not started');
          await runtime.worker.refresh(request.packages as ExternalWorkflowRef[]);
        } else await drain();
        await reply(id, true);
      } catch (error) {
        exitCode = 1;
        await reply(id, false, error instanceof Error ? error.message : 'worker command failed');
      } finally {
        pending--;
        if (request.action === 'stop') {
          await guardian.terminate();
          process.exit(exitCode);
        }
      }
    });
  });
}
