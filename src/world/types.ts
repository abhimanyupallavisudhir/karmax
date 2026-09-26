import type { BranchAdjustment, WorldHandleRef } from '../domain/types.js';

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

/** Provider ids whose worlds live on the host filesystem: no metered remote
 * sandbox and no provider control plane to reconcile against. Exported as one
 * list because it is consulted from modules that must not construct a provider
 * registry (the Git broker, workflow-adjacent activities, the deterministic
 * workflow contract). Providers also declare it via `capabilities.remote`; use
 * that whenever a registry is already at hand. */
export const LOCAL_WORLD_KINDS: readonly string[] = ['worktree', 'container', 'memory'];

export function isRemoteWorldKind(kind: string | undefined): boolean {
  return !!kind && !LOCAL_WORLD_KINDS.includes(kind);
}

/** Worlds whose repos are host checkouts sharing ONE git ref database with
 * their source repository. `container` qualifies despite its distinct `kind`:
 * `ContainerWorldProvider.create` delegates to `WorktreeProvider` and only
 * bind-mounts the resulting host worktree, so its refs and the source repo's
 * are literally the same files. Remote sandboxes clone over SSH and share
 * nothing. */
export function sharesHostRefDatabase(kind: string | undefined): boolean {
  return kind === 'worktree' || kind === 'container';
}

/**
 * One repository checked out inside a (possibly multi-repo) world. A project may
 * configure several repos (`ProjectConfig.repos`); each becomes a `WorldRepo`
 * with its own worktree under the world root, sharing the task's branch/base so
 * a single task can span a fleet of repos (e.g. a frontend + backend).
 */
export interface WorldRepo {
  /** Platform-owned companion repository. It participates in branching and
   * merge like every other repo, while callers can still identify its role. */
  role?: 'project-wiki';
  /** Short, world-unique name (usually the source repo's basename). For a
   *  multi-repo world this is the subdirectory the repo is checked out into. */
  name: string;
  /** Absolute source repo path (the origin the worktree branches off). */
  repo: string;
  /** Configured network source when `repo` is a managed local checkout. Remote
   *  providers keep the URL directly in `repo`, so this is normally absent. */
  source?: string;
  /** Host checkout this repo was provisioned from (remote worlds whose project
   *  repo is a local path). It is authoritative by default; an explicit
   *  `sourceAuthority: 'origin'` keeps it only as compatibility-file provenance
   *  because GitHub owns PR-policy base and landing history. */
  localPath?: string;
  /** Which repository owns the protected/base history for this checkout.
   * Host-local project state is the default for backwards compatibility;
   * GitHub-backed checkouts under remote policy `pr` use `origin`. */
  sourceAuthority?: 'project' | 'origin';
  /** Absolute worktree path (where this repo is checked out in the world). */
  root: string;
  /** The branch work happens on in this repo. */
  branch: string;
  /** Base branch this repo forked from. */
  base: string;
  /** Protected branch this repo lands on. Defaults to the world's target. */
  target?: string;
  /** Whether `target` is an explicit or resolved per-repository policy. A non-pinned target
   * is retained for inspection but merge receives the task's live target. */
  targetPinned?: boolean;
  /** Immutable commit from which this attempt started. */
  baseSha?: string;
  /** Setup corrected a missing base; retained for durable task metadata and notices. */
  branchAdjustment?: BranchAdjustment;
}

