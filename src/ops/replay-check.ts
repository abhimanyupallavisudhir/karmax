import type { Client } from '@temporalio/client';
import type { WorkflowBundle } from '@temporalio/worker';
import { snapshotRunningHistories } from '../activities/replay-histories.js';

export interface ReplayFailure { workflowId: string; workflowType?: string; message: string }

/** Temporal's own ceiling is 50 MB of history per execution; the total only
 * bounds the spool on disk. Exceeding either fails the check, never passes it. */
const INSTALLATION_LIMITS = { histories: 20_000, historyBytes: 64 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 * 1024 };

/**
 * Replay the history of every running workflow, coordinators included, under
 * `workflowBundle`. A running workflow replays its history under whatever code
 * the next worker loads, and a nondeterminism wedges it at its next event, so a
 * release is safe to start only if this finds no failure (WF-34).
 */
export async function replayRunningWorkflows(client: Client, workflowBundle: WorkflowBundle,
  limits = INSTALLATION_LIMITS): Promise<{ checked: number; failures: ReplayFailure[] }> {
  const snapshot = await snapshotRunningHistories(client, { limits });
  try {
    const { Worker } = await import('@temporalio/worker');
    const failures: ReplayFailure[] = [];
    for await (const result of Worker.runReplayHistories({ workflowBundle }, snapshot.histories())) {
      if (!result.error) continue;
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      failures.push({ workflowId: result.workflowId, workflowType: snapshot.typeOf(result.workflowId), message });
    }
    failures.sort((a, b) => a.workflowId.localeCompare(b.workflowId));
    return { checked: snapshot.count, failures };
  } finally { snapshot.release(); }
}
