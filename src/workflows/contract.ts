/**
 * The workflow-safe type surface. Workflows may only import pure types (no
 * Node-only modules) into the deterministic sandbox. This re-exports the domain
 * contract for that purpose.
 */
export type {
  TaskInput,
  TaskView,
  Stage,
  TaskStatus,
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
} from '../domain/types.js';

/** One repo checked out in a (possibly multi-repo) world, as carried in state. */
export interface WorldRepoLike {
  name: string;
  repo: string;
  root: string;
  branch: string;
  base: string;
}

/** Plain (method-free) world handle as carried in workflow state. */
export interface WorldHandleLike {
  kind: 'worktree' | 'container' | 'memory';
  id: string;
  root: string;
  branch: string;
  base: string;
  repo?: string;
  target?: string;
  repos?: WorldRepoLike[];
  meta?: Record<string, unknown>;
}