export interface WorldHandle extends WorldHandleRef {
  kind: WorldKind;
  id: string;
  /** Absolute working directory (for worktree/container-mounted). For a
   *  single-repo world this IS the worktree; for a multi-repo world it is the
   *  parent directory holding one worktree subdirectory per repo. */
  root: string;
  /** Default directory for agent turns and commands. The world boundary remains
   *  `root`; this may point at the sole development repo when platform-owned
   *  companion repos (such as the project wiki) make the world multi-repo. */
  workdir?: string;
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
  /** Activity cancellation propagated into provider allocation/provisioning.
   * Provider implementations must leave no live sandbox when it aborts. */
  signal?: AbortSignal;
  /** Durable generation Karmax is provisioning. Remote providers use this as
   * an idempotency key when a create request times out after the provider has
   * already allocated the sandbox. */
  generation?: number;
  /** Tenant used to resolve the provider connection inside the trusted activity.
   * It is non-secret and is sealed into remote handles for later resume. */
  organizationId?: string;
  /** Source repo (worktree). When absent (and `repos` is empty), the world is a plain directory. */
  repo?: string;
  /** Source repos for a multi-repo world. Takes precedence over `repo`. Empty means no Git checkout. */
  repos?: string[];
  /** Keep a plain working directory in addition to configured companion repos. */
  scratch?: boolean;
  /** Recorded checkout topology, indexed like repos, for portable recovery. */
  checkouts?: Array<Pick<WorldRepo, 'name' | 'branch' | 'base' | 'target' | 'sourceAuthority'> & { gitIdentity?: WorldGitIdentity }>;
  base: string;
  target?: string;
  /** Check out this existing branch instead of creating karmax/<taskId> (merge-only). */
  branch?: string;
  /** Delete an existing task branch before provisioning it from `base`. */
  resetBranch?: boolean;
  /** @deprecated Host-local compatibility input. Resource attachments replace
   * this for hosted/non-Git project state (SPEC §11.4). */
  copyGlobs?: string[];
  /** Host checkouts corresponding to `repos`, used only by the trusted
   * provisioner to upload requested gitignored files into a remote clone. */
  copySources?: Array<string | undefined>;
  /** Worktree-scoped identity/signing for every commit made in this world.
   * Absent is retained only for the personal organization's host fallback. */
  gitIdentity?: WorldGitIdentity;
  /** Ephemeral clone credentials resolved inside the create-world activity.
   * Providers may install them into the isolated world, but must never persist
   * their values in WorldHandle or logs. */
  gitCredentials?: {
    /** Disable host gh/SSH/helper fallback when no explicit credential matches. */
    isolated?: boolean;
    /** Compatibility key for one repository/local profiles. */
    sshKey?: string;
    /** SSH URL -> distinct read-only clone key for non-GitHub repositories. */
    repositories?: Record<string, string>;
    /** SSH-shaped GitHub URL -> short-lived, repository-scoped App token. */
    httpsTokens?: Record<string, string>;
  };
  /** Per-repository branch policy supplied by first-class hosted repository
   * attachments. Keys are the exact SSH URLs in `repos`. */
  repositoryBranches?: Record<string, { base: string; target: string }>;
  /** Per-source authority selected by the trusted create-world activity. A PR
   * checkout forks from and later publishes through origin; local-only and
   * none/push checkouts retain the configured project repository. */
  repositoryAuthorities?: Record<string, 'project' | 'origin'>;
  /** Network identity behind a configured local path. Providers retain it on
   * WorldRepo.source so the trusted broker can address origin later. */
  repositoryOrigins?: Record<string, string>;
  /** Provider-internal per-repository projection of repositoryAuthorities. */
  sourceAuthority?: 'project' | 'origin';
  network?: { allowDomains?: string[]; allowCidrs?: string[]; unrestricted?: boolean };
  environment?: { flavor?: 'headless' | 'desktop'; template?: string; image?: string; snapshot?: string };
  resources?: { cpu?: number; memoryMb?: number; gpu?: number };
  /** Where the checkouts sit under the world root. `flat` (the default for a
   * lone repo) makes the world root itself the worktree; `nested` always gives
   * each checkout its own subdirectory — which is what leaves room for a
   * second one. A multi-PR task nests from Setup so a branch added later has
   * somewhere to live that is neither inside another checkout's working tree
   * nor outside the world boundary. */
  layout?: 'flat' | 'nested';
}

