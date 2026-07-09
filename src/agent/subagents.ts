/**
 * Track a Claude-Agent-SDK turn's in-harness **sub-agents** (the Task tool) so a
 * turn is not reported "done" while the agent is still waiting on them.
 *
 * The problem this solves: Claude Code auto-backgrounds long-running sub-agents
 * (the terminal's Ctrl+B semantics — see the SDK's `background_tasks` control
 * request). When it does, the main turn's `result` message arrives — and the
 * agent may have already called `signal_completion` — WHILE a spawned sub-agent
 * is still running and will only emit its settlement (`task_notification`) later.
 * Left unhandled, karmax advances the task Do→Review even though the agent is
 * still waiting on its sub-agents (the reported bug). We fold the SDK's task
 * lifecycle messages into a small outstanding-set so the turn can report how many
 * sub-agents are still in flight; the workflow holds in Do until that reaches 0.
 *
 * Only **sub-agent** tasks are tracked, never plain backgrounded shells — a task
 * may deliberately leave a dev server running in the background, and blocking on
 * that would wedge the task forever. Sub-agents, by contrast, are always work the
 * turn is genuinely waiting on.
 *
 * Pure and side-effect free so it can be unit-tested against synthetic SDK
 * messages without a live model.
 */

export interface SubagentTask {
  id: string;
  /** Present for Task-tool sub-agents (e.g. 'general-purpose', 'code-reviewer'). */
  agentType?: string;
  /** The agent backgrounded it (Ctrl+B); still outstanding, just no longer foreground. */
  backgrounded: boolean;
}

/** The mutable set of sub-agents seen this turn that have not yet settled. */
export type SubagentTracker = Map<string, SubagentTask>;

export function newSubagentTracker(): SubagentTracker {
  return new Map();
}

/** True when an SDK `system/task_*` message is for a Task-tool sub-agent (not a
 *  shell / MCP monitor / workflow task, which we intentionally don't wait on). */
function isSubagentTask(msg: any): boolean {
  return typeof msg?.subagent_type === 'string' || msg?.task_type === 'subagent';
}

/**
 * Fold one SDK message into the tracker. Recognizes the `system` task-lifecycle
 * messages (`task_started` / `task_updated` / `task_notification`); everything
 * else is ignored, so it is safe to call for every streamed message.
 */
export function trackTaskMessage(tracker: SubagentTracker, msg: any): void {
  if (!msg || msg.type !== 'system') return;
  switch (msg.subtype) {
    case 'task_started': {
      // A sub-agent began. Non-sub-agent tasks (shells, monitors) are ignored.
      if (typeof msg.task_id === 'string' && isSubagentTask(msg)) {
        tracker.set(msg.task_id, { id: msg.task_id, agentType: msg.subagent_type, backgrounded: false });
      }
      break;
    }
    case 'task_updated': {
      const task = typeof msg.task_id === 'string' ? tracker.get(msg.task_id) : undefined;
      if (!task) return; // not a tracked sub-agent
      const status = msg.patch?.status;
      if (status === 'completed' || status === 'failed' || status === 'killed') tracker.delete(task.id);
      else if (msg.patch?.is_backgrounded) task.backgrounded = true;
      break;
    }
    case 'task_notification': {
      // A backgrounded task settled (completed / failed / stopped). Only clears an
      // entry we were actually tracking — notifications for shells are no-ops.
      if (typeof msg.task_id === 'string') tracker.delete(msg.task_id);
      break;
    }
    default:
      break;
  }
}

/** How many sub-agents are still in flight (running or backgrounded, not settled). */
export function pendingSubagentCount(tracker: SubagentTracker): number {
  return tracker.size;
}
