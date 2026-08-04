import type { Client } from '@temporalio/client';
import { Context as activityContext } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { classifyProviderTurnError, isTransportError, isResourceKill, type LimitClassification } from '../agent/limits.js';
import { hostStats, hostMemoryTight } from './agent-slots.js';
import { Store } from '../store/db.js';
import { WorldRegistry } from '../world/registry.js';
import { World, WorldHandle, WorldKind, worldWorkingDirectory } from '../world/types.js';
import { finalizeMerge, MergeResult } from '../world/merge.js';
import { applyAgentSpec, ProfileResolver } from '../agent/profiles.js';
import {
  apiKeyEnv,
  canonicalModelProvider,
  credentialAliases,
  credentialMatchesProfile,
  credentialProvider,
  MODEL_PROVIDERS,
  modelProviderFromModel,
} from '../agent/provider-registry.js';
import { AgentAdapter } from '../agent/types.js';
import { KARMAX_RUNTIME_PROTOCOL, runRuntimeTurn } from '../agent/runtime.js';
import { acquireAgentSlot, awaitAgentResources, AgentResourcesUnavailableError } from './agent-slots.js';
import { assemblePrompt } from '../agent/prompt.js';
import { GLOBAL_INSTRUCTIONS } from '../agent/instructions.js';
import { autoResolve as runAutoResolve } from '../resolve/cases.js';
import { KarmaxBus } from '../contrib/bus.js';
import { TokenAuthority } from '../platform/tokens.js';
import { CredentialBroker } from '../autonomy/broker.js';
import { VaultItems } from '../autonomy/vault-items.js';
import { PermissionRequests } from '../platform/permission-requests.js';
import { GitProfiles, userGitScope } from '../autonomy/git-profiles.js';
import { worldRepos, worldRepoSource, worldRepoTarget } from '../world/types.js';
import { git as hostGit, isolatedGitEnvironment } from '../world/git.js';
import { brokerFinalizeMerge, brokerPublishBranch, brokerPushBranches, describePublishFailures, type GitBrokerAuth } from '../world/git-broker.js';
import { materializeGitCredential } from '../world/git-credential.js';
import {
  GithubApiError,
  GithubPrApi,
  githubSlug,
  type GithubPrApiOptions,
  type GithubPullRequestReadiness,
} from '../integrations/github-pr.js';
import type { GitHubRepositoryPermission } from '../integrations/github-app.js';
import { cloudGitSource } from '../world/cloud-source.js';
import { PaymentProvider, PaymentRegistry, BudgetService } from '../autonomy/payments.js';
import { fillViaCdp } from '../autonomy/fill.js';
import { fillCardInWorld, BILLING_FIELDS } from '../autonomy/card-fill.js';
import { tokenToInject } from '../autonomy/config-homes.js';
import { materializeFork } from '../agent/fork.js';
import { materializeRemoteSession } from '../agent/remote-process.js';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from '../config/paths.js';
import { ensureProjectWikiRepository, PROJECT_WIKI_BRANCH } from '../wiki/repository.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, roleCeiling } from '../contrib/manifests.js';
import { allows, attenuate } from '../platform/capabilities.js';
import { Provider, Message, TaskInput, TaskView, AgentRole, type Repository, type TaskPullRequest,
  type GitHubMergeAuthorization } from '../domain/types.js';
import { newId } from '../util/id.js';
import { SIG_AGENT_TURN_STATE } from '../workflows/names.js';
import { destroyWorldServices } from '../world/services.js';
import { sameRepository } from '../world/repository-identity.js';
import { activateProjectRuntime, selectProjectEnvironment } from '../world/project-runtime.js';
import {
  AGENT_QUEUE_WORKFLOW,
  SIG_CANCEL_AGENT,
  SIG_LEASE_AGENT,
  SIG_RELEASE_AGENT,
  SIG_SET_AGENT_CAPACITY,
  UPD_WAIT_AGENT,
  agentQueueId,
} from '../coordinators/names.js';

// Old executions without a recorded grant retain the normal developer workflow
// surface (but no administration). New tasks always carry a creator-attenuated
// stored grant, so this compatibility path disappears as legacy runs finish.
const DEFAULT_GRANT = [
  'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
  'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
];

// A confirmer belongs to a logical task, so sibling attempts must not review in
// parallel against divergent copies of its conversation. The worker is the
// single activity host in v1; this keyed FIFO serializes those turns while each
// Temporal activity remains independently retryable.
const confirmLocks = new Map<string, { held: boolean; waiters: Array<() => void> }>();
async function acquireConfirmLock(key: string): Promise<() => void> {
  let lock = confirmLocks.get(key);
  if (!lock) {
    lock = { held: false, waiters: [] };
    confirmLocks.set(key, lock);
  }
  if (lock.held) await new Promise<void>((resolve) => lock!.waiters.push(resolve));
  else lock.held = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = lock!.waiters.shift();
    if (next) next();
    else {
      lock!.held = false;
      confirmLocks.delete(key);
    }
  };
}

/**
 * Tag a thrown turn error for Temporal's retry policy (the `turns` proxy in the
 * workflows) — see src/workflows/failures.ts for the taxonomy. Original
 * messages are preserved verbatim for display, while provider failure metadata
 * rides in ApplicationFailure.details for account rotation and auto-resolve.
 */
function classifyTurnError(err: unknown, provider?: Provider): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err : undefined;
  // Admission happens before a provider process exists. Temporal coordinator
  // backpressure/outages therefore cannot be an agent error and must retain
  // their retryable infrastructure classification through this outer boundary.
  if (err instanceof AgentAdmissionInfrastructureError || err instanceof AgentResourcesUnavailableError) {
    return ApplicationFailure.create({ message: msg, type: 'agent-infra', nonRetryable: false, cause });
  }
  const { classification: cls, metadata } = classifyProviderTurnError(err, provider);
  if (cls.limited) {
    return ApplicationFailure.create({
      message: msg,
      type: 'agent-limit',
      nonRetryable: true,
      cause,
      ...(metadata ? { details: [metadata] } : {}),
    });
  }
  // A signal-9/SIGKILL agent death is environmental, not a code bug (karmax#4):
  // classify it as retryable 'agent-infra' with an ACTIONABLE message — the raw
  // "terminated by signal SIGKILL" tells an operator nothing. Temporal re-runs the
  // turn and the retry re-enters the host-admission gate (acquireAgentSlot) and
  // resumes the interrupted session. isResourceKill is the shared predicate
  // (src/agent/limits.ts) the software-dev auto-resolve task reuses.
  if (isResourceKill(msg)) return ApplicationFailure.create({ message: signalKillMessage(msg), type: 'agent-infra', nonRetryable: false, cause });
  if (isTransportError(msg)) return ApplicationFailure.create({ message: msg, type: 'agent-infra', nonRetryable: false, cause });
  return ApplicationFailure.create({ message: msg, type: 'agent-error', nonRetryable: true, cause });
}

class AgentAdmissionInfrastructureError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`agent-slot admission failed: ${detail}`, { cause: cause instanceof Error ? cause : undefined });
    this.name = 'AgentAdmissionInfrastructureError';
  }
}

/**
 * Turn an opaque SIGKILL into an operator-actionable line — WITHOUT asserting a
 * cause the evidence doesn't support. A signal-9 agent death has very different
 * senders on this single-host deployment, and the message must not name one when
 * another is true (karmax#4 diagnosis, 2026-07: the observed kills were karmax's
 * OWN reapOrphans() sweep after a tsx-watch reload — journalctl -k and
 * systemd-oomd logged zero kills — NOT the kernel OOM killer; 2026-07-12: a
 * dogfooding karmax booted from a task world swept prod's LIVE agents — since
 * fixed, reapOrphans now skips records whose owner process is alive). So branch
 * on LIVE host memory:
 *   - memory genuinely tight → likely the OS OOM killer; the operator should
 *     reduce concurrency / free RAM (and the gated retry waits for RAM to recover).
 *   - memory healthy → NOT OOM; most likely a karmax restart/reload/redeploy
 *     tearing down in-flight turns (orphan-sweep or shutdown escalation,
 *     src/agent/custody.ts) or an external kill. The retry admits immediately
 *     and resumes the session.
 * Either way the raw signal string is appended (truncated) for diagnostics.
 */
const pexec = promisify(execFile);

function signalKillMessage(raw: string): string {
  const h = hostStats();
  const mem = `${h.freeMemMb}MB free of ${h.totalMemMb}MB (${h.usedMemPct}% used, load ${h.loadPerCore}/core)`;
  const diagnosis = hostMemoryTight()
    ? `host out of memory — the agent was likely killed by the OS OOM killer (${mem}). ` +
      `Reduce Concurrent agent turns in Global settings (or raise KARMAX_AGENT_MIN_FREE_MB), or free RAM.`
    : `host memory is healthy (${mem}), so this is NOT an OOM kill — most likely a krmax ` +
      `restart/reload/redeploy tearing down in-flight turns (orphan-sweep or shutdown escalation) or an external kill.`;
  return `agent turn interrupted by SIGKILL: ${diagnosis} Retrying with session resume. [signal: ${raw.slice(0, 200)}]`;
}

export interface CoreActivityDeps {
  store: Store;
  worlds: WorldRegistry;
  adapters: Map<Provider, AgentAdapter>;
  profiles: ProfileResolver;
  client?: Client;
  taskQueue?: string;
  bus?: KarmaxBus;
  globalInstructions?: string;
  tokens?: TokenAuthority;
  broker?: CredentialBroker;
  githubApp?: import('../integrations/github-app.js').GitHubAppService;
  /** GitHub REST endpoint/transport override for pull-request operations (tests). */
  githubPr?: GithubPrApiOptions;
  checkpoints?: import('../world/checkpoint.js').WorldCheckpointService;
  runners?: import('../world/runners.js').RunnerPoolService;
  payments?: PaymentProvider;
  paymentRegistry?: PaymentRegistry;
  configHomes?: import('../autonomy/config-homes.js').ConfigHomeManager;
  resources?: import('../world/resources.js').ProjectResourceService;
  contentDir?: string;
}

/** What the PR stage puts on the pull request it opens for the task. */
export interface OpenPrDetails {
  title?: string;
  /** Human-facing summary of the work — normally the task's review info. */
  summary?: string;
}

/** The PR description: the task's own summary, plus the provenance line that
 *  correlates the pull request back to the karmax task (also what the webhook
 *  dispatcher's branch matching relies on being true). */