/**
 * A checkout added to an existing world (the multi-PR primitive). A task's
 * change is often best partitioned into several branches — stacked, or in
 * different repos — each reviewed and landed as its own pull request. One Do
 * agent still owns all of them: they live side by side in the same world, so
 * check-in, parking, and the account/compute lease stay single-world.
 */
export interface WorldCheckoutSpec {
  /** World-unique name: the subdirectory it is checked out into, and the label
   * its pull request carries. */
  name: string;
  /** Name of an existing checkout whose SOURCE repository this one branches
   * from. Defaults to the world's primary checkout, which is what makes "split
   * this change into two PRs against the same repo" the easy case. */
  from?: string;
  /** Branch to create. Defaults to `<world branch>-<name>`, so every branch of
   * a task still carries its task id. */
  branch?: string;
  /** Base ref. Naming a SIBLING checkout stacks this branch on that one (its
   * branch becomes the base, and the merge orders them accordingly). Anything
   * else is an ordinary git ref. Defaults to the source checkout's base. */
  base?: string;
  /** Branch this checkout merges into. Defaults to the source checkout's target. */
  target?: string;
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
      branch: handle.branch, base: handle.base, target: handle.target, targetPinned: false }];
  }
  return [];
}

/** Stable configured identity for enrollment/checkpoint lookups. Local
 * worktrees created from URLs branch from a managed checkout, but must retain
 * the URL selected in project Settings. */
export function worldRepoSource(repo: WorldRepo): string {
  return repo.source ?? repo.repo;
}

/** Resolve a repo's merge/publish destination without letting the task's
 * creation-time target shadow a later in-flight target update. */
export function worldRepoTarget(repo: WorldRepo, liveTarget: string): string {
  return repo.targetPinned === false ? liveTarget : (repo.target ?? liveTarget);
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
/** How a PTY process ended when it produced no exit code: killed by a signal,
 * or unknown because the provider stream was lost (the process may still be
 * running in the world). */
export type WorldPtyTermination = { signal: NodeJS.Signals } | { lost: Error };

/** Evidence, from outside the agent, that the world itself broke a turn. */
export interface WorldDiagnosis {
  summary: string;
  memoryExhausted: boolean;
}

export interface WorldPty {
  readonly pid?: number;
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (code: number | null, termination?: WorldPtyTermination) => void): () => void;
  write(data: string): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  close(): (void | Promise<void>) | Promise<void | Promise<void>>;
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
  /** Same task boundary without application environment injection. Provider
   * bootstrap/model subprocesses use this; agent work retains the decorated world. */
  withoutProjectEnvironment?(): World;
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
  /** Add another checkout (another branch, hence another PR) to this world and
   * return the updated handle. The world mutates its own handle too, so a
   * caller holding the live world sees the new checkout immediately. */
  addCheckout?(spec: WorldCheckoutSpec): Promise<WorldHandle>;
  /** Remote providers: whether the sandbox (not the agent) explains a failure,
   * judged from control-plane evidence that survives a frozen sandbox. */
  diagnose?(window: { since: number; now?: number }): Promise<WorldDiagnosis | undefined>;
  destroy(): Promise<void>;
}

/** A sandbox found on a provider's control plane by karmax's own labels, with
 * just enough to attribute and destroy it. Provider SDK objects never escape
 * the provider module through this shape. */
export interface ProviderSandboxRef {
  /** Provider-side id. Diagnostic only — never persisted in a handle. */
  sandboxId: string;
  /** The karmax task this sandbox was created for (`karmaxTaskId` metadata). */
  taskId?: string;
  /** Whether this provider object is the sandbox sealed into a durable world
   * handle. Provider modules can answer without exposing the sealed id. */
  matches?(handle: WorldHandleRef): boolean | undefined;
  destroy(): Promise<void>;
}

/** One completed billable execution reported by a provider's control plane.
 * A persistent sandbox may have many executions as it pauses and resumes; `id`
 * identifies that execution (not the sandbox) and is the idempotency key. */
