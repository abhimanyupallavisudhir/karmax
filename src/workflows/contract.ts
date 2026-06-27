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
  Message,
  ReviewInfo,
  DeclaredAction,
  ActionArg,
  ProjectConfig,
} from '../domain/types.js';

/** Plain (method-free) world handle as carried in workflow state. */
export interface WorldHandleLike {
  kind: 'worktree' | 'container' | 'memory';
  id: string;
  root: string;
  branch: string;
  base: string;
  repo?: string;
  target?: string;
  meta?: Record<string, unknown>;
}
