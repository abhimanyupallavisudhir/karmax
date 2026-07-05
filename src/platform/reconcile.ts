import type { Client } from '@temporalio/client';
import { Store } from '../store/db.js';
import { TaskView, TaskRecord } from '../domain/types.js';
import { withTimeout } from '../util/timeout.js';

const TERMINAL = ['done', 'failed', 'cancelled'];

/** How long to wait on a describe before assuming the task is fine and moving on. */
const DESCRIBE_TIMEOUT_MS = 4000;

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
    for (const t of store.listTasks(project.id)) {
      if (t.params?.draft) continue; // drafts are intentionally not started
      const v: TaskView | undefined = t.lastView;
      if (v && TERMINAL.includes(v.status)) continue;
      checked++;
      const base = v ?? stubView(t);
      try {
        // Bound the describe: a wedged server makes describe hang without
        // rejecting, which would otherwise freeze boot. On timeout, leave the
        // task as-is (assume in-flight) rather than wrongly failing it.
        const desc = await withTimeout(client.workflow.getHandle(t.id).describe(), DESCRIBE_TIMEOUT_MS);
        const name = desc.status.name;
        if (name === 'RUNNING') continue; // genuinely in-flight — Temporal will resume it
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