function prBody(handle: WorldHandle, details: OpenPrDetails, num?: number, repoName?: string): string {
  const summary = details.summary?.trim() || '_No review summary was recorded for this task._';
  const task = num != null ? `karmax task #${num} (\`${handle.id}\`)` : `karmax task \`${handle.id}\``;
  return `${summary}\n\n---\n${task} · branch \`${handle.branch}\`${repoName ? ` · repo \`${repoName}\`` : ''}`;
}

export interface CreateWorldArgs {
  taskId: string;
  projectId?: string;
  repo?: string;
  /** Source repos for a multi-repo world; takes precedence over `repo`. */
  repos?: string[];
  base: string;
  target?: string;
  branch?: string;
  resetBranch?: boolean;
  copyGlobs?: string[];
  /** Multi-PR task: nest the checkouts so branches added later have somewhere
   *  to live inside the world boundary (SPEC §11.1). */
  multiPr?: boolean;
  kind: WorldKind;
  /** The project's git profile selection (PLAN-git-config.md §3); the activity
   *  resolves it (project → global default) and materializes identity/signing. */
  gitProfile?: string;
}

async function acquireWorkflowAgentSlot(args: {
  client: Client;
  taskQueue: string;
  store: Store;
  taskId: string;
  turnId: string;
  role: string;
  provider?: string;
  title?: string;
  projectId?: string;
  heartbeat?: () => void;
  signal?: AbortSignal;
}): Promise<() => Promise<void>> {
  const saved = Number(args.store.getSettings('global', 'agent-queue')?.capacity);
  const capacity = Number.isFinite(saved) && saved > 0
    ? Math.floor(saved)
    : 3;
  const id = agentQueueId();
  await args.client.workflow.signalWithStart(AGENT_QUEUE_WORKFLOW, {
    workflowId: id,
    taskQueue: args.taskQueue,
    args: [{ capacity }],
    signal: SIG_LEASE_AGENT,
    signalArgs: [{ taskId: args.taskId, turnId: args.turnId, role: args.role, provider: args.provider, title: args.title, projectId: args.projectId }],
  });
  await args.client.workflow.getHandle(id).signal(SIG_SET_AGENT_CAPACITY, { capacity });
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  try {
    if (args.signal?.aborted)
      throw args.signal.reason instanceof Error ? args.signal.reason : new Error('agent queue wait cancelled');
    // Keep the long-running activity lease alive while one durable Workflow
    // Update waits for promotion. This creates O(waiters), not O(waiters × time),
    // Temporal requests and cannot fill the consistent-query buffer.
    heartbeatTimer = setInterval(() => {
      try { args.heartbeat?.(); } catch { /* activity cancellation is handled below */ }
    }, 10_000);
    heartbeatTimer.unref?.();
    const admission = args.client.workflow.getHandle(id).executeUpdate(UPD_WAIT_AGENT, {
      args: [{
        taskId: args.taskId,
        turnId: args.turnId,
        role: args.role,
        provider: args.provider,
        title: args.title,
        projectId: args.projectId,
      }],
    }) as Promise<boolean>;
    let removeAbortListener = () => {};
    const granted = await (args.signal
      ? Promise.race([
          Promise.resolve(admission),
          new Promise<never>((_, reject) => {
            const abort = () => reject(args.signal!.reason instanceof Error
              ? args.signal!.reason
              : new Error('agent queue wait cancelled'));
            args.signal!.addEventListener('abort', abort, { once: true });
            removeAbortListener = () => args.signal!.removeEventListener('abort', abort);
          }),
        ]).finally(() => removeAbortListener())
      : Promise.resolve(admission));
    if (!granted) throw new Error('agent queue lease was cancelled before admission');
  } catch (e) {
    await args.client.workflow.getHandle(id).signal(SIG_CANCEL_AGENT, { taskId: args.taskId, turnId: args.turnId }).catch(() => undefined);
    if (args.signal?.aborted) throw e;
    throw new AgentAdmissionInfrastructureError(e);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await args.client.workflow.getHandle(id).signal(SIG_RELEASE_AGENT, { taskId: args.taskId, turnId: args.turnId }).catch(() => undefined);
  };
}

export interface RunAgentTurnArgs {
  taskId: string;
  role: AgentRole;
  worldHandle: WorldHandle;
  messages: Message[];
  session?: string;
  /** How many leading `messages` the resumed `session` already holds — forwarded to
   *  the adapter so a resumed turn sends only the delta, not the whole transcript. */
  deliveredMessages?: number;
  task: TaskInput;
  bindings?: Record<string, string>;
  explicitProfileId?: string;
  /** Config home leased by the account coordinator for this turn (SPEC §6.2). */
  accountConfigHome?: string;
  /** Kind of credential leased; distinguishes an environment key/ambient login. */
  accountCredentialKind?: 'login' | 'ambient' | 'key';
  /** Model/API provider of the exact credential leased by the coordinator. */
  accountCredentialProvider?: string;
  /** Broker API-key handle leased by the coordinator for this turn (a `key:handle:*`
   * credential); resolved JIT and overrides the auth. Env keys carry no handle —
   * they fall through to the adapter's env credential. */
  accountApiKeyHandle?: string;
  /** Workflow-generated id used to correlate live admission/running signals. */
  agentTurnId?: string;
  /** Current workflow versions acquire/release the durable queue lease themselves. */
  agentSlotGranted?: boolean;
  /** Current workflow versions own admission, including the remote-rail exemption. */
  agentAdmissionManaged?: boolean;
}

export interface PrepareChildArgs {
  parentTaskId: string;
  projectId: string;
  title: string;
  prompt: string;
  base?: string;
  target?: string;
  project: TaskInput['project'];
  profiles?: Record<string, string>;
  resolveAgentEnabled?: boolean;
  /** The parent's world branch — the child's merge cap is scoped to exactly this
   *  (SPEC §8.2). The parent owns this branch, so it may grant merge into it. */
  parentBranch?: string;
  /** The parent's own capability grant; the child's delegation caps are attenuated
   *  by it (a restricted parent can't over-grant). Merge is scoped separately. */
  parentGrant?: string[];
}

/** Side-effecting activities the workflows drive (SPEC §3.1). */
export function makeCoreActivities(deps: CoreActivityDeps) {
  const { store, worlds, profiles } = deps;
  const isRemote = (kind: WorldKind) => worlds.get(kind).capabilities?.remote === true;

  const organizationGitProfilesFor = (projectId?: string) => new GitProfiles(
    store,
    deps.broker,
    paths().state,
    (projectId ? store.getProject(projectId)?.organizationId : undefined) ?? 'org_personal',
  );

  const gitProfilesForScope = (scope: string) => new GitProfiles(store, deps.broker, paths().state, scope);
  const activeGithubAccountId = (userId: string) => typeof deps.githubApp?.activeUserAccountId === 'function'
    ? deps.githubApp.activeUserAccountId(userId) : undefined;

  const taskGithubAccountId = (taskId: string): string | undefined => {
    const seen = new Set<string>();
    let task = store.getTask(taskId);
    while (task && !seen.has(task.id)) {
      seen.add(task.id);
      const accountId = task.params?._githubAccountId;
      if (typeof accountId === 'string' && /^\d+$/.test(accountId)) return accountId;
      task = task.parentTaskId ? store.getTask(task.parentTaskId) : undefined;
    }
    return undefined;
  };

  /** Development follows the human creator, never the tenant. Organization Git
   * remains the fallback for system/automation tasks that have no human owner and
   * for historical task-less activity calls used by older workflow histories. */
  const developmentGitBinding = (taskId: string, projectId?: string, requestedProfile?: string) => {
    const userId = store.taskCreatorUserId(taskId);
    if (userId) {
      const scope = userGitScope(userId);
      const profiles = gitProfilesForScope(scope);
      const accountId = taskGithubAccountId(taskId) ?? activeGithubAccountId(userId);
      return { scope, profiles, profile: accountId ? profiles.githubProfile(accountId) : profiles.resolve(undefined), userId, accountId };
    }
    const profiles = organizationGitProfilesFor(projectId);
    const organizationId = (projectId ? store.getProject(projectId)?.organizationId : undefined) ?? 'org_personal';
    const configured = profiles.resolve({ gitProfile: requestedProfile });
    return { scope: organizationId, profiles,
      profile: configured ?? profiles.automationIdentity() ?? profiles.saveAutomationIdentity({}) };
  };

  const gitBindingFromHandle = (handle: WorldHandle, taskId?: string) => {
    const profileName = handle.meta?.gitProfile;
    const scope = handle.meta?.gitProfileScope;
    if (typeof profileName === 'string' && profileName && typeof scope === 'string' && scope) {
      const profiles = gitProfilesForScope(scope);
      return { scope, profiles, profile: profiles.get(profileName) };
    }
    const projectId = typeof handle.meta?.projectId === 'string'
      ? handle.meta.projectId
      : taskId ? store.getTask(taskId)?.projectId : undefined;
    return developmentGitBinding(taskId ?? handle.id, projectId,
      typeof profileName === 'string' ? profileName : undefined);
  };

  function record(taskId: string, type: string, payload: Record<string, unknown>) {
    const ev = { type, taskId, ts: Date.now(), payload };
    const seq = store.appendEvent(ev);
    deps.bus?.emit({ ...ev, seq });
  }

  /** JIT env for remote git/gh operations in this world (PLAN-git-config.md §4B):
   *  the world's user-owned git profile (stamped on the handle at creation) →
   *  GIT_SSH_COMMAND / GH_TOKEN, per subprocess. Only legacy worlds without a
   *  human owner retain host fallback. */
  function gitEnvFor(handle: WorldHandle, taskId?: string): Record<string, string> {
    const binding = gitBindingFromHandle(handle, taskId);
    const fallback = binding.scope === 'org_personal' ? {} : isolatedGitEnvironment();
    if (!binding.profile) return fallback;
    try {
      return { ...fallback, ...binding.profiles.env(binding.profile, { taskId }) };
    } catch {
      return fallback;
    }
  }

  /** The project-enrolled GitHub repository behind a PR slug. Enrollment is the
   * authority boundary: a user's OAuth grant must not turn an arbitrary origin
   * mentioned by a task into an authorized repository. */
  function enrolledGithubRepository(projectId: string | undefined, slug: string): Repository | undefined {
    if (!projectId) return undefined;
    const linked = store.listProjectRepositories(projectId).map((entry) => entry.repository);
    const wiki = store.projectWiki(projectId)?.repository;
    return [...linked, ...(wiki ? [wiki] : [])]
      .find((candidate) => `${candidate.owner}/${candidate.name}`.toLowerCase() === slug.toLowerCase());
  }

  /** Resolve a local or remote checkout back to its enrolled repository. Local
   * worktrees retain a filesystem source, so their configured origin supplies
   * the network identity used for the lookup. */
  async function enrolledRepositoryForCheckout(handle: WorldHandle, repo: ReturnType<typeof worldRepos>[number]): Promise<Repository | undefined> {
    const projectId = typeof handle.meta?.projectId === 'string'
      ? handle.meta.projectId
      : store.getTask(handle.id)?.projectId;
    if (!projectId) return undefined;
    const linked = store.listProjectRepositories(projectId).map((entry) => entry.repository);
    const wiki = store.projectWiki(projectId)?.repository;
    const candidates = [...linked, ...(wiki ? [wiki] : [])];
    for (const source of [worldRepoSource(repo), repo.repo, repo.source].filter((value): value is string => Boolean(value))) {
      const found = candidates.find((candidate) => sameRepository(candidate.sshUrl, source));
      if (found) return found;
    }
    if (repo.localPath) {
      const catalog = store.listRepositories(store.getProject(projectId)?.organizationId ?? 'org_personal');
      const found = [worldRepoSource(repo), repo.repo, repo.source]
        .filter((value): value is string => Boolean(value))
        .flatMap((source) => catalog.filter((candidate) => sameRepository(candidate.sshUrl, source)))[0];
      if (found) return found;
    }
    if (!isRemote(handle.kind)) {
      const origin = await hostGit(repo.root, ['config', '--get', 'remote.origin.url']);
      if (origin.code === 0) {
        const found = candidates.find((candidate) => sameRepository(candidate.sshUrl, origin.stdout.trim()));
        if (found) return found;
        // A configured local checkout is itself a project authority. It may
        // predate first-class project repository attachments, but if its origin
        // exactly matches a repository exposed by this organization's GitHub
        // App installation, use that installation instead of falling back to
        // the host's SSH agent/PAT.
        const catalog = store.listRepositories(store.getProject(projectId)?.organizationId ?? 'org_personal');
        return catalog.find((candidate) => sameRepository(candidate.sshUrl, origin.stdout.trim()));
      }
    }
    return undefined;
  }

  /** Run one trusted host-side Git operation with the enrolled repository's
   * short-lived installation credential. The caller's profile/host env remains
   * the compatibility path for sources outside the App catalog. */
  async function hostGitWithRepositoryCredential(
    repository: Repository | undefined,
    cwd: string,
    args: string[],
    fallbackEnv: Record<string, string>,
  ) {
    if (!repository?.gitConnectionId || !deps.githubApp) return hostGit(cwd, args, { env: fallbackEnv });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-auth-'));
    try {
      const credential = await deps.githubApp.brokerCredentials(repository);
      const materialized = materializeGitCredential(directory, {
        ...credential,
        env: { ...isolatedGitEnvironment(), ...(credential.env ?? {}) },
      });
      return await hostGit(cwd, args, { env: materialized.env });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  /** Static-token compatibility for PR operations. Human work first resolves
   * its refreshable App user authorization in prApiFor(); this fallback retains
   * manually managed profiles, organization automation, and legacy host login. */
  async function githubTokenFor(
    handle: WorldHandle,
    slug: string,
    authorizedRepository?: Repository,
  ): Promise<string | undefined> {
    const projectId = typeof handle.meta?.projectId === 'string'
      ? handle.meta.projectId
      : store.getTask(handle.id)?.projectId;
    const env = gitEnvFor(handle, handle.id);
    if (env.GH_TOKEN) return env.GH_TOKEN;
    // A human task must never silently open its PR as the organization App.
    // Transport may use the installation, but authorship is the person's App
    // authorization (handled above), a manual profile fallback, or a setup error.
    if (gitBindingFromHandle(handle, handle.id).scope.startsWith('user:')) return undefined;
    if (projectId && deps.githubApp) {
      const repository = authorizedRepository ?? enrolledGithubRepository(projectId, slug);
      const connection = repository?.gitConnectionId ? store.getGitConnection(repository.gitConnectionId) : undefined;
      if (connection) return await deps.githubApp.installationToken(connection);
    }
    // `isolatedGitEnvironment()` blanks GH_TOKEN: an organization without a
    // credentialed profile fails closed rather than borrowing the host's login.
    if ('GH_TOKEN' in env) return undefined;
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    try {
      const { stdout } = await pexec('gh', ['auth', 'token'], { timeout: 15_000 });
      return stdout.trim() || undefined;
    } catch { return undefined; }
  }

  async function prApiFor(
    handle: WorldHandle,
    slug: string,
    checkout?: ReturnType<typeof worldRepos>[number],
  ): Promise<GithubPrApi> {
    const projectId = typeof handle.meta?.projectId === 'string'
      ? handle.meta.projectId
      : store.getTask(handle.id)?.projectId;
    const userId = store.taskCreatorUserId(handle.id);
    const accountId = taskGithubAccountId(handle.id) ?? (userId ? activeGithubAccountId(userId) : undefined);
    let repository = enrolledGithubRepository(projectId, slug);
    if (!repository && checkout) {
      const candidate = await enrolledRepositoryForCheckout(handle, checkout);
      if (`${candidate?.owner}/${candidate?.name}`.toLowerCase() === slug.toLowerCase()) repository = candidate;
    }
    // Connected development uses the SAME deployment App in two distinct
    // capacities: its installation owns repository transport, while this
    // per-user OAuth grant makes the PR attributable to the task creator.
    if (userId && repository?.gitConnectionId && deps.githubApp?.status(userId).userAuthorized) {
      return new GithubPrApi(
        (options) => deps.githubApp!.userAccessToken(userId, { ...options, ...(accountId ? { accountId } : {}) }),
        deps.githubPr ?? {},
      );
    }
    const token = await githubTokenFor(handle, slug, repository);
    if (!token) {
      if (userId && repository?.gitConnectionId && deps.githubApp?.status(userId).oauthConfigured) {
        throw new Error('Connect GitHub on your profile, then try again.');
      }
      throw new Error(`Your GitHub account cannot access ${slug}. Grant it access on GitHub, then reconnect GitHub on your profile.`);
    }
    return new GithubPrApi(token, deps.githubPr ?? {});
  }

  /** A merge is always attributed to the consenting human selected below. It
   * never falls back to an installation token or an unrelated host credential. */
  function prApiForUser(userId: string, accountId?: string): GithubPrApi {
    if (!deps.githubApp) throw new Error('GitHub integration is unavailable');
    return new GithubPrApi(
      (options) => deps.githubApp!.userAccessToken(userId, { ...options, ...(accountId ? { accountId } : {}) }),
      deps.githubPr ?? {},
    );
  }

  /** Each world repo that a pull request can be opened against. A repo without
   *  a GitHub origin is recorded and skipped — a project may legitimately mix a
   *  GitHub repo with a local-only one. */
  async function githubPrTargets(world: World, handle: WorldHandle):
  Promise<{ repo: ReturnType<typeof worldRepos>[number]; slug: string; api: GithubPrApi }[]> {
    const targets = [];
    for (const repo of worldRepos(world.handle)) {
      // The *configured* origin URL, not `remote get-url`: that one applies the
      // host's `insteadOf` rewrites, which are a transport detail (mirrors,
      // ssh-for-https) and can hide the github.com identity the PR is keyed on.
      const origin = await world.exec('git', ['config', '--get', 'remote.origin.url'], { cwd: repo.root });
      const slug = githubSlug(worldRepoSource(repo)) ?? (origin.code === 0 ? githubSlug(origin.stdout.trim()) : undefined);
      if (!slug) {
        record(handle.id, 'pr.skipped', { repo: repo.name, reason: 'no GitHub origin remote' });
        continue;
      }
      targets.push({ repo, slug, api: await prApiFor(handle, slug, repo) });
    }
    return targets;
  }

  /** Publish each changed repo's task branch to origin so its PR can reference it. */
  async function pushTaskBranches(
    world: World,
    handle: WorldHandle,
    env: Record<string, string>,
    repos: ReturnType<typeof worldRepos>,
  ) {
    if (isRemote(handle.kind)) return brokerPushBranches(world, brokerAuthFor(handle, handle.id), repos);
    const pushed: string[] = [];
    const skipped: string[] = [];
    const errors: Record<string, string> = {};
    for (const repo of repos) {
      const repository = await enrolledRepositoryForCheckout(handle, repo);
      // GitHub App installation tokens are short-lived HTTPS credentials. Use
      // them from the trusted host even for a local/container worktree, so a
      // connected repository never needs the person's SSH private key or PAT.
      const push = repository?.gitConnectionId && deps.githubApp
        ? await hostGitWithRepositoryCredential(repository, repo.root, ['push', '-u', 'origin', repo.branch], env)
        : await world.exec('git', ['push', '-u', 'origin', repo.branch],
          { cwd: repo.root, env: { GIT_TERMINAL_PROMPT: '0', ...env } });
      if (push.code === 0) pushed.push(repo.name);
      else {
        skipped.push(repo.name);
        errors[repo.name] = (push.stderr || push.stdout).slice(0, 300);
      }
    }
    return { pushed, skipped, ...(skipped.length ? { errors } : {}) };
  }

  function brokerAuthFor(handle: WorldHandle, taskId?: string): GitBrokerAuth {
    const projectId = typeof handle.meta?.projectId === 'string' ? handle.meta.projectId : undefined;
    const project = projectId ? store.getProject(projectId) : undefined;
    const linked = projectId ? store.listProjectRepositories(projectId) : [];
    const wiki = projectId ? store.projectWiki(projectId)?.repository : undefined;
    const catalog = project?.organizationId ? store.listRepositories(project.organizationId) : [];
    if (project?.organizationId && (linked.length || wiki || catalog.length) && deps.githubApp) {
      return async (worldRepo) => {
        const source = worldRepoSource(worldRepo);
        let repository = linked.find((candidate) => sameRepository(candidate.repository.sshUrl, source))?.repository
          ?? (wiki && sameRepository(wiki.sshUrl, source) ? wiki : undefined);
        if (!repository && worldRepo.localPath)
          repository = catalog.find((candidate) => sameRepository(candidate.sshUrl, source));
        // A cloud checkout provisioned from a project-configured host checkout
        // is authorized by that exact local authority. Prefer its matching App
        // catalog credential; if the installation does not expose that origin,
        // retain the selected Git profile compatibility path. The sealed world
        // handle preserves localPath from cloudGitSource; arbitrary network
        // repositories still fail the catalog guard below.
        if (!repository && worldRepo.localPath) return { env: gitEnvFor(handle, taskId) };
        if (!repository) throw new Error(`Git broker rejected repository outside project enrollment: ${source}`);
        return deps.githubApp!.brokerCredentials(repository);
      };
    }
    return gitEnvFor(handle, taskId);
  }

  async function ensureRunnerLease(handleInput: WorldHandle, taskId: string): Promise<WorldHandle> {
    const handle = (store.currentWorld(handleInput.id) ?? handleInput) as WorldHandle;
    if (!isRemote(handle.kind) || !deps.runners) return handle;
    const existing = typeof handle.meta?.worldLeaseId === 'string' ? store.worldLease(handle.meta.worldLeaseId) : undefined;
    if (existing?.state === 'active') return handle;
    const projectId = String(handle.meta?.projectId ?? store.getTask(taskId)?.projectId ?? '');
    const project = store.getProject(projectId);
    if (!project) throw new Error('cloud world has no owning project');
    const ctx = activityContext.current();
    const acquired = await deps.runners.acquire({ project, taskId, worldId: handle.id, provider: handle.kind,
      priority: Number(store.getTask(taskId)?.params.priority ?? 0), signal: ctx.cancellationSignal,
      heartbeat: () => ctx.heartbeat({ waitingFor: 'world-capacity' }) });
    const next = store.updateWorldMeta(handle, { worldLeaseId: acquired.leaseId, runnerPoolId: acquired.runnerPoolId });
    store.setWorldState(next, 'ready');
    record(taskId, 'world.lease-acquired', { leaseId: acquired.leaseId, runnerPoolId: acquired.runnerPoolId });
    return next as WorldHandle;
  }

  async function openWorld(handle: WorldHandle, taskId = handle.id): Promise<World> {
    let world: World;
    try {
      world = await worlds.open(await ensureRunnerLease(handle, taskId));
    } catch (e) {
      const recovered = await recoverVanishedWorld(handle, taskId, e);
      if (!recovered) throw e;
      world = recovered;
    }
    return deps.resources ? await deps.resources.prepare(world) : world;
  }

  // A remote sandbox can vanish out-of-band while a task is parked (provider GC,
  // eviction, an incident). The parked world already carries a checkpoint (taken
  // at park time above), so re-provision a fresh sandbox from it and carry on with
  // the same branch/files and the same agent session — instead of surfacing a raw
  // provider "sandbox not found" the task can never get past. Gated on
  // probe === 'missing', so a transient open error never discards good in-sandbox
  // state by reverting to the checkpoint. The restored world registers under the
  // same world id, so every later openWorld() (which re-resolves currentWorld via
  // ensureRunnerLease) transparently uses it.
  async function recoverVanishedWorld(handle: WorldHandle, taskId: string, cause: unknown): Promise<World | undefined> {
    if (!isRemote(handle.kind) || !deps.checkpoints) return undefined;
    // A finished task's world is deliberately gone. Without this guard a stray
    // open on a released handle (a retried activity, a late artifact fetch, an
    // MCP call holding the old handle) would probe 'missing' — correctly, it was
    // destroyed — and re-provision a fresh billable sandbox for a done task.
    if (store.worldState(handle.id) === 'released') return undefined;
    const checkpointId = handle.checkpointId ?? (store.currentWorld(handle.id) as WorldHandle | undefined)?.checkpointId;
    if (!checkpointId) return undefined;
    const state = await worlds.probe(handle).catch(() => undefined);
    if (state !== 'missing') return undefined; // transient/parked → keep the original error
    record(taskId, 'world.recovering', { checkpointId, reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 200) });
    try {
      const restored = await deps.checkpoints.restore(checkpointId, handle.kind);
      const opened = await worlds.open(await ensureRunnerLease(restored, taskId));
      store.setWorldState((store.currentWorld(restored.id) ?? restored) as WorldHandle, 'ready');
      record(taskId, 'world.recovered', { checkpointId, generation: restored.generation });
      return opened;
    } catch (error) {
      record(taskId, 'world.recover-failed', { checkpointId, detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      return undefined; // fall through to the original provider error
    }
  }

  /** Make the task's live project-wiki checkout host-readable for prompt
   * assembly. Local providers already expose it directly; remote providers are
   * copied into a short-lived snapshot through the provider-neutral file API. */
  async function projectWikiPromptSnapshot(world: World): Promise<{ root: string; release(): void } | undefined> {
    const repo = worldRepos(world.handle).find((candidate) => candidate.role === 'project-wiki');
    if (!repo) return undefined;
    if (fs.existsSync(repo.root)) return { root: repo.root, release: () => {} };

    const worldRoot = world.handle.root.replace(/\\/g, '/').replace(/\/+$/, '');
    const repoRoot = repo.root.replace(/\\/g, '/').replace(/\/+$/, '');
    const prefix = path.posix.relative(worldRoot, repoRoot);
    if (prefix.startsWith('..') || path.posix.isAbsolute(prefix))
      throw new Error('project wiki is outside the task world');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-prompt-'));
    try {
      for (const file of await world.listFiles()) {
        if (prefix && file !== prefix && !file.startsWith(`${prefix}/`)) continue;
        const rel = prefix ? file.slice(prefix.length).replace(/^\/+/, '') : file;
        if (!rel || rel === '.git' || rel.startsWith('.git/')) continue;
        const target = path.resolve(root, rel);
        if (target !== root && !target.startsWith(`${root}${path.sep}`))
          throw new Error('invalid file path in project wiki checkout');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, await world.readFileBuffer(file));
      }
      return { root, release: () => fs.rmSync(root, { recursive: true, force: true }) };
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    async createWorld(args: CreateWorldArgs): Promise<WorldHandle> {
      const remote = isRemote(args.kind);
      if (process.env.KARMAX_DEPLOYMENT === 'hosted' && !remote)
        throw new Error(`hosted deployments cannot run task code in the control plane (${args.kind}); select a remote runner`);
      record(args.taskId, 'world.provisioning', { provider: args.kind });
      const projectId = args.projectId ?? store.getTask(args.taskId)?.projectId;
      const project = projectId ? store.getProject(projectId) : undefined;
      const organizationId = project?.organizationId ?? 'org_personal';
      // Resolve the human creator's profile. A tenant-wide identity is only valid
      // for a system-created task with no human ancestor.
      const gitBinding = developmentGitBinding(args.taskId, projectId, args.gitProfile);
      const { profile, profiles: gitProfiles } = gitBinding;
      let gitIdentity;
      let gitCredentials;
      try {
        gitIdentity = profile
          ? gitProfiles.identity(profile, { taskId: args.taskId })
          : gitBinding.userId
            ? { name: 'karmax', email: `karmax+${gitBinding.userId.replace(/[^a-z0-9.-]/gi, '-')}@localhost` }
            : organizationId === 'org_personal'
              ? undefined
              : { name: 'karmax', email: `karmax+${organizationId.replace(/[^a-z0-9.-]/gi, '-')}@localhost` };
      } catch (e) {
        record(args.taskId, 'world.warning', { warning: `git profile "${profile?.name}": ${e instanceof Error ? e.message : e}` });
      }
      try {
        gitCredentials = {
          ...(gitBinding.scope === 'org_personal' ? {} : { isolated: true }),
          ...(profile ? gitProfiles.worldCredentials(profile, { taskId: args.taskId }) : {}),
        };
        if (!Object.keys(gitCredentials).length) gitCredentials = undefined;
      } catch (e) {
        record(args.taskId, 'world.warning', { warning: `git profile "${profile?.name}" clone credentials: ${e instanceof Error ? e.message : e}` });
      }
      // The project wiki is a platform-owned companion repository. Add it at
      // provisioning time (rather than to deterministic workflow input), so
      // old workflow histories remain replay-compatible.
      const wikiRoot = project
        ? ensureProjectWikiRepository(deps.contentDir ?? paths().content, project.id)
        : undefined;
      if (project && !store.projectWiki(project.id)) store.setProjectWikiRepository(project.id);
      const wikiRepository = project ? store.projectWiki(project.id)?.repository : undefined;
      if (remote && project && (!wikiRepository || !wikiRepository.private))
        throw new Error('the project wiki needs a private GitHub remote before a cloud world can be created');
      const developmentSources = args.repos?.length ? args.repos : args.repo ? [args.repo] : [];
      const requestedSources = [
        ...developmentSources,
        ...(wikiRoot && (!remote || wikiRepository) ? [wikiRoot] : []),
      ];
      const cloudSources = remote ? await Promise.all(requestedSources.map((source) => cloudGitSource(source))) : [];
      const worldSources = remote ? cloudSources.map((resolved) => resolved.source) : requestedSources;
      for (let i = 0; i < cloudSources.length; i++) {
        if (cloudSources[i]!.localPath)
          record(args.taskId, 'world.repository-resolved', {
            localPath: cloudSources[i]!.localPath, remote: cloudSources[i]!.source,
          });
      }
      // Older/local workflow histories do not pass projectId into createWorld;
      // the durable task record is the compatibility source for repository
      // enrollment, credentials, and world ownership.
      const linkedRepositories = projectId ? store.listProjectRepositories(projectId) : [];
      const organizationRepositories = project?.organizationId
        ? store.listRepositories(project.organizationId)
        : [];
      const hasCatalogedLocalSource = worldSources.some((source, index) =>
        Boolean(cloudSources[index]?.localPath)
        && organizationRepositories.some((candidate) => sameRepository(candidate.sshUrl, source)));
      const repositoryBranches = Object.fromEntries(worldSources.flatMap((source) => {
        const candidate = linkedRepositories.find((entry) => sameRepository(entry.repository.sshUrl, source));
        if (!candidate) return [];
        const base = candidate.baseBranch ?? candidate.repository.defaultBranch;
        return [[source, { base, target: candidate.targetBranch ?? base }]];
      }));
      if (wikiRoot && requestedSources.includes(wikiRoot))
        repositoryBranches[remote ? worldSources[worldSources.length - 1]! : wikiRoot] = {
        base: PROJECT_WIKI_BRANCH, target: PROJECT_WIKI_BRANCH,
      };
      if (linkedRepositories.length || wikiRepository || hasCatalogedLocalSource) {
        if (!deps.githubApp && remote) throw new Error('hosted repositories require the configured GitHub App');
        const httpsTokens: Record<string, string> = {};
        for (const [index, source] of worldSources.entries()) {
          const linked = linkedRepositories.find((candidate) => sameRepository(candidate.repository.sshUrl, source));
          const repository = linked?.repository
            ?? (wikiRepository && sameRepository(wikiRepository.sshUrl, source) ? wikiRepository : undefined)
            // Local filesystem sources are explicitly configured project
            // authorities. In a cloud world their origin becomes the clone
            // transport; match that origin against the connected GitHub App
            // catalog even when the project predates repository attachments.
            ?? (cloudSources[index]?.localPath
              ? organizationRepositories.find((candidate) => sameRepository(candidate.sshUrl, source))
              : undefined);
          if (!repository) {
            // A configured host checkout is already the authority for this
            // repository. cloudGitSource resolved its origin only as the cloud
            // transport and copySources seeds the sandbox from the exact local
            // commit, so it neither needs nor implies a GitHub catalog
            // attachment. Requiring enrollment here discarded that provenance
            // and made a correctly auto-detected local origin fail as soon as
            // any other source (normally the project wiki) was enrolled.
            if (cloudSources[index]?.localPath) continue;
            if (remote) throw new Error(`repository ${source} is not enrolled in this project`);
            continue;
          }
          if (deps.githubApp) httpsTokens[source] = await deps.githubApp.repositoryCloneToken(repository);
        }
        // Repository-scoped read-only installation tokens exist only during
        // trusted provisioning and are removed before the agent starts.
        if (Object.keys(httpsTokens).length) gitCredentials = { ...gitCredentials, httpsTokens };
      }
      const executionConfig = project ? store.effectiveProjectConfig(project) : undefined;
      const environmentSelection = projectId
        ? selectProjectEnvironment(store, projectId, args.kind, executionConfig?.environment)
        : { built: false, environment: executionConfig?.environment };
      let acquired: { leaseId: string; runnerPoolId: string } | undefined;
      if (remote && project && deps.runners) {
        const ctx = activityContext.current();
        acquired = await deps.runners.acquire({ project, taskId: args.taskId, worldId: args.taskId, provider: args.kind,
          priority: Number(store.getTask(args.taskId)?.params.priority ?? 0), signal: ctx.cancellationSignal,
          heartbeat: () => ctx.heartbeat({ waitingFor: 'world-capacity' }) });
      }
      let world: World;
      try {
        world = await worlds.create(args.kind, {
          taskId: args.taskId,
          organizationId: project?.organizationId,
          repo: worldSources.length === 1 ? worldSources[0] : undefined,
          repos: worldSources.length > 1 ? worldSources : undefined,
          scratch: developmentSources.length === 0,
          ...(args.multiPr ? { layout: 'nested' as const } : {}),
          base: args.base,
          target: args.target,
          branch: args.branch,
          resetBranch: args.resetBranch,
          copyGlobs: args.copyGlobs,
          ...(remote ? { copySources: cloudSources.map((source) => source.localPath) } : {}),
          gitIdentity,
          gitCredentials,
          ...(Object.keys(repositoryBranches).length ? { repositoryBranches } : {}),
          network: executionConfig?.network,
          environment: environmentSelection.environment,
          resources: executionConfig?.resources,
        });
      } catch (error) {
        if (acquired) deps.runners?.release(acquired.leaseId, args.kind);
        throw error;
      }
      try {
        if (projectId && deps.resources) {
          const generation = ((store.currentWorld(args.taskId)?.generation ?? 0) + 1);
          world.handle = await deps.resources.materialize(projectId, args.taskId, world, generation);
        }
        if (projectId) {
          const runtime = await activateProjectRuntime({ world, store, projectId, taskId: args.taskId,
            selection: environmentSelection, resources: deps.resources, runSetupIfUnbuilt: true });
          world.handle = runtime.handle;
          for (const warning of runtime.warnings) record(args.taskId, 'world.warning', { warning });
        }
        if (profile) world.handle.meta = { ...world.handle.meta,
          gitProfile: profile.name, gitProfileScope: gitBinding.scope };
        if (wikiRoot && requestedSources.includes(wikiRoot) && world.handle.repos?.length) {
          const wikiSource = remote ? worldSources[worldSources.length - 1] : wikiRoot;
          const wiki = wikiSource && world.handle.repos.find((repo) => sameRepository(worldRepoSource(repo), wikiSource)
            || sameRepository(repo.repo, wikiSource));
          if (wiki) wiki.role = 'project-wiki';
        }
        // A platform-owned companion must not unexpectedly move agents out of
        // the project's only development repository. Keep `root` as the world
        // boundary so the wiki remains accessible, and select that development
        // checkout as the default cwd. Genuine multi-development-repo projects
        // retain the encompassing root as their working directory.
        const developmentRepos = worldRepos(world.handle).filter((repo) => repo.role !== 'project-wiki');
        if (developmentRepos.length === 1) world.handle.workdir = developmentRepos[0]!.root;
        if (projectId) world.handle.meta = { ...world.handle.meta, projectId,
          repositoryIds: [...linkedRepositories.map((candidate) => candidate.repository.id),
            ...(wikiRepository ? [wikiRepository.id] : [])] };
        if (acquired) world.handle.meta = { ...world.handle.meta, worldLeaseId: acquired.leaseId };
        if (projectId) {
          world.handle = store.registerWorld(world.handle, projectId, {
            runnerPoolId: acquired?.runnerPoolId ?? (remote ? `managed-${args.kind}` : 'local'),
            environmentDigest: environmentSelection.digest
              ?? (remote ? String(world.handle.meta?.environmentArtifact
                ?? `${args.kind}:${executionConfig?.environment?.flavor ?? 'headless'}`) : 'karmax-local'),
          }) as WorldHandle;
        }
        record(args.taskId, 'world.created', { handle: world.handle });
        record(args.taskId, 'world.ready', { provider: world.handle.kind, generation: world.handle.generation ?? 1 });
        for (const warning of world.handle.warnings ?? []) record(args.taskId, 'world.warning', { warning });
      } catch (error) {
        // `world` is still live on this path — pass it, or teardown addresses the
        // HOST daemon while the containers live inside the world (a silent no-op).
        await destroyWorldServices(args.taskId, world).catch(() => undefined);
        await world.destroy().catch(() => undefined);
        if (acquired) deps.runners?.release(acquired.leaseId, args.kind);
        throw error;
      }
      return world.handle;
    },

    /** The effective provider for a role's turn (task override → seeded profile),
     *  so the workflow can lease an account of the right provider (SPEC §6.2). */
    async resolveProvider(args: { role: AgentRole; task: TaskInput }): Promise<string> {
      const baseProfile = profiles.resolve(args.role, args.task.profiles, undefined, args.task.projectId);
      return applyAgentSpec(baseProfile, args.task.agents?.[args.role]).provider;
    },

    /** Whether this turn consumes host model-process capacity. Remote subscription
     * CLIs run inside their provider world; local turns and API rails run here. */
    async agentUsesHostCapacity(args: {
      role: AgentRole;
      task: TaskInput;
      worldHandle: WorldHandle;
      accountConfigHome?: string;
      accountApiKeyHandle?: string;
      accountCredentialKind?: 'login' | 'ambient' | 'key';
      accountCredentialProvider?: string;
    }): Promise<boolean> {
      if (!isRemote(args.worldHandle.kind)) return true;
      if (args.accountCredentialKind === 'key') return true;
      if (args.accountCredentialKind === 'login' || args.accountCredentialKind === 'ambient') return false;

      // Replay compatibility for workflow histories recorded before credential
      // metadata accompanied the lease. A broker handle is an API rail; a config
      // home is a provider-hosted subscription rail.
      if (args.accountApiKeyHandle && deps.broker) return true;
      if (args.accountConfigHome) return false;

      const baseProfile = profiles.resolve(args.role, args.task.profiles, undefined, args.task.projectId);
      const profile = applyAgentSpec(baseProfile, args.task.agents?.[args.role]);
      const modelProvider = args.accountCredentialProvider
        ? canonicalModelProvider(args.accountCredentialProvider)
        : credentialProvider(profile);
      return (
        (profile.provider === 'claude' && !!process.env.ANTHROPIC_API_KEY)
        || (profile.provider === 'codex' && !!process.env.OPENAI_API_KEY)
        || (profile.provider === 'opencode' && !!process.env[apiKeyEnv(modelProvider)])
      );
    },

    /** The ordered, enabled credential keys for a turn's provider, per the credential
     *  policy resolved global→project→task (SPEC §7/§9). The coordinator leases the
     *  first available one from this list. An empty compatible set resolves to a
     *  denied marker so explicit policy cannot fall through to profile defaults. */
    async resolveCredentialOrder(args: { taskId: string; projectId: string; provider: string; role?: AgentRole; task?: TaskInput }): Promise<string[]> {
      const { gatherCredentialSources, readPolicyLayers } = await import('../platform/credential-sources.js');
      const { enumerateCredentials, resolveCredentials } = await import('../platform/credentials.js');
      const organizationId = store.getProject(args.projectId)?.organizationId ?? 'org_personal';
      const sources = gatherCredentialSources({ configHomes: deps.configHomes, broker: deps.broker, organizationId });
      const all = enumerateCredentials(sources);
      const layers = readPolicyLayers((k) => store.kvGet(k), { organizationId, projectId: args.projectId, taskId: args.taskId });
      const profile = args.role && args.task
        ? applyAgentSpec(
          profiles.resolve(args.role, args.task.profiles, undefined, args.task.projectId),
          args.task.agents?.[args.role],
        )
        : undefined;
      const enabled = resolveCredentials(all, layers);
      let missingNamespace = args.provider;
      const openCodePrefix = profile?.provider === 'opencode' ? modelProviderFromModel(profile.model) : undefined;
      const recognizedOpenCodePrefix = !!openCodePrefix && (
        (MODEL_PROVIDERS as readonly string[]).includes(openCodePrefix)
        || all.some((candidate) =>
          candidate.kind === 'key' && credentialAliases(openCodePrefix).includes(candidate.provider),
        )
      );
      if (profile?.provider === 'opencode') {
        missingNamespace = recognizedOpenCodePrefix ? openCodePrefix! : 'opencode-compatible';
      }
      const ordered = enabled.filter((credential) => {
        if (!profile) return credentialAliases(args.provider).includes(credential.provider);
        if (profile.provider !== 'opencode') {
          missingNamespace = credentialProvider(profile);
          return credentialMatchesProfile(profile, credential);
        }

        // An OpenCode subscription is harness-native and may carry credentials
        // for multiple model vendors. API keys are narrowed only when the model
        // has a recognizable `provider/model` prefix. With an unprefixed or
        // custom id, the user's general Credentials ordering is authoritative.
        if (credential.kind !== 'key') {
          if (credential.provider !== 'opencode') return false;
          if (!credential.modelProvider) return recognizedOpenCodePrefix;
          return !recognizedOpenCodePrefix
            || credentialAliases(openCodePrefix!).includes(credential.modelProvider);
        }
        if (!recognizedOpenCodePrefix) return true;
        return credentialAliases(openCodePrefix!).includes(credential.provider);
      });
      // A native OpenCode fork is stored in the source XDG home. Lease that
      // exact login first so account concurrency, quota failures, and policy
      // attribution remain honest; never reopen one account after leasing
      // another. Ambient/API-key sessions have no stored source home.
      const resume = args.role ? args.task?.agents?.[args.role]?.resumeFrom : undefined;
      if (profile?.provider === 'opencode' && resume?.taskId) {
        const srcRole = resume.role ?? args.role!;
        const raw = store.kvGet(`sessionmeta:${resume.taskId}:${srcRole}`);
        if (raw) {
          try {
            const meta = JSON.parse(raw) as { home?: string; provider?: string };
            if (meta.home && (!meta.provider || meta.provider === 'opencode')) {
              const index = ordered.findIndex((credential) =>
                credential.provider === 'opencode' && credential.configHome === meta.home,
              );
              // This is not merely a preference: another free OpenCode account
              // cannot resolve the source session. Restrict the lease request so
              // the coordinator waits for this home instead of skipping to a
              // different account.
              if (index >= 0) return [ordered[index]!.key];
              return [`missing:${organizationId}:opencode-fork`];
            }
          } catch {
            /* malformed historical metadata — adapter will report the missing session */
          }
        }
      }
      const keys = ordered.map((c) => c.key);
      // An empty compatible set must not fall through to an ambient/profile
      // credential and bypass an explicit disable. A non-existent allow-list
      // entry makes the coordinator deny the turn with a credential action.
      return keys.length || profile?.provider === 'mock'
        ? keys
        : [`missing:${organizationId}:${missingNamespace}`];
    },

    async runAgentTurn(args: RunAgentTurnArgs) {
      const baseProfile = profiles.resolve(args.role, args.task.profiles, args.explicitProfileId, args.task.projectId);
      // Apply the per-role agent override from the task form (SPEC §10.5).
      const spec = args.task.agents?.[args.role];
      let profile = applyAgentSpec(baseProfile, spec);
      const leasedCredentialProvider = args.accountCredentialProvider
        ? canonicalModelProvider(args.accountCredentialProvider)
        : undefined;
      if (profile.provider === 'opencode' && leasedCredentialProvider) {
        // Internal, per-turn resolution only. Persisted/task modelProvider values
        // are stripped by applyAgentSpec; the credential actually leased by the
        // general policy is the sole authority for custom/unprefixed model ids.
        profile = { ...profile, modelProvider: leasedCredentialProvider };
      }
      const organizationId = store.getProject(args.task.projectId)?.organizationId ?? 'org_personal';
      const world = await openWorld(args.worldHandle, args.taskId);

      // Fork a prior agent (SPEC §10.5) — set up below, AFTER auth resolution, since
      // materializing the source session needs this turn's config home + world path.
      const conversationTaskId = args.role === 'confirm' ? (args.task.intentId ?? args.taskId) : args.taskId;
      let session = args.session;
      let messages = args.messages; // may be replaced by the shared confirmer transcript
      let deliveredMessages = args.deliveredMessages;
      let fork = false; // true → the adapter branches a NEW session id from `session`

      // Temporal wiring: cancellation aborts the in-flight turn (SPEC §5.6), and
      // heartbeats carry the live session id so a RETRY of this activity (stream
      // cut, host slept, heartbeat timeout) RESUMES the interrupted session from
      // heartbeat details instead of replaying the whole turn from scratch.
      let signal: AbortSignal | undefined;
      let heartbeat: (() => void) | undefined;
      let hbSession: string | undefined; // set once real progress exists (onSession)
      let legacyAgentTurnId: string | undefined;
      let turnSessionKey: string | undefined;
      let resumedActivityAttempt = false;
      let activityAttempt = 1;
      // Live in-flight-injection channel: a streaming adapter polls the workflow for
      // follow-ups queued WHILE this turn runs and injects them into the live session
      // (SPEC §5.6). Off on a resumed retry — its `messages` were replaced by a single
      // continuation notice, so the workflow's msgs-index boundary no longer applies.
      let liveChannel = true;
      try {
        const actx = activityContext.current();
        activityAttempt = actx.info.attempt;
        signal = actx.cancellationSignal;
        heartbeat = () => actx.heartbeat(hbSession ? { session: hbSession } : undefined);
        // v1 workflows cannot add the new agentTurnId argument without changing
        // their recorded activity command. Derive a stable compatibility id from
        // the existing activity execution instead, so the activity can repair the
        // persisted view without changing workflow history.
        if (!args.agentTurnId && actx.info.workflowExecution) {
          legacyAgentTurnId = `legacy:${actx.info.workflowExecution.runId}:${actx.info.activityId}`;
        }
        const stableTurnId = args.agentTurnId ?? legacyAgentTurnId;
        turnSessionKey = stableTurnId ? `turnsession:${stableTurnId}` : undefined;
        // Heartbeat details are Temporal's primary retry checkpoint. The per-turn
        // SQLite key closes the small hard-kill window before a heartbeat reaches the
        // service; unlike session:<task>:<role>, it cannot accidentally pick up a
        // stale session from an earlier turn.
        const prior =
          (actx.info.heartbeatDetails as { session?: string } | undefined)?.session ??
          (actx.info.attempt > 1 && turnSessionKey ? store.kvGet(turnSessionKey) : undefined);
        if (actx.info.attempt > 1 && prior) {
          resumedActivityAttempt = true;
          liveChannel = false;
          // The interrupted attempt's session already holds the original prompt and
          // any partial work — continue it rather than re-sending the turn input.
          session = prior;
          hbSession = prior;
          // `messages` is replaced by the single continuation notice below, so the
          // delivered-boundary from the workflow no longer applies — send all of it.
          deliveredMessages = 0;
          messages = [
            {
              id: `retry-${actx.info.attempt}`,
              role: 'user',
              text: '(This turn was interrupted mid-run — the connection dropped or the host slept. Continue from where you left off; if the work was already finished, restate the final result.)',
              ts: 0,
            },
          ];
          record(args.taskId, 'turn.resumed', { role: args.role, attempt: actx.info.attempt });
        }
      } catch {
        /* not running inside a Temporal activity (e.g. a direct unit test) */
      }

      // The workflow mints the agent's scoped credential (SPEC §8.3): effective
      // capabilities = intersection(role ceiling, granting principal). The two are
      // orthogonal axes — the ceiling is what this ROLE could ever need (declared by
      // the workflow), the grant is what the task's authorization profile delegated —
      // so a Merge agent stays a Merge agent even on an administrator-authorized task.
      // Human-approved credential escalations recorded after creation
      // (PLAN-passwords.md §7 approve-for-task) extend the stored grant here,
      // so the next minted token carries them without touching workflow input.
      const orgVaultItems = new VaultItems(store, deps.broker, undefined, organizationId);
      const approvedPermissions = new PermissionRequests(store, organizationId).extensionCaps(args.taskId, args.role);
      // Requesting human input is a non-removable safety valve for every task
      // agent. The API restricts task-scoped callers to their own task, so this
      // cannot be used to interrupt peer work or widen the agent's authority.
      const storedAuthorization = store.getTask(args.taskId)?.params?._authorization as {
        capabilities?: string[];
        scope?: 'projects' | 'organization' | 'global';
        projectIds?: string[];
        organizationId?: string;
      } | undefined;
      const grant = [...new Set([
        ...(storedAuthorization?.capabilities ?? args.task.grant ?? DEFAULT_GRANT),
        ...orgVaultItems.extensionCaps(args.taskId),
        ...approvedPermissions,
        'task:escalate',
      ])];
      // An explicit human approval is the only way to extend the task beyond
      // the workflow role's ordinary ceiling. Fold it into both token axes: the
      // normal stored task grant remains least-privilege, while the approved
      // exception is exact, task-scoped, durable, and audited.
      const ceiling = [...new Set([...roleCeiling(args.role), ...approvedPermissions])];
      const effective = attenuate(ceiling, grant);
      let token: string | undefined;
      if (deps.tokens) {
        const authorizationScope = storedAuthorization?.scope;
        const minted = deps.tokens.mint({
          taskId: args.taskId,
          profileId: profile.id,
          role: args.role,
          principal: args.task.parentTaskId ? `task:${args.task.parentTaskId}` : (args.task.grantPrincipal ?? 'system:legacy-task'),
          projectId: authorizationScope ? undefined : args.task.projectId,
          projectIds: authorizationScope === 'projects' ? storedAuthorization?.projectIds : undefined,
          organizationId: authorizationScope === 'global' ? undefined
            : (storedAuthorization?.organizationId ?? store.getProject(args.task.projectId)?.organizationId),
          audience: 'karmax-platform',
          executionId: args.agentTurnId ?? legacyAgentTurnId,
          worldGeneration: args.worldHandle.generation,
          ceiling,
          grantorCaps: grant,
        });
        token = minted.token;
        record(args.taskId, 'token.minted', { tokenId: minted.record.id, profile: profile.id, caps: effective,
          audience: minted.record.audience, executionId: minted.record.executionId, expiresAt: minted.record.expiresAt });
      }

      // JIT-resolve credentials via the broker (never journaled). Every current
      // turn receives its selection from the general Credentials policy.
      let resolvedAuth: { apiKey?: string; configHome?: string; oauthToken?: string } | undefined;
      // A coordinator-leased account home wins over the profile default so turns
      // rotate across connected logins (SPEC §6.2 token/account leasing).
      if (args.accountConfigHome) {
        const tok = tokenToInject(args.accountConfigHome);
        resolvedAuth = { ...resolvedAuth, configHome: args.accountConfigHome, ...(tok ? { oauthToken: tok } : {}) };
      }
      // A coordinator-leased API key wins over both (SPEC §6.2/§7). Vault handles
      // resolve JIT; reserved environment-key references carry only the provider
      // identity and let the adapter read that provider's process environment.
      if (args.accountApiKeyHandle && deps.broker) {
        const apiKey = deps.broker.resolve(args.accountApiKeyHandle, { taskId: args.taskId, profileId: profile.id, caps: effective });
        resolvedAuth = { apiKey };
      }
      if (
        organizationId !== 'org_personal'
        && profile.provider !== 'mock'
        && !args.accountConfigHome
        && !args.accountApiKeyHandle
      ) {
        throw new Error(`organization ${organizationId} has no usable ${credentialProvider(profile)} credential; connect an organization login or API key`);
      }
      // API sessions are stateless. Cloud subscription sessions live in their
      // sandbox; a requested cross-world session is materialized explicitly below.
      const apiRail = !!resolvedAuth?.apiKey || (!resolvedAuth && (
        (profile.provider === 'claude' && !!process.env.ANTHROPIC_API_KEY) ||
        (profile.provider === 'codex' && !!process.env.OPENAI_API_KEY) ||
        (profile.provider === 'opencode' && !!process.env[apiKeyEnv(credentialProvider(profile))])
      ));
      const remoteSubscriptionRail = isRemote(args.worldHandle.kind) && !apiRail;
      // ── Fork a prior agent (SPEC §10.5) ──────────────────────────────────────
      // Branch a NEW session from the source's REAL conversation — NOT by stuffing its
      // transcript into the prompt. Make the source session visible to THIS turn's
      // (home × world), then let the adapter run a native fork (Claude --fork-session /
      // Codex exec resume). Falls back to transcript replay only if the source session
      // file is gone (worlds get cleaned; the session survives in the home) or it's a
      // cross-provider jump.
      if (!session && spec?.resumeFrom) {
        const srcRole = spec.resumeFrom.role ?? args.role; // a task has many agents; pick the source's role
        // The config home THIS turn runs under — where the source session must be
        // visible for the provider to resolve it. Shared by both resume paths below.
        const ambientHome =
          profile.provider === 'codex' ? '.codex'
          : profile.provider === 'kimi' ? '.kimi-code'
          : profile.provider === 'grok' ? '.grok'
          : profile.provider === 'opencode' ? path.join('.local', 'share', 'opencode')
          : '.claude';
        const forkHome = resolvedAuth?.configHome || path.join(os.homedir(), ambientHome);
        if (spec.resumeFrom.sessionId) {
          // A raw pasted provider session id = "continue THIS exact session" (resume,
          // not fork). Materialize it into this turn's (home × world) so the provider
          // resolves it even when the id was minted under a DIFFERENT config home or
          // world — Claude keys sessions by (home × cwd), Codex by id across homes, so
          // a bare pass-through silently missed both. The copy is non-mutating, so the
          // source is never disturbed; `fork` stays false to keep the same session id.
          session = spec.resumeFrom.sessionId;
          // The mock provider is hermetic — it has no on-disk session, so materialize is
          // meaningless; pass the id straight through. Real providers (claude/codex) key
          // a session to a file; make it visible in this turn's (home × world) or fail.
          const materialized =
            profile.provider === 'mock' || apiRail
              || profile.provider === 'opencode' || profile.provider === 'kimi' || profile.provider === 'grok'
              ? true
              : materializeFork({ provider: profile.provider, session, forkHome, worldPath: worldWorkingDirectory(world.handle) });
          if (!materialized) {
            // The id resolves in NO config home for this provider. Fail loudly instead
            // of handing an unknown id to the adapter, which would silently start a
            // FRESH conversation — the user asked to continue a specific one, and would
            // otherwise never learn it was lost. Permanent (nonRetryable): retrying can't
            // conjure the session. Covers a typo, a cleaned session, or a cross-provider
            // id (we run under this profile's provider).
            record(args.taskId, 'session.resume-failed', { session, provider: profile.provider });
            throw ApplicationFailure.create({
              message: `Cannot resume session "${session}": no such ${profile.provider} conversation found in any connected config home. Check the id, or that it belongs to a ${profile.provider} login connected to krmax (cross-provider resume is unsupported).`,
              type: 'agent-error',
              nonRetryable: true,
            });
          }
          record(args.taskId, 'session.resumed', { session, materialized });
        } else if (spec.resumeFrom.taskId) {
          const srcSession = store.kvGet(`session:${spec.resumeFrom.taskId}:${srcRole}`) || undefined;
          let srcHome: string | undefined;
          let srcProvider: string | undefined;
          const metaRaw = store.kvGet(`sessionmeta:${spec.resumeFrom.taskId}:${srcRole}`);
          if (metaRaw) { try { const m = JSON.parse(metaRaw); srcHome = m.home || undefined; srcProvider = m.provider || undefined; } catch { /* ignore */ } }
          let forked = false;
          if (srcSession && (!srcProvider || srcProvider === profile.provider)) {
            // OpenCode sessions live inside the harness's isolated XDG data home.
            // A native fork must start in the SOURCE home; otherwise account
            // rotation can hand session/fork to a different empty store. The
            // credential resolver above requests only this account.
            const openCodeSourceConnected =
              profile.provider !== 'opencode'
              || !srcHome
              || !!deps.configHomes?.list().some((account) =>
                account.provider === 'opencode'
                && account.path === srcHome
                && account.loggedIn,
              );
            if (
              profile.provider === 'opencode'
              && srcHome
              && (!openCodeSourceConnected || resolvedAuth?.configHome !== srcHome)
            ) {
              record(args.taskId, 'session.fork-failed', {
                session: srcSession,
                reason: 'source-account-unavailable',
              });
              throw ApplicationFailure.create({
                message: 'Cannot fork this OpenCode session because its source login is disabled, disconnected, or was not leased. Enable that OpenCode account and retry.',
                type: 'agent-error',
                nonRetryable: true,
              });
            }
            // OpenCode advertises ACP session/fork and resolves its own opaque
            // ids. Kimi and Grok currently do not; their native harnesses are not
            // admitted, and any historical profile uses the honest replay path.
            if (profile.provider === 'opencode') {
              forked = true;
            } else if (profile.provider !== 'kimi' && profile.provider !== 'grok') {
              if (remoteSubscriptionRail) {
                const sourceHandle = store.currentWorld(spec.resumeFrom.taskId) as WorldHandle | undefined;
                if (sourceHandle && isRemote(sourceHandle.kind)) {
                  try {
                    const sourceWorld = await openWorld(sourceHandle, spec.resumeFrom.taskId);
                    forked = await materializeRemoteSession(sourceWorld, world, profile.provider, srcSession, forkHome);
                  } catch { /* source world may have expired; try the durable local home below */ }
                }
              }
              if (!forked) forked = materializeFork({ provider: profile.provider, session: srcSession,
                forkHome, worldPath: worldWorkingDirectory(world.handle), srcHome });
            }
            if (forked) {
              session = srcSession;
              fork = true; // adapter branches a NEW session id from it (native fork)
              record(args.taskId, 'session.forked', { from: spec.resumeFrom, session: srcSession, native: true });
            }
          }
          if (!forked) {
            // Degraded fallback (no real source session file — e.g. the mock adapter,
            // a cleaned source, or a cross-provider jump): replay the source transcript
            // as context. NOT a native fork — flagged `native: false`.
            const srcView = store.getTask(spec.resumeFrom.taskId)?.lastView;
            const srcMsgs =
              srcView?.transcripts?.find((t) => t.role === srcRole)?.messages ??
              (srcRole === 'do' ? srcView?.messages : undefined) ??
              [];
            if (srcMsgs.length) {
              messages = [...srcMsgs, ...args.messages];
              record(args.taskId, 'session.forked', { from: spec.resumeFrom, replayed: srcMsgs.length, native: false });
            }
          }
        }
      }

      // Self-healing loop (SPEC §3.4): show the Resolve agent the INDEX of prior saved
      // resolutions (`{{skills}}`) so it reuses a known fix rather than rediscovering
      // one. Read here (an activity) since the workflow can't touch the filesystem.
      let bindings = args.bindings;
      if (args.role === 'resolve') {
        const { listResolveSkills, renderSkillsIndex } = await import('../resolve/skills.js');
        const { paths } = await import('../config/paths.js');
        bindings = { ...(bindings ?? {}), skills: renderSkillsIndex(listResolveSkills(paths().content)) };
      }
      // Goal mode: the do agent is told to keep driving across turns until the
      // objective is verifiably complete. Appended to the built-in working
      // instructions so it flows through the wiki context and fallback alike.
      const goalSuffix = args.role === 'do' && (args.task as { goalMode?: boolean }).goalMode
        ? `
