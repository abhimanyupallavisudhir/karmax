/**
 * The workflow-safe type surface. Workflows may only import pure types (no
 * Node-only modules) into the deterministic sandbox. This re-exports the domain
 * contract for that purpose.
 */
export type {
  TaskInput,
  TaskRecoveryCheckpoint,
  TaskContinuation,
  TaskParticipant,
  TaskView,
  Stage,
  TaskStatus,
  StageTransition,
  AgentRole,
  AgentSpec,
  ConfirmConfig,
  ResponderConfig,
  ConfirmLayer,
  ConfirmMode,
  ConfirmDecision,
  ConfirmAction,
  Message,
  ReviewInfo,
  DeclaredAction,
  ActionArg,
  ProjectConfig,
  ChildRaise,
  ParentResponse,
  SubTaskRequest,
  SubTaskResponse,
  RaiseToParent,
  AgentWait,
  HumanAudience,
  Urgency,
  RaiseType,
  SubTaskAction,
  RemotePolicy,
  LandingAuthority,
  TaskPullRequest,
  GithubLandingParticipant,
  GitHubMergeAuthorization,
  UpstreamProposal,
  TaskLandingState,
  TaskCheckout,
  WorldHandleRef,
} from '../domain/types.js';

// Pure, deterministic helpers (no Node imports) — safe inside the workflow sandbox.
export { mergeQueueDomains, remotePolicyOf, landingAuthorityOf, samePosition, MERGE_POLL } from '../domain/types.js';
// Multi-PR Review bookkeeping (SPEC §11.1) and the world's checkout list. Both
// are pure data transforms over the handle, so they are sandbox-safe too.
export { reviewCheckouts, allCheckoutsApproved, approveAll } from '../domain/checkouts.js';
export type { CheckoutApprovals } from '../domain/checkouts.js';
export { worldRepos } from '../world/types.js';
import { worldRepos } from '../world/types.js';

/** The line a landing adds to the work summary. The commit is the one that
 * landed in the world's primary repo, so with several repos it names that repo;
 * the project wiki companion never counts as one. */
export function landedNote(world: import('../domain/types.js').WorldHandleRef | undefined, target: string, sha: string | undefined): string | undefined {
  if (!sha) return undefined;
  const repos = world ? worldRepos(world as import('../world/types.js').WorldHandle).filter((repo) => repo.role !== 'project-wiki') : [];
  const primary = repos.find((repo) => repo.repo === world?.repo) ?? repos[0];
  return `Merged into ${target} as ${sha.slice(0, 8)}${repos.length > 1 && primary ? ` (${primary.name})` : ''}.`;
}

/** Pure provider classification, safe in Temporal's deterministic sandbox. */
export function remoteWorldProvider(provider: string | undefined): boolean {
  return !!provider && !['worktree', 'container', 'memory'].includes(provider);
}

export function releaseWorldOnCompletion(handle: import('../domain/types.js').WorldHandleRef): boolean {
  return remoteWorldProvider(handle.provider ?? handle.kind) || handle.meta?.releaseOnCompletion === true;
}

/** One repo checked out in a (possibly multi-repo) world, as carried in state. */
/** Back-compatible workflow name for the domain's provider-neutral handle. */
export type WorldHandleLike = import('../domain/types.js').WorldHandleRef;
