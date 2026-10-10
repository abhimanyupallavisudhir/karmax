import type { Client } from '@temporalio/client';
import { WorkflowFailedError } from '@temporalio/client';
import { TerminatedFailure } from '@temporalio/common';
import { Store } from '../store/db.js';
import { TaskView, TaskRecord } from '../domain/types.js';
import { withTimeout } from '../util/timeout.js';
import { notifyChildSettlement } from './child-settlement.js';

const TERMINAL = ['done', 'failed', 'cancelled'];

/** How long to wait on a describe before assuming the task is fine and moving on. */
const DESCRIBE_TIMEOUT_MS = 4000;
const TURN_COLLISION = 'usage admission retry key belongs to different attributed work';

/** A minimal stand-in view for a task that never produced one (orphaned start). */
function stubView(t: TaskRecord): TaskView {
  return {
    taskId: t.id,
    title: t.title,
    workflow: t.workflow,
    stage: 'failed',
    status: 'failed',
    messages: [],
    actions: [],
    state: {},
    updatedAt: t.createdAt,
  };
}

/** Temporal terminates a run whose history reaches 50 MB or 51,200 events,
 * and termination runs nothing in the workflow (#367). Software Dev continues
 * as new long before that; any run that still grows this large is recorded
 * once, as a `workflow.history-large` event, while there is time to act. */
const HISTORY_WARN_BYTES = 20 * 1024 * 1024;
const HISTORY_WARN_EVENTS = 20_000;
async function warnOnLargeHistory(
  store: Store,
  taskId: string,
  desc: { runId: string; historySize?: number; historyLength?: number },
): Promise<void> {
  const bytes = desc.historySize ?? 0;
  const events = desc.historyLength ?? 0;
  if (bytes < HISTORY_WARN_BYTES && events < HISTORY_WARN_EVENTS) return;
  const key = `history-warning:${taskId}:${desc.runId}`;
  if (await store.kvGet(key)) return;
  (await store.kvSet(key, String(Date.now())));
  (await store.appendEvent({ taskId, type: 'workflow.history-large', ts: Date.now(),
    payload: { runId: desc.runId, bytes, events, limitBytes: 50 * 1024 * 1024, limitEvents: 51_200 } }));
  console.warn(`[karmax] ${taskId}: workflow history is ${Math.round(bytes / 1048576)} MB / ${events} events; Temporal terminates it at 50 MB / 51,200`);
}

/** A run that ended without settling its own view failed in the stage that
 * view shows. Keep that stage: Retry needs it to resume the run faithfully
 * (an interrupted Landing becomes an integration repair). */
function failedView(base: TaskView): TaskView {
  const failedFrom = TERMINAL.includes(base.stage) ? base.state?.failedFrom : base.stage;
  return { ...base, status: 'failed', stage: 'failed', state: { ...base.state, ...(failedFrom ? { failedFrom } : {}) } };
}

/**
 * Reconcile the task index against live Temporal workflows on boot (SPEC §9
 * boundary: state survives a restart, but a workflow that was terminated or lost
 * shouldn't leave a task stuck "active" forever). For each non-terminal,
 * non-draft task, check whether its workflow still exists; if it completed or
 * vanished, settle the stored view so the UI is honest.
 *
 * This also catches *view-less* orphans: a task row whose `workflow.start` never
 * landed (e.g. it was created while Temporal was wedged) has no view and no
 * workflow, and would otherwise render forever at the first stage ("setup"). We
 * treat those as failed too, so a restart cleans them up.
 */