export interface ProviderUsageEvent {
  id: string;
  sandboxId: string;
  taskId?: string;
  startedAt: number;
  endedAt: number;
  activeMs: number;
  cpu: number;
  memoryMb: number;
  gpu?: number;
}

/**
 * Order checkouts so a branch stacked on a sibling merges AFTER it. Order is the
 * whole point of stacking: land the dependent first and it drags its base's
 * commits along, so the base's own pull request arrives with nothing left of its
 * own. A plain depth-first walk over `base`-names-a-sibling's-`branch` edges;
 * a cycle (which no legal stack can produce) degrades to input order rather
 * than looping. Stable for the flat case — one checkout, or none stacked, comes
 * back exactly as given.
 */
export function orderCheckouts(repos: WorldRepo[]): WorldRepo[] {
  const byBranch = new Map(repos.map((r) => [r.branch, r]));
  const ordered: WorldRepo[] = [];
  const state = new Map<WorldRepo, 'visiting' | 'done'>();
  const visit = (repo: WorldRepo) => {
    if (state.get(repo)) return; // already placed, or an ancestor of itself
    state.set(repo, 'visiting');
    const parent = byBranch.get(repo.base);
    if (parent && parent !== repo) visit(parent);
    state.set(repo, 'done');
    ordered.push(repo);
  };
  for (const repo of repos) visit(repo);
  return ordered;
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
  /** Delete through the control plane without resuming the sandbox. */
  destroy?(handle: WorldHandle): Promise<void>;
  status?(handle: WorldHandle): Promise<WorldLifecycleState>;
  /** Ask the provider's control plane for the sandbox's authoritative state
   * without resuming or otherwise mutating it. `status` reports the local
   * in-process view; `probe` reconciles against the remote source of truth.
   * Undefined means the provider cannot say (no probe support, network error). */
  probe?(handle: WorldHandle): Promise<WorldLifecycleState | undefined>;
  /**
   * Enumerate the sandboxes THIS deployment owns on the provider's control
   * plane, matched on the `karmaxHome`/`karmaxTaskId` labels written at create.
   * The lifecycle sweep uses it to reap sandboxes whose task is terminal or
   * gone: a terminated or lost workflow never reaches `destroyWorld`, a `ready`
   * world is never swept (hibernation scans only `parked`), and Daytona is
   * created with `autoDeleteInterval: -1` so the provider will never reap it
   * either — the sandbox would bill forever. Absent (or a rejection) means the
   * provider cannot enumerate and nothing is reaped.
   */
  listSandboxes?(organizationId?: string): Promise<ProviderSandboxRef[]>;
  /** Completed provider-authoritative billable executions. Lease wall time is
   * not usage: providers can auto-pause while a local capacity lease is stale. */
  listUsageEvents?(organizationId: string): Promise<ProviderUsageEvent[]>;
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

/** Default process/agent directory, tolerant of handles created before the
 * distinction between a world's boundary and its working directory existed. */
export function worldWorkingDirectory(handle: WorldHandle): string {
  return handle.workdir ?? handle.root;
}

/** Translate an agent-relative path into the root-relative namespace used by
 * the provider-neutral file API. */
export function worldWorkingRelativePath(handle: WorldHandle, relPath: string): string {
  const safe = worldRelativePath(relPath);
  // Unit adapters and historical serialized handles may only carry an id. In
  // that single-root compatibility shape, agent-relative is already root-relative.
  if (!handle.root && !handle.workdir) return safe;
  const root = (handle.root ?? handle.workdir).replace(/\\/g, '/').replace(/\/+$/, '');
  const workdir = worldWorkingDirectory(handle).replace(/\\/g, '/').replace(/\/+$/, '');
  if (workdir === root) return safe;
  if (!workdir.startsWith(`${root}/`)) throw new Error('working directory escapes world');
  const prefix = workdir.slice(root.length + 1);
  return safe === '.' ? prefix : `${prefix}/${safe}`;
}
