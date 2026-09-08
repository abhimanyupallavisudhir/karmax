import { patched, workflowInfo } from '@temporalio/workflow';

/** A replacement execution restarts its counter, but must not reuse the old
 * execution's usage, session checkpoints, or coordinator leases. Keep recorded
 * IDs during replay; newly scheduled turns are scoped to their Temporal run. */
export function agentTurnId(taskId: string, sequence: number): string {
  return patched('agent-turn-run-identity-v1')
    ? `${taskId}:${workflowInfo().runId}#${sequence}`
    : `${taskId}#${sequence}`;
}
