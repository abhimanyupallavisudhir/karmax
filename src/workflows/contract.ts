/**
 * The workflow-safe type surface. Workflows may only import pure types (no
 * Node-only modules) into the deterministic sandbox. This re-exports the domain
 * contract for that purpose.
 */
export type {
  TaskInput,
  TaskRecoveryCheckpoint,
  TaskView,
  Stage,
  TaskStatus,
  StageTransition,
  AgentRole,
  AgentSpec,
  ConfirmConfig,
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
  SubTaskResponse,
  RaiseToParent,
  RaiseType,
  SubTaskAction,
  RemotePolicy,
  LandingAuthority,
  TaskPullRequest,
  GithubLandingParticipant,
  GitHubMergeAuthorization,
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
