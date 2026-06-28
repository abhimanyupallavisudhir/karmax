import type { Client } from '@temporalio/client';
import { Store } from '../store/db.js';
import { TaskView } from '../domain/types.js';

const TERMINAL = ['done', 'failed', 'cancelled'];

/**
 * Reconcile the task index against live Temporal workflows on boot (SPEC §9
 * boundary: state survives a restart, but a workflow that was terminated or lost
 * shouldn't leave a task stuck "active" forever). For each non-terminal,
 * non-draft task, check whether its workflow still exists; if it completed or
 * vanished, settle the stored view so the UI is honest.
 */
export async function reconcileTasks(store: Store, client: Client): Promise<{ checked: number; settled: number }> {
  let checked = 0;
  let settled = 0;
  for (const project of store.listProjects()) {
    for (const t of store.listTasks(project.id)) {
      const v: TaskView | undefined = t.lastView;
      if (t.params?.draft) continue;
      if (!v || TERMINAL.includes(v.status)) continue;
      checked++;
      try {
        const desc = await client.workflow.getHandle(t.id).describe();
        const name = desc.status.name;
        if (name === 'RUNNING') continue; // genuinely in-flight — Temporal will resume it
        const next: TaskView =
          name === 'COMPLETED'
            ? { ...v, status: 'done', stage: v.stage === 'done' ? 'done' : 'done', updatedAt: v.updatedAt }
            : { ...v, status: 'failed', stage: 'failed', error: v.error ?? `workflow ${name.toLowerCase()}`, updatedAt: v.updatedAt };
        store.saveView(t.id, next);
        settled++;
      } catch {
        // workflow not found → lost (e.g. Temporal state reset out from under us)
        store.saveView(t.id, { ...v, status: 'failed', stage: 'failed', error: 'workflow not found (lost on restart)', updatedAt: v.updatedAt });
        settled++;
      }
    }
  }
  return { checked, settled };
}
