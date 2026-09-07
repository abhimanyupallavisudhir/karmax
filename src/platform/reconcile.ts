import type { Client } from '@temporalio/client';
import { Store } from '../store/db.js';
import { TaskView, TaskRecord } from '../domain/types.js';
import { withTimeout } from '../util/timeout.js';

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
  let checked = 0;
  let settled = 0;
  for (const project of store.listProjects()) {
    // Reconciliation operates on Temporal executions, not logical list rows:
    // every sibling attempt has its own workflow that must be settled.
    for (const t of store.listTaskAttempts(project.id)) {
      if (t.params?.draft) continue; // drafts are intentionally not started
      if (t.params?.triggerState === 'armed') continue; // armed triggered tasks have no workflow yet
      if (t.params?.repeatable) continue; // a series never runs its own workflow — only its runs do
      const v: TaskView | undefined = t.lastView;
      if (v && TERMINAL.includes(v.status)) continue;
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
          // Older executions restarted their turn counter at zero, colliding
          // with reservations from the previous run. The run-scoped turn IDs
          // now make a fresh retry safe. Recover only that proven historical
          // collision, once per run, and never relax admission attribution.
          if (base.stage === 'escalated' && base.error?.includes(TURN_COLLISION)
            && !base.pointOfNoReturnPassed && ['software-dev', 'goal'].includes(t.workflow)) {
            const repairKey = `repair:agent-turn-run-identity:${t.id}:${desc.runId}`;
            const old = store.db.prepare('SELECT createdAt FROM usage_admissions WHERE id=? AND taskId=? AND projectId=?')
              .get(`${t.id}#0`, t.id, t.projectId) as { createdAt: number } | undefined;
            if (old && desc.startTime && old.createdAt < desc.startTime.getTime() && !store.kvGet(repairKey)) {
              // A failed probe/signal is transient; it must not fall into the
              // outer workflow-not-found handler and falsely fail this task.
              try {
                const live = await withTimeout(handle.query('view') as Promise<TaskView>, DESCRIBE_TIMEOUT_MS);
                if (live.stage === 'escalated' && live.error?.includes(TURN_COLLISION)
                  && !live.state.cancelled && !live.pointOfNoReturnPassed) {
                  await withTimeout(handle.signal('retry'), DESCRIBE_TIMEOUT_MS);
                  store.kvSet(repairKey, 'requested');
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
              for (const lease of store.worldLeasesForTask(t.id)) store.releaseWorldLease(String(lease.id));
              store.saveView(t.id, {
                ...live,
                stage: 'cancelled',
                status: 'cancelled',
                waitingFor: undefined,
                actions: [],
                state: { ...live.state, cancelled: true, cancelledFrom: 'setup' },
                updatedAt: Date.now(),
              });
              settled++;
            }
          }
          continue;
        }
        const next: TaskView =
          name === 'COMPLETED'
            ? { ...base, status: 'done', stage: 'done', updatedAt: base.updatedAt }
            : { ...base, status: 'failed', stage: 'failed', error: base.error ?? `workflow ${name.toLowerCase()}`, updatedAt: base.updatedAt };
        store.saveView(t.id, next);
        settled++;
      } catch (e) {
        if (e instanceof Error && e.message === 'operation timed out') continue; // transient — don't fail a live task
        // workflow not found → lost (state reset) or never started (orphan row).
        store.saveView(t.id, {
          ...base,
          status: 'failed',
          stage: 'failed',
          error: v ? 'workflow not found (lost on restart)' : 'workflow never started (engine was unavailable when queued)',
          updatedAt: base.updatedAt,
        });
        settled++;
      }
    }
  }
  return { checked, settled };
}
