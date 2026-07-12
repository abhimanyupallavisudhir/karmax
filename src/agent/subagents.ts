/**
 * Track a Claude-Agent-SDK turn's in-harness background work so a turn is not
 * reported "done" while the agent is still waiting on something it launched.
 *
 * Two kinds are tracked, with different downstream handling in the workflow:
 *
 * 1. **Sub-agents** (the Task tool). Claude Code auto-backgrounds long-running
 *    sub-agents (the terminal's Ctrl+B semantics — see the SDK's `background_tasks`
 *    control request). When it does, the main turn's `result` message arrives — and
 *    the agent may have already called `signal_completion` — WHILE a spawned
 *    sub-agent is still running and will only emit its settlement
 *    (`task_notification`) later. Left unhandled, karmax advances the task Do→Review
 *    even though the agent is still waiting on its sub-agents (the reported bug). The
 *    workflow holds in Do until the sub-agent count reaches 0.
 *
 * 2. **Backgrounded shells** (a `run_in_background` Bash — e.g. `npm test &`). These
 *    were historically ignored, which let a second bug through: an agent that
 *    backgrounds a test run, ends its turn saying "I'll report when it finishes",
 *    and gets shoved to Review because the turn returned with nothing tracked
 *    outstanding (karmax#—, task 130). We now surface a count of still-running
 *    backgrounded shells so the workflow can NUDGE the agent (bounded) to wait for
 *    them and fold in their results before Review — but, unlike sub-agents, it never
 *    blocks indefinitely: a shell may be a dev server the task deliberately left
 *    running, so after a small budget the workflow proceeds anyway (with a note).
 *
 * We deliberately do NOT treat **workflow** tasks or ambient/housekeeping tasks
 * (`skip_transcript`, e.g. MCP monitors) as shells — blocking or nudging on those
 * would be noise.
 *
 * Pure and side-effect free so it can be unit-tested against synthetic SDK
 * messages without a live model.
 */

export type TrackedKind = 'subagent' | 'shell';

export interface TrackedTask {
  id: string;
  kind: TrackedKind;
  /** Present for Task-tool sub-agents (e.g. 'general-purpose', 'code-reviewer'). */
  agentType?: string;
  /** The agent backgrounded it (Ctrl+B); still outstanding, just no longer foreground. */
  backgrounded: boolean;
}

/** The mutable set of tasks seen this turn that have not yet settled. */
export type SubagentTracker = Map<string, TrackedTask>;

export function newSubagentTracker(): SubagentTracker {
  return new Map();
}

/** True when an SDK `system/task_*` message is for a Task-tool sub-agent. */
function isSubagentTask(msg: any): boolean {
  return typeof msg?.subagent_type === 'string' || msg?.task_type === 'subagent';
}

/** True when a task is a backgrounded shell we should nudge on — a plain Bash task,
 *  not a sub-agent, not a workflow task, and not ambient/housekeeping. Plain shells
 *  carry no `task_type` (unlike 'subagent' / 'workflow' / 'local_workflow'). */
function isShellTask(msg: any): boolean {
  if (isSubagentTask(msg)) return false;
  if (msg?.task_type === 'workflow' || msg?.task_type === 'local_workflow') return false;
  if (msg?.skip_transcript) return false; // ambient/housekeeping (e.g. MCP monitors)
  return true;
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
      if (typeof msg.task_id !== 'string') break;
      if (isSubagentTask(msg)) {
        tracker.set(msg.task_id, { id: msg.task_id, kind: 'subagent', agentType: msg.subagent_type, backgrounded: false });
      } else if (isShellTask(msg)) {
        // A shell/Bash task. It only *matters* once it outlives the turn (backgrounded
        // or still running at turn end); tracking it from the start lets the settlement
        // path clear a fast foreground command before we ever count it.
        tracker.set(msg.task_id, { id: msg.task_id, kind: 'shell', backgrounded: false });
      }
      break;
    }
    case 'task_updated': {
      const task = typeof msg.task_id === 'string' ? tracker.get(msg.task_id) : undefined;
      if (!task) return; // not a tracked task
      const status = msg.patch?.status;
      if (status === 'completed' || status === 'failed' || status === 'killed') tracker.delete(task.id);
      else if (msg.patch?.is_backgrounded) task.backgrounded = true;
      break;
    }
    case 'task_notification': {
      // A backgrounded task settled (completed / failed / stopped). Only clears an
      // entry we were actually tracking — notifications for untracked ids are no-ops.
      if (typeof msg.task_id === 'string') tracker.delete(msg.task_id);
      break;
    }
    default:
      break;
  }
}

/** How many sub-agents are still in flight (running or backgrounded, not settled). */
export function pendingSubagentCount(tracker: SubagentTracker): number {
  let n = 0;
  for (const t of tracker.values()) if (t.kind === 'subagent') n++;
  return n;
}

/** How many backgrounded shells (a `run_in_background` Bash) are still in flight — the
 *  agent launched them and the turn returned before they settled. */
export function pendingBackgroundShellCount(tracker: SubagentTracker): number {
  let n = 0;
  for (const t of tracker.values()) if (t.kind === 'shell') n++;
  return n;
}
