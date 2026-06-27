/**
 * The world provider interface (SPEC §11.1). A world is the environment a
 * task's work happens in. Workflows talk only to this interface so the backend
 * (worktree / container / remote sandbox) is swappable without touching them.
 *
 * Because workflow state must be plain serializable data, the workflow holds a
 * `WorldHandle` (data), not a live `World` (methods). Activities reconstruct the
 * live world from the handle via the provider registry.
 */

export type WorldKind = 'worktree' | 'container' | 'memory';

export interface WorldHandle {
  kind: WorldKind;
  id: string;
  /** Absolute working directory (for worktree/container-mounted). */
  root: string;
  /** The branch work happens on. */
  branch: string;
  /** Base branch this world forked from. */
  base: string;
  /** Source repo path (worktree provider). */
  repo?: string;
  /** Target branch work merges to. */
  target?: string;
  /** Provider-specific extra (container id, etc.). */
  meta?: Record<string, unknown>;
}

export interface WorldSpec {
  taskId: string;
  /** Source repo (worktree). When absent a scratch repo is created. */
  repo?: string;
  base: string;
  target?: string;
  /** Check out this existing branch instead of creating karmax/<taskId> (merge-only). */
  branch?: string;
  /** Gitignored files (globs) to copy into the world (SPEC §5.2). */
  copyGlobs?: string[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
}

export interface World {
  handle: WorldHandle;
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  listFiles(): Promise<string[]>;
  destroy(): Promise<void>;
}

export interface WorldProvider {
  readonly kind: WorldKind;
  /** Whether this provider supports snapshot-on-park (SPEC §11.3). */
  readonly parkable: boolean;
  create(spec: WorldSpec): Promise<World>;
  /** Reconstruct a live world from a persisted handle. */
  open(handle: WorldHandle): Promise<World>;
}
