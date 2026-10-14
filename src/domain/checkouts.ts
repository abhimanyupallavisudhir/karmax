import type { BranchLedger, BranchState, OpenPrProposal, TaskCheckout, TaskPullRequest } from './types.js';
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
 *  is going, whether it is approved right now, and its pull request. With a
 *  branch ledger (software-dev ≥1.30) each also carries its own lifecycle state,
 *  and approval means approval of the head it was proposed at. */
export function reviewCheckouts(
  repos: WorldRepo[],
  heads: Record<string, string>,
  approvals: CheckoutApprovals,
  prs: TaskPullRequest[],
  lifecycle?: { ledger: BranchLedger; landing: string[] },
): TaskCheckout[] {
  return repos.map((repo) => {
    const stacked = stackedOn(repo, repos);
    const pr = prs.find((p) => p.repo === repo.name);
    const state = lifecycle ? branchState(repo.name, lifecycle.ledger, approvals, lifecycle.landing) : undefined;
    const proposedHead = lifecycle?.ledger.proposed[repo.name];
    const landedSha = lifecycle?.ledger.landed[repo.name];
    return {
      name: repo.name,
      branch: repo.branch,
      base: repo.base,
      ...(repo.target ? { target: repo.target } : {}),
      ...(heads[repo.name] ? { head: heads[repo.name] } : {}),
      approved: state ? state === 'approved' || state === 'landing' : approvedNow(repo.name, heads, approvals),
      ...(stacked ? { stackedOn: stacked } : {}),
      ...(pr ? { pr } : {}),
      ...(state ? { state } : {}),
      ...(proposedHead ? { proposedHead } : {}),
      ...(landedSha ? { landedSha } : {}),
    };
  });
}

// ── Per-branch lifecycle (software-dev ≥1.30) ──
//
// Each branch is proposed, reviewed and landed on its own while the one Do
// agent keeps working in the others. An approval binds to the head the branch
// was PROPOSED at — the head its pull request showed the reviewer — never to
// whatever the checkout holds when someone clicks: a commit the agent made
// after proposing was never reviewed.

/** Where one branch is in its lifecycle. */
export function branchState(name: string, ledger: BranchLedger, approvals: CheckoutApprovals, landing: string[]): BranchState {
  if (landing.includes(name)) return 'landing';
  const proposed = ledger.proposed[name];
  if (proposed) return approvals[name] === proposed ? 'approved' : 'review';
  return ledger.landed[name] ? 'landed' : 'working';
}

/** Approve proposed branches (`names`, default every one) at the heads they
 *  were proposed at. A name that is not proposed approves nothing. */
export function approveProposed(ledger: BranchLedger, approvals: CheckoutApprovals, names?: string[]): CheckoutApprovals {
  const next = { ...approvals };
  for (const [name, head] of Object.entries(ledger.proposed))
    if (!names || names.includes(name)) next[name] = head;
  return next;
}

/** Proposed branches the agent moved after proposing: they were never reviewed
 *  at their current head, so their proposal lapses. An unreadable head is not
 *  evidence of a move. */
export function movedSinceProposal(ledger: BranchLedger, heads: Record<string, string>): string[] {
  return Object.entries(ledger.proposed).filter(([name, head]) => heads[name] && heads[name] !== head).map(([name]) => name);
}

/** The branches that may land now: approved at the head they were proposed at
 *  and still there, and — when stacked on a sibling — only once that sibling has
 *  landed or lands with them, so a pull request never lands its base's change. */
export function landableBranches(
  repos: WorldRepo[],
  ledger: BranchLedger,
  approvals: CheckoutApprovals,
  heads: Record<string, string>,
): string[] {
  const ready = new Set(Object.entries(ledger.proposed)
    .filter(([name, head]) => approvals[name] === head && heads[name] === head)
    .map(([name]) => name));
  for (let changed = true; changed;) {
    changed = false;
    for (const name of ready) {
      const repo = repos.find((candidate) => candidate.name === name);
      const base = repo ? stackedOn(repo, repos) : undefined;
      if (base && !ledger.landed[base] && !ready.has(base)) { ready.delete(name); changed = true; }
    }
  }
  return repos.map((repo) => repo.name).filter((name) => ready.has(name));
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

/** Two open_pr requests made before either was acted on, as one: every branch
 *  either names (a request naming none proposes everything), and the later
 *  word on `final`. */
export function combineProposals(earlier: OpenPrProposal | undefined, later: OpenPrProposal): OpenPrProposal {
  const branches = (earlier && !earlier.branches) || !later.branches ? undefined
    : [...new Set([...earlier?.branches ?? [], ...later.branches])];
  const final = later.final ?? earlier?.final;
  return { ...(branches ? { branches } : {}), ...(final !== undefined ? { final } : {}) };
}

/** A replacement run's branch ledger, rebuilt from the last published view:
 *  what was proposed (landing counts — it lands again) and what landed. The
 *  view's `state` carries the agent's last word on finishing. */
export function branchLedgerOf(checkouts: TaskCheckout[], state?: Record<string, unknown>): BranchLedger {
  const proposed: Record<string, string> = {};
  const landed: Record<string, string> = {};
  for (const checkout of checkouts) {
    if (checkout.proposedHead && checkout.state && checkout.state !== 'landed' && checkout.state !== 'working')
      proposed[checkout.name] = checkout.proposedHead;
    if (checkout.landedSha) landed[checkout.name] = checkout.landedSha;
  }
  const repairing = Array.isArray(state?.branchesRepairing) ? state.branchesRepairing.filter((name): name is string => typeof name === 'string') : [];
  const final = Array.isArray(state?.branchesFinal) ? state.branchesFinal.filter((name): name is string => typeof name === 'string') : undefined;
  return { proposed, landed, ...(final ? { finish: true, finalBranches: final } : {}), ...(repairing.length ? { repairing } : {}) };
}

/** The approvals a replacement run keeps: with a ledger, each approved branch
 *  at the head it was proposed at; otherwise at the head it had. */
export function approvalsOf(checkouts: TaskCheckout[]): CheckoutApprovals {
  return Object.fromEntries(checkouts.filter((c) => c.approved && (c.state ? c.proposedHead : c.head))
    .map((c) => [c.name, (c.state ? c.proposedHead : c.head)!]));
}
