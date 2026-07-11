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

/**
 * One repository checked out inside a (possibly multi-repo) world. A project may
 * configure several repos (`ProjectConfig.repos`); each becomes a `WorldRepo`
 * with its own worktree under the world root, sharing the task's branch/base so
 * a single task can span a fleet of repos (e.g. a frontend + backend).
 */
export interface WorldRepo {
  /** Short, world-unique name (usually the source repo's basename). For a
   *  multi-repo world this is the subdirectory the repo is checked out into. */
  name: string;
  /** Absolute source repo path (the origin the worktree branches off). */
  repo: string;
  /** Absolute worktree path (where this repo is checked out in the world). */
  root: string;
  /** The branch work happens on in this repo. */
  branch: string;
  /** Base branch this repo forked from. */
  base: string;
}

export interface WorldHandle {
  kind: WorldKind;
  id: string;
  /** Absolute working directory (for worktree/container-mounted). For a
   *  single-repo world this IS the worktree; for a multi-repo world it is the
   *  parent directory holding one worktree subdirectory per repo. */
  root: string;
  /** The branch work happens on. */
  branch: string;
  /** Base branch this world forked from. */
  base: string;
  /** Primary source repo path (worktree provider) — `repos[0]` when multi-repo. */
  repo?: string;
  /** Target branch work merges to. */
  target?: string;
  /** All repos checked out in this world (§multi-repo). Single-repo worlds carry
   *  a one-element array; older handles without it are treated as single-repo via
   *  {@link worldRepos}. */
  repos?: WorldRepo[];
  /** Provider-specific extra (container id, etc.). */
  meta?: Record<string, unknown>;
  /** Non-fatal notices raised while building the world (e.g. a configured base
   *  branch that didn't exist, so the worktree forked off HEAD instead). Surfaced
   *  as `world.warning` events by the createWorld activity. */
  warnings?: string[];
}

export interface WorldSpec {
  taskId: string;
  /** Source repo (worktree). When absent (and `repos` is empty) a scratch repo is created. */
  repo?: string;
  /** Source repos for a multi-repo world. Takes precedence over `repo`. Empty ⇒ scratch. */
  repos?: string[];
  base: string;
  target?: string;
  /** Check out this existing branch instead of creating karmax/<taskId> (merge-only). */
  branch?: string;
  /** Gitignored files (globs) to copy into the world (SPEC §5.2). */
  copyGlobs?: string[];
}

/**
 * The repos of a world, tolerant of older handles that predate `repos[]`: falls
 * back to a single synthesized entry from the top-level fields. The single
 * source of truth for "which repos does this world contain" across merge,
 * destroy, and prompt assembly.
 */
export function worldRepos(handle: WorldHandle): WorldRepo[] {
  if (handle.repos?.length) return handle.repos;
  if (handle.repo) {
    return [{ name: handle.repo.split('/').filter(Boolean).pop() ?? handle.id, repo: handle.repo, root: handle.root, branch: handle.branch, base: handle.base }];
  }
  return [];
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
