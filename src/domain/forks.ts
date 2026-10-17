/**
 * A task-agent fork is stored on the NEW task as `resumeFrom.taskId`. Agent
 * specs appear in several parameter fields (Do/Merge overrides and nested
 * confirmation layers), so the relationship is discovered by shape rather than
 * by today's field names. A raw provider-session continuation has no taskId and
 * is not a fork. Mirrors `taskForkSourceIds` in web/app.js.
 */
export function taskForkSourceIds(params: unknown): string[] {
  const sources = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const resumeFrom = (value as { resumeFrom?: unknown }).resumeFrom;
    if (resumeFrom && typeof resumeFrom === 'object' && typeof (resumeFrom as { taskId?: unknown }).taskId === 'string')
      sources.add((resumeFrom as { taskId: string }).taskId);
    for (const child of Object.values(value)) visit(child);
  };
  visit(params);
  return [...sources];
}

/** The source agent a fork reads: the one it names, else the agent of the same
 * role — and for an agent called in with `@` (role `agent`, which keys no
 * session), the source task's main agent. */
export function forkSourceRole(resumeFrom: { role?: string }, role: string): string {
  return resumeFrom.role ?? (role === 'agent' ? 'do' : role);
}

/**
 * Once a person has confirmed a task's proposal it is sealed: it lands (or has
 * landed) exactly as approved. Talking to its agent then carries the work on in
 * a new task that forks the agent — its session, and its world while the
 * proposal is still landing — instead of pulling the proposal back to Do. While
 * landing waits on people (a repair it could not make, a merge only they may
 * authorize) a message is about that proposal and still goes to the agent.
 * Top-level software-dev tasks with an agent only: a sub-task's work belongs to
 * its parent, and a command task has no agent to continue.
 */
export function continuesInNewTask(
  task: { workflow: string; parentTaskId?: string; params?: Record<string, unknown> },
  view: { stage: string; status: string; waitingFor?: { kind: string }; state?: Record<string, unknown> } | undefined,
): boolean {
  if (!view || task.workflow !== 'software-dev' || task.parentTaskId || task.params?.command) return false;
  if (view.stage === 'done') return view.status === 'done' && !view.state?.manuallyDoneFrom;
  return view.stage === 'merge' && (view.status === 'active' || view.status === 'waiting')
    && view.waitingFor?.kind !== 'human' && view.waitingFor?.kind !== 'parent';
}

/** What `message_agent` tells the agent that sent a message. */
export function continuedReply(continuedIn?: { id: string; num?: number }): string {
  return continuedIn
    ? `That task's proposal is confirmed, so its agent continues in a new task: ${continuedIn.num != null ? `#${continuedIn.num} ` : ''}(${continuedIn.id}).`
    : 'message delivered';
}
