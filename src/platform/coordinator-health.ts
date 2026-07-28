import type { Client } from '@temporalio/client';
import { withTimeout } from '../util/timeout.js';
import {
  MERGE_QUEUE_WORKFLOW,
  AGENT_QUEUE_WORKFLOW,
  ACCOUNT_COORDINATOR_WORKFLOW,
  BUDGET_COORDINATOR_WORKFLOW,
  RESOURCE_PUBLISH_COORDINATOR_WORKFLOW,
  QRY_QUEUE,
  QRY_AGENT_QUEUE,
  QRY_ACCOUNTS,
  QRY_BUDGET,
  QRY_RESOURCE_PUBLISH,
} from '../coordinators/names.js';

/** Bound every probe: a wedged coordinator answers neither query nor history. */
const PROBE_TIMEOUT_MS = 4000;

const MERGE_QUEUE_ID_PREFIX = 'merge-queue:';

export interface CoordinatorHealth {
  checked: number;
  wedged: string[];
  rebuilt: string[];
  /** Wedged coordinators we deliberately did not rebuild, with the reason. */
  reported: { workflowId: string; reason: string }[];
}

/**
 * How to probe a coordinator singleton, and whether it can be rebuilt from
 * nothing. `rebuild` returns the constructor args for a replacement, or null
 * when a rebuild would destroy state that exists nowhere else.
 */
interface CoordinatorSpec {
  query: string;
  rebuild: ((workflowId: string) => unknown[]) | null;
  /** Why a rebuild is unsafe. Shown to the operator instead of acting. */
  reason?: string;
}

const SPECS: Record<string, CoordinatorSpec> = {
  // The merge queue is the one coordinator that is safe to rebuild empty: a task
  // parked in the merge wait re-enqueues itself on its next poll (see
  // `mergeQueuePosition`), so a fresh queue repopulates from its waiters within
  // one poll interval. Nothing else is stored here.
  [MERGE_QUEUE_WORKFLOW]: {
    query: QRY_QUEUE,
    rebuild: (workflowId) => [{ domain: workflowId.slice(MERGE_QUEUE_ID_PREFIX.length) }],
  },
  // A granted agent slot is a one-shot durable signal, not a poll: a task already
  // parked on `agentSlot` would never be granted again by a fresh, empty queue,
  // so rebuilding this silently hangs every waiting turn. Report it instead.
  [AGENT_QUEUE_WORKFLOW]: {
    query: QRY_AGENT_QUEUE,
    rebuild: null,
    reason: 'parked agent turns are granted by one-shot signal and would never be re-granted',
  },
  [ACCOUNT_COORDINATOR_WORKFLOW]: {
    query: QRY_ACCOUNTS,
    rebuild: null,
    reason: 'in-flight account leases would be lost while their holders keep using them',
  },
  // Its `spent` counters exist nowhere else; resetting them re-authorizes money
  // that has already been spent.
  [BUDGET_COORDINATOR_WORKFLOW]: {
    query: QRY_BUDGET,
    rebuild: null,
    reason: 'spend counters exist nowhere else; a reset would re-authorize money already spent',
  },
  [RESOURCE_PUBLISH_COORDINATOR_WORKFLOW]: {
    query: QRY_RESOURCE_PUBLISH,
    rebuild: null,
    reason: 'an in-flight publish lease would be lost',
  },
};

/**
 * Is this execution unable to replay its own history?
 *
 * A query can fail for boring reasons (the query name isn't registered, a
 * transient transport error), and rebuilding on those would be destructive. So
 * the verdict comes from the workflow's own history rather than the query error:
 * scan back to the most recent workflow task and see how it ended. A
 * `WorkflowTaskFailed` carrying a nondeterminism error means today's code cannot
 * replay what was recorded, and Temporal retries that task forever — the
 * coordinator can neither act nor answer. A `WorkflowTaskCompleted` first means
 * it is making progress and the query failure was something else.
 */
async function isUnreplayable(client: Client, workflowId: string, runId?: string): Promise<boolean> {
  const history = await withTimeout(
    client.workflow.getHandle(workflowId, runId).fetchHistory(),
    PROBE_TIMEOUT_MS,
  );
  const events = history?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.workflowTaskCompletedEventAttributes) return false;
    const failed = event.workflowTaskFailedEventAttributes;
    if (failed) return /TMPRL1100|non-?determin/i.test(failed.failure?.message ?? '');
  }
  return false;
}

/**
 * Probe every running coordinator singleton and rebuild the ones whose history
 * today's code can no longer replay.
 *
 * Coordinators are the one workflow family with no version pin: they are keyed
 * by id, started once, and run for weeks, so they replay against whatever code
 * is loaded now. Editing `src/coordinators/*` therefore wedges every in-flight
 * singleton that had already entered the changed path — and a wedged merge queue
 * is invisible, because the tasks waiting on it just poll a position query that
 * never resolves. That is exactly how karmax#345 and #350 stalled for hours.
 *
 * Rebuilding terminates the wedged run **by its exact runId** and immediately
 * starts a replacement under the same workflow id. Both halves matter: Temporal
 * replays closed workflows to answer queries too, so terminating alone leaves
 * the failure flood running and nothing serving the domain; and pinning the
 * runId means a replacement started concurrently is never the one we kill.
 */
export async function healCoordinators(
  client: Client,
  taskQueue: string,
): Promise<CoordinatorHealth> {
  const result: CoordinatorHealth = { checked: 0, wedged: [], rebuilt: [], reported: [] };

  for (const [type, spec] of Object.entries(SPECS)) {
    let running: { workflowId: string; runId?: string }[] = [];
    try {
      running = await collectRunning(client, type);
    } catch {
      continue; // visibility unavailable — nothing safe to conclude
    }

    for (const { workflowId, runId } of running) {
      result.checked++;
      try {
        await withTimeout(client.workflow.getHandle(workflowId, runId).query(spec.query), PROBE_TIMEOUT_MS);
        continue; // answered — healthy
      } catch {
        // fall through to classification
      }

      let wedged = false;
      try {
        wedged = await isUnreplayable(client, workflowId, runId);
      } catch {
        continue; // couldn't classify — never rebuild on a guess
      }
      if (!wedged) continue;

      result.wedged.push(workflowId);
      if (!spec.rebuild) {
        result.reported.push({ workflowId, reason: spec.reason ?? 'no safe rebuild' });
        continue;
      }
      try {
        await client.workflow
          .getHandle(workflowId, runId)
          .terminate('karmax: coordinator history is unreplayable by current code');
        await client.workflow.start(type, {
          workflowId,
          taskQueue,
          args: spec.rebuild(workflowId),
        });
        result.rebuilt.push(workflowId);
      } catch {
        result.reported.push({ workflowId, reason: 'rebuild failed' });
      }
    }
  }
  return result;
}

async function collectRunning(client: Client, type: string) {
  const running: { workflowId: string; runId?: string }[] = [];
  const iter = client.workflow.list({ query: `WorkflowType = '${type}' AND ExecutionStatus = 'Running'` });
  for await (const wf of iter) {
    running.push({ workflowId: wf.workflowId, runId: wf.runId });
  }
  return running;
}