- Goal mode is active. Continue autonomously across turns until the entire objective is complete and verified. A normal response does not finish the task: call signal_completion only when no required work remains. If you genuinely need a human decision, raise it with the appropriate task tool instead.`
        : '';
      const builtinInstructions = goalSuffix ? `${deps.globalInstructions ?? GLOBAL_INSTRUCTIONS}${goalSuffix}` : deps.globalInstructions;
      // Wiki context (SPEC §5.4 "global + project instructions"): the built-in
      // working instructions (a virtual unconditional wiki entry), then per
      // scope its unconditional entries in full and the indexed TOC. Read here
      // (an activity) and snapshotted into the journaled turn input — content
      // is free to edit between turns, never mid-turn. If the wiki is ever
      // unreadable, the agent still gets the built-in instructions.
      let projectInstructions: string | undefined;
      let globalInstructions: string | undefined;
      let wikiSnapshot: { root: string; release(): void } | undefined;
      try {
        const { buildWikiPromptContext } = await import('../wiki/wiki.js');
        // Wiki pages the task tags in its prompt/follow-ups (`@proj:…`/`@org:…`)
        // are inlined in full, as are the tokens in the task's wiki-context field
        // (`params.wikiContext`, read fresh here like the wiki content itself;
        // absent ⇒ the default `tag:default` tokens apply).
        const taggedText = [args.task.prompt, ...args.messages.filter((m) => m.role === 'user').map((m) => m.text)]
          .filter(Boolean)
          .join('\n');
        const wikiContext = store.getTask(args.taskId)?.params?.wikiContext;
        wikiSnapshot = await projectWikiPromptSnapshot(world);
        projectInstructions = buildWikiPromptContext({
          contentDir: deps.contentDir ?? paths().content,
          organizationId: store.getProject(args.task.projectId)?.organizationId,
          projectId: args.task.projectId,
          projectRoot: wikiSnapshot?.root,
          builtinInstructions,
          taggedText,
          contextTokens: Array.isArray(wikiContext) ? wikiContext.map(String) : undefined,
        }) || undefined;
      } catch {
        globalInstructions = `${deps.globalInstructions ?? GLOBAL_INSTRUCTIONS}${goalSuffix}`;
      } finally {
        wikiSnapshot?.release();
      }
      const systemPrompt = assemblePrompt({
        profile,
        role: args.role,
        task: args.task,
        world: args.worldHandle,
        globalInstructions,
        projectInstructions,
        bindings,
      });
      // Snapshot the journaled turn input (SPEC §5.4).
      record(args.taskId, 'turn.prompt', { role: args.role, profile: profile.id, provider: profile.provider });

      // Live follow-up poller (SPEC §5.6): a streaming adapter calls this mid-turn to
      // fetch follow-ups queued in the workflow at/after a `msgs` index and inject them
      // into the running session. Backed by the workflow's `pendingMessages` query;
      // absent when there's no client (unit tests) or the workflow doesn't define it
      // (the query throws → treated as "no new messages").
      const pullFollowUps: ((fromIndex: number) => Promise<Message[]>) | undefined =
        deps.client && liveChannel
          ? async (fromIndex: number) => {
              try {
                const handle = deps.client!.workflow.getHandle(args.taskId);
                const out = (await handle.query('pendingMessages', args.role, fromIndex)) as Message[] | undefined;
                return Array.isArray(out) ? out : [];
              } catch {
                return []; // query not registered / workflow gone / transient — no injection
              }
            }
          : undefined;

      // Confirm turns for sibling attempts share one durable transcript and run
      // serially. Fresh provider sessions replay that canonical transcript, which
      // also works across account/config-home rotation (native sessions are home-bound).
      const releaseConfirm = args.role === 'confirm' ? await acquireConfirmLock(conversationTaskId) : () => {};
      let confirmTranscript: Message[] | undefined;
      if (args.role === 'confirm') {
        let shared: Message[];
        try { shared = JSON.parse(store.kvGet(`confirm-transcript:${conversationTaskId}`) ?? '[]'); }
        catch { shared = []; }
        confirmTranscript = shared;
        const request = [...args.messages].reverse().find((m) => m.role === 'user');
        if (request) {
          const id = `${args.taskId}:${request.id}`;
          if (!shared.some((m) => m.id === id)) shared.push({ ...request, id, ts: shared.length });
        }
        // Sibling task attempts deliberately start a fresh provider session and replay
        // the intent-wide transcript. A retry of THIS SAME Temporal activity is
        // different: it must resume the interrupted provider session checkpointed
        // above, otherwise a worker restart discards the in-flight confirmer turn.
        if (!resumedActivityAttempt) {
          messages = shared;
          session = undefined;
          deliveredMessages = 0;
        }
      }
      /** Compatibility publisher for immutable v1 histories. Those workflows
       * clear their in-memory account wait after a grant but cannot schedule a
       * publish there without becoming nondeterministic. The activity is already
       * a side-effect boundary, so it may keep the SQLite/UI snapshot truthful:
       * account granted → waiting for host slot → running. A matching id prevents
       * a late retry/cancellation from overwriting a newer turn's view. */
      const publishLegacyAgentState = (state: 'waiting-slot' | 'running' | undefined) => {
        if (!legacyAgentTurnId) return;
        const taskRecord = store.getTask(args.taskId);
        // A late retry from a terminated v1 execution must never overwrite the
        // replacement run's v1.1+ snapshot. Workflow version is the stable guard;
        // view shape alone is not (a review wait legitimately has no agentTurn).
        if (taskRecord?.workflowVersion !== '1.0.0') return;
        const prev = taskRecord.lastView;
        if (!prev || prev.status === 'done' || prev.status === 'failed' || prev.status === 'cancelled') return;
        if (state) {
          if (prev.agentTurn && prev.agentTurn.turnId !== legacyAgentTurnId) return;
        } else if (prev.agentTurn?.turnId !== legacyAgentTurnId) {
          return;
        }
        const next: TaskView = state
          ? {
              ...prev,
              status: state === 'running' ? 'active' : 'waiting',
              waitingFor:
                state === 'waiting-slot'
                  ? { kind: 'agentSlot', provider: profile.provider, detail: 'Waiting for host capacity to run the agent' }
                  : undefined,
              agentTurn: { turnId: legacyAgentTurnId, role: args.role, provider: profile.provider, state },
            }
          : { ...prev, status: prev.status === 'waiting' ? 'active' : prev.status, waitingFor: undefined, agentTurn: undefined };
        store.saveView(args.taskId, next);
        record(args.taskId, 'view.updated', {
          stage: next.stage,
          status: next.status,
          waitingFor: next.waitingFor?.kind ?? null,
          waitingDetail: next.waitingFor?.detail ?? null,
          waitingProvider: next.waitingFor?.provider ?? null,
          waitingResetAt: next.waitingFor?.earliestResetAt ?? null,
          agentTurn: next.agentTurn?.state ?? null,
          agentRole: next.agentTurn?.role ?? null,
          compatibility: 'legacy-agent-turn',
        });
      };

      // Host-wide agent-turn admission (SPEC §12): cap concurrent model
      // subprocesses so a burst can't OOM the host. Acquired around the model
      // call ONLY — the setup above is cheap — and released in `finally` below.
      let releaseSlot: () => void | Promise<void> = () => {};
      let lastEmit: string | undefined;
      let lastPressureDetail: string | undefined;
      let result;
      try {
        const signalTurnState = async (
          state: 'running' | 'waiting-host',
          detail?: string,
        ): Promise<void> => {
          if (!deps.client || !args.agentTurnId) return;
          await deps.client.workflow
            .getHandle(args.taskId)
            .signal(SIG_AGENT_TURN_STATE, {
              turnId: args.agentTurnId,
              role: args.role,
              provider: profile.provider,
              state,
              ...(detail ? { detail } : {}),
            })
            .catch(() => undefined);
        };
        const publishPressure = async (state: { memoryTight: boolean; loadHigh: boolean }) => {
          const detail =
            state.memoryTight && state.loadHigh
              ? 'Waiting for host memory and load to start agent'
              : state.memoryTight
                ? 'Waiting for host memory to start agent'
                : 'Waiting for host load to start agent';
          if (detail === lastPressureDetail) return;
          lastPressureDetail = detail;
          await signalTurnState('waiting-host', detail);
        };
        // Remote subscription CLIs consume provider-world CPU/RAM, not host
        // capacity. API rails and local subprocesses retain the host admission
        // queue; account-level concurrency is enforced separately for every rail.
        if (!remoteSubscriptionRail) {
          publishLegacyAgentState('waiting-slot');
          // Current workflows carry a stable turn id, so the activity enrolls that
          // turn in the durable/reorderable coordinator before starting the model.
          // Historical executions lack the id and retain the replay-safe file gate.
          if (args.agentAdmissionManaged) {
            if (!args.agentSlotGranted)
              throw new AgentAdmissionInfrastructureError('host-running turn started without its durable agent-slot grant');
            await awaitAgentResources(heartbeat, signal, publishPressure);
          } else if (args.agentTurnId && deps.client && deps.taskQueue) {
            releaseSlot = await acquireWorkflowAgentSlot({
              client: deps.client,
              taskQueue: deps.taskQueue,
              store,
              taskId: args.taskId,
              turnId: args.agentTurnId,
              role: args.role,
              provider: profile.provider,
              title: args.task.title,
              projectId: args.task.projectId,
              heartbeat,
              signal,
            });
            try {
              await awaitAgentResources(heartbeat, signal, publishPressure);
            } catch (e) {
              await releaseSlot();
              releaseSlot = () => {};
              throw e;
            }
          } else releaseSlot = await acquireAgentSlot(heartbeat, signal);
        }
        // The workflow publishes `waiting-slot` immediately after the account grant;
        // only admission itself can truthfully report that the model is now running.
        await signalTurnState('running');
        publishLegacyAgentState('running');
        result = await runRuntimeTurn({ version: KARMAX_RUNTIME_PROTOCOL, input: {
          profile,
          world,
          messages,
          session,
          deliveredMessages,
          fork,
          systemPrompt,
          role: args.role,
          maxTurns: profile.maxTurns,
          ...(resolvedAuth ? { resolvedAuth } : {}),
          // Git-profile credentials for the agent subprocess (PLAN-git-config.md
          // §4B): an agent that pushes or runs `gh` acts as the project's account.
          ...(() => {
            // Remote provider tools receive repository credentials through the
            // broker, but the local harness process must still have host Git
            // credentials scrubbed for non-personal organizations.
            const gitEnv = isRemote(args.worldHandle.kind) && organizationId === 'org_personal'
              ? {}
              : gitEnvFor(args.worldHandle, args.taskId);
            // Granted `auto` vault items materialize into the subprocess env
            // (PLAN-passwords.md §5A): .env bags, API keys under their envVar,
            // SSH keys as 0600 file paths. Local worlds only, like gitEnv.
            // Item resolution is per-organization (the tenant boundary), so bind
            // to the task's org — not the module-level personal-org instance.
            const vaultEnv = isRemote(args.worldHandle.kind) ? {} : orgVaultItems.envFor(args.taskId, effective);
            // The platform MCP subprocess inherits this short-lived workflow
            // token. The gateway accepts it directly and enforces its project +
            // capability grant; no full-power browser session is ever acquired.
            const extraEnv = { ...vaultEnv, ...gitEnv, ...(token ? { KARMAX_TOKEN: token } : {}) };
            // Values are resolved from resource leases and broker handles only
            // now, at the activity/subprocess boundary. Keep them separate so a
            // remote adapter can explicitly allowlist only these names.
            const secretEnv = deps.resources?.environmentFor(world.handle) ?? {};
            return {
              ...(Object.keys(extraEnv).length ? { extraEnv } : {}),
              ...(Object.keys(secretEnv).length ? { secretEnv } : {}),
            };
          })(),
          // MCP servers the workflow gives its agents (SPEC §7.5).
          ...(args.task.workflow ? { agentMcp: manifest(args.task.workflow)?.agentMcp } : {}),
        } },
        {
          adapters: deps.adapters,
          signal,
          heartbeat,
          pullFollowUps,
          // Coalesce the live-output stream: adapters re-emit the growing *cumulative*
          // message text, so consecutive identical/prefix emits carry no new info.
          // Dropping them cuts the single biggest events-table growth driver
          // (one row per chunk) without changing what the UI renders.
          onEmit: (t) => {
            if (t === lastEmit) return;
            lastEmit = t;
            record(args.taskId, 'agent.output', { text: t });
          },
          onActivity: (activity) => {
            record(args.taskId, 'agent.activity', {
              ...activity,
              role: args.role,
              attempt: activityAttempt,
              ...(args.agentTurnId ? { turnId: args.agentTurnId } : {}),
            });
          },
          // Publish the session id + its home the moment the adapter knows it (mid-turn),
          // so the drawer's live "fork this agent" command appears WHILE the turn runs,
          // not only at turn-end (RESOLVE-PLAN #3). Fire-once per session in the adapters.
          onSession: (s) => {
            hbSession = s; // heartbeats now carry it → a retry resumes this session
            if (turnSessionKey) store.kvSet(turnSessionKey, s);
            // Do not wait for the 10-second liveness interval: checkpoint the newly
            // minted provider session immediately so a restart on the next instruction
            // still resumes this exact turn.
            heartbeat?.();
            store.kvSet(`session:${conversationTaskId}:${args.role}`, s);
            store.kvSet(
              `sessionmeta:${conversationTaskId}:${args.role}`,
              JSON.stringify({
                home: resolvedAuth?.configHome ?? '',
                provider: profile.provider,
                ...(profile.model ? { model: profile.model } : {}),
                ...(profile.effort ? { effort: profile.effort } : {}),
              }),
            );
            record(args.taskId, 'session.started', { role: args.role });
          },
          ...(deps.payments
            ? {
                budget: new BudgetService(store, deps.paymentRegistry ?? deps.payments),
                spendCtx: {
                  projectId: args.task.projectId,
                  taskId: args.taskId,
                  organizationId: store.getProject(args.task.projectId)?.organizationId,
                  capabilities: args.task.grant,
                },
                onSpend: (req: any, outcome: any) => record(args.taskId, 'spend.requested', { ...req, status: outcome.status, reason: outcome.reason }),
                fillPaymentCard: async (fill: {
                  requestId: string;
                  cdpUrl: string;
                  selectors: import('../autonomy/card-fill.js').CardFillSelectors;
                }) => {
                  const request = store.getPaymentSpendRequest(fill.requestId);
                  // A webhook rail reserves ('authorized'); an immediate rail has
                  // already drawn the spend down ('settled'). Both are fillable.
                  if (!request || request.taskId !== args.taskId
                    || !['authorized', 'settled'].includes(request.status))
                    throw new Error('payment request is not an active reservation for this task');
                  const card = request.cardId ? store.getCard(request.cardId) : undefined;
                  if (!card) throw new Error('secure fill requires a reserved card');
                  // Any rail that can resolve a card's secret half is fillable; the
                  // mock rail deliberately cannot, because it moves no real money.
                  const provider = deps.paymentRegistry?.forCard(card as any);
                  if (!provider?.retrieveCardDetails)
                    throw new Error(`the ${card.provider} rail has no card that can be filled into a checkout`);
                  const rawMerchant = String(request.merchant ?? '').trim();
                  let domain = '';
                  try {
                    domain = new URL(rawMerchant.includes('://') ? rawMerchant : `https://${rawMerchant}`).hostname;
                  } catch {}
                  if (!domain || !domain.includes('.'))
                    throw new Error('request_spend merchant must be the checkout domain before a card can be filled');
                  if (!fill.selectors.number || !fill.selectors.cvc
                    || (!fill.selectors.expiry && !(fill.selectors.expMonth && fill.selectors.expYear)))
                    throw new Error('number, CVC, and either combined expiry or month/year selectors are required');
                  const details = await provider.retrieveCardDetails(card.id);
                  const expected = [domain];
                  let origin: string;
                  if (isRemote(world.handle.kind) || world.handle.kind === 'container') {
                    origin = (await fillCardInWorld(world, {
                      cdpUrl: fill.cdpUrl, domain, selectors: fill.selectors, details,
                    })).origin;
                  } else {
                    origin = (await fillViaCdp({ cdpUrl: fill.cdpUrl, selector: fill.selectors.number,
                      text: details.number, expectDomains: expected })).origin;
                    const month = String(details.expMonth).padStart(2, '0');
                    if (fill.selectors.expiry) {
                      origin = (await fillViaCdp({ cdpUrl: fill.cdpUrl, selector: fill.selectors.expiry,
                        text: `${month}/${String(details.expYear).slice(-2)}`, expectDomains: expected })).origin;
                    } else {
                      origin = (await fillViaCdp({ cdpUrl: fill.cdpUrl, selector: fill.selectors.expMonth!,
                        text: month, expectDomains: expected })).origin;
                      origin = (await fillViaCdp({ cdpUrl: fill.cdpUrl, selector: fill.selectors.expYear!,
                        text: String(details.expYear), expectDomains: expected })).origin;
                    }
                    origin = (await fillViaCdp({ cdpUrl: fill.cdpUrl, selector: fill.selectors.cvc,
                      text: details.cvc, expectDomains: expected })).origin;
                    // Billing fields, where the card carries one and the form asks.
                    for (const field of BILLING_FIELDS) {
                      const selector = fill.selectors[field];
                      const value = details.billing?.[field];
                      if (selector && value) origin = (await fillViaCdp({ cdpUrl: fill.cdpUrl,
                        selector, text: value, expectDomains: expected })).origin;
                    }
                  }
                  store.appendAudit({ principalId: `task:${args.taskId}`, action: 'payment.card.filled',
                    detail: { taskId: args.taskId, requestId: request.id, cardId: card.id, origin } });
                  return { filled: true as const, origin };
                },
              }
            : {}),
          ...(token
            ? {
                platformRequest: async (method: string, requestPath: string, body?: unknown) => {
                  if (!requestPath.startsWith('/api/')) throw new Error('platform path must start with /api/');
                  const base = process.env.KARMAX_GATEWAY_URL ?? 'http://127.0.0.1:4505';
                  const response = await fetch(`${base}${requestPath}`, {
                    method,
                    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                  });
                  const value = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
                  if (!response.ok) throw new Error((value as any)?.error ?? `HTTP ${response.status}`);
                  return value;
                },
              }
            : {}),
        },
        );
        // Defence in depth around the activity boundary. `runTurn` rejects an
        // adapter return after abort, but cancellation can race the few synchronous
        // instructions between that check and this await continuation. Never report
        // a normal Temporal activity result once shutdown/cancellation is visible.
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('agent turn cancelled');
        }
        if (confirmTranscript) {
          if (result.output?.trim()) confirmTranscript.push({ id: `${args.taskId}:out:${confirmTranscript.length}`, role: 'agent', text: result.output, ts: confirmTranscript.length });
          if (result.confirmDecision) {
            const d = result.confirmDecision;
            confirmTranscript.push({ id: `${args.taskId}:decision:${confirmTranscript.length}`, role: 'system', text: `confirm_decision: ${d.action}${d.text ? ` — ${d.text}` : ''}`, ts: confirmTranscript.length });
          }
          store.kvSet(`confirm-transcript:${conversationTaskId}`, JSON.stringify(confirmTranscript));
        }
      } catch (err) {
        if (token) deps.tokens?.revoke(token);
        // Providers often surface their own generic AbortError after the activity
        // cancellation signal fires. Throw Temporal's cancellation reason instead
        // so WAIT_CANCELLATION_COMPLETED records an acknowledged cancellation,
        // rather than turning a user cancel into an ordinary workflow failure.
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : err;
        }
        throw classifyTurnError(err, profile.provider);
      } finally {
        await releaseSlot();
        releaseConfirm();
        publishLegacyAgentState(undefined);
      }
      if (token) deps.tokens?.revoke(token);
      // Persist the session id so other tasks can resume from this one (§10.5), plus
      // which config home + provider minted it — provider sessions are home-bound, so
      // the CLI resume-command needs the right CONFIG_DIR/CODEX_HOME (§2.5, #2/#3).
      if (result.session) {
        store.kvSet(`session:${conversationTaskId}:${args.role}`, result.session);
        store.kvSet(
          `sessionmeta:${conversationTaskId}:${args.role}`,
          JSON.stringify({
            home: resolvedAuth?.configHome ?? '',
            provider: profile.provider,
            ...(profile.model ? { model: profile.model } : {}),
            ...(profile.effort ? { effort: profile.effort } : {}),
          }),
        );
      }

      // A branch the agent added with `create_branch` exists on disk now, but the
      // DURABLE handle is what merge, the PR stage and check-in re-open the world
      // from — so persist it here as well as returning it for the workflow to
      // adopt. Recorded before the turn result is consumed, so a checkout can
      // never be live on disk yet invisible to the stages that must land it.
      if (result.worldHandle?.repos?.length) {
        try {
          store.updateWorldCheckouts(args.worldHandle, result.worldHandle.repos);
          record(args.taskId, 'world.checkout_added', {
            checkouts: result.worldHandle.repos.map((repo) => ({ name: repo.name, branch: repo.branch, base: repo.base })),
          });
        } catch (error) {
          // A stale generation means this turn's world was already replaced; the
          // branch belongs to a world nobody will merge, so say so rather than
          // failing a turn whose actual work succeeded.
          record(args.taskId, 'world.checkout_orphaned', { error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (result.skills?.length) {
        for (const s of result.skills) record(args.taskId, 'skill.saved', { name: s.name });
      }
      record(args.taskId, 'turn.result', {
        completed: result.completed,
        providerCompleted: result.providerCompleted,
        providerTermination: result.providerTermination,
        subTasks: result.subTasks?.length ?? 0,
        hasReview: !!result.reviewInfo,
        output: result.output.slice(0, 2000),
      });
      return result;
    },

    /** Auto-derive the changed-files summary so Review always shows what changed
     *  (§5.5). Diffs are intentionally NOT computed — they were removed from the
     *  review packet; reviewers use the changed-files list + the in-world terminal. */
    async buildReview(handle: WorldHandle, base: string): Promise<{ summary: string; changedFiles: string[] }> {
      const world = await openWorld(handle);
      const repos = worldRepos(handle);
      const roots = repos.length ? repos : [{ name: '', root: handle.root }];
      const developmentRepos = repos.filter((repo) => repo.role !== 'project-wiki');
      const changedFiles: string[] = [];
      for (const repo of roots) {
        const repoBase = 'base' in repo ? repo.base : base;
        // Diff from the FORK POINT, not the base branch's current tip. `base` is a
        // live ref: while this world is open, other tasks merge into it, and a
        // two-dot `git diff <base>` would report their files as this task's work
        // (they feed the confirmer's review packet, so a reviewer would be shown —
        // and asked to approve — changes the task never made). The merge-base is
        // resolved to a commit so the comparison still includes the worktree, which
        // `<base>...HEAD` would drop along with every uncommitted change.
        const forkPoint = await world.exec('git', ['merge-base', repoBase, 'HEAD'], { cwd: repo.root });
        const since = forkPoint.code === 0 && forkPoint.stdout.trim() ? forkPoint.stdout.trim() : repoBase;
        const tracked = await world.exec('git', ['diff', '--name-only', since], { cwd: repo.root });
        const untracked = await world.exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo.root });
        // A companion wiki must not make the sole development checkout appear
        // artificially nested. Keep a stable prefix for wiki changes, while
        // genuine multi-development-repo worlds retain repository prefixes.
        const prefix = 'role' in repo && repo.role === 'project-wiki'
          ? `${repo.name}/`
          : developmentRepos.length > 1
            ? `${repo.name}/`
            : '';
        changedFiles.push(
          ...tracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map((file) => `${prefix}${file}`),
          ...untracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map((file) => `${prefix}${file} (new)`),
        );
      }
      const summary = changedFiles.length ? `${changedFiles.length} file(s) changed.` : 'No file changes detected.';
      record(handle.id, 'review.built', { files: changedFiles.length });
      return { summary, changedFiles };
    },

    /** Read-only readiness check for the explicit Open PR transition. The Do
     * agent owns commit-vs-ignore judgment; machinery only refuses to publish a
     * proposal that still has unresolved or uncommitted state. */
    async checkProposal(handle: WorldHandle): Promise<{
      ready: boolean;
      dirty?: string;
      conflict?: string;
      note?: string;
    }> {
      const world = await openWorld(handle);
      const dirty: string[] = [];
      const conflicts: string[] = [];
      for (const repo of worldRepos(world.handle)) {
        const unresolved = await world.exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo.root });
        if (unresolved.stdout.trim()) {
          conflicts.push(...unresolved.stdout.trim().split('\n').filter(Boolean).map((file) => `${repo.name}/${file}`));
        }
        const status = await world.exec('git', ['status', '--porcelain'], { cwd: repo.root });
        if (status.code !== 0) {
          return { ready: false, note: `could not inspect checkout "${repo.name}": ${status.stderr || status.stdout || 'git status failed'}` };
        }
        dirty.push(...status.stdout.split('\n').filter(Boolean).map((line) => `${repo.name}/${line.slice(3).trim()}`));
      }
      if (conflicts.length) {
        return { ready: false, conflict: [...new Set(conflicts)].join('\n'), note: 'the proposal has unresolved merge conflicts' };
      }
      if (dirty.length) {
        return { ready: false, dirty: [...new Set(dirty)].join('\n'), note: 'the proposal has uncommitted changes' };
      }
      return { ready: true };
    },

    async finalizeMergeActivity(handle: WorldHandle, target: string): Promise<MergeResult> {
      const world = await openWorld(handle);
      // Merge commits carry the world's profile identity too (PLAN-git-config.md
      // §4A) — they land on the target, where worktree-scoped config doesn't reach.
      let identity;
      const profileName = handle.meta?.gitProfile;
      if (typeof profileName === 'string' && profileName) {
        try {
          const binding = gitBindingFromHandle(handle, handle.id);
          identity = binding.profile ? binding.profiles.identity(binding.profile, { taskId: handle.id }) : undefined;
        } catch {
          identity = undefined; // fall back to ensureIdentity inside finalizeMerge
        }
      }
      const result = isRemote(handle.kind)
        ? await brokerFinalizeMerge(world, target, identity, brokerAuthFor(handle, handle.id))
        : await finalizeMerge(world, target, identity);
      record(handle.id, 'merge.result', { merged: result.merged, sha: result.sha, conflict: result.conflict, dirty: result.dirty });
      return result;
    },

    async runScript(args: { taskId: string; worldHandle: WorldHandle; command: string }): Promise<{ code: number; output: string }> {
      const world = await openWorld(args.worldHandle, args.taskId);
      record(args.taskId, 'script.start', { command: args.command });
      const r = await world.exec('bash', ['-lc', args.command], { timeoutMs: 30 * 60_000 });
      const output = `${r.stdout}${r.stderr}`;
      record(args.taskId, 'script.done', { code: r.code, output: output.slice(0, 4000) });
      return { code: r.code, output };
    },

    async runWorkflowChecks(args: { taskId: string; worldHandle: WorldHandle }): Promise<{ passed: boolean; detail?: string }> {
      const world = await openWorld(args.worldHandle, args.taskId);
      const hasPkg = (await world.exec('bash', ['-lc', 'test -f package.json && echo yes || echo no'])).stdout.includes('yes');
      if (!hasPkg) {
        record(args.taskId, 'checks.skip', { reason: 'no package.json' });
        return { passed: true, detail: 'no test suite found' };
      }
      const r = await world.exec('bash', ['-lc', 'npm test --silent 2>&1 | tail -40'], { timeoutMs: 10 * 60_000 });
      record(args.taskId, 'checks.done', { code: r.code });
      if (r.code !== 0) return { passed: false, detail: r.stdout.slice(-600) };

      // SPEC §4.4's replay gate is literal: fetch every currently-running history
      // and compare the candidate bundle with the bundle serving production now.
      // Pre-existing incompatibilities are reported but do not make unrelated edits
      // impossible; any history that regresses from baseline-pass to candidate-fail
      // blocks the merge.
      if (!deps.client) return { passed: false, detail: 'tests passed, but replay compatibility could not run: no Temporal client' };

      // INTENDED: the replay gate applies only to a repo that actually carries a
      // karmax workflow bundle. `propose_workflow_edit` also targets external
      // workflow *package* repos, which declare their own entrypoint and have no
      // `src/workflows/index.ts` — blocking those for a "missing bundle" made the
      // package flow unusable. Probe INSIDE the world so the answer is identical
      // on a remote sandbox, where the host cannot see the world's files at all.
      const bundleRel = path.posix.join('src', 'workflows', 'index.ts');
      const hasBundle = (await world.exec('bash', ['-lc', `test -f ${bundleRel} && echo yes || echo no`])).stdout.includes('yes');
      if (!hasBundle) {
        record(args.taskId, 'checks.replay', { skipped: 'repo carries no karmax workflow bundle' });
        return { passed: true, detail: 'tests passed; replay gate does not apply (this repo carries no karmax workflow bundle)' };
      }

      // The Temporal replay bundler needs a real HOST filesystem tree. A remote
      // world's `root` is a path inside the provider sandbox, so `fs` on it always
      // missed and every hosted workflow edit failed the gate with a misleading
      // "bundle is missing". Mirror the candidate sources out in ONE exec (a
      // per-file download over the provider API is hundreds of round-trips) and
      // borrow the running install's node_modules for module resolution.
      let mirror: string | undefined;
      let candidatePath = path.join(args.worldHandle.root, 'src', 'workflows', 'index.ts');
      if (isRemote(args.worldHandle.kind)) {
        mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-replay-'));
        const packed = await world.exec('bash', ['-lc', 'tar czf - src package.json | base64 -w0'], { timeoutMs: 5 * 60_000 });
        if (packed.code !== 0) {
          fs.rmSync(mirror, { recursive: true, force: true });
          return { passed: false, detail: `tests passed, but the candidate sources could not be read from the remote world: ${(packed.stderr || packed.stdout).slice(-400)}` };
        }
        fs.writeFileSync(path.join(mirror, 'src.tgz'), Buffer.from(packed.stdout.trim(), 'base64'));
        try {
          await pexec('tar', ['xzf', 'src.tgz'], { cwd: mirror });
        } catch (e) {
          fs.rmSync(mirror, { recursive: true, force: true });
          return { passed: false, detail: `tests passed, but the candidate sources could not be unpacked: ${(e instanceof Error ? e.message : String(e)).slice(-400)}` };
        }
        // Symlink rather than install: the candidate is a karmax checkout, so the
        // running install's dependencies are exactly the ones its imports resolve to.
        fs.symlinkSync(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(mirror, 'node_modules'));
        candidatePath = path.join(mirror, 'src', 'workflows', 'index.ts');
      }
      try {
        if (!fs.existsSync(candidatePath)) return { passed: false, detail: `tests passed, but candidate workflow bundle is missing: ${candidatePath}` };
        const histories: Array<{ workflowId: string; history: unknown }> = [];
        for await (const execution of deps.client.workflow.list({ query: "ExecutionStatus='Running'" })) {
          histories.push({ workflowId: execution.workflowId, history: await deps.client.workflow.getHandle(execution.workflowId, execution.runId).fetchHistory() });
        }
        const { Worker } = await import('@temporalio/worker');
        const replay = async (workflowsPath: string) => {
          const failures = new Map<string, string>();
          for await (const result of Worker.runReplayHistories({ workflowsPath }, histories)) {
            if (result.error) failures.set(result.workflowId, result.error.message);
          }
          return failures;
        };
        const baselinePath = fileURLToPath(new URL('../workflows/index.ts', import.meta.url));
        const baselineFailures = await replay(baselinePath);
        const candidateFailures = await replay(candidatePath);
        const regressions = [...candidateFailures.entries()].filter(([id]) => !baselineFailures.has(id));
        const fixed = [...baselineFailures.keys()].filter((id) => !candidateFailures.has(id));
        const existing = [...candidateFailures.keys()].filter((id) => baselineFailures.has(id));
        record(args.taskId, 'checks.replay', {
          histories: histories.length,
          regressions: regressions.map(([id]) => id),
          preExisting: existing,
          fixed,
        });
        if (regressions.length) {
          const detail = regressions.map(([id, error]) => `${id}: ${error}`).join('\n');
          return { passed: false, detail: `tests passed; replay REGRESSED ${regressions.length}/${histories.length} active histories:\n${detail}`.slice(-4000) };
        }
        return {
          passed: true,
          detail: `tests + replay passed (${histories.length} active histories; ${existing.length} pre-existing incompatibilities${fixed.length ? `; ${fixed.length} repaired` : ''})`,
        };
      } catch (e) {
        return { passed: false, detail: `tests passed, but replay compatibility failed to run: ${e instanceof Error ? e.message : String(e)}` };
      } finally {
        if (mirror) fs.rmSync(mirror, { recursive: true, force: true });
      }
    },

    /**
     * Head commit of every checkout in the world, keyed by checkout name.
     *
     * Review approval for a multi-PR task is bound to `(checkout, head sha)`
     * (PLAN-multi-pr.md §3), so the gate needs the heads to tell an approval that
     * still stands from one the Do agent has since invalidated. A branch whose
     * head cannot be read is simply absent, which the domain helpers treat as
     * unapproved — the gate fails closed rather than passing by omission.
     */
    async checkoutHeads(handle: WorldHandle): Promise<Record<string, string>> {
      const world = await openWorld(handle);
      const heads: Record<string, string> = {};
      for (const repo of worldRepos(world.handle)) {
        const head = await world.exec('git', ['rev-parse', 'HEAD'], { cwd: repo.root }).catch(() => undefined);
        if (head?.code === 0 && head.stdout.trim()) heads[repo.name] = head.stdout.trim();
      }
      return heads;
    },

    async commitWork(handle: WorldHandle, message: string): Promise<{ committed: boolean; sha?: string }> {
      const world = await openWorld(handle);
      const repos = worldRepos(world.handle);
      const roots = repos.length ? repos.map((repo) => repo.root) : [world.handle.root];
      let committed = true;
      let sha: string | undefined;
      for (const root of roots) {
        const add = await world.exec('git', ['add', '-A'], { cwd: root });
        const commit = add.code === 0 ? await world.exec('git', ['commit', '-q', '-m', message], { cwd: root }) : add;
        const head = await world.exec('git', ['rev-parse', 'HEAD'], { cwd: root });
        const nothing = /nothing to commit|no changes added/i.test(`${commit.stdout}${commit.stderr}`);
        committed &&= add.code === 0 && (commit.code === 0 || nothing) && head.code === 0;
        sha = head.stdout.trim() || sha;
      }
      record(handle.id, 'work.committed', { committed, repos: roots.length });
      return { committed, sha };
    },

    /** Persist a cloud task branch before releasing its sandbox. Unlike the
     * best-effort post-merge push policy, this is the only durable copy of a
     * just-do world's result, so any skipped repository is a hard failure. */
    async publishTaskBranch(handle: WorldHandle): Promise<{ pushed: string[] }> {
      if (!isRemote(handle.kind)) return { pushed: [] };
      const world = await openWorld(handle);
      const result = await brokerPublishBranch(world, brokerAuthFor(handle, handle.id));
      if (!result.pushed.length || result.skipped.length) {
        throw new Error(`cloud task branch was not persisted${result.skipped.length ? ` for: ${describePublishFailures(result)}` : ' because it has no remote repository'}`);
      }
      record(handle.id, 'push.branch', { branch: handle.branch, repos: result.pushed });
      return { pushed: result.pushed };
    },

    async destroyWorld(handle: WorldHandle): Promise<void> {
      const current = (store.currentWorld(handle.id) ?? handle) as WorldHandle;
      const leaseId = typeof current.meta?.worldLeaseId === 'string' ? current.meta.worldLeaseId : undefined;
      try {
        await deps.resources?.release(current);
        const world = await worlds.open(handle);
        await world.destroy();
        store.setWorldState((store.currentWorld(handle.id) ?? current) as WorldHandle, 'released');
        record(handle.id, 'world.destroyed', {});
      } catch (error) {
        // The provider may be unavailable while its own timeout is evicting the
        // sandbox. Do not retain admission capacity forever; keep the durable
        // world degraded so operations can see/retry the incomplete teardown.
        store.setWorldState((store.currentWorld(handle.id) ?? current) as WorldHandle, 'degraded');
        record(handle.id, 'world.destroy_failed', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        await destroyWorldServices(handle.id).catch(() => undefined);
        if (leaseId) deps.runners?.release(leaseId, current.kind);
      }
    },

    /**
     * The PR stage under remote policy 'pr' (SPEC §5.2, PLAN-git-config.md §5):
     * push every repo's task branch and open — or update — its pull request.
     *
     * Idempotent by construction: the PR is keyed on the task branch, so a
     * retried stage, a follow-up that reopened Do, or a replacement execution
     * all land on the same PR with a refreshed title/body. Unlike the earlier
     * best-effort `gh` path, a policy that asks for PRs and cannot get one is an
     * error the human is told about (through Resolve), not a silent skip.
     */
    async openPr(handle: WorldHandle, target: string, details: OpenPrDetails = {}): Promise<TaskPullRequest[]> {
      const world = await openWorld(handle);
      const repos = worldRepos(world.handle);
      const targets = await githubPrTargets(world, handle);
      if (!targets.length) {
        throw new Error('remote policy "pr" is on, but no repository in this world has a GitHub origin remote'
          + ' — set the project\'s remote policy to "push"/"none", or give the repository a github.com origin');
      }
      const changed: Array<(typeof targets)[number] & { base: string }> = [];
      for (const { repo, slug, api } of targets) {
        // A checkout whose base is a SIBLING's branch is a stacked pull request:
        // open it against that branch so GitHub renders the stack and its diff
        // shows only this branch's own change, not the base's as well.
        const stacked = repos.some((other) => other !== repo && other.branch === repo.base);
        const base = stacked ? repo.base : worldRepoTarget(repo, target);
        // karmax's own model lets a worktree stay dirty until the merge stage
        // (PLAN-git-config.md §6 loops that back to the merge agent), so arriving
        // here with nothing committed is a state the design produces. GitHub
        // answers it with an opaque 422 — diagnose it ourselves instead.
        const ahead = await world.exec('git', ['rev-list', '--count', `${base}..${repo.branch}`], { cwd: repo.root });
        if (ahead.code !== 0) {
          throw new Error(`could not compare branch "${repo.branch}" of repo "${repo.name}" with "${base}":`
            + ` ${ahead.stderr || ahead.stdout || 'git rev-list failed'}`);
        }
        if (ahead.stdout.trim() === '0') {
          record(handle.id, 'pr.skipped', { repo: repo.name, reason: `no commits ahead of ${base}` });
          continue;
        }
        changed.push({ repo, slug, api, base });
      }
      // No committed proposal is a successful PR no-op, even when EVERY checkout
      // is unchanged. Historical workflow pins (notably softwareDev@1.10.0) can
      // legitimately reach this activity with a dirty-but-uncommitted branch and
      // have their already-recorded Merge stage prepare it afterwards. Failing
      // here strands those executions before the Merge agent can do its job.
      // Current workflows prepare before PR, while finalizeMergeActivity still
      // rejects dirty worktrees, so returning [] neither loses work nor weakens
      // the protected-target merge invariant.
      const pushed = await pushTaskBranches(world, handle, gitEnvFor(handle, handle.id), changed.map(({ repo }) => repo));
      const opened: TaskPullRequest[] = [];
      for (const { repo, slug, api, base } of changed) {
        if (!pushed.pushed.includes(repo.name)) {
          throw new Error(`could not push branch "${repo.branch}" of repo "${repo.name}" to origin`
            + `${pushed.errors?.[repo.name] ? `: ${pushed.errors[repo.name]}` : ''}`);
        }
        const { pr, created } = await api.openOrUpdate(slug, {
          head: repo.branch, base,
          // With several branches in flight the task title alone names none of
          // them; say which pull request this one is.
          title: changed.length > 1
            ? `${details.title?.trim() || 'karmax'} (${repo.name})`
            : details.title?.trim() || `karmax: ${repo.branch}`,
          body: prBody(handle, details, store.getTask(handle.id)?.num, changed.length > 1 ? repo.name : undefined),
        });
        const ref: TaskPullRequest = {
          repo: repo.name, slug, number: pr.number, url: pr.url, state: pr.state, merged: pr.merged,
          ...(pr.headSha ? { headSha: pr.headSha } : {}),
          ...(pr.nodeId ? { nodeId: pr.nodeId } : {}),
        };
        record(handle.id, created ? 'pr.opened' : 'pr.updated', { ...ref, base });
        opened.push(ref);
      }
      return opened;
    },

    /**
     * GitHub-authoritative merge for current PR-policy workflows.
     *
     * krmax first selects a consenting human (the creator or someone who
     * confirmed a human Review layer), then checks that person's repository
     * role live. Current tasks enter GitHub's native queue or atomically
     * fast-forward the target to the exact validated head; historical versions
     * retain direct PR merge behavior. The App installation is intentionally
     * not a candidate: it may transport task branches, but it must not bypass a
     * person's merge rights.
     */
    async mergeGithubPrs(handle: WorldHandle, prs: TaskPullRequest[], options?: { mode?: 'submit' | 'observe' }): Promise<GitHubMergeAuthorization> {
      // A PR-policy task may legitimately make no changes. There is nothing
      // external to authorize in that case, so do not manufacture a human gate.
      if (!prs.length) return { status: 'merged', prs };
      const task = store.getTask(handle.id);
      if (!task || !deps.githubApp) {
        return { status: 'needs-authorizer', prs, detail: 'GitHub is not connected for human-attributed merges.' };
      }
      const workflowMinor = Number(String(task.workflowVersion ?? '').split('.')[1] ?? 0);
      const classifiedGithubStates = workflowMinor >= 14;
      const intentAuthorizedLanding = workflowMinor >= 15;
      const observeOnly = intentAuthorizedLanding && options?.mode === 'observe';
      const creator = store.taskCreatorUserId(handle.id);
      const events = store.eventsSince(handle.id, 0);
      const eventAuthorizesCurrentHeads = (event: { payload?: any }) => {
        const heads = event.payload?.githubPrHeads;
        return Array.isArray(heads) && prs.filter((ref) => !ref.merged).every((ref) =>
          Boolean(ref.headSha) && heads.some((head: any) => head?.slug === ref.slug
            && Number(head?.number) === ref.number && head?.headSha === ref.headSha));
      };
      const latestRevocation = intentAuthorizedLanding
        ? events.map((event, index) => ({ event, index }))
          .filter(({ event }) => event.type === 'github.merge.authorization-revoked').at(-1)?.index ?? -1
        : -1;
      const authorizationEvents = events.slice(latestRevocation + 1);
      const currentHeadVoters = authorizationEvents
        .filter((event) => event.type === 'task.confirmation-voted'
          && event.payload?.satisfied !== false && event.payload?.githubMergeAuthorized === true
          && eventAuthorizesCurrentHeads(event))
        .map((event) => typeof event.payload?.userId === 'string' ? event.payload.userId : undefined)
        .filter((userId): userId is string => Boolean(userId));
      const voters = intentAuthorizedLanding
        ? authorizationEvents
          .filter((event) => event.type === 'task.confirmation-voted'
            && event.payload?.satisfied !== false
            && (event.payload?.githubMergeIntentAuthorized === true
              || (event.payload?.githubMergeAuthorized === true && eventAuthorizesCurrentHeads(event))))
          .map((event) => typeof event.payload?.userId === 'string' ? event.payload.userId : undefined)
          .filter((userId): userId is string => Boolean(userId))
        : currentHeadVoters;
      // The most recent Review decision is the clearest explicit consent. The
      // creator remains a valid sponsor when a task auto-confirms or uses an
      // agent reviewer, but never after GitHub reports that the reviewed head
      // moved: that replacement needs an exact-head human confirmation too.
      const requiresFreshReview = !intentAuthorizedLanding && events.some((event) => event.type === 'github.merge.review-stale'
        && prs.some((ref) => event.payload?.slug === ref.slug && event.payload?.number === ref.number
          && event.payload?.liveHead === ref.headSha));
      const candidates = [...new Set([
        ...voters.reverse(), ...(!requiresFreshReview && creator ? [creator] : []),
      ])];
      const accountFor = (userId: string) => userId === creator
        ? (typeof task.params?._githubAccountId === 'string' ? task.params._githubAccountId : deps.githubApp!.activeUserAccountId(userId))
        : deps.githubApp!.activeUserAccountId(userId);

      let actorUserId: string | undefined;
      let actorPermissions = new Map<string, GitHubRepositoryPermission>();
      for (const userId of candidates) {
        const accountId = accountFor(userId);
        if (!accountId) continue;
        let eligible = true;
        const permissions = new Map<string, GitHubRepositoryPermission>();
        for (const ref of prs.filter((candidate) => !candidate.merged)) {
          const permission = await deps.githubApp.repositoryPermission(userId, ref.slug, accountId).catch(() => undefined);
          if (!permission?.canMerge) { eligible = false; break; }
          permissions.set(ref.slug, permission);
        }
        if (eligible) { actorUserId = userId; actorPermissions = permissions; break; }
      }

      if (!actorUserId) {
        const eligibleUserIds: string[] = [];
        // This scan is advisory only (for the reviewer picker). Revalidation
        // above always happens again immediately before a real merge request.
        for (const userId of store.humanAudience(handle.id, ['@project'])) {
          const accountId = deps.githubApp.activeUserAccountId(userId);
          if (!accountId) continue;
          const checks = await Promise.all(prs.filter((ref) => !ref.merged).map((ref) =>
            deps.githubApp!.repositoryPermission(userId, ref.slug, accountId).catch(() => undefined)));
          if (checks.length && checks.every((permission) => permission?.canMerge)) eligibleUserIds.push(userId);
        }
        record(handle.id, 'github.merge.authorization-required', { eligibleUserIds, repositories: prs.map((ref) => ref.slug) });
        return {
          status: 'needs-authorizer', prs,
          detail: eligibleUserIds.length
            ? 'The task creator cannot merge these pull requests. Ask a listed project member with GitHub merge access to confirm the merge.'
            : 'No connected project member currently has GitHub merge access for every pull request.',
          eligibleUserIds,
        };
      }

      const accountId = accountFor(actorUserId);
      const api = prApiForUser(actorUserId, accountId);
      const settled: TaskPullRequest[] = [];
      let lastSha: string | undefined;
      let queued = false;
      let pendingDetail: string | undefined;
      const errorDecision = (error: unknown, current: TaskPullRequest[]): GitHubMergeAuthorization => {
        const detail = error instanceof Error ? error.message : String(error);
        const rateLimited = error instanceof GithubApiError
          && (error.status === 429 || (error.status === 403 && /rate.?limit|secondary limit|abuse/i.test(detail)));
        if (!rateLimited && error instanceof GithubApiError && (error.status === 401 || error.status === 403)) {
          return {
            status: 'needs-authorizer', prs: current, actorUserId,
            detail: `${detail} Reconnect GitHub or ask another selected project member with merge access to continue.`,
          };
        }
        if (error instanceof GithubApiError && [404, 410, 422].includes(error.status)) {
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `${detail} The pull request or branch needs human attention on GitHub before krmax can continue.`,
          };
        }
        return {
          status: 'retryable-error', prs: current, actorUserId,
          detail: `GitHub could not be inspected or updated: ${detail}`,
        };
      };
      const ciFailureDetail = (ref: TaskPullRequest, readiness: GithubPullRequestReadiness) => {
        const failures = (readiness.failedChecks ?? []).slice(0, 12).map((check) => {
          const detail = check.detail?.replace(/\s+/g, ' ').trim();
          return `- ${check.name}: ${check.state}${check.url ? ` (${check.url})` : ''}${detail ? ` — ${detail.slice(0, 500)}` : ''}`;
        });
        return [
          `Pull request ${ref.slug}#${ref.number} has terminally failing CI (${readiness.checks}).`,
          ...(failures.length ? failures : ['GitHub did not expose an individual failed-check summary; inspect the PR checks page.']),
        ].join('\n');
      };
      for (const ref of prs) {
        let live;
        try {
          live = await api.get(ref.slug, ref.number);
        } catch (error) {
          if (!classifiedGithubStates) throw error;
          return errorDecision(error, [...settled, ref, ...prs.slice(settled.length + 1)]);
        }
        const next = {
          ...ref, state: live.state, merged: live.merged,
          ...(live.headSha ? { headSha: live.headSha } : {}),
          ...(live.nodeId ? { nodeId: live.nodeId } : {}),
        };
        if (live.merged) { lastSha = live.mergeCommitSha ?? lastSha; settled.push(next); continue; }
        const current = [...settled, next, ...prs.slice(settled.length + 1)];
        if (classifiedGithubStates && live.state === 'closed') {
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `Pull request ${ref.slug}#${ref.number} was closed without merging. Reopen it on GitHub and retry, send the task back to Do, or cancel it.`,
          };
        }
        if (!ref.headSha || !live.headSha || ref.headSha !== live.headSha) {
          record(handle.id, 'github.merge.review-stale', { ...ref, reviewedHead: ref.headSha, liveHead: live.headSha });
          if (intentAuthorizedLanding) {
            record(handle.id, 'github.merge.authorization-revoked', {
              ...ref, reason: 'head-changed-outside-repair', reviewedHead: ref.headSha, liveHead: live.headSha,
            });
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `Pull request ${ref.slug}#${ref.number} changed outside krmax's authorized repair cycle. Inspect the new head and send the proposal through human Review before landing.`,
              repair: { kind: 'head-changed', preserveAuthorization: false },
            };
          }
          return {
            status: 'stale-review', prs: [...settled, next, ...prs.slice(settled.length + 1)], actorUserId,
            detail: `Pull request ${ref.slug}#${ref.number} changed after Review. Review the new head before merging.`,
            eligibleUserIds: [actorUserId],
          };
        }
        // Current explicit-PR workflows classify GitHub's live policy state:
        // proposal failures return to Do, external decisions wait for a human,
        // and only genuinely transient checks/queues remain a polling wait.
        let readiness: GithubPullRequestReadiness | undefined;
        if (workflowMinor >= 13 && live.nodeId) {
          try {
            readiness = await api.readiness(ref.slug, ref.number);
          } catch (error) {
            if (classifiedGithubStates) return errorDecision(error, current);
          }
          if (readiness?.mergeable === 'CONFLICTING' || readiness?.mergeStateStatus === 'DIRTY') {
            return {
              status: 'needs-revision',
              prs: current,
              actorUserId,
              detail: intentAuthorizedLanding
                ? `Pull request ${ref.slug}#${ref.number} conflicts with the latest target or merge group. GitHub has ejected this entry; resolve it against the newest target and reopen it for automated integration review.`
                : `Pull request ${ref.slug}#${ref.number} conflicts with its target. Resolve it in the task branch, reopen the proposal, and review the new head.`,
              ...(intentAuthorizedLanding ? { repair: { kind: 'conflict' as const, preserveAuthorization: true } } : {}),
            };
          }
          if (classifiedGithubStates && readiness?.draft) {
            return {
              status: 'needs-human', prs: current, actorUserId,
              detail: `Pull request ${ref.slug}#${ref.number} is a draft. Mark it ready for review on GitHub and retry, send it back to Do, or cancel it.`,
            };
          }
          if (classifiedGithubStates && (readiness?.checks === 'FAILURE' || readiness?.checks === 'ERROR')) {
            return {
              status: 'needs-revision', prs: current, actorUserId, detail: ciFailureDetail(ref, readiness),
              ...(intentAuthorizedLanding ? { repair: { kind: 'ci' as const, preserveAuthorization: true } } : {}),
            };
          }
          if (classifiedGithubStates && readiness?.reviewDecision === 'CHANGES_REQUESTED') {
            if (intentAuthorizedLanding)
              record(handle.id, 'github.merge.authorization-revoked', { ...ref, reason: 'changes-requested' });
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `GitHub reviewers requested changes on pull request ${ref.slug}#${ref.number}. Inspect their review comments and update the proposal.`,
              ...(intentAuthorizedLanding ? { repair: { kind: 'changes-requested' as const, preserveAuthorization: false } } : {}),
            };
          }
          if (classifiedGithubStates && !intentAuthorizedLanding && readiness?.mergeStateStatus === 'BEHIND') {
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `Pull request ${ref.slug}#${ref.number} must be updated with its target branch before it can merge. Refresh the task branch, resolve any resulting conflict, and review the new head.`,
            };
          }
        }
        if (intentAuthorizedLanding && (readiness?.mergeQueueEntryId || readiness?.autoMerge)) {
          const entryIds = readiness.mergeQueueEntryId ? [readiness.mergeQueueEntryId] : [];
          return {
            status: 'queued', prs: current, actorUserId,
            detail: readiness.mergeQueueEntryId
              ? 'GitHub is validating this pull request in its merge queue.'
              : 'GitHub auto-merge is waiting for repository requirements.',
            providerQueue: { state: 'validating', ...(entryIds.length ? { entryIds } : {}) },
          };
        }
        const mirroredReviews = store.eventsSince(handle.id, 0).filter((event) =>
          event.type === 'github.pr.review-approved'
          && event.payload?.slug === ref.slug && event.payload?.number === ref.number
          && event.payload?.actorUserId === actorUserId);
        const alreadyMirrored = mirroredReviews.some((event) =>
          event.type === 'github.pr.review-approved'
          && event.payload?.slug === ref.slug && event.payload?.number === ref.number
          && event.payload?.headSha === ref.headSha && event.payload?.actorUserId === actorUserId);
        const exactHeadConfirmed = currentHeadVoters.includes(actorUserId);
        if (intentAuthorizedLanding && readiness?.reviewDecision === 'REVIEW_REQUIRED'
          && mirroredReviews.length > 0 && !exactHeadConfirmed) {
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `Repository policy requires a fresh human approval of repaired pull request ${ref.slug}#${ref.number}. This PR is parked outside the provider queue; confirm here after reviewing the current head, or approve it on GitHub and retry.`,
            eligibleUserIds: [actorUserId],
          };
        }
        const mayMirrorApproval = exactHeadConfirmed
          || (!intentAuthorizedLanding && voters.includes(actorUserId))
          || (intentAuthorizedLanding && mirroredReviews.length === 0 && voters.includes(actorUserId));
        if (mayMirrorApproval && !alreadyMirrored) {
          await api.approve(ref.slug, ref.number, ref.headSha,
            'Approved in krmax after reviewing this exact pull-request head.')
            .then(() => record(handle.id, 'github.pr.review-approved', { ...ref, actorUserId }))
            .catch((error) => record(handle.id, 'github.pr.review-skipped', {
              ...ref, actorUserId, detail: error instanceof Error ? error.message : String(error),
            }));
        }
        // A mirrored approval may have satisfied GitHub's own required-review
        // rule. Re-read only when that rule was previously blocking; if it still
        // is, this is a real external-human wait rather than an opaque merge poll.
        if (classifiedGithubStates && readiness?.reviewDecision === 'REVIEW_REQUIRED') {
          try {
            readiness = await api.readiness(ref.slug, ref.number);
          } catch (error) {
            return errorDecision(error, current);
          }
          if (readiness.checks === 'FAILURE' || readiness.checks === 'ERROR')
            return {
              status: 'needs-revision', prs: current, actorUserId, detail: ciFailureDetail(ref, readiness),
              ...(intentAuthorizedLanding ? { repair: { kind: 'ci' as const, preserveAuthorization: true } } : {}),
            };
          if (readiness.reviewDecision === 'CHANGES_REQUESTED') {
            if (intentAuthorizedLanding)
              record(handle.id, 'github.merge.authorization-revoked', { ...ref, reason: 'changes-requested' });
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `GitHub reviewers requested changes on pull request ${ref.slug}#${ref.number}. Inspect their review comments and update the proposal.`,
              ...(intentAuthorizedLanding ? { repair: { kind: 'changes-requested' as const, preserveAuthorization: false } } : {}),
            };
          }
          if (readiness.reviewDecision === 'REVIEW_REQUIRED') {
            return {
              status: 'needs-human', prs: current, actorUserId,
              detail: `Pull request ${ref.slug}#${ref.number} still requires a GitHub review under repository policy. Complete that review on GitHub, then retry here.`,
            };
          }
        }
        if (observeOnly) {
          return {
            status: 'needs-revision', prs: current, actorUserId,
            detail: `GitHub ejected pull request ${ref.slug}#${ref.number} from its merge queue without merging it. Inspect the merge-group checks and the newest target, repair the branch if needed, and revalidate before requeueing.`,
            repair: { kind: 'ci', preserveAuthorization: true },
          };
        }
        if (intentAuthorizedLanding) {
          // The provider queue is the preferred owner because it builds and
          // validates a merge group against the then-current target. Crucially,
          // do this BEFORE a direct PR merge: GitHub's REST merge binds the head
          // SHA but not the base SHA, so a target race could land a candidate CI
          // never saw.
          let queueResult;
          let queueError: unknown;
          if (live.nodeId) {
            try { queueResult = await api.enqueue(live.nodeId, ref.headSha); }
            catch (error) { queueError = error; }
          }
          if (queueResult?.queued) {
            queued = true;
            pendingDetail = 'GitHub accepted the pull request into its merge queue.';
            settled.push(next);
            record(handle.id, 'github.pr.queued', { ...ref, actorUserId });
            continue;
          }
          if (queueError) return errorDecision(queueError, current);

          // A repository without a native merge queue can still land safely,
          // but only by advancing its target to the exact tested PR head. The
          // head must contain the latest base, and GitHub's force:false ref
          // update atomically rejects a target race as non-fast-forward.
          if (readiness?.mergeStateStatus === 'BEHIND') {
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `Pull request ${ref.slug}#${ref.number} is behind its target and this repository did not accept it into a native merge queue. Repair the branch against the newest target and revalidate the exact resulting head.`,
              repair: { kind: 'base-moved', preserveAuthorization: true },
            };
          }
          if (readiness && ['PENDING', 'EXPECTED'].includes(readiness.checks ?? '')) {
            return {
              status: 'waiting', prs: current, actorUserId,
              detail: `Waiting for checks on the exact pull-request head before attempting an atomic fast-forward landing.`,
            };
          }
          if (readiness && readiness.mergeStateStatus !== 'CLEAN') {
            return {
              status: 'needs-human', prs: current, actorUserId,
              detail: `GitHub did not accept pull request ${ref.slug}#${ref.number} into a merge queue and reports ${readiness.mergeStateStatus}. Resolve the repository policy, or enable a GitHub merge queue so candidate construction and CI remain provider-owned.`,
              eligibleUserIds: [actorUserId],
            };
          }
          const mergeMethod = actorPermissions.get(ref.slug)?.mergeMethod ?? 'merge';
          if (mergeMethod !== 'merge') {
            return {
              status: 'needs-human', prs: current, actorUserId,
              detail: `Repository policy requests ${mergeMethod} landing, but GitHub did not accept this PR into a merge queue. Enable the native queue for ${mergeMethod} landing; krmax will not substitute an unvalidated direct merge.`,
              eligibleUserIds: [actorUserId],
            };
          }
          if (!live.base) {
            return {
              status: 'retryable-error', prs: current, actorUserId,
              detail: `GitHub did not report the target branch for pull request ${ref.slug}#${ref.number}; exact landing cannot proceed safely.`,
            };
          }
          let advanced;
          try { advanced = await api.fastForwardTarget(ref.slug, live.base, ref.headSha); }
          catch (error) { return errorDecision(error, current); }
          if (advanced.updated) {
            lastSha = ref.headSha;
            settled.push({ ...next, state: 'closed', merged: true });
            record(handle.id, 'github.pr.merged', {
              ...ref, sha: ref.headSha, actorUserId, strategy: 'exact-fast-forward',
            });
            continue;
          }
          if (/fast.?forward|behind|reference update failed|not a valid head/i.test(advanced.message)) {
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `The target moved before GitHub could land exact head ${ref.headSha} for ${ref.slug}#${ref.number}: ${advanced.message}`,
              repair: { kind: 'base-moved', preserveAuthorization: true },
            };
          }
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `GitHub refused the exact fast-forward landing for ${ref.slug}#${ref.number}: ${advanced.message}. The PR is outside every queue; fix its branch policy or enable the native merge queue, then retry.`,
            eligibleUserIds: [actorUserId],
          };
        }
        let merged;
        try {
          merged = await api.merge(ref.slug, ref.number, ref.headSha,
            actorPermissions.get(ref.slug)?.mergeMethod ?? 'merge');
        } catch (error) {
          if (!classifiedGithubStates) throw error;
          return errorDecision(error, current);
        }
        if (merged.merged) {
          lastSha = merged.sha ?? lastSha;
          settled.push({ ...next, state: 'closed', merged: true });
          record(handle.id, 'github.pr.merged', { ...ref, sha: merged.sha, actorUserId });
          continue;
        }
        let queueResult;
        let fallbackError: unknown;
        if (live.nodeId) {
          try { queueResult = await api.enqueue(live.nodeId, ref.headSha); }
          catch (error) { fallbackError = error; }
        }
        if (queueResult?.queued) {
          queued = true;
          pendingDetail = 'GitHub accepted the pull request into its merge queue.';
          settled.push(next);
          record(handle.id, 'github.pr.queued', { ...ref, actorUserId });
          continue;
        }
        const mergeMethod = actorPermissions.get(ref.slug)?.mergeMethod ?? 'merge';
        let autoMerge;
        if (live.nodeId) {
          try { autoMerge = await api.enableAutoMerge(live.nodeId, ref.headSha, mergeMethod); }
          catch (error) { fallbackError ??= error; }
        }
        if (autoMerge?.enabled) {
          queued = true;
          pendingDetail = 'GitHub auto-merge is enabled for the reviewed pull-request head.';
          settled.push(next);
          record(handle.id, 'github.pr.auto-merge-enabled', { ...ref, actorUserId, mergeMethod });
          continue;
        }
        if (classifiedGithubStates && fallbackError) return errorDecision(fallbackError, current);
        if (classifiedGithubStates && readiness
          && !['PENDING', 'EXPECTED'].includes(readiness.checks ?? '')
          && ['BLOCKED', 'DRAFT', 'HAS_HOOKS'].includes(readiness.mergeStateStatus)) {
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `GitHub policy is blocking pull request ${ref.slug}#${ref.number} (${readiness.mergeStateStatus}). Inspect the repository rule or PR state, then retry or send the task back to Do.`,
          };
        }
        if (classifiedGithubStates && readiness
          && !['PENDING', 'EXPECTED'].includes(readiness.checks ?? '')
          && !['UNKNOWN', 'UNSTABLE'].includes(readiness.mergeStateStatus)) {
          return {
            status: 'retryable-error', prs: current, actorUserId,
            detail: `GitHub refused to merge pull request ${ref.slug}#${ref.number}: ${merged.message}`,
          };
        }
        record(handle.id, 'github.pr.merge-waiting', { ...ref, actorUserId, detail: merged.message });
        return {
          status: 'waiting', prs: [...settled, next, ...prs.slice(settled.length + 1)], actorUserId,
          detail: merged.message,
        };
      }
      if (settled.every((ref) => ref.merged))
        return { status: 'merged', prs: settled, actorUserId, ...(lastSha ? { sha: lastSha } : {}) };
      return {
        status: queued ? 'queued' : 'waiting', prs: settled, actorUserId,
        detail: queued ? pendingDetail : 'Waiting for GitHub merge policy.',
        ...(intentAuthorizedLanding && queued ? { providerQueue: { state: 'queued' as const } } : {}),
      };
    },

    /**
     * Reconcile the PRs with what actually landed, after the merge and the
     * policy push. The local merge is the deliverable, so this never fails the
     * task — but it is where the PR stops being a fire-and-forget artifact: the
     * outcome is commented on it, a PR GitHub already marked merged is recorded
     * as such, and one left open because the target push never reached GitHub
     * says so instead of dangling silently.
     */
    async finalizePrs(handle: WorldHandle, prs: TaskPullRequest[], outcome: { target: string; sha?: string; pushed: string[] }):
    Promise<TaskPullRequest[]> {
      const settled: TaskPullRequest[] = [];
      for (const ref of prs) {
        try {
          const api = await prApiFor(handle, ref.slug);
          const landed = outcome.pushed.includes(ref.repo);
          const as = outcome.sha ? ` as ${outcome.sha}` : '';
          // Settle the PR first, then describe the state it settled in. GitHub
          // marks a PR merged by itself once its commits reach the base, and it
          // can do so moments after the push — so deciding the wording from a
          // read taken beforehand narrates a state the PR has already left.
          if (landed && !(await api.get(ref.slug, ref.number)).merged) {
            // The merge commit is on the pushed target but GitHub still shows the
            // PR open (a squash/rebase-shaped history, or a base it can't match).
            // Close it explicitly — the work is in, the PR is done.
            await api.update(ref.slug, ref.number, { state: 'closed' }).catch(() => undefined);
          }
          const after = await api.get(ref.slug, ref.number);
          await api.comment(ref.slug, ref.number,
            after.merged ? `Merged into \`${outcome.target}\` by karmax${as}.`
            : landed ? `karmax merged this branch into \`${outcome.target}\`${as} and pushed it. Closing.`
            : `karmax merged this branch into \`${outcome.target}\` locally${as}, but could not push`
              + ` \`${outcome.target}\` to origin. This pull request stays open until that target lands.`);
          const next = { ...ref, state: after.state, merged: after.merged };
          record(handle.id, after.merged ? 'pr.merged' : after.state === 'closed' ? 'pr.closed' : 'pr.open', next);
          settled.push(next);
        } catch (error) {
          record(handle.id, 'pr.finalize_failed', { ...ref, error: error instanceof Error ? error.message : String(error) });
          settled.push(ref);
        }
      }
      return settled;
    },

    /** Close the task's still-open PRs (cancellation). Best-effort: a task that
     *  is going away must not be held up by GitHub being unreachable. */
    async closePrs(handle: WorldHandle, prs: TaskPullRequest[], reason: string): Promise<void> {
      for (const ref of prs) {
        try {
          const api = await prApiFor(handle, ref.slug);
          if ((await api.get(ref.slug, ref.number)).state === 'closed') continue;
          await api.comment(ref.slug, ref.number, reason);
          await api.update(ref.slug, ref.number, { state: 'closed' });
          record(handle.id, 'pr.closed', { ...ref, state: 'closed' as const, reason });
        } catch (error) {
          record(handle.id, 'pr.close_failed', { ...ref, error: error instanceof Error ? error.message : String(error) });
        }
      }
    },

    /**
     * Push the landed target branch to each repo's origin (remote policy
     * 'push'/'pr', PLAN-git-config.md §5). Best-effort by contract: the local
     * merge is the deliverable; every skip/failure is recorded, never thrown.
     */
    async pushTarget(handle: WorldHandle, target: string): Promise<{ pushed: string[]; skipped: string[] }> {
      const env = { GIT_TERMINAL_PROMPT: '0', ...gitEnvFor(handle, handle.id) };
      const world = await openWorld(handle);
      const pushed: string[] = [];
      const skipped: string[] = [];
      if (isRemote(handle.kind)) {
        for (const r of worldRepos(handle)) {
          if (!r.localPath) {
            // brokerFinalizeMerge already performed the authenticated target push;
            // report the policy step as satisfied without re-exporting credentials.
            pushed.push(r.name);
            continue;
          }
          // Locally-authoritative repo: the broker landed the merge in the local
          // checkout and pushed nothing, so the policy push runs from there —
          // exactly like a worktree world's. Honor an in-flight (non-pinned)
          // retarget so we push the branch the merge actually landed on, matching
          // the origin-authoritative branch below.
          const repoTarget = r.targetPinned === false ? target : (r.target ?? target);
          const repository = await enrolledRepositoryForCheckout(handle, r);
          const push = await hostGitWithRepositoryCredential(repository, r.localPath,
            ['push', 'origin', repoTarget], env);
          if (push.code === 0) {
            pushed.push(r.name);
            record(handle.id, 'push.done', { repo: r.name, target: repoTarget });
          } else {
            skipped.push(r.name);
            record(handle.id, 'push.failed', { repo: r.name, target: repoTarget, detail: (push.stderr || push.stdout).slice(0, 300) });
          }
        }
        return { pushed, skipped };
      }
      for (const r of worldRepos(handle)) {
        const repoTarget = r.targetPinned === false ? target : (r.target ?? target);
        const repository = await enrolledRepositoryForCheckout(handle, r);
        const appConnected = Boolean(repository?.gitConnectionId && deps.githubApp);
        const hasOrigin = appConnected
          ? await hostGit(r.repo, ['remote', 'get-url', 'origin'], { env })
          : await world.exec('git', ['remote', 'get-url', 'origin'], { cwd: r.repo, env });
        if (hasOrigin.code !== 0) {
          skipped.push(r.name);
          record(handle.id, 'push.skipped', { repo: r.name, reason: 'no origin remote' });
          continue;
        }
        const push = appConnected
          ? await hostGitWithRepositoryCredential(repository, r.repo, ['push', 'origin', repoTarget], env)
          : await world.exec('git', ['push', 'origin', repoTarget], { cwd: r.repo, env });
        if (push.code === 0) {
          pushed.push(r.name);
          record(handle.id, 'push.done', { repo: r.name, target });
        } else {
          skipped.push(r.name);
          record(handle.id, 'push.failed', { repo: r.name, target, detail: (push.stderr || push.stdout).slice(0, 300) });
        }
      }
      return { pushed, skipped };
    },

    async publishView(taskId: string, view: TaskView): Promise<void> {
      store.saveView(taskId, view);
      // Entering Merge is the logical commitment boundary. The SQLite compare-and-
      // set is the winner lease: exactly one attempt may get past this awaited
      // activity and approach the global merge queue.
      if (view.stage === 'merge') {
        const claim = store.claimAttempt(taskId);
        for (const siblingId of claim.cancel) {
          const sibling = store.getTask(siblingId);
          if (sibling?.params.draft) {
            store.markDraftSuperseded(siblingId, taskId);
            continue;
          }
          await deps.client?.workflow.getHandle(siblingId).signal('cancel').catch(() => undefined);
        }
      }
      record(taskId, 'view.updated', {
        stage: view.stage,
        status: view.status,
        waitingFor: view.waitingFor?.kind ?? null,
        waitingDetail: view.waitingFor?.detail ?? null,
        waitingProvider: view.waitingFor?.provider ?? null,
        waitingResetAt: view.waitingFor?.earliestResetAt ?? null,
        agentTurn: view.agentTurn?.state ?? null,
        agentRole: view.agentTurn?.role ?? null,
      });
      // A waiting task owns durable state, not continuously-metered compute.
      // Parking is an implementation detail inside this existing activity (no new
      // workflow command, so old Temporal histories remain replay-compatible).
      // Every later operation goes through worlds.open(), which transparently
      // resumes a paused provider before a terminal, artifact, agent turn, or merge.
      // software-dev also stores the handle in structured recovery state, while
      // newer workflow views expose it directly. Accept both shapes. Crucially,
      // skip providers that cannot really park: even a no-op lifecycle detour on
      // every waiting publish creates avoidable activity contention precisely
      // while parent/child cancellation signals need to settle promptly.
      const waitingWorld = (view.world ?? view.state.recoveryWorld) as WorldHandle | undefined;
      if (view.status === 'waiting' && waitingWorld && worlds.get(waitingWorld.kind).parkable) {
        try {
          const before = await worlds.status(waitingWorld);
          if (before === 'ready') {
            if (deps.checkpoints) {
              try {
                // The branch is the portable checkpoint's committed layer. Push
                // it through the trusted broker before capturing the dirty delta.
                if (isRemote(waitingWorld.kind) && worldRepos(waitingWorld).length) {
                  const remoteWorld = await openWorld(waitingWorld, taskId);
                  const projectId = String(waitingWorld.meta?.projectId ?? '');
                  if (store.listProjectRepositories(projectId).length) {
                    const pushed = await brokerPublishBranch(remoteWorld, brokerAuthFor(waitingWorld, taskId));
                    if (pushed.skipped.length) throw new Error(`could not persist branch for ${describePublishFailures(pushed)}`);
                    record(taskId, 'push.branch', { branch: waitingWorld.branch, repos: pushed.pushed, reason: 'checkpoint' });
                  }
                }
                const checkpoint = await deps.checkpoints.checkpoint(waitingWorld);
                record(taskId, 'checkpoint.created', { checkpointId: checkpoint.id,
                  generation: checkpoint.generation, bytes: checkpoint.filesystemDelta?.bytes ?? 0 });
              } catch (error) {
                record(taskId, 'checkpoint.warning', { warning: error instanceof Error ? error.message : String(error) });
              }
            }
            await worlds.park(waitingWorld);
            if (await worlds.status(waitingWorld) === 'parked') {
              const current = (store.currentWorld(waitingWorld.id) ?? waitingWorld) as WorldHandle;
              const leaseId = typeof current.meta?.worldLeaseId === 'string' ? current.meta.worldLeaseId : undefined;
              if (leaseId) {
                deps.runners?.release(leaseId, current.kind);
                store.updateWorldMeta(current, { worldLeaseId: null });
              }
              store.setWorldState((store.currentWorld(waitingWorld.id) ?? waitingWorld) as WorldHandle, 'parked');
              record(taskId, 'world.parked', { provider: waitingWorld.kind, reason: view.waitingFor?.kind ?? view.stage });
            }
          }
        } catch (error) {
          // Auto-pause remains the cost backstop; a transient park failure must
          // never roll back or retry the authoritative view update.
          record(taskId, 'world.warning', { warning: `could not park waiting world: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    },

    async recordEvent(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
      record(taskId, type, payload);
    },

    async prepareChildTask(args: PrepareChildArgs): Promise<TaskInput> {
      const parent = store.getTask(args.parentTaskId);
      const child = store.createTask({
        projectId: args.projectId,
        listId: parent?.listId,
        title: args.title,
        workflow: 'software-dev',
        workflowVersion: parent?.workflowVersion ?? '1.0.0',
        params: { prompt: args.prompt, base: args.base, target: args.target },
        parentTaskId: args.parentTaskId,
        createdBy: { kind: 'task-agent', taskId: args.parentTaskId, role: 'do' },
        assignee: { kind: 'task-agent', taskId: args.parentTaskId, role: 'do' },
      });
      record(args.parentTaskId, 'subtask.created', { childTaskId: child.id, title: args.title });
      // Least-privilege grant (SPEC §8.2): the child's delegation caps are attenuated
      // by the parent's own grant, and its merge cap is scoped to EXACTLY the parent's
      // branch (which the parent owns and merges into). If no branch is known,
      // the child gets no merge capability — never a broad fallback.
      const delegation = attenuate(
        [
          'create-sub-task', 'create-review-info', 'signal-completion', 'save-skill',
          'task:read', 'task:event:read', 'task:git:publish', 'task:git:import',
          'task:conversation:read', 'task:conversation:fork', 'task:conversation:message',
        ],
        args.parentGrant ?? DEFAULT_GRANT,
      );
      const mergeBack = args.parentBranch && allows(args.parentGrant ?? DEFAULT_GRANT, `merge-into:${args.parentBranch}`)
        ? [`merge-into:${args.parentBranch}`]
        : [];
      const grant = [...delegation, ...mergeBack];
      store.updateTaskParams(child.id, {
        ...child.params,
        _authorization: { profileId: 'inherited-child', principal: `task:${args.parentTaskId}`, capabilities: grant, attenuated: true },
      });
      return {
        taskId: child.id,
        projectId: args.projectId,
        title: args.title,
        prompt: args.prompt,
        base: args.base,
        target: args.target,
        parentTaskId: args.parentTaskId,
        project: args.project,
        profiles: args.profiles,
        resolveAgentEnabled: args.resolveAgentEnabled,
        grant,
        grantPrincipal: `task:${args.parentTaskId}`,
        authorizationProfile: 'inherited-child',
      };
    },

    async autoResolve(args: {
      taskId: string;
      stage: string;
      error: string;
      limit?: LimitClassification;
    }): Promise<{ resolved: boolean; note?: string; action?: string }> {
      // Workflow-declared resolve rules (SPEC §5.2) take precedence over the defaults.
      const wf = store.getTask(args.taskId)?.workflow;
      const rules = wf ? manifest(wf)?.resolveRules : undefined;
      // A typed provider failure has already been classified at the adapter boundary;
      // do not discard that ground truth and re-interpret provider prose here.
      const r = args.limit?.limited
        ? { resolved: true, action: 'retry' as const, note: 'provider account unavailable — retrying without a Resolve agent' }
        : runAutoResolve(args.stage, args.error, rules);
      record(args.taskId, 'resolve.auto', {
        stage: args.stage,
        resolved: r.resolved,
        action: r.action,
        source: args.limit?.limited ? 'provider-metadata' : 'message-rule',
      });
      return r;
    },

    /** Used by the gateway-side too; generates ids deterministically off the worker. */
    async newTaskId(): Promise<string> {
      return newId('task');
    },
  };
}

export type coreActivities = ReturnType<typeof makeCoreActivities>;
