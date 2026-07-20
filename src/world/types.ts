import type { WorldHandleRef } from '../domain/types.js';

/**
 * The world provider interface (SPEC §11.1). A world is the environment a
 * task's work happens in. Workflows talk only to this interface so the backend
 * (worktree / container / remote sandbox) is swappable without touching them.
 *
 * Because workflow state must be plain serializable data, the workflow holds a
 * `WorldHandle` (data), not a live `World` (methods). Activities reconstruct the
 * live world from the handle via the provider registry.
 */

/** Stable provider id persisted in Temporal history. Additive only: a handle
 * keeps naming the provider that created it for the lifetime of the task. */
/** Provider registry id. Kept as an alias because it is persisted in workflow state. */
export type WorldKind = string;

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
  /** Configured network source when `repo` is a managed local checkout. Remote
   *  providers keep the URL directly in `repo`, so this is normally absent. */
  source?: string;
  /** Absolute worktree path (where this repo is checked out in the world). */
  root: string;
  /** The branch work happens on in this repo. */
  branch: string;
  /** Base branch this repo forked from. */
  base: string;
  /** Protected branch this repo lands on. Defaults to the world's target. */
  target?: string;
  /** Immutable commit from which this attempt started. */
  baseSha?: string;
}

export interface WorldHandle extends WorldHandleRef {
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

/** Git identity a world's commits carry (PLAN-git-config.md §4A), materialized
 *  from the project's git profile. `signingKeyPath` is an SSH key file already
 *  written to disk by the profile service (never a secret in transit here). */
export interface WorldGitIdentity {
  name: string;
  email: string;
  signingKeyPath?: string;
}

export interface WorldSpec {
  taskId: string;
  /** Tenant used to resolve the provider connection inside the trusted activity.
   * It is non-secret and is sealed into remote handles for later resume. */
  organizationId?: string;
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
  /** Host checkouts corresponding to `repos`, used only by the trusted
   * provisioner to upload requested gitignored files into a remote clone. */
  copySources?: Array<string | undefined>;
  /** Worktree-scoped identity/signing for every commit made in this world
   *  (PLAN-git-config.md §4A). Absent ⇒ host identity, else karmax@localhost. */
  gitIdentity?: WorldGitIdentity;
  /** Ephemeral clone credentials resolved inside the create-world activity.
   * Providers may install them into the isolated world, but must never persist
   * their values in WorldHandle or logs. */
  gitCredentials?: {
    /** Compatibility key for one repository/local profiles. */
    sshKey?: string;
    /** SSH URL -> distinct read-only clone key for hosted repository records. */
    repositories?: Record<string, string>;
  };
  /** Per-repository branch policy supplied by first-class hosted repository
   * attachments. Keys are the exact SSH URLs in `repos`. */
  repositoryBranches?: Record<string, { base: string; target: string }>;
  network?: { allowDomains?: string[]; allowCidrs?: string[]; unrestricted?: boolean };
  environment?: { flavor?: 'headless' | 'desktop'; template?: string; image?: string; snapshot?: string };
  resources?: { cpu?: number; memoryMb?: number; gpu?: number };
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
    return [{ name: handle.repo.split('/').filter(Boolean).pop() ?? handle.id, repo: handle.repo, root: handle.root,
      branch: handle.branch, base: handle.base, target: handle.target }];
  }
  return [];
}

/** Stable configured identity for enrollment/checkpoint lookups. Local
 * worktrees created from URLs branch from a managed checkout, but must retain
 * the URL selected in project Settings. */
export function worldRepoSource(repo: WorldRepo): string {
  return repo.source ?? repo.repo;
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

/** A streaming process started inside a world. The gateway owns only this
 * opaque lease; providers decide whether the process is local, in Docker, or in
 * a remote sandbox. */
export interface WorldProcess {
  /** Present for host-visible processes, absent for remote provider processes. */
  readonly pid?: number;
  onOutput(listener: (chunk: string) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void | Promise<void>;
}

export interface WorldProcessSpec {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** A provider-owned interactive terminal. This deliberately mirrors the tiny
 * subset the browser terminal needs instead of leaking node-pty into callers. */
export interface WorldPty {
  readonly pid?: number;
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  write(data: string): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface WorldPtySpec {
  /** Optional command to execute directly on the PTY. Remote agent runtimes use
   * this bidirectional channel for the Claude/Codex SDK protocol. */
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export type WorldLifecycleState = 'ready' | 'parked' | 'missing';

export interface WorldHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface WorldHttpRequest {
  method: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

export interface WorldPreviewSocketTarget {
  url: string;
  headers?: Record<string, string>;
}

export interface WorldDesktopSession {
  /** Provider-authenticated browser URL for a human visual check-in. */
  url: string;
  provider: string;
}

export interface World {
  handle: WorldHandle;
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  readFile(relPath: string): Promise<string>;
  readFileBuffer(relPath: string): Promise<Buffer>;
  writeFile(relPath: string, content: string): Promise<void>;
  writeFileBuffer?(relPath: string, content: Buffer): Promise<void>;
  listFiles(): Promise<string[]>;
  startProcess(spec: WorldProcessSpec): Promise<WorldProcess>;
  openPty(spec?: WorldPtySpec): Promise<WorldPty>;
  /** Authenticated control-plane proxy to a service bound inside this world.
   * Remote providers implement it without exposing provider credentials. */
  fetchPort?(port: number, requestPath: string, request?: WorldHttpRequest): Promise<WorldHttpResponse>;
  /** Short-lived, server-side upstream for an authenticated preview WebSocket.
   * Provider traffic credentials are returned only to the gateway. */
  previewSocketTarget?(port: number, requestPath: string): Promise<WorldPreviewSocketTarget>;
  /** Start (or reconnect to) the provider's desktop stack and return its
   * authenticated noVNC viewer. Present only for desktop-flavor worlds. */
  desktopSession?(): Promise<WorldDesktopSession>;
  destroy(): Promise<void>;
}

export interface WorldProvider {
  readonly kind: WorldKind;
  readonly capabilities?: {
    remote: boolean;
    pty: boolean;
    snapshots: boolean;
    ports: boolean;
    networkPolicy: boolean;
  };
  /** Whether this provider supports snapshot-on-park (SPEC §11.3). */
  readonly parkable: boolean;
  create(spec: WorldSpec): Promise<World>;
  /** Reconstruct a live world from a persisted handle. */
  open(handle: WorldHandle): Promise<World>;
  /** Release metered compute while retaining the world's durable state. */
  park?(handle: WorldHandle): Promise<WorldHandle>;
  status?(handle: WorldHandle): Promise<WorldLifecycleState>;
  /** Ask the provider's control plane for the sandbox's authoritative state
   * without resuming or otherwise mutating it. `status` reports the local
   * in-process view; `probe` reconciles against the remote source of truth.
   * Undefined means the provider cannot say (no probe support, network error). */
  probe?(handle: WorldHandle): Promise<WorldLifecycleState | undefined>;
}

/** Provider-independent confinement for every file/process cwd crossing the
 * gateway boundary. Providers may map this path to any physical location. */
export function worldRelativePath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/');
  if (!normalized || normalized === '.') return '.';
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) throw new Error('path must be relative to the world');
  const parts = normalized.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error('path escapes world');
  return parts.join('/') || '.';
}
