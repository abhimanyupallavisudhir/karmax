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
  WorldHandleRef,
} from '../domain/types.js';

// Pure, deterministic helper (no Node imports) — safe inside the workflow sandbox.
export { remotePolicyOf } from '../domain/types.js';

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
