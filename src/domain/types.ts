/**
 * The karmax domain model (SPEC §2) and the task view-model contract (§10.2).
 * These types are shared across the workflow contract, the gateway, and the UI.
 */

// ─── Identity ────────────────────────────────────────────────────────────────

import type { TaskTrigger, TriggerState } from './triggers.js';
import type { HostedPlanId } from './entitlements.js';
export type { TaskTrigger, TriggerState } from './triggers.js';

/**
 * The coding harness that executes a turn. OpenCode is driven through stable
 * ACP; Kimi/Grok remain in this replay-persistent union for historical workflow
 * data but are not admitted by the current provider registry. Model vendors are
 * separate profile properties because OpenCode can use many of them.
 */
export type Provider = 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'mock';

export type AgentRole = 'do' | 'merge' | 'resolve' | 'confirm' | 'responder' | (string & {});

// ─── Tenancy and collaboration ────────────────────────────────────────────────

/** Immutable references are persisted; display names are resolved at the edge. */
export type PrincipalRef =
  | { kind: 'user'; userId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'avatar'; avatarId: string }
  | { kind: 'task-agent'; taskId: string; role: string };

/** Project access may also target the entire containing organization. This is
 * deliberately project-specific; @all is not a valid task assignee. */
export type ProjectPrincipalRef = PrincipalRef | { kind: 'organization'; organizationId: string };

export type ConfirmationTarget = PrincipalRef | { kind: 'project-role'; projectId: string; role: string };

export interface ConfirmationPolicy {
  targets: ConfirmationTarget[];
  rule: 'any' | 'all' | { quorum: number };
}

export interface Organization {
  /** Name discovery only; never grants access to organization resources. */
  nameVisibility: 'members' | 'public';
  id: string;
  name: string;
  slug: string;
  kind: 'personal' | 'team';
  /** Hosted billing selection. Private installations ignore monetization plans. */
  plan: HostedPlanId;
  createdAt: number;
}

export interface OrganizationMembership {
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: number;
}

export interface AuthorizationSelection {
  level: string;
  scope: 'projects' | 'organization' | 'global';
  projectIds?: string[];
}

/** A durable, user-authored autonomous principal. Avatars are project-owned for
 * discovery/routing, while their authority is an explicit delegation captured
 * at creation or edit time. `roles=[]` means every workflow role; callableBy
 * uses the same stable user/team selectors as task routing plus `@project`. */