export async function reconcileTasks(store: Store, client: Client): Promise<{ checked: number; settled: number }> {
  // A parent that continued as new no longer holds its child's handle, so the
  // settled durable view is what tells it the child ended. Best effort: the
  // next sweep skips a settled task, but each continued run of the parent
  // reads its children's durable views again.
  const settle = async (taskId: string, view: TaskView) => {
    (await store.saveView(taskId, view));
    await notifyChildSettlement(store, client, view).catch(() => undefined);
  };
  let checked = 0;
  let settled = 0;
  for (const project of (await store.listProjects())) {
    // Reconciliation operates on Temporal executions, not logical list rows:
    // every sibling attempt has its own workflow that must be settled.
    const candidates = await store.listReconciliationCandidates(project.id);
    for (let offset = 0; offset < candidates.length; offset += 8) {
      await Promise.all(candidates.slice(offset, offset + 8).map(async (t) => {
      const v: TaskView | undefined = t.lastView;
      if (v && TERMINAL.includes(v.status)) return;
      checked++;
      const base = v ?? stubView(t);
      try {
        // Bound the describe: a wedged server makes describe hang without
        // rejecting, which would otherwise freeze boot. On timeout, leave the
        // task as-is (assume in-flight) rather than wrongly failing it.
        const handle = client.workflow.getHandle(t.id);
        const desc = await withTimeout(handle.describe(), DESCRIBE_TIMEOUT_MS);
        const name = desc.status.name;
        if (name === 'RUNNING') {
          await warnOnLargeHistory(store, t.id, desc).catch(() => undefined);
          // Older executions restarted their turn counter at zero, colliding
          // with reservations from the previous run. The run-scoped turn IDs
          // now make a fresh retry safe. Recover only that proven historical
          // collision, once per run, and never relax admission attribution.
          if (base.stage === 'escalated' && base.error?.includes(TURN_COLLISION)
            && !base.pointOfNoReturnPassed && ['software-dev', 'goal'].includes(t.workflow)) {
            const repairKey = `repair:agent-turn-run-identity:${t.id}:${desc.runId}`;
            const old = (await store.db.prepare('SELECT createdAt FROM usage_admissions WHERE id=? AND taskId=? AND projectId=?')
              .get(`${t.id}#0`, t.id, t.projectId)) as { createdAt: number } | undefined;
            if (old && desc.startTime && old.createdAt < desc.startTime.getTime() && !(await store.kvGet(repairKey))) {
              // A failed probe/signal is transient; it must not fall into the
              // outer workflow-not-found handler and falsely fail this task.
              try {
                const live = await withTimeout(handle.query('view') as Promise<TaskView>, DESCRIBE_TIMEOUT_MS);
                if (live.stage === 'escalated' && live.error?.includes(TURN_COLLISION)
                  && !live.state.cancelled && !live.pointOfNoReturnPassed) {
                  await withTimeout(handle.signal('retry'), DESCRIBE_TIMEOUT_MS);
                  (await store.kvSet(repairKey, 'requested'));
                }
              } catch { /* Retry recovery on the next reconciliation sweep. */ }
            }
          }
          // software-dev pins before 1.26 accepted Cancel during Setup but did
          // not cancel createWorld. Their live query says cancelled while the
          // persisted projection remains active indefinitely. Recover those
          // already-signalled production executions on deploy; current pins
          // own acknowledged provider cleanup inside the workflow itself.
          const minor = Number(String(t.workflowVersion ?? '').split('.')[1] ?? 0);
          if (base.stage === 'setup' && ['software-dev', 'goal'].includes(t.workflow) && minor < 26) {
            const live = await withTimeout(handle.query('view') as Promise<TaskView>, DESCRIBE_TIMEOUT_MS)
              .catch(() => undefined);
            if (live?.state?.cancelled) {
              await handle.terminate('cancelled Setup did not settle').catch(() => undefined);
              for (const lease of (await store.worldLeasesForTask(t.id))) (await store.releaseWorldLease(String(lease.id)));
              (await settle(t.id, {
                ...live,
                stage: 'cancelled',
                status: 'cancelled',
                waitingFor: undefined,
                actions: [],
                state: { ...live.state, cancelled: true, cancelledFrom: 'setup' },
                updatedAt: Date.now(),
              }));
              settled++;
            }
          }
          return;
        }
        let terminationReason: string | undefined;
        if (name === 'TERMINATED') {
          try {
            // result() requests only the close event, not a potentially 50MB
            // history. Bind to the described run in case recovery starts another.
            await withTimeout(client.workflow.getHandle(t.id, desc.runId).result(), DESCRIBE_TIMEOUT_MS);
          } catch (error) {
            if (error instanceof WorkflowFailedError && error.cause instanceof TerminatedFailure)
              terminationReason = error.cause.message;
            // Diagnostics failure must not turn a known termination into "lost".
          }
        }
        const next: TaskView =
          name === 'COMPLETED'
            ? { ...base, status: 'done', stage: 'done', updatedAt: base.updatedAt }
            : { ...failedView(base), error: terminationReason
              ? `workflow terminated: ${terminationReason}`
              : base.error ?? `workflow ${name.toLowerCase()}`, updatedAt: base.updatedAt };
        (await settle(t.id, next));
        settled++;
      } catch (e) {
        if (e instanceof Error && e.message === 'operation timed out') return; // transient — don't fail a live task
        // workflow not found → lost (state reset) or never started (orphan row).
        (await settle(t.id, {
          ...failedView(base),
          error: v ? 'workflow not found (lost on restart)' : 'workflow never started (engine was unavailable when queued)',
          updatedAt: base.updatedAt,
        }));
        settled++;
      }
      }));
    }
  }
  return { checked, settled };
}
