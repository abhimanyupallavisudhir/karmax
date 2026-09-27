import type { TaskCheckout, TaskPullRequest } from './types.js';
import type { WorldRepo } from '../world/types.js';

/**
 * Review bookkeeping for a multi-PR task (SPEC §11.1).
 *
 * A multi-PR task keeps ONE Review gate; what it gains is the ability to approve
 * its branches one at a time, so a human can confirm the finished ones and send a
 * follow-up about the rest instead of re-reviewing everything each round.
 *
 * The invariant that makes that safe: **an approval is bound to `(checkout, head
 * sha)`**. If the Do agent touches an approved branch afterwards its approval
 * lapses, so "confirm these three" can never quietly keep approving work that
 * has since changed underneath it. An unreadable head counts as unapproved —
 * the gate must fail closed, never pass by omission.
 */

/** checkout name → the head sha it was approved at. */
export type CheckoutApprovals = Record<string, string>;

/** Is this checkout approved at the head it currently has? */
function approvedNow(name: string, heads: Record<string, string>, approvals: CheckoutApprovals): boolean {
  const head = heads[name];
  return !!head && approvals[name] === head;
}

/** The name of the sibling checkout this one is stacked on, if any. */
function stackedOn(repo: WorldRepo, repos: WorldRepo[]): string | undefined {
  return repos.find((r) => r !== repo && r.branch === repo.base)?.name;
}

/** Project the world's checkouts for the task view: what each branch is, where it
 *  is going, whether it is approved right now, and its pull request. */
export function reviewCheckouts(
  repos: WorldRepo[],
  heads: Record<string, string>,
  approvals: CheckoutApprovals,
  prs: TaskPullRequest[],
): TaskCheckout[] {
  return repos.map((repo) => {
    const stacked = stackedOn(repo, repos);
    const pr = prs.find((p) => p.repo === repo.name);
    return {
      name: repo.name,
      branch: repo.branch,
      base: repo.base,
      ...(repo.target ? { target: repo.target } : {}),
      ...(heads[repo.name] ? { head: heads[repo.name] } : {}),
      approved: approvedNow(repo.name, heads, approvals),
      ...(stacked ? { stackedOn: stacked } : {}),
      ...(pr ? { pr } : {}),
    };
  });
}

/** Has every branch of this task been approved at the head it currently has? */
export function allCheckoutsApproved(
  repos: WorldRepo[],
  heads: Record<string, string>,
  approvals: CheckoutApprovals,
): boolean {
  return repos.length > 0 && repos.every((repo) => approvedNow(repo.name, heads, approvals));
}

/** What one Confirm click means for a multi-PR task: approve every branch at the
 *  head it has right now — the same decision, taken for all of them at once. */
export function approveAll(
  repos: WorldRepo[],
  heads: Record<string, string>,
  approvals: CheckoutApprovals,
): CheckoutApprovals {
  const next = { ...approvals };
  for (const repo of repos) {
    const head = heads[repo.name];
    if (head) next[repo.name] = head;
  }
  return next;
}
