/**
 * How long a task waiting on GitHub (CI, a review, the merge) waits before it
 * looks again when no webhook woke it.
 *
 * GitHub's webhooks (pull_request, check_run, review) wake a waiting task at
 * once, so the poll only catches what they do not announce — commit statuses
 * from external CI, the target branch moving — and a missed delivery. It
 * starts at the task's poll interval and doubles while nothing changes, up to
 * ten minutes. Every look spends calls from the hourly budget GitHub gives the
 * installation or person, shared with all their other tasks: below a fifth of
 * it, the task waits for the hour to reset (a webhook still wakes it earlier),
 * so the calls left go to opening and merging pull requests.
 */
export const GITHUB_WATCH_MAX_MS = 10 * 60_000;
/** Below this share of its hourly budget, a waiting task looks again only after the reset. */
export const GITHUB_BUDGET_RESERVE = 0.2;

export interface GithubBudget { limit: number; remaining: number; resetAt: number }

export function githubWatchDelayMs(pollMs: number, unchanged: number, now: number, budget?: GithubBudget): number {
  const backoff = Math.min(pollMs * 2 ** Math.min(unchanged, 30), Math.max(pollMs, GITHUB_WATCH_MAX_MS));
  if (budget && budget.limit > 0 && budget.remaining < budget.limit * GITHUB_BUDGET_RESERVE && budget.resetAt > now)
    return Math.max(backoff, Math.min(budget.resetAt - now + 1_000, 60 * 60_000));
  return backoff;
}
