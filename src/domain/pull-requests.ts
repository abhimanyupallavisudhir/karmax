/**
 * A task with several branches opens a pull request per branch while its agent
 * works (SPEC §11.1). Each pull request lands through a record of its own — so
 * Review, landing, GitHub and the inbox work as for any task — but it is part
 * of its task, not a task of its own: it has no number, no row in any task list
 * or search, and what it asks of people is asked as its task's.
 */
export interface PullRequestOf { taskId: string; checkout: string }

/** The task this record is a pull request of, if it is one. */
export function pullRequestOf(task: { parentTaskId?: string; params?: Record<string, unknown> } | undefined): PullRequestOf | undefined {
  const from = task?.params?._shippedFrom as { taskId?: unknown; checkout?: unknown } | undefined;
  return task?.parentTaskId && from?.taskId === task.parentTaskId && typeof from.checkout === 'string'
    ? { taskId: task.parentTaskId, checkout: from.checkout } : undefined;
}

/** SQL: the task row `t` is not a pull request of its parent. */
export function notPullRequestSql(dialect: 'sqlite' | 'postgres', alias = 't'): string {
  const from = dialect === 'postgres'
    ? `(${alias}.params::jsonb -> '_shippedFrom' ->> 'taskId')`
    : `json_extract(${alias}.params, '$._shippedFrom.taskId')`;
  return `NOT (${alias}.parentTaskId IS NOT NULL AND ${from} IS NOT NULL AND ${from} = ${alias}.parentTaskId)`;
}