export interface Avatar {
  id: string;
  organizationId: string;
  projectId: string;
  ownerUserId: string;
  name: string;
  purpose?: string;
  prompt: string;
  promptVersion: number;
  enabled: boolean;
  authorityMode: 'full' | 'restricted';
  authorization: AuthorizationSelection & {
    profileId: string;
    capabilities: string[];
    organizationId?: string;
    /** Principal whose live grant backs this delegation. Legacy Avatars fall
     * back to their owner so revocation behavior remains unchanged. */
    principal?: string;
  };
  credentialPolicies?: Record<string, { use?: 'auto' | 'ask' | 'never'; reveal?: 'auto' | 'ask' | 'never' }>;
  githubAccountId?: string;
  callableBy: string[];
  roles: string[];
  runtime: {
    provider: Provider;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface AvatarAvailability {
  organization: boolean;
  project: 'inherit' | 'enabled' | 'disabled';
  effective: boolean;
}

export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationMembership['role'];
  /** Authorization is selected explicitly; membership role is an internal
   * ownership invariant, not a second permissions system. */
  profileId?: string;
  authorization?: AuthorizationSelection;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
}

export interface Team {
  id: string;
  organizationId: string;
  projectId?: string;
  name: string;
  slug: string;
  createdAt: number;
}

export interface TeamMembership {
  teamId: string;
  userId: string;
  role: 'member';
  joinedAt: number;
}

export interface ProjectMembership {
  projectId: string;
  principal: ProjectPrincipalRef;
  role: 'owner' | 'admin' | 'member' | 'reviewer' | (string & {});
  joinedAt: number;
}

export interface Repository {
  id: string;
  organizationId: string;
  provider: 'github';
  providerId?: string;
  owner: string;
  name: string;
  sshUrl: string;
  defaultBranch: string;
  private: boolean;
  gitConnectionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRepository {
  projectId: string;
  repositoryId: string;
  baseBranch?: string;
  targetBranch?: string;
  order: number;
}

export interface GitConnection {
  id: string;
  organizationId: string;
  provider: 'github';
  installationId: string;
  accountLogin: string;
  accountType?: 'User' | 'Organization';
  createdAt: number;
  suspendedAt?: number;
}

/**
 * How loudly an ask asks. Urgency is the one knob an agent turns when it needs a
 * person: it orders the inbox (highest first, always) and selects the behaviour
 * that person configured for the level — a system notification, a sound, and in
 * time a connector that reaches them away from the browser.
 */
export type Urgency = 'low' | 'normal' | 'high' | 'critical';

/** Ascending, so the array index IS the rank the inbox row stores and sorts on. */
export const URGENCY_LEVELS: Urgency[] = ['low', 'normal', 'high', 'critical'];

export function urgencyRank(urgency: Urgency): number {
  const rank = URGENCY_LEVELS.indexOf(urgency);
  return rank < 0 ? URGENCY_LEVELS.indexOf('normal') : rank;
}

/** Anything unrecognized collapses to the caller's fallback instead of throwing:
 * urgency is advisory metadata and must never be the reason an ask fails. */
export function normalizeUrgency(value: unknown, fallback: Urgency = 'normal'): Urgency {
  return URGENCY_LEVELS.includes(value as Urgency) ? value as Urgency : fallback;
}

/**
 * What a kind of ask is worth when nobody said. An approval request blocks an
 * agent on a person and is the one thing that cannot proceed without them, so it
 * starts high; an outcome report is not an ask at all, so it starts low. Agents
 * override this per request — the default is what an unopinionated caller gets.
 */
export const DEFAULT_URGENCY: Record<InboxItem['kind'], Urgency> = {
  'approval-requested': 'high',
  'review-requested': 'normal',
  escalated: 'normal',
  assigned: 'normal',
  mentioned: 'normal',
  update: 'low',
};

export interface InboxItem {
  id: string;
  organizationId: string;
  userId: string;
  eventSeq: number;
  taskId: string;
  kind: 'assigned' | 'mentioned' | 'review-requested' | 'approval-requested' | 'escalated' | 'update';
  urgency: Urgency;
  unread: boolean;
  actionable: boolean;
  createdAt: number;
  readAt?: number;
  /** Resource-backed asks use the inbox without manufacturing a task merely to
   * carry a notification. */
  subject?: { kind: 'avatar-authorization'; avatarId: string; projectId: string; requestId: string };
}

export interface DeliveryPreferences {
  userId: string;
  organizationId: string;
  browser: boolean;
  email: boolean;
  emailUrgencies?: Partial<Record<Urgency, boolean>>;
  slack: boolean;
  routine: boolean;
}

export interface OrganizationIdentityPolicy {
  organizationId: string;
  oidcProviderId?: string;
  verifiedDomains: string[];
  enforceSso: boolean;
  scimTokenId?: string;
  updatedAt: number;
}

export interface WorldCheckpoint {
  id: string;
  worldId: string;
  generation: number;
  projectId: string;
  runnerPoolId: string;
  environmentDigest: string;
  repos: Array<{
    repositoryId: string;
    /** Clone/worktree source pinned at checkpoint time. Older checkpoints omit
     * this and recover it from the durable world handle or project config. */
    source?: string;
    checkoutPath: string;
    baseSha: string;
    branch: string;
    headSha?: string;
    /** Per-checkout branch policy. This matters for platform companions such as
     * the project wiki, which do not necessarily share the project's default. */
    base?: string;
    target?: string;
    targetPinned?: boolean;
    role?: 'project-wiki';
  }>;
  filesystemDelta?: { objectKey: string; sha256: string; bytes: number };
  resources?: Array<{ attachmentId: string; revisionId: string }>;
  /** Metadata-only inventory of ignored paths omitted from the portable delta.
   * Contents are never read or uploaded by this safety net. */
  ignored?: IgnoredResourceInventory;
  /** Accepted provider-neutral runtime declarations pinned at checkpoint time.
   * Provider snapshots remain accelerators; generated endpoints are excluded. */
  environment?: ProjectEnvironmentSpec;
  services?: ProjectService[];
  createdAt: number;
}

export interface RunnerPool {
  id: string;
  organizationId: string;
  name: string;
  provider: string;
  region?: string;
  mode: 'managed' | 'customer';
  capacity: { activeWorlds: number; cpu: number; memoryMb: number; gpu: number };
  createdAt: number;
  enabled: boolean;
}

/** One organization-owned connection to a remote execution provider. Secrets
 * live only in the encrypted credential broker; this record is safe to return
 * through the UI/API and to include in tenant exports. Keeping one connection
 * per provider makes the common case genuinely one-click while runner pools
 * remain the capacity/policy layer above it. */
export interface WorldProviderConnection {
  id: string;
  organizationId: string;
  provider: 'e2b' | 'daytona' | (string & {});
  name: string;
  credentialHandle: string;
  config: {
    /** Provider-native launch artifact for ordinary headless worlds. */
    template?: string;
    snapshot?: string;
    image?: string;
    /** Optional provider-native desktop variant. E2B defaults to its public
     * `desktop` template; Daytona defaults to its VNC-capable stock image. */
    desktopTemplate?: string;
    desktopSnapshot?: string;
    desktopImage?: string;
    apiUrl?: string;
    target?: string;
  };
  enabled: boolean;
  status: 'untested' | 'ready' | 'error';
  lastCheckedAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UsageEvent {
  id: string;
  organizationId: string;
  projectId?: string;
  taskId?: string;
  worldId?: string;
  provider: string;
  kind: 'world.active' | 'checkpoint.storage' | 'resource.storage' | 'preview.active' | 'agent.request' | 'agent.tokens' | 'agent.cost';
  /** Who pays the upstream bill. `managed` is installation-funded and is
   * disabled in hosted mode until an owner sets an explicit spend cap. */
  fundingSource?: 'managed' | 'byok' | 'customer';
  /** Whether costMicros is an upstream-incurred amount or a conservative
   * estimate used when the provider did not expose priceable usage. */
  costClassification?: 'incurred' | 'estimated' | 'none';
  quantity: number;
  unit: 'second' | 'byte' | 'byte-second' | 'request' | 'token';
  costMicros: number;
  startedAt: number;
  endedAt: number;
  metadata?: Record<string, unknown>;
}

export interface PromotedArtifact {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  name: string;
  createdAt: number;
  expiresAt?: number;
}

export interface ExecutionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  worldId: string;
  generation: number;
  kind: 'review-action' | 'terminal' | 'preview' | 'agent' | 'command';
  label: string;
  command?: string;
  server: boolean;
  openUrls: string[];
  state: 'starting' | 'running' | 'stop-requested' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  startedAt: number;
  heartbeatAt: number;
  endedAt?: number;
  exitCode?: number | null;
  runnerLeaseId?: string;
}

export interface ExecutionFrame {
  executionId: string;
  seq: number;
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  data: string;
}

export interface PreviewLease {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  worldId: string;
  generation: number;
  port: number;
  public: boolean;
  tokenHash?: string;
  runnerLeaseId?: string;
  provider: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  /** Exact per-lease browser hostname approved for on-demand TLS. */
  hostname?: string;
}

/** Plain, serializable reference to a task world. Workflows and trusted server
 * code carry this opaque handle; only the selected provider is allowed to
 * interpret `root` and `meta`. The gateway replaces it with the public
 * `worldAvailable`/`worldProvider` projection before sending a view to a client.
 * `root` may be a virtual path in a remote sandbox. */
export interface WorldHandleRef {
  /** V2 lifecycle fields are additive so historical v1 Temporal histories replay. */
  version?: 1 | 2;
  /** Replay-compatible provider id. V2 accepts registry strings, not a closed union. */
  kind: string;
  /** Canonical V2 spelling; `kind` remains while V1 histories exist. */
  provider?: string;
  id: string;
  generation?: number;
  runnerPoolId?: string;
  environmentDigest?: string;
  checkpointId?: string;
  /** Provider-interpreted encrypted reference. Never contains a plaintext sandbox id/token. */
  sealedProviderRef?: string;
  /** Stable path inside the environment; unlike `root`, never denotes a control-plane path. */
  workspaceRoot?: string;
  root: string;
  /** Default agent/process directory inside the world boundary. */
  workdir?: string;
  branch: string;
  base: string;
  repo?: string;
  target?: string;
  repos?: { name: string; role?: 'project-wiki'; repo: string; root: string; branch: string; base: string; target?: string;
    /** True only when a repository attachment pins its own target. False means
     * `target` is the task's initial value and live task updates take precedence. */
    targetPinned?: boolean; baseSha?: string; localPath?: string }[];
  meta?: Record<string, unknown>;
  warnings?: string[];
}

/**
 * Every durable merge-queue lease a task world can own. Kept in the pure domain
 * contract so deterministic workflows and the platform's out-of-band lifecycle
 * controls use exactly the same keys when acquiring and withdrawing work.
 */
export function mergeQueueDomains(
  world: WorldHandleRef | undefined,
  target: string,
  projectId: string,
): string[] {
  const domains = world?.repos?.length
    ? world.repos.map((repo) =>
      `${repo.localPath ?? repo.repo}:${repo.targetPinned === false ? target : (repo.target ?? target)}`)
    : [`${world?.repo ?? projectId}:${target}`];
  return [...new Set(domains)].sort();
}

/**
 * How long a task parked in a merge queue waits between position refreshes.
 *
 * The grant itself arrives as a signal, which wakes the wait immediately, so
 * this interval only controls how fresh the *displayed* position is — it costs
 * no merge latency. It is deliberately coarse because every tick appends
 * activity and workflow-task events to a history Temporal hard-caps at 50MB:
 * a 5s tick let a few hours of queueing terminate the task outright.
 */
export const MERGE_POLL = '30s';

/** Whether two merge-queue positions are indistinguishable to a viewer, and so
 *  whether re-publishing the (large) task view would tell anyone anything. */
export function samePosition(
  a: TaskView['mergeQueue'],
  b: TaskView['mergeQueue'],
): boolean {
  return a?.position === b?.position
    && a?.total === b?.total
    && !!a?.unreachable === !!b?.unreachable;
}

// ─── Project / list / task records (the metadata index) ──────────────────────

export interface Project {
  id: string;
  /** Every project belongs to exactly one tenant. Optional only while reading
   * historical workflow/test fixtures created before the organization migration. */
  organizationId?: string;
  name: string;
  createdAt: number;
  config: ProjectConfig;
  /** Hand-picked sidebar position within the organization (drag to reorder).
   * Optional only while reading historical fixtures, where creation order rules. */
  order?: number;
  /** Sidebar folder as a `/`-separated path ("Work/Clients"). Folders are
   * implicit — one exists exactly while a project names it — so there is no
   * folder entity to create, rename, or garbage-collect. Absent = top level. */
  folder?: string;
}

export interface ProjectConfig {
  /** Repository sources: local filesystem paths for local worlds, SSH Git URLs
   * for hosted worlds. */
  repos?: string[];
  /** Default base branch worlds branch off (e.g. "main"). */
  defaultBase?: string;
  /** Default branch merges land on. */
  defaultTarget?: string;
  /** @deprecated Self-hosted compatibility/import path. Project resources and
   * credential injection are the durable/hosted model (SPEC §11.4). */
  copyGlobs?: string[];
  /** @deprecated Superseded by `remote: 'pr'` (PLAN-git-config.md §5); still honored. */
  openGithubPr?: boolean;
  /**
   * Remote policy (PLAN-git-config.md §5): what leaves the machine, and when.
   * 'none' (self-hosted/local default) — merges are local. 'push' — the target
   * branch is pushed after a merge lands. 'pr' — the task branch is pushed and a
   * GitHub PR opened at the PR stage, and the target pushed after merge. Hosted
   * GitHub projects default to 'pr' and do not accept 'none'. Anything beyond
   * this happens only when a task explicitly asks its agent to push.
   */
  remote?: RemotePolicy;
  /** Who is expected to order pull-request landing. `auto` prefers a provider
   * queue/auto-merge and falls back to Karmax admission only when strict
   * freshness needs serialization. `external` is for a repository-triggered
   * third-party queue Karmax can observe but must never shadow. `karmax` forces
   * the fair fallback admission queue. */
  landingAuthority?: LandingAuthority;
  /** Allow one task to partition its change across several branches, each landing
   *  as its own pull request (SPEC §11.1, the agent's `create_branch`). Its only
   *  structural effect is that the world nests its checkouts at Setup, so a
   *  branch added later has somewhere to live inside the world boundary; the
   *  task's lifecycle stays singular (one Review, one Merge). */
  multiPr?: boolean;
  /** @deprecated Human-created development ignores this field and always uses
   *  the creator's user-owned default Git profile. Retained for replay and for
   *  system/automation work with no human creator, where it selects an
   *  organization service profile. */
  gitProfile?: string;
  /** role -> agent profile id. */
  defaultProfiles?: Record<string, string>;
  /** World backend. */
  worldProvider?: string;
  /** Resume provider-backed worlds after a parked wait (§11.3). */
  resumeWorlds?: boolean;
  /** Hosted execution pool and declared resources. */
  runnerPoolId?: string;
  resources?: { cpu?: number; memoryMb?: number; gpu?: number };
  /** Remote-world egress policy. Normal coding uses unrestricted internet;
   * allowlists are an explicit organization-level hardening mode. */
  network?: { allowDomains?: string[]; allowCidrs?: string[]; unrestricted?: boolean };
  /** Immutable remote environment selector. Provider adapters resolve this to
   * their image/snapshot primitive and stamp the result on the world handle. */
  environment?: { flavor?: 'headless' | 'desktop'; template?: string; image?: string; snapshot?: string };
  /** Hard monthly provider-cost ceiling; provisioning queues once exhausted. */
  monthlyBudgetMicros?: number;
  /** Parked-world retention before portable hibernation (default seven days). */
  hibernateAfterMs?: number;
}

// ─── Project resources (SPEC §11.4) ────────────────────────────────────────

export type ResourceAccess = 'read' | 'write';
export type ResourceIsolation = 'fork' | 'shared';
export type ResourcePublishPolicy = 'discard' | 'review';
export type ResourceTarget =
  /** Relative to the task working directory: the sole development checkout,
   * or the encompassing workspace for multiple development repositories. */
  | { kind: 'path'; path: string }
  | { kind: 'environment'; name: string }
  | { kind: 'service'; name: string };

/** Durable, secret-free project attachment. Driver configuration may contain
 * locators and policy only; credentials are write-only vault handles. */
export interface ResourceAttachment {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  driver: string;
  target: ResourceTarget;
  access: ResourceAccess;
  isolation: ResourceIsolation;
  source: Record<string, unknown>;
  credentialHandles: string[];
  /** Where new immutable revisions are written. Existing revisions remain pinned
   * to their own location when this default changes. */
  storageLocationId?: string;
  currentRevisionId?: string;
  publish: ResourcePublishPolicy;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Immutable revision envelope. `sealedRef` is meaningful only to the selected
 * snapshot/resource driver and never enters workflow history. */
export interface ResourceRevision {
  id: string;
  attachmentId: string;
  parentRevisionId?: string;
  engine: string;
  /** Immutable data-plane placement. Undefined is the legacy managed store. */
  storageLocationId?: string;
  sealedRef: string;
  rootDigest: string;
  bytes: number;
  files?: number;
  metadata?: Record<string, unknown>;
  createdByTaskId?: string;
  createdAt: number;
}

/** Organization-owned object-storage placement. Credentials are deliberately
 * absent from the returned configuration and live only behind credentialHandle. */
export interface StorageLocation {
  id: string;
  organizationId: string;
  name: string;
  kind: 'managed' | 's3';
  config: { endpoint?: string; bucket?: string; region?: string; prefix?: string };
  credentialHandle?: string;
  isDefault: boolean;
  status: 'ready' | 'untested' | 'error';
  lastCheckedAt?: number;
  lastError?: string;
  /** Hard physical-byte ceiling. Undefined means customer-billed/unlimited. */
  quotaBytes?: number;
  createdAt: number;
  updatedAt: number;
}

export interface StorageLocationUsage {
  locationId: string;
  retainedBytes: number;
  quotaBytes?: number;
  availableBytes?: number;
}

/** A task-owned proposal to make newly-created non-Git state a project
 * resource. The attachment is kept disabled until Review adopts it; snapshot
 * bytes are already durable so provider loss cannot race the decision. */
export interface ResourceCandidate {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  worldId: string;
  worldGeneration: number;
  attachmentId: string;
  sourceKind: 'path' | 'vault-item';
  sourcePath?: string;
  vaultItemId?: string;
  vaultField?: string;
  state: 'pending' | 'adopted' | 'discarding' | 'discarded';
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface IgnoredResourceInventory {
  entries: Array<{ checkout?: string; path: string; bytes: number; likelySecret: boolean }>;
  truncated: boolean;
}

export type ResourceLeaseState = 'preparing' | 'active' | 'released' | 'failed';
export interface ResourceLease {
  id: string;
  attachmentId: string;
  revisionId?: string;
  taskId: string;
  worldId: string;
  worldGeneration: number;
  access: ResourceAccess;
  state: ResourceLeaseState;
  sealedDriverRef?: string;
  createdAt: number;
  expiresAt?: number;
  releasedAt?: number;
}

export interface ResourceChangeSummary {
  attachmentId: string;
  baseRevisionId?: string;
  added: number;
  modified: number;
  deleted: number;
  bytes: number;
  changedPaths: string[];
}

// ─── Project environments and per-world services ───────────────────────────

/** A user-approved derivation recipe. Setup is baked into immutable provider
 * artifacts; boot commands run for each world. The proposal UI derives this
 * from lockfiles/devcontainers instead of requiring hand-authored config. */
export interface ProjectEnvironmentSpec {
  image?: string;
  setup?: string[];
  boot?: string[];
  includeDocker?: boolean;
}

export interface EnvironmentBuildRecord {
  provider: string;
  digest: string;
  status: 'building' | 'ready' | 'failed';
  ref?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** Services are recipes/access declarations, not a second data store. A
 * per-world seed references a typed resource attachment already materialized
 * in the world; external services name a secret attachment. */
export interface ProjectService {
  name: string;
  kind: 'external' | 'per-world';
  connectionResourceId?: string;
  image?: string;
  command?: string[];
  env?: Record<string, string>;
  containerPort?: number;
  urlEnv?: string;
  urlTemplate?: string;
  seedResourceId?: string;
  seedContainerPath?: string;
}

/** Organization-owned defaults for task execution. Projects may select another
 * connected provider/pool or set a tighter budget, but sandbox shape, lifecycle,
 * and network posture have one obvious home. */
export interface OrganizationExecutionPolicy {
  worldProvider?: string;
  runnerPoolId?: string;
  resources?: ProjectConfig['resources'];
  network?: ProjectConfig['network'];
  /** Headless includes screenshot-capable browser MCPs. Desktop additionally
   * enables provider-native Xvfb/XFCE/noVNC computer use. */
  environment?: ProjectConfig['environment'];
  monthlyBudgetMicros?: number;
  hibernateAfterMs?: number;
}

/** Trusted admission policy for hosted, organization-attributed work. Empty
 * allowlists mean "all connected BYOK providers/models"; they never authorize
 * an installation credential. Managed model rails require both an explicit
 * provider boundary and an owner-set spend cap. */
export interface OrganizationUsagePolicy {
  managedSpendCapMicros?: number;
  managedModelProviders: string[];
  allowedModelProviders: string[];
  allowedModels: string[];
  maxAgentStartsPerMinute: number;
  maxRemoteStartsPerMinute: number;
  /** Optional owner-selected cap. Hosted admission clamps it to the central
   * plan entitlement; omission means the marketed plan limit exactly. */
  maxActiveAgentTurns?: number;
  /** Computed, never persisted: min(owner cap, plan entitlement). */
  effectiveMaxActiveAgentTurns: number;
  /** Hosted: computed from the plan's active-agent concurrency and never
   * independently configurable. Private installs retain their saved pool guard. */
  maxActiveWorlds: number;
}

// ─── Git & GitHub configuration (PLAN-git-config.md) ────────────────────────

export type RemotePolicy = 'none' | 'push' | 'pr';
export type LandingAuthority = 'auto' | 'external' | 'karmax';

/** The effective remote policy, honoring the deprecated `openGithubPr` flag. */
export function remotePolicyOf(project: ProjectConfig | undefined): RemotePolicy {
  return project?.remote ?? (project?.openGithubPr ? 'pr' : 'none');
}

export function landingAuthorityOf(project: ProjectConfig | undefined): LandingAuthority {
  return project?.landingAuthority ?? 'auto';
}

/** A GitHub pull request karmax opened for one repo of a task's world. The
 *  slug/number pair is what every later lifecycle call (comment, close, state
 *  re-read) needs, so it travels on the task view rather than being re-derived. */
/**
 * One branch of a task, as the task view shows it (SPEC §11.1). A single-branch
 * task has exactly one; a multi-PR task has one per pull request it is opening.
 * `approved` is bound to `head`: it lapses whenever the branch moves, so partial
 * Review approval can never carry over onto work nobody looked at.
 */
export interface TaskCheckout {
  /** World-unique name: its directory, and the label on its pull request. */
  name: string;
  branch: string;
  base: string;
  target?: string;
  /** Head commit of the branch when the view was built. */
  head?: string;
  /** Approved at exactly `head` (Review). */
  approved?: boolean;
  /** Name of the sibling checkout this one is stacked on, if any. */
  stackedOn?: string;
  pr?: TaskPullRequest;
}

export interface TaskPullRequest {
  /** World repo name the PR belongs to (multi-repo tasks open one per repo). */
  repo: string;
  /** `owner/name` on GitHub. */
  slug: string;
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged?: boolean;
  /** GitHub's immutable commit identity for the proposal a human reviewed. */
  headSha?: string;
  /** GraphQL node id, used only to enter a repository merge queue. */
  nodeId?: string;
}

export type GithubLandingOwner = 'provider' | 'external' | 'karmax' | 'unowned' | 'merged';

/** One independently scheduled participant in a multi-PR landing saga.  The
 * domain is the canonical remote `(provider repository, target)` identity, not
 * a checkout path: several projects/clones of the same repository must contend
 * for the same fallback admission slot. */
export interface GithubLandingParticipant {
  key: string;
  repo: string;
  slug: string;
  number: number;
  headSha?: string;
  target: string;
  domain: string;
  owner: GithubLandingOwner;
  state: 'ready' | 'queued' | 'waiting' | 'merged';
}

export interface GitHubMergeAuthorization {
  status: 'planned' | 'candidate-ready' | 'merged' | 'queued' | 'waiting' | 'retryable-error' | 'needs-human' | 'needs-authorizer' | 'stale-review' | 'needs-revision';
  prs: TaskPullRequest[];
  /** GitHub user whose token performed or queued the merge. */
  actorUserId?: string;
  sha?: string;
  detail?: string;
  /** Concise provider-owned wait reason for task summaries. Detailed evidence
   * remains in `detail`. */
  waitReason?: string;
  /** Project members whose live GitHub role currently permits a merge request. */
  eligibleUserIds?: string[];
  /** Why landing returned to Do, and whether the already-recorded intent
   * authorization survives an automated repair. */
  repair?: {
    kind: 'conflict' | 'base-moved' | 'ci' | 'changes-requested' | 'head-changed';
    preserveAuthorization: boolean;
    /** Stable identity for one substantive failure observation. Reobserving it
     * cannot consume another automated repair or wake Do again. */
    fingerprint?: string;
  };
  /** This wait depends on GitHub changing externally and must own no Karmax
   * admission lease while it is parked. */
  releaseAdmission?: boolean;
  /** Provider-owned durable queue state. Used by replay-pinned v1.16 landing;
   * v1.17 keeps the karmax target lease through exact-candidate validation and
   * automated repair instead. */
  providerQueue?: { state: 'queued' | 'validating'; entryIds?: string[] };
  /** Which scheduler owns the current wait. Provider/external ownership means
   * no Karmax target lease; fallback ownership keeps only the live mechanical
   * update/check/merge admission turn. */
  landingOwner?: 'provider' | 'external' | 'karmax';
  /** Per-PR ownership is authoritative for current multi-repository workflows;
   * `landingOwner` remains as the single-PR/replay compatibility summary. */
  participants?: GithubLandingParticipant[];
}

/** Human authorization is intent-scoped; integration validation is bound to a
 * disposable exact candidate and is invalidated whenever its head changes. */
export interface TaskLandingState {
  authorization: 'none' | 'authorized' | 'reapproval-required';
  validation: 'none' | 'pending' | 'passed' | 'failed';
  provider: 'none' | 'admitting' | 'queued' | 'validating' | 'ejected';
  authority?: 'provider' | 'external' | 'karmax';
  /** PR identity -> independently scheduled landing participant. */
  participants?: Record<string, GithubLandingParticipant>;
  /** PR identity -> head that received the most recent full Review. */
  authorizedHeads?: Record<string, string>;
  repairAttempts?: number;
  lastRepairFingerprint?: string;
  detail?: string;
}

/**
 * A named bundle of git identity + credentials — the git analogue of an agent
 * config-home account. The record itself carries NO secrets: the three key
 * fields are true/false flags for whether a vault secret exists under the
 * profile's handles (`git:<name>:ssh` / `git:<name>:signing` / `git:<name>:token`).
 * Human development profiles are user-owned and selected by the task creator's
 * default. Organization-scoped records exist separately for service automation.
 */
export interface GitProfile {
  name: string;
  /** git user.name commits are attributed to. */
  userName: string;
  /** git user.email. */
  userEmail: string;
  /** An SSH signing key is stored (worktree-scoped commit.gpgsign, gpg.format=ssh). */
  signingKey?: boolean;
  /** An SSH auth key is stored (injected as GIT_SSH_COMMAND for fetch/push). */
  sshKey?: boolean;
  /** A GitHub token is stored (injected as GH_TOKEN for gh + https pushes). */
  githubToken?: boolean;
  /** GitHub account that owns this inferred human identity. The numeric id is
   * stable across login renames and is also part of GitHub's attributed noreply
   * commit address. */
  github?: { id: string; login: string; name?: string };
  /** Explicit author overrides. Missing fields inherit the connected GitHub
   * account (human profiles) or krmax's neutral automation identity (org
   * profiles). */
  customIdentity?: { userName?: string; userEmail?: string };
  /** An organization may deliberately reuse a member's user-owned profile.
   * This is a live reference, not a secret copy: rotation and revocation remain
   * under that user's control. User-owned profile records never set `source`. */
  source?: { kind: 'user'; userId: string; profile: string };
}

export interface TaskList {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  order: number;
}

/** The persisted index record for a task. The live view comes from the workflow query. */
export interface TaskRecord {
  id: string;
  /** Stable identity of the user's intent. Every alternate execution shares it. */
  intentId?: string;
  /** One-based creation order within the intent. */
  attemptNumber?: number;
  /**
   * Simple, human-facing sequential id, numbered PER PROJECT (SPEC §10.6): each
   * project's queued tasks run #1, #2, …, assigned when first queued. Drafts that
   * have never been queued have no number. The UI displays `#num` and
   * the URL scheme uses it (`/projects/<name>/tasks/<num>`); the opaque `id` above
   * stays the canonical key (it is the Temporal workflowId, event key, and session
   * key, so it must never change).
   */
  num?: number;
  projectId: string;
  listId: string;
  title: string;
  workflow: string; // workflow definition name
  /**
   * Workflow definition that started the current Temporal execution. Normally
   * identical to `workflow`; it stays fixed while a compatible workflow mode
   * (software-dev ↔ goal) changes in-flight, preserving the real replay pin.
   */
  executionWorkflow?: string;
  workflowVersion: string; // pinned at creation (SPEC §4.4)
  params: TaskParams;
  createdAt: number;
  order: number;
  parentTaskId?: string;
  /** Immutable creator provenance. */
  createdBy?: PrincipalRef;
  /** One accountable actor; assignment never grants project access. */
  assignee?: PrincipalRef;
  /** Optional executing agent while a human remains accountable. */
  delegate?: PrincipalRef;
  /** Explicit principals allowed/required to decide at Review. */
  confirmationPolicy?: ConfirmationPolicy;
  /** Materialized subscribers. Team expansion happens when an event is emitted. */
  subscribers?: PrincipalRef[];
  /** Resolved human review audience for search/UI; recalculated from policy. */
  reviewers?: string[];
  /**
   * Free-form human notes about the task (SPEC §10). Purely cosmetic — shown only
   * in the UI and never assembled into any agent prompt. The human jots whatever
   * they want here; it has no effect on workflow execution.
   */
  notes?: string;
  /**
   * Tag ids applied to this task (task organization — labels + topics). Persisted in
   * the `task_tags` join table and hydrated onto the record by the store; the tag
   * definitions (name/parent/colour) live in the `tags` table. Purely organizational
   * — never assembled into any agent prompt.
   */
  tags?: string[];
  /** Last view snapshot, refreshed opportunistically so terminal/parked tasks list cheaply. */
  lastView?: TaskView;
}

export interface TaskParams {
  prompt: string;
  /** Images attached to the initial prompt (references, never inline bytes). */
  images?: ImageRef[];
  /** Files made available in the task world (references, never inline bytes). */
  files?: FileRef[];
  /**
   * Wiki pages inlined into this task's agent context, as `[[proj:…]]`/`[[org:…]]`
   * references (a page, a whole `[[proj:tag:<label>]]`, or a folder
   * `[[proj:<section>/*]]`). The task-form "wiki context" field seeds this with
   * both scopes' `tag:default` references so default-labelled pages are inlined; a task
   * opts out by clearing them. Absent (API/quick-add) ⇒ the default tokens apply.
   * Resolved fresh each turn by `buildWikiPromptContext` (SPEC §5.4), UNION any
   * wiki references written inline in the prompt/follow-ups.
   */
  wikiContext?: string[];
  base?: string;
  target?: string;
  /** role -> profile id overrides. */
  profiles?: Record<string, string>;
  /** script-exec command. */
  command?: string;
  /** UI lifecycle: stored-not-queued (draft) / hidden from the default list (archived). */
  draft?: boolean;
  archived?: boolean;
  /**
   * Triggers (generic, workflow-agnostic): gate *when* this task's workflow
   * starts — on other tasks completing, on a schedule, or on any karmax event.
   * A task with triggers is stored-not-started and armed; the dispatcher starts
   * it when its dependency prerequisites and an activation trigger are satisfied
   * (see src/domain/triggers.ts). Kept here (not
   * in a workflow manifest) because a trigger is orthogonal to what the workflow
   * does — the same tier as `draft`.
   */
  triggers?: TaskTrigger[];
  /** Set by the dispatcher: `armed` = waiting on a trigger, `fired` = already started. */
  triggerState?: TriggerState;
  /**
   * Dispatcher bookkeeping for cron catch-up: the scheduled instant (epoch-ms) of
   * the most recent cron occurrence this task has observed, or the moment it was
   * first armed. `nextCronFire` is strictly-after-now, so without a durable mark
   * a window missed while karmax was down would be unrepresentable and silently
   * skipped — `0 9 * * *` would simply lose the day. On boot the dispatcher records
   * one pending activation if an occurrence elapsed between this mark and now (see
   * src/platform/trigger-scheduler.ts). Never sent to any agent.
   */
  triggerLastFiredAt?: number;
  /**
   * Dispatcher bookkeeping: a schedule/event activation occurred but is still
   * waiting for its dependency prerequisites. Durable so a restart cannot lose
   * that occurrence. Never sent to an agent.
   */
  triggerPending?: boolean;
  /**
   * Repeatable "series" (Model A — template + runs). A repeatable task never runs
   * its own workflow; it spawns independent **run** records (each a normal task
   * with its own history) on each trigger fire or "Run again". A cron trigger
   * forces this on. Off (default) = a one-off task that runs exactly once.
   */
  repeatable?: boolean;
  /** Set on a run: the id of the series (repeatable template) it was spawned from. */
  runOf?: string;
  /**
   * Human-assigned importance for organization/sorting (task search & views). A small
   * ordinal, 0=none … 4=urgent (see PRIORITIES). Purely organizational — never sent to
   * any agent. Stored on params (not a dedicated column) so the schema stays stable and
   * it re-resolves at queue time like every other param.
   */
  priority?: number;
  [k: string]: unknown;
}

// ─── Task organization: tags, search queries, saved views (PLAN-search-views) ─
// A view IS a saved query (the Linear/Jira model): every list surface is the result
// of evaluating a `TaskQuery` (filter + full-text + sort + group). The searchable-field
// registry in `src/domain/search.ts` is the single source of truth that the query
// parser, the evaluator, and the UI filter menu all derive from ("declare, don't guess").

/** Ordinal priority levels, low→high. Index is the stored `params.priority` value. */
export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type PriorityName = (typeof PRIORITIES)[number];

/**
 * A tag: a label ("bug", "feature-request") or a topic ("frontend", "auth"), scoped to
 * a project. Tags are hierarchical via `parentId` — selecting a parent in search matches
 * every descendant (Linear label-groups). `kind` separates the conceptual axes so the
 * UI can present them differently: `type` = what-kind-of-work, `topic` = what-area,
 * `flag` = an operational marker (e.g. no-merge).
 */
export interface Tag {
  id: string;
  projectId: string;
  /** Leaf name (unique among siblings within the project). */
  name: string;
  /** Parent tag id for hierarchy; absent ⇒ a root tag. */
  parentId?: string;
  /** Presentation colour (hex or a named swatch key); optional. */
  color?: string;
  /** Which conceptual axis this tag belongs to. */
  kind?: 'type' | 'topic' | 'flag';
  /** Optional guidance shown at the start of this tag's task-list section. */
  description?: string;
  createdAt: number;
}

/** How a filter clause compares the field value(s) to the requested value(s). */
export type FilterOp = 'is' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

/**
 * One filter condition. Clauses are AND-ed together; `values` within a clause are OR-ed
 * (`status:active,waiting`). `negate` flips the whole clause (`-tag:bug`). For number/date
 * fields a comparison op (`gt`/`lt`/…) is used with a single value; for enum/tag/text
 * fields `is`/`contains` with one-or-more values.
 */
export interface FilterClause {
  field: string;
  op: FilterOp;
  values: string[];
  negate?: boolean;
}

/** A sort directive: a searchable-field key + direction. Applied left-to-right (stable). */
export interface SortClause {
  field: string;
  dir: 'asc' | 'desc';
}

/**
 * The complete description of a task list surface: free text + structured filters + sort +
 * group. Search and views are the same thing — a view is just a persisted `TaskQuery`.
 */
export interface TaskQuery {
  /** Free-text match (title / notes / #num). */
  text?: string;
  /** Structured filter clauses, AND-ed. */
  filters?: FilterClause[];
  /** Sort order (first clause primary). Absent ⇒ default (created desc). */
  sort?: SortClause[];
  /** Field key to group rows by (e.g. status, priority, tag, workflow). Absent ⇒ flat. */
  group?: string;
}

/** A named, saved query — the user's custom "view" of a project's tasks. */
export interface SavedView {
  id: string;
  projectId: string;
  name: string;
  query: TaskQuery;
  /** Optional icon/emoji shown in the views sidebar. */
  icon?: string;
  order: number;
  createdAt: number;
}

// ─── The view-model (SPEC §10.2 — the mandatory typed projection) ─────────────

export type Stage =
  | 'setup'
  | 'do'
  | 'review'
  | 'pr'
  | 'merge'
  | 'done'
  | 'resolve'
  | 'escalated'
  | 'cancelled'
  | 'failed';

export type TaskStatus = 'active' | 'waiting' | 'blocked' | 'done' | 'failed' | 'cancelled';

/** A lifecycle destination exposed by the platform. Workflow stages remain the
 * pipeline positions above; `draft` and `human` are cross-cutting platform states. */
export interface StageTransition {
  target: Stage | 'draft' | 'human';
  label: string;
  description?: string;
  danger?: boolean;
}

/**
 * A reference to a user-attached image, stored content-addressed on disk under
 * `$KARMAX_HOME/attachments/<id>` (SPEC — image prompts; PLAN_IMAGE_PROMPTS.md).
 * Deliberately carries NO bytes: only this lightweight handle flows through
 * Temporal workflow input/signals/history. Bytes are resolved back to base64
 * (Claude/OpenAI APIs) or temp files (Codex CLI) at the activity boundary.
 */
export interface ImageRef {
  /** Content hash (sha256, hex) — also the storage filename stem. */
  id: string;
  mediaType: string; // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number;
}

/**
 * A durable reference to an ordinary user upload. The bytes live in Karmax's
 * content-addressed attachment store and are copied into each task world before
 * an agent turn. Keeping the original name here makes the world path useful to
 * humans while the hash keeps storage deduplicated and immutable.
 */
export interface FileRef {
  /** Content hash (sha256, hex) — also the storage filename stem. */
  id: string;
  /** Sanitized basename supplied by the uploader. */
  name: string;
  mediaType: string;
  bytes: number;
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  ts: number;
  /** User-attached images (references, never inline bytes). Absent ⇒ text-only. */
  images?: ImageRef[];
  /** User-attached files materialized into the task world before delivery. */
  files?: FileRef[];
  /**
   * The provider timeline item which already renders this agent reply. Agent
   * output is kept in `Message[]` so a resumed model receives its conversation,
   * while the same output is also kept as an `AgentActivity` for the live UI.
   * Linking the two lets presentation de-duplicate by identity instead of
   * comparing prose (which is brittle across line-ending/format normalization).
   */
  sourceActivity?: { turnId: string; id: string; attempt: number };
}

/**
 * A provider-neutral item in an agent turn. Codex app-server and the Claude
 * Agent SDK both expose work as typed, ordered events; keeping that shape lets
 * clients render a faithful conversation instead of flattening commands, tool
 * calls, edits, and progress into assistant prose.
 *
 * These items are written to the durable Karmax event log by the activity layer
 * (with the event row's timestamp and task id), not into `Message[]`: provider
 * actions are presentation/audit data and must never be replayed to the model as
 * conversation input.
 */
export interface AgentActivity {
  /** Provider item/tool id. Repeated updates with the same id replace in-place. */
  id: string;
  kind: 'message' | 'reasoning' | 'command' | 'file' | 'tool' | 'search' | 'subagent' | 'status' | 'turn' | 'error';
  phase: 'started' | 'updated' | 'completed' | 'failed';
  /** Compact human-facing label, e.g. "Read package.json" or "npm test". */
  title: string;
  /** Optional bounded detail (command output, tool arguments/result, progress). */
  detail?: string;
}

/**
 * A single click-to-verify affordance the reviewer can act on. Review info is a
 * list of these — NOT a prose changelog (that belongs in the conversation). Three
 * primitives:
 *  - `run`  — a shell command executed IN THE TASK'S WORLD (start a server, run an
 *             app or script). A long-lived one (`server: true`) streams logs and can
 *             be stopped; `openUrls` are opened once it's up.
 *  - `open` — open a produced artifact: a world-relative file (PDF, notebook, image,
 *             video) or an absolute URL. No command runs.
 *  - `payment` — approve or deny a durable spend request. The server resolves the
 *                request by id and enforces both task and organization ownership.
 */
export type ReviewActionKind = 'run' | 'open' | 'payment';

export interface ReviewAction {
  kind: ReviewActionKind;
  /** Short button label, e.g. "Start dev server", "Open coverage report". */
  label: string;
  /** `run` only: the exact shell command executed in the task's world. */
  command?: string;
  /** `run` only: the command is a long-lived server/watcher (stream logs + Stop). */
  server?: boolean;
  /** `run` only: URLs to open once the command is up (e.g. a dev server page). */
  openUrls?: string[];
  /** `open` only: world-relative file path OR an absolute URL to open. */
  target?: string;
  /** `payment` only: durable spend request and reviewer operation. */
  requestId?: string;
  operation?: 'approve' | 'deny';
}

export interface ReviewInfo {
  /**
   * Terse orientation — WHAT to verify, not a narrative of what was done. One line.
   * Prose about the work belongs in the conversation/messages, not here. Agent-authored
   * captions are limited to 280 characters at the create_review_info tool boundary.
   */
  caption?: string;
  /** Click-to-verify affordances (SPEC §5.5): the primary review payload. */
  actions?: ReviewAction[];
  /** @deprecated Legacy free-form summary; kept for back-compat rendering only. */
  summary?: string;
  links?: { label: string; url: string }[];
  diff?: string;
  /** Files changed vs base (auto-derived from git so Review always shows them). */
  changedFiles?: string[];
  /** Agent-authored rich HTML, rendered in a sandboxed iframe (§10.2 tier 4). */
  html?: string;
  /**
   * How the Do turn that reached Review actually ended — set by the workflow (NOT the
   * agent), so a reviewer can tell an asserted finish from a silent stall:
   *   - `signalled`: the agent called `signal_completion` → it claims the work is done.
   *   - `finished`:  the provider emitted its verified successful terminal event.
   *   - `stalled`:   legacy v1.0/v1.1 turn ended without signal_completion.
   *   - `raised`:    the agent raised a decision/question to its confirmer.
   * Under a human confirmer all three route to the same gate (see software-dev's Review
   * block), so without this marker the distinction the runtime computes is discarded.
   * See the `signal_completion` note in src/agent/runtime.ts.
   */
  completion?: 'finished' | 'signalled' | 'stalled' | 'raised';
}

export type ActionKind = 'signal' | 'update' | 'query';

export interface ActionArg {
  name: string;
  type: 'string' | 'text' | 'boolean' | 'number' | 'select';
  label?: string;
  required?: boolean;
  options?: string[];
  default?: unknown;
}

// ─── Parameter schema (SPEC §10.4) — drives task forms + settings + defaults ──

export type FieldType = 'text' | 'string' | 'number' | 'boolean' | 'select' | 'list' | 'repoPath' | 'branch' | 'agent' | 'confirmer' | 'responder';
/** Which surfaces a field appears on. */
export type FieldScope = 'task' | 'project' | 'global';
/** Where a resolved value lands in TaskInput (the generic assembler reads this). */
export type FieldBind = 'prompt' | 'top' | 'project' | 'profile' | 'confirm' | 'responder';
/**
 * When a param may be edited after the task is queued (SPEC §4.5/§5.5). This is
 * the single declaration that drives in-flight edits: the workflow validator
 * enforces it, and the UI/gateway derive which fields to expose as editable.
 * - `queue`    — frozen once the workflow starts (draft-only). The default.
 * - `untilUsed`— editable in-flight until the workflow *consumes* it: the target
 *                branch until a PR opens / the merge enqueue; an auxiliary agent
 *                until that role's turn runs. Consumption points are workflow-specific.
 * - `always`   — editable until the point of no return (for values consulted
 *                repeatedly, such as agent tuning and ordinary-input routing).
 * An `untilUsed`/`always` field is only truly live if the workflow actually
 * re-reads it at consumption time; declaring it without re-reading it is a bug.
 */
export type FieldMutable = 'queue' | 'untilUsed' | 'always';

export interface FieldSpec {
  name: string;
  type: FieldType;
  label: string;
  help?: string;
  required?: boolean;
  options?: string[];
  default?: unknown;
  placeholder?: string;
  scopes: FieldScope[];
  bind: FieldBind;
  /** For agent, confirmer, and responder fields — the role this configures. */
  role?: string;
  /** For confirmer/responder fields — the default auxiliary-agent prompt template
   *  the form pre-fills (and inherits back to on reset) when none is stored. */
  promptDefault?: string;
  /** In-flight editability window (SPEC §4.5/§5.5). Omitted ⇒ `queue`. */
  mutable?: FieldMutable;
}

/** A per-use agent override collected by the `agent` field (SPEC §10.5). */
export interface AgentSpec {
  /** Omitted inherits tools; [] explicitly selects no optional connections. */
  mcpConnections?: string[];
  provider: Provider;
  /** Select a durable Avatar. Provider/model remain snapshotted for replay and
   * display, but current turns resolve the owner-controlled prompt + authority
   * from this id and refuse execution when it has been disabled. */
  avatarId?: string;
  /** Internal invocation purpose when an Avatar is answering an authorization
   * or response request rather than filling the workflow role itself. */
  avatarPurpose?: 'authorize' | 'respond';
  /** @deprecated Replay-only. Routing comes from the model id + Credentials policy. */
  modelProvider?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Fork prior context from a task agent, a public share link, a host-local
   * provider conversation id, or an uploaded Codex/Claude conversation file. */
  resumeFrom?: {
    taskId?: string;
    role?: string;
    /** A public chatgpt.com/share / claude.ai/share URL, or a native provider id
     * when the Karmax console is host-local. */
    sessionId?: string;
    upload?: {
      id: string;
      name: string;
      bytes: number;
      format: 'codex' | 'claude-code' | 'claude-export' | 'panagent';
      projectId: string;
    };
  };
}

/**
 * Who drives the Review gate (SPEC §5.2/§5.3): an ordered list of confirm LAYERS,
 * played sequentially each time the task reaches Review. Every layer must approve
 * for the task to proceed to PR/merge; a revise verdict or a follow-up sends the
 * task back to Do, and the next Review replays the sequence from the first layer.
 * Zero layers ⇒ auto-confirm (e.g. "agent review, then a final human confirmation"
 * is `[{ kind: 'agent', … }, { kind: 'human', audience: ['@creator'] }]`;
 * auto-confirm is `[]`).
 *
 * A `human` layer waits for a person to click Confirm. An `agent` layer runs a
 * Confirm-agent turn that reviews the work and returns a structured verdict
 * (confirm / revise / reject) — the same three transitions a human drives; its
 * `AgentSpec` fields configure that agent exactly like any operational agent
 * fields (including `resumeFrom`).
 *
 * The pre-layers single-gate shape ({ mode, …agent }) is still accepted anywhere a
 * ConfirmConfig flows (old stored settings, old drafts, in-flight inputs) and is
 * normalized via confirmLayersOf (domain/confirm.ts): auto ⇒ [], human ⇒ one human
 * layer, agent ⇒ one agent layer.
 */
export type ConfirmMode = 'human' | 'auto' | 'agent';
/** Stable workflow-owned audience selectors. Human-readable names are resolved
 * at the UI edge; workflows persist ids/special selectors so renames are safe. */
export type HumanAudience = string[];
export interface ConfirmLayer extends Partial<AgentSpec> {
  kind: 'human' | 'agent';
  /** Human layers only. Supported selectors are @creator, @all, @owners,
   * @project, @team:<slug>, user:<id>, and legacy team:<id>. Multiple selectors mean any matching
   * person may satisfy this layer; use sequential layers for sequential gates. */
  audience?: HumanAudience;
  /** Agent layers: the review-request message template sent each time the task
   *  reaches Review — optional instructions/guidance ("ensure X, Y and Z"), with
   *  {{prompt}} / {{response}} placeholders for the task prompt and the Do agent's
   *  latest response (see domain/confirm-prompt.ts). Empty ⇒ the built-in default
   *  (CONFIRM_PROMPT_DEFAULT, pre-filled in the form). */
  prompt?: string;
}
export interface ConfirmConfig extends Partial<AgentSpec> {
  /** The ordered Review gates. [] ⇒ auto-confirm. Wins over the legacy `mode`. */
  layers?: ConfirmLayer[];
  /** Legacy single-gate mode (pre-layers shape); read only when `layers` is absent. */
  mode?: ConfirmMode;
  /** Legacy: the single agent gate's review-request template. */
  prompt?: string;
}

/** Who answers an ordinary "Needs input" pause. Unlike the Review route,
 * this is exactly one step: a selected human audience or a response-agent turn.
 * Agent responses are fed back to the working agent as the requested input. */
export interface ResponderConfig extends Partial<AgentSpec> {
  kind: 'human' | 'agent';
  /** Human responder only. Uses the same stable audience selectors as Review. */
  audience?: HumanAudience;
  /** Agent responder only. Optional request template; empty uses the built-in. */
  prompt?: string;
}

/** The Confirm agent's structured verdict at the Review gate. `confirm` proceeds,
 *  `revise` sends the task back to Do (with an optional comment), `reject` cancels. */
export type ConfirmAction = 'confirm' | 'revise' | 'reject';
export interface ConfirmDecision {
  otherAttempts?: 'keep' | 'cancel';
  action: ConfirmAction;
  text?: string;
}

/** A declared action the workflow exposes; auto-rendered as a button/form (§10.2 tier 1). */
export interface DeclaredAction {
  name: string;
  kind: ActionKind;
  label: string;
  enabled: boolean;
  danger?: boolean;
  args?: ActionArg[];
  /** Conversations this action may address. Omitted means every agent role. */
  roles?: AgentRole[];
}

/** The typed projection of a task's state + allowed actions the UI renders. */
export interface TaskView {
  taskId: string;
  /**
   * Human-facing sequential id (SPEC §10.6), mirrored onto the view from the task
   * record by the gateway so the UI can show `#num` and build permalinks. Not
   * produced by the workflow (which only knows the opaque `taskId`).
   */
  num?: number;
  title: string;
  workflow: string;
  /** Compatible workflow modes this execution can adopt without replacing its
   * pinned Temporal workflow. The UI renders these as the in-flight mode picker. */
  workflowOptions?: string[];
  /** False once confirmation / the point of no return has begun. */
  workflowSwitchable?: boolean;
  stage: Stage;
  status: TaskStatus;
  /** Pending credential decisions projected by the gateway. The vault remains
   * the source of truth; workflows do not persist or replay this host state. */
  approvalRequests?: number;
  /**
   * Free-form human notes (cosmetic, UI-only — never sent to any agent). Mirrored
   * onto the view from the task record so the UI can show/edit them at any stage,
   * even for a task not currently in the loaded list. Not produced by the workflow.
   */
  notes?: string;
  messages: Message[];
  /**
   * Per-role conversation transcripts. `messages` above is
   * kept as the Do transcript for back-compat + the live bubble; this carries all
   * roles so the UI can show each — collapsed except the one owning the active
   * stage (SPEC §5.5). Roles with no turns yet are omitted.
   */
  transcripts?: { role: string; label: string; messages: Message[] }[];
  /** Queue-time effective agent selection per role. Added by the platform from
   * its durable execution snapshot, so the UI never has to guess from mutable
   * defaults or from the compact `agent:unified` form representation. */
  agents?: Record<string, AgentSpec>;
  reviewInfo?: ReviewInfo;
  actions: DeclaredAction[];
  /** Mandatory structured state — keeps search/audit/auto-render working (§10.2). */
  state: Record<string, unknown>;
  branch?: string;
  base?: string;
  targetBranch?: string;
  /** Provider-owned world reference. `worldPath` remains as a display/back-compat
   * hint only; gateway operations must resolve this handle through WorldRegistry.
   * The gateway strips this field from public responses. */
  world?: WorldHandleRef;
  /** Safe client projection: whether provider-backed world operations such as a
   * terminal are available. Added by the gateway, not workflow code. */
  worldAvailable?: boolean;
  /** Safe client projection of the selected backend. Provider-owned ids and
   * metadata are intentionally never included. */
  worldProvider?: WorldHandleRef['kind'];
  /** Safe projection indicating that provider-native noVNC check-in exists. */
  worldDesktop?: boolean;
  worldPath?: string;
  /** The primary repo's pull request (remote policy 'pr'); `prs` carries every
   *  repo's, which for a single-repo task is the same one. */
  pr?: TaskPullRequest;
  prs?: TaskPullRequest[];
  /** Every branch this task is opening a pull request for (SPEC §11.1). Present
   *  only for a multi-PR task; a single-branch task keeps `branch`/`prs` alone. */
  checkouts?: TaskCheckout[];
  /** `unreachable` distinguishes "the coordinator could not be queried" from
   *  the identical-looking "position -1 of an empty queue". */
  mergeQueue?: { position: number; total: number; unreachable?: boolean };
  /** Separate proposal authorization and exact integration validation. */
  landing?: TaskLandingState;
  subTasks?: string[];
  parentTaskId?: string;
  error?: string;
  /**
   * What the task is currently parked on, if anything (SPEC §6.2). Surfaced so the
   * UI can show e.g. "Waiting for quota refresh" while a turn waits for a compatible
   * agent login to free up or refresh. Cleared once unparked.
   */
  waitingFor?: { kind: 'account' | 'agentSlot' | 'mergeSlot' | 'github' | 'human' | 'subtask' | 'collaboration' | 'subagent' | 'shell' | 'parent' | 'confirm' | 'responder'; provider?: string; earliestResetAt?: number; detail?: string; summary?: string; audience?: HumanAudience };
  /** Live model-turn admission/execution state, separate from account leasing. */
  agentTurn?: { turnId: string; role: AgentRole; provider?: Provider; state: 'waiting-slot' | 'running' };
  pointOfNoReturnPassed?: boolean;
  /** Authoritative lifecycle moves currently accepted by the platform. This is
   * enriched at the API edge because attempt commitment and terminal execution
   * state live outside an individual workflow's deterministic history. */
  stageTransitions?: StageTransition[];
  /**
   * Task-scope param field names the workflow will accept live edits for right
   * now (SPEC §5.5). Derived from each field's `mutable` window and the current
   * stage; the UI renders these editable and everything else read-only. Enriched
   * by the gateway from the manifest schema (the workflow needn't know its schema).
   */
  editableParams?: string[];
  updatedAt: number;
}

// ─── Agent profiles (SPEC §7.1) ──────────────────────────────────────────────

export interface AuthSource {
  kind: 'none' | 'configHome' | 'apiKeyHandle';
  /** A CODEX_HOME / CLAUDE_CONFIG_DIR directory. */
  configHome?: string;
  /** Credential-broker handle (never a raw key). */
  handle?: string;
  /** Account id for config-home leasing via the account coordinator. */
  account?: string;
}

export interface AgentProfile {
  mcpConnections?: string[];
  id: string;
  name: string;
  provider: Provider;
  /** @internal Resolved leased provider; persisted values are ignored. */
  modelProvider?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  role: AgentRole;
  /** Prompt template path under the content store, or inline text. */
  promptTemplate?: string;
  /** @deprecated Task authorization owns capability selection. Declared agent
   *  roles preserve that grant; persisted profile capability copies are ignored. */
  capabilities?: string[];
  maxTurns?: number;
  /** @deprecated Credentials policy is authoritative; persisted values are ignored. */
  auth?: AuthSource;
  /** @deprecated Credentials policy is authoritative; persisted values are ignored. */
  allowedAccounts?: string[];
}

// ─── Workflow input ──────────────────────────────────────────────────────────

export interface TaskInput {
  taskId: string;
  /** Logical task identity shared by mutually-exclusive attempts. */
  intentId?: string;
  projectId: string;
  /** The workflow this task runs (so activities can read its manifest — roles, agentMcp). */
  workflow?: string;
  title: string;
  /** Epoch milliseconds of the task record; used for the initial chat timestamp. */
  createdAt?: number;
  prompt: string;
  /** Images attached to the initial prompt (references, never inline bytes). */
  images?: ImageRef[];
  /** Files attached to the initial prompt (references, never inline bytes). */
  files?: FileRef[];
  base?: string;
  target?: string;
  /** Existing branch to merge (merge-only workflow). */
  branch?: string;
  command?: string;
  parentTaskId?: string;
  /** Resolved profile ids per role. */
  profiles?: Record<string, string>;
  /** Per-role agent overrides (provider/model/effort/resume) from the task form (§10.5). */
  agents?: Record<string, AgentSpec>;
  /** The Review-gate confirm layers (SPEC §5.2), played in order — each a human
   *  confirmation or a Confirm-agent turn; [] ⇒ auto-confirm. Absent ⇒ one human
   *  layer (or none when the legacy `autoConfirm` flag is set). */
  confirm?: ConfirmConfig;
  /** Single human or agent route for ordinary Waiting-for-input pauses. */
  responder?: ResponderConfig;
  /** A snapshot of project config, captured at creation. */
  project: ProjectConfig;
  /** Capability grant from the spawning principal. */
  grant?: string[];
  /** Principal and job-shaped profile from which `grant` was attenuated. */
  grantPrincipal?: string;
  /** Opaque token-authority provenance for a verified delegated human subject. */
  delegationId?: string;
  authorizationProfile?: string;
  /**
   * Snapshot of the process-wide Resolve-agent flag. It is carried in workflow
   * input so Temporal replay never depends on mutable process state. `undefined`
   * means enabled for historical executions created before the flag existed.
   */
  resolveAgentEnabled?: boolean;
  /**
   * Per-field in-flight editability windows (SPEC §4.5/§5.5), copied from the
   * workflow manifest at assembly time. Lets the deterministic workflow validate
   * live param edits without importing the manifest into the Temporal sandbox.
   * Sparse — only non-`queue` fields are carried; a missing name means `queue`.
   */
  paramWindows?: Record<string, FieldMutable>;
  /**
   * Recovery checkpoint for restarting a failed software-dev execution. A failed
   * Temporal run is terminal, so Retry starts a new run which opens this existing
   * world instead of recreating it (and thereby deleting dirty work). Kept on the
   * generic input for serialization; only software-dev consumes it.
   */
  recovery?: TaskRecoveryCheckpoint;
  /** Platform-internal one-shot reset used when a progressed task is moved back
   * to Draft. The next Setup recreates its branch from base. */
  discardProgress?: boolean;
}

/** Plain serializable world handle + conversation state needed to resume a failed
 * software-dev task. Mirrors world/types without importing Node-facing world code. */
export interface TaskRecoveryCheckpoint {
  world?: WorldHandleRef;
  messages: Message[];
  transcripts?: { role: string; label: string; messages: Message[] }[];
  reviewInfo?: ReviewInfo;
  /** Pull requests already opened for the preserved proposal. */
  prs?: TaskPullRequest[];
  session?: string;
  sessionHome?: string;
  seen?: number;
  target?: string;
  /** Public pipeline position at which a replacement execution should resume. */
  resumeStage?: Stage;
  /** Start parked for a human, retaining `resumeStage` as the return route. */
  pausedForHuman?: boolean;
  /** Exact routing and question for a cross-cutting human hold. This belongs to
   * the checkpoint because the replacement workflow republishes its own view. */
  humanWait?: { audience: string[]; detail: string };
  /** The human already approved the Review represented by this checkpoint.
   * The replacement must still verify that the reopened PR heads match. */
  reviewConfirmed?: boolean;
  /** Multi-PR Review approvals (checkout name -> approved head sha). Carried so a
   *  replacement execution does not make a human re-approve branches nothing has
   *  touched; an approval whose branch moved lapses on its own either way. */
  checkoutApprovals?: Record<string, string>;
  /** Landing state carried across replacement executions and manual stage moves. */
  landing?: TaskLandingState;
  /** The preserved intent-authorized proposal changed in Do and needs an
   * automatic integration review before provider re-admission. */
  repairValidationPending?: boolean;
}

// ─── Events (SPEC §5 — typed, namespaced, schema-declared) ───────────────────

export interface KarmaxEvent {
  type: string; // e.g. "software-dev.stage-changed"
  taskId: string;
  ts: number;
  payload: Record<string, unknown>;
}

// ─── Sub-task hierarchy (raise-to-parent) ────────────────────────────────────
// A child task doesn't block on a hidden human at Review/Escalation; it RAISES a
// typed event to its parent, whose Do agent decides. The parent's decision maps
// onto the SAME state transitions a human would drive (confirm/retry/cancel/
// follow-up), so "the parent as confirmer" is literal (SPEC §5.2/§5.3).

/** Why a child is asking its parent to act. */
export type RaiseType = 'needs_confirmation' | 'needs_info' | 'needs_permission' | 'blocked';

/** Signal a child sends UP to its parent when it reaches a decision point. */
export interface ChildRaise {
  childTaskId: string;
  childTitle: string;
  type: RaiseType;
  detail?: string;
}

/** How a parent's Do agent answers a child raise (the `respond_to_sub_task` tool). */
export type SubTaskAction = 'open_pr' | 'confirm' | 'comment' | 'retry' | 'cancel';

/** Signal a parent sends DOWN to a child in response to a raise. */
export interface ParentResponse {
  action: SubTaskAction;
  text?: string;
}

/** A parent-agent response emitted in a turn. `childTaskId` omitted ⇒ all children
 *  currently awaiting a response (the common "confirm my sub-tasks" case). */
export interface SubTaskResponse {
  childTaskId?: string;
  action: SubTaskAction;
  text?: string;
}

/** A child-agent's explicit request up to its parent (the `raise_to_parent` tool). */
export interface RaiseToParent {
  type: RaiseType;
  detail?: string;
}
