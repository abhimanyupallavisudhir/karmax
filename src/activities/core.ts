import { createHash } from 'node:crypto';
import { buildVersionedBundle } from '../packages/bundle.js';
import type { WorkflowBundle } from '@temporalio/worker';
import { concurrentMap } from '../util/concurrent-map.js';
import { notifyChildSettlement } from '../platform/child-settlement.js';
import { AdmissionBackpressureError } from '../domain/admission-error.js';
import { snapshotReplayHistories } from './replay-histories.js';
import { turnPlatformRequest } from '../agent/platform-request.js';
import { acquireConfirmLock } from './confirm-lock.js';
import { scriptOutput, reviewFiles } from './result-bounds.js';
import { mapBatches } from '../util/async-batch.js';
import { timingEnabled, installationTiming, withTiming, timed } from '../timing/index.js';
import { McpConnections } from '../mcp/connections/store.js';
import { preserveReviewArtifacts, unsavedReviewArtifacts } from '../store/review-artifacts.js';
import { prepareConnections } from '../mcp/connections/runtime.js';
import { expectedTaskRemoteHeads } from '../world/publication.js';
import { hasLiveWorldWork, type PublishedView, type ViewConversation, type LifecyclePublication } from '../domain/view-publication.js';
import { recordHumanConfirmation } from '../platform/review-confirmation.js';
import type { Client } from '@temporalio/client';
import { Context as activityContext } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { ProviderPolicyFailure, isProviderPolicyRejection, classifyProviderTurnError, isTransportError, isResourceKill, type LimitClassification } from '../agent/limits.js';
import { hostStats, hostMemoryTight } from './agent-slots.js';
import { Store, type ViewPublicationOrder } from '../store/db.js';
import { WorldRegistry } from '../world/registry.js';
import { World, WorldHandle, WorldKind, WorldSpec, worldWorkingDirectory, type WorldDiagnosis } from '../world/types.js';
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
import { AgentAdapter, type TurnResult, type AdapterTurn } from '../agent/types.js';
import { KARMAX_RUNTIME_PROTOCOL, runRuntimeTurn, type QueuedDelegation } from '../agent/runtime.js';
import { SecretScrubber } from '../agent/activity.js';
import { gateFollowUps } from './follow-up-gate.js';
import { acquireAgentSlot, awaitAgentResources, AgentResourcesUnavailableError } from './agent-slots.js';
import { assemblePrompt } from '../agent/prompt.js';
import { GLOBAL_INSTRUCTIONS } from '../agent/instructions.js';
import { autoResolve as runAutoResolve } from '../resolve/cases.js';
import { KarmaxBus } from '../contrib/bus.js';
import { TokenAuthority } from '../platform/tokens.js';
import type { AuthorizationService } from '../platform/authorization.js';
import { CredentialBroker } from '../autonomy/broker.js';
import { VaultItems, removeTurnKeys, turnKeyDirectory } from '../autonomy/vault-items.js';
import { PermissionRequests } from '../platform/permission-requests.js';
import { applyAvatarProfile, avatarAuthorizationCapabilities, avatarForRole, avatarPrincipal } from '../platform/avatars.js';
import { GitProfiles, userGitScope } from '../autonomy/git-profiles.js';
import { worldRepos, worldRepoSource, worldRepoTarget } from '../world/types.js';
import { git as hostGit, isolatedGitEnvironment } from '../world/git.js';
import { brokerFinalizeMerge, brokerPublishBranch, brokerPushBranches, describePublishFailures, type GitBrokerAuth } from '../world/git-broker.js';
import { enrollWorldRepositories } from '../world/repository-enrollment.js';
import { materializeGitCredential } from '../world/git-credential.js';
import {
  GithubApiError,
  GithubPrApi,
  githubSlug,
  type GithubPrApiOptions,
  type GithubPullRequestReadiness,
} from '../integrations/github-pr.js';
import {
  GithubActionsApiError,
  classifyGithubCheckStates,
  classifyGithubActionsFailure,
  githubActionsRunIdFromUrl,
  githubRequiredCheckKey,
  reconcileGithubActionsRuns,
  renderGithubActionsFailure,
  summarizeGithubActionsFailure,
  type GithubActionsApi,
  type GithubActionsFailureDecision,
} from '../integrations/github-actions.js';
import { isGithubWorkflowPermissionRejection, type GitHubRepositoryPermission } from '../integrations/github-app.js';
import { cloudGitSource, type CloudGitSource } from '../world/cloud-source.js';
import { PaymentProvider, PaymentRegistry, BudgetService } from '../autonomy/payments.js';
import { fillViaCdp } from '../autonomy/fill.js';
import { fillCardInWorld, BILLING_FIELDS } from '../autonomy/card-fill.js';
import { localTaskBrowserUrl, WORLD_CDP_URL } from '../autonomy/task-browser.js';
import { tokenToInject } from '../autonomy/config-homes.js';
import { findProviderSession, materializeFork } from '../agent/fork.js';
import { CodexHistoryError } from '../agent/codex-history.js';
import { importWithPanagent, looksLikeConversationUrl, publicConversationShare, type PanagentSource } from '../agent/panagent.js';
import { isRemoteAgentWorld, materializeRemoteSession } from '../agent/remote-process.js';
import { materializeFileAttachments } from '../agent/files.js';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from '../config/paths.js';
import { hostLocal as deploymentHostLocal } from '../config/deployment.js';
import type { ObjectStore } from '../store/objects.js';
import { conversationImportObjectKey } from '../store/conversation-imports.js';
import { ensureProjectWikiRepository, PROJECT_WIKI_BRANCH, setProjectWikiRemote } from '../wiki/repository.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, roleCeiling } from '../contrib/manifests.js';
import { allows, attenuate, CHILD_TASK_CEILING } from '../platform/capabilities.js';
import { Provider, Message, TaskInput, TaskView, AgentRole, remotePolicyOf, landingAuthorityOf, type Repository, type TaskPullRequest,
  type GitHubMergeAuthorization, type GithubLandingParticipant, type LandingAuthority, type SubTaskResponse } from '../domain/types.js';
import { newId } from '../util/id.js';
import { SIG_AGENT_TURN_STATE } from '../workflows/names.js';
import { destroyWorldServices } from '../world/services.js';
import { sameRepository } from '../world/repository-identity.js';
import { forkDevelopmentSources, forkRecordedAuthority, type ForkWorldSource } from '../world/fork.js';
import { REPOSITORY_BRANCHES_RESOLVED_PARAM } from '../platform/branch-defaults.js';
import { syncLocalTarget, type LocalTargetSyncResult } from '../world/target-sync.js';
import { ensureTaskBranchAncestry } from '../world/task-branch.js';
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
import { lifecycleReplacementKey, lifecycleReplacementMatches } from '../platform/lifecycle-replacement.js';

// Old executions without a recorded grant retain the normal developer workflow
// surface (but no administration). New tasks always carry a creator-attenuated
// stored grant, so this compatibility path disappears as legacy runs finish.
const DEFAULT_GRANT = [
  'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
  'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
  'github:actions:read',
];


/**
 * Tag a thrown turn error for Temporal's retry policy (the `turns` proxy in the
 * workflows) — see src/workflows/failures.ts for the taxonomy. Original
 * messages are preserved verbatim for display, while provider failure metadata
 * rides in ApplicationFailure.details for account rotation and auto-resolve.
 */
function classifyTurnError(err: unknown, provider?: Provider, sandbox?: { diagnosis?: WorldDiagnosis }): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err : undefined;
  // Admission happens before a provider process exists. Temporal coordinator
  // backpressure/outages therefore cannot be an agent error and must retain
  // their retryable infrastructure classification through this outer boundary.
  if (err instanceof AdmissionBackpressureError || err instanceof AgentAdmissionInfrastructureError || err instanceof AgentResourcesUnavailableError) {
    return ApplicationFailure.create({ message: msg, type: 'agent-infra', nonRetryable: false, cause });
  }
  if (err instanceof ProviderPolicyFailure || isProviderPolicyRejection(err)) {
    const failure = err instanceof ProviderPolicyFailure ? err : new ProviderPolicyFailure(err, provider);
    return ApplicationFailure.create({
      message: failure.message, type: 'agent-policy', nonRetryable: true, cause: failure,
      details: [failure.diagnostic],
    });
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
  // A remote sandbox's own metrics outrank any reading of the error text: a
  // frozen sandbox fails with whatever the next provider call happens to say
  // (tasks 348/349: an exit "-1", "Sandbox is probably not running anymore").
  if (sandbox?.diagnosis) {
    const { summary, memoryExhausted } = sandbox.diagnosis;
    return ApplicationFailure.create({ type: 'agent-infra', nonRetryable: false, cause,
      message: `${msg} — ${summary}${memoryExhausted ? '; a command in the sandbox likely used more memory than it has.' : '.'}` });
  }
  // The control plane's memory says nothing about a kill inside a sandbox.
  if (sandbox && isResourceKill(msg)) return ApplicationFailure.create({ message: msg, type: 'agent-infra', nonRetryable: false, cause });
  // A signal-9/SIGKILL agent death is environmental, not a code bug (karmax#4):
  // classify it as retryable 'agent-infra' with an ACTIONABLE message — the raw
  // "terminated by signal SIGKILL" tells an operator nothing. Temporal re-runs the
  // turn and the retry re-enters the host-admission gate (acquireAgentSlot) and
  // resumes the interrupted session. isResourceKill is the shared predicate
  // (src/agent/limits.ts) the software-dev auto-resolve task reuses.
  if (isResourceKill(msg)) return ApplicationFailure.create({ message: signalKillMessage(msg), type: 'agent-infra', nonRetryable: false, cause });
  if (isTransportError(err)) return ApplicationFailure.create({ message: msg, type: 'agent-infra', nonRetryable: false, cause });
  return ApplicationFailure.create({ message: msg, type: 'agent-error', nonRetryable: true, cause });
}

function parseInterruption(value: string | undefined): WorldDiagnosis | undefined {
  try { const parsed = value ? JSON.parse(value) : undefined; return typeof parsed?.summary === 'string' ? parsed : undefined; }
  catch { return undefined; }
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
const MAX_SUPERSEDED_CI_POLLS = 20;
const CANCELLED_RUN_RECONCILIATIONS = 2;

function signalKillMessage(raw: string): string {
  const h = hostStats();
  const mem = `${h.freeMemMb}MB free of ${h.totalMemMb}MB (${h.usedMemPct}% used, load ${h.loadPerCore}/core)`;
  const diagnosis = hostMemoryTight()
    ? `host out of memory — the agent was likely killed by the OS OOM killer (${mem}). ` +
      `Reduce Concurrent agent turns under Installation → Host capacity (or raise KARMAX_AGENT_MIN_FREE_MB), or free RAM.`
    : `host memory is healthy (${mem}), so this is NOT an OOM kill — most likely a krmax ` +
      `restart/reload/redeploy tearing down in-flight turns (orphan-sweep or shutdown escalation) or an external kill.`;
  return `agent turn interrupted by SIGKILL: ${diagnosis} Retrying with session resume. [signal: ${raw.slice(0, 200)}]`;
}

export interface CoreActivityDeps {
  workflowBundle?: () => WorkflowBundle;
  store: Store;
  worlds: WorldRegistry;
  adapters: Map<Provider, AgentAdapter>;
  profiles: ProfileResolver;
  client?: Client;
  taskQueue?: string;
  bus?: KarmaxBus;
  globalInstructions?: string;
  tokens?: TokenAuthority;
  authorization?: AuthorizationService;
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
  objects?: ObjectStore;
  contentDir?: string;
  /** Snapshot of whether this console is running on the user's own machine. */
  hostLocal?: boolean;
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
  const provenance = `\n\n---\n${task} · branch \`${handle.branch}\`${repoName ? ` · repo \`${repoName}\`` : ''}`;
  const suffix = '\n… (summary truncated)';
  const budget = Math.max(0, 65_536 - Buffer.byteLength(provenance + suffix));
  let bounded = summary;
  if (Buffer.byteLength(summary) > budget) {
    let bytes = 0;
    bounded = '';
    for (const character of summary) {
      bytes += Buffer.byteLength(character);
      if (bytes > budget) break;
      bounded += character;
    }
    bounded += suffix;
  }
  return bounded + provenance;
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
  /** The project's git profile selection (wiki plans/PLAN-git-config §3); the activity
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
  const saved = Number((await args.store.getSettings('global', 'agent-queue'))?.capacity);
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
/** Keep an agent's sub-task replies to this task's own children. A reply
 *  becomes a workflow signal (confirm / cancel / comment) to the id the agent
 *  names, and every workflow — any tenant's task, any coordinator — shares one
 *  namespace. No id means "every child awaiting a reply", which the workflow
 *  resolves from its own children. Replay-safe: it only narrows the result. */
export async function ownSubTaskResponses(store: Pick<Store, 'getTask'>, taskId: string,
  responses: SubTaskResponse[] | undefined): Promise<{ kept?: SubTaskResponse[]; refused: string[] }> {
  const kept: SubTaskResponse[] = [];
  const refused: string[] = [];
  for (const response of responses ?? []) {
    if (!response.childTaskId || (await store.getTask(response.childTaskId))?.parentTaskId === taskId) kept.push(response);
    else refused.push(response.childTaskId);
  }
  return { ...(kept.length ? { kept } : {}), refused };
}

export function makeCoreActivities(deps: CoreActivityDeps) {
  const { store, worlds, profiles } = deps;
  const isRemote = (kind: WorldKind) => worlds.get(kind).capabilities?.remote === true;
  const turnProfile = async (task: TaskInput, role: AgentRole, explicitProfileId?: string) => {
    const base = (await profiles.resolve(role, task.profiles, explicitProfileId, task.projectId));
    const avatar = (await avatarForRole(store, task, role));
    return { avatar, profile: applyAvatarProfile(base, task.agents?.[role], avatar) };
  };

  const organizationGitProfilesFor = async (projectId?: string) => new GitProfiles(
    store,
    deps.broker,
    paths().state,
    (projectId ? (await store.getProject(projectId))?.organizationId : undefined) ?? 'org_personal',
  );

  const gitProfilesForScope = (scope: string) => new GitProfiles(store, deps.broker, paths().state, scope);
  const activeGithubAccountId = async (userId: string) => typeof deps.githubApp?.activeUserAccountId === 'function'
    ? (await deps.githubApp.activeUserAccountId(userId)) : undefined;

  const taskGithubAccountId = async (taskId: string): Promise<string | undefined> => {
    const seen = new Set<string>();
    let task = (await store.getTask(taskId));
    while (task && !seen.has(task.id)) {
      seen.add(task.id);
      const accountId = task.params?._githubAccountId;
      if (typeof accountId === 'string' && /^\d+$/.test(accountId)) return accountId;
      task = task.parentTaskId ? (await store.getTask(task.parentTaskId)) : undefined;
    }
    return undefined;
  };

  /** Development follows the human creator, never the tenant. Organization Git
   * remains the fallback for system/automation tasks that have no human owner and
   * for historical task-less activity calls used by older workflow histories. */
  const developmentGitBinding = async (taskId: string, projectId?: string, requestedProfile?: string) => {
    const userId = (await store.taskCreatorUserId(taskId));
    if (userId) {
      const scope = userGitScope(userId);
      const profiles = gitProfilesForScope(scope);
      const accountId = (await taskGithubAccountId(taskId)) ?? (await activeGithubAccountId(userId));
      return { scope, profiles, profile: accountId ? (await profiles.githubProfile(accountId)) : (await profiles.resolve(undefined)), userId, accountId };
    }
    const profiles = (await organizationGitProfilesFor(projectId));
    const organizationId = (projectId ? (await store.getProject(projectId))?.organizationId : undefined) ?? 'org_personal';
    const configured = (await profiles.resolve({ gitProfile: requestedProfile }));
    return { scope: organizationId, profiles,
      profile: configured ?? (await profiles.automationIdentity()) ?? (await profiles.saveAutomationIdentity({})) };
  };

  const gitBindingFromHandle = async (handle: WorldHandle, taskId?: string) => {
    const profileName = handle.meta?.gitProfile;
    const scope = handle.meta?.gitProfileScope;
    if (typeof profileName === 'string' && profileName && typeof scope === 'string' && scope) {
      const profiles = gitProfilesForScope(scope);
      return { scope, profiles, profile: (await profiles.get(profileName)) };
    }
    const projectId = typeof handle.meta?.projectId === 'string'
      ? handle.meta.projectId
      : taskId ? (await store.getTask(taskId))?.projectId : undefined;
    return (await developmentGitBinding(taskId ?? handle.id, projectId,
      typeof profileName === 'string' ? profileName : undefined));
  };

  async function record(taskId: string, type: string, payload: Record<string, unknown>) {
    const ev = { type, taskId, ts: Date.now(), payload };
    const seq = (await store.appendEvent(ev));
    deps.bus?.emit({ ...ev, seq });
    return seq;
  }

  /** JIT env for remote git/gh operations in this world (wiki plans/PLAN-git-config §4B):
   *  the world's user-owned git profile (stamped on the handle at creation) →
   *  GIT_SSH_COMMAND / GH_TOKEN, per subprocess. Only legacy worlds without a
   *  human owner retain host fallback. */
  async function gitEnvFor(handle: WorldHandle, taskId?: string): Promise<Record<string, string>> {
    const binding = (await gitBindingFromHandle(handle, taskId));
    const fallback = binding.scope === 'org_personal' ? {} : isolatedGitEnvironment();
    if (!binding.profile) return fallback;
    try {
      return { ...fallback, ...(await binding.profiles.env(binding.profile, { taskId })) };
    } catch {
      return fallback;
    }
  }

  /** The project-enrolled GitHub repository behind a PR slug. Enrollment is the
   * authority boundary: a user's OAuth grant must not turn an arbitrary origin
   * mentioned by a task into an authorized repository. */
  async function enrolledGithubRepository(projectId: string | undefined, slug: string): Promise<Repository | undefined> {
    if (!projectId) return undefined;
    const linked = (await store.listProjectRepositories(projectId)).map((entry) => entry.repository);
    const wiki = (await store.projectWiki(projectId))?.repository;
    return [...linked, ...(wiki ? [wiki] : [])]
      .find((candidate) => `${candidate.owner}/${candidate.name}`.toLowerCase() === slug.toLowerCase());
  }

  /** Resolve a local or remote checkout back to its enrolled repository. Local
   * worktrees retain a filesystem source, so their configured origin supplies
   * the network identity used for the lookup. */
  async function enrolledRepositoryForCheckout(handle: WorldHandle, repo: ReturnType<typeof worldRepos>[number]): Promise<Repository | undefined> {
    const projectId = typeof handle.meta?.projectId === 'string'
      ? handle.meta.projectId
      : (await store.getTask(handle.id))?.projectId;
    if (!projectId) return undefined;
    const linked = (await store.listProjectRepositories(projectId)).map((entry) => entry.repository);
    const wiki = (await store.projectWiki(projectId))?.repository;
    const candidates = [...linked, ...(wiki ? [wiki] : [])];
    for (const source of [worldRepoSource(repo), repo.repo, repo.source].filter((value): value is string => Boolean(value))) {
      const found = candidates.find((candidate) => sameRepository(candidate.sshUrl, source));
      if (found) return found;
    }
    if (repo.localPath) {
      const catalog = (await store.listRepositories((await store.getProject(projectId))?.organizationId ?? 'org_personal'));
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
        const catalog = (await store.listRepositories((await store.getProject(projectId))?.organizationId ?? 'org_personal'));
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

  /** Mirror a provider-owned PR target back into the configured host checkout.
   * GitHub may be the protected-history authority while the local checkout is
   * still the source this Karmax process loaded. Project-wiki histories are the
   * exception to the ordinary fast-forward-only rule: canonical UI edits and a
   * task PR may legitimately advance the two sides concurrently, so reconcile
   * and publish both histories through the wiki's serialized mutation lane.
   * Ordinary repositories still preserve divergent/dirty targets for explicit
   * operator reconciliation. */
  async function syncGithubTargetToLocal(
    handle: WorldHandle,
    ref: TaskPullRequest,
    target: string,
    expectedLandedSha?: string,
  ): Promise<LocalTargetSyncResult> {
    const checkout = worldRepos(handle).find((candidate) => candidate.name === ref.repo);
    const authority = checkout?.localPath
      ?? (checkout?.repo && path.isAbsolute(checkout.repo) ? checkout.repo : undefined);
    if (!checkout || !authority) return { coherent: true, target };

    const repository = await enrolledRepositoryForCheckout(handle, checkout);
    const trackingRef = `refs/remotes/origin/${target}`;
    const finish = async (initial: LocalTargetSyncResult, source: string): Promise<LocalTargetSyncResult> => {
      let result = initial;
      if (result.coherent && expectedLandedSha) {
        const containsLanding = await hostGit(authority, [
          'merge-base', '--is-ancestor', expectedLandedSha, trackingRef,
        ]);
        if (containsLanding.code !== 0) result = {
          coherent: false,
          retryable: true,
          target,
          sha: result.sha,
          checkout: result.checkout,
          detail: `GitHub reports ${expectedLandedSha} landed, but ${source} does not contain it yet.`,
        };
      }
      (await record(handle.id, result.coherent ? 'checkout.synced' : 'checkout.sync-blocked', {
        repo: checkout.name,
        target,
        sha: result.sha,
        updated: result.updated,
        checkout: result.checkout ?? authority,
        detail: result.detail,
      }));
      if (result.coherent) {
        // The live-restart loop keys off the same event as deterministic local
        // landing. It can now restart npm-start Karmax after a GitHub PR advances
        // the checkout this process loaded, instead of continuing on stale code.
        (await record(handle.id, 'merge.result', {
          merged: true,
          sha: result.sha,
          target,
          checkout: result.checkout ?? authority,
          provider: 'github',
        }));
      }
      return result;
    };

    if (checkout.role === 'project-wiki' && target === PROJECT_WIKI_BRANCH && repository && deps.githubApp) {
      let result: LocalTargetSyncResult;
      try {
        await setProjectWikiRemote(authority, repository.sshUrl,
          await deps.githubApp.brokerCredentials(repository));
        // Reconciliation fetches, merges, and pushes origin/main. Reuse the
        // ordinary mirror check to verify the checkout and tracking ref ended
        // at the same clean commit before announcing local coherence.
        result = await syncLocalTarget(authority, target, trackingRef);
      } catch (error) {
        result = {
          coherent: false,
          target,
          checkout: authority,
          detail: `GitHub merged the project-wiki pull request, but Karmax could not reconcile concurrent canonical and task edits: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return finish(result, 'the reconciled project wiki');
    }

    const fetched = await hostGitWithRepositoryCredential(repository, authority, [
      'fetch', '--no-tags', 'origin', `+refs/heads/${target}:${trackingRef}`,
    ], { GIT_TERMINAL_PROMPT: '0', ...(await gitEnvFor(handle, handle.id)) });
    if (fetched.code !== 0) {
      return {
        coherent: false,
        retryable: true,
        target,
        detail: `GitHub merged the pull request, but Karmax could not fetch origin/${target} into the enrolled local checkout: ${fetched.stderr || fetched.stdout}`,
      };
    }

    return finish(await syncLocalTarget(authority, target, trackingRef), `the fetched origin/${target}`);
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
      : (await store.getTask(handle.id))?.projectId;
    const env = (await gitEnvFor(handle, handle.id));
    if (env.GH_TOKEN) return env.GH_TOKEN;
    // A human task must never silently open its PR as the organization App.
    // Transport may use the installation, but authorship is the person's App
    // authorization (handled above), a manual profile fallback, or a setup error.
    if ((await gitBindingFromHandle(handle, handle.id)).scope.startsWith('user:')) return undefined;
    if (projectId && deps.githubApp) {
      const repository = authorizedRepository ?? (await enrolledGithubRepository(projectId, slug));
      const connection = repository?.gitConnectionId ? (await store.getGitConnection(repository.gitConnectionId)) : undefined;
      if (connection && repository) return await deps.githubApp.installationToken(connection, [repository.providerId ?? '']);
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
      : (await store.getTask(handle.id))?.projectId;
    const userId = (await store.taskCreatorUserId(handle.id));
    const accountId = (await taskGithubAccountId(handle.id)) ?? (userId ? (await activeGithubAccountId(userId)) : undefined);
    let repository = (await enrolledGithubRepository(projectId, slug));
    if (!repository && checkout) {
      const candidate = await enrolledRepositoryForCheckout(handle, checkout);
      if (`${candidate?.owner}/${candidate?.name}`.toLowerCase() === slug.toLowerCase()) repository = candidate;
    }
    // Connected development uses the SAME deployment App in two distinct
    // capacities: its installation owns repository transport, while this
    // per-user OAuth grant makes the PR attributable to the task creator.
    const githubStatus = userId ? (await deps.githubApp?.status(userId)) : undefined;
    if (userId && repository?.gitConnectionId && githubStatus?.userAuthorized) {
      return new GithubPrApi(
        (options) => deps.githubApp!.userAccessToken(userId, { ...options, ...(accountId ? { accountId } : {}) }),
        deps.githubPr ?? {},
      );
    }
    const token = await githubTokenFor(handle, slug, repository);
    if (!token) {
      if (userId && repository?.gitConnectionId && githubStatus?.oauthConfigured) {
        const failure = githubStatus.lastAuthorizationFailure;
        const diagnostic = failure
          ? ` Last recorded authorization failure: ${failure.summary} [${failure.code}, ${new Date(failure.occurredAt).toISOString()}]`
          : '';
        throw new Error(`GitHub PR identity is not connected for ${slug}. Connect GitHub on your profile so the pull request has a human author, then retry.${diagnostic} Repository transport authorization is already separate; this is not a non-fast-forward or local ancestry error.`);
      }
      throw new Error(`GitHub identity/authorization is missing for ${slug}. Grant the acting account access to this repository, then connect or re-authorize GitHub on your profile. This is not a branch-history conflict.`);
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
        (await record(handle.id, 'pr.skipped', { repo: repo.name, reason: 'no GitHub origin remote' }));
        continue;
      }
      targets.push({ repo, slug, api: await prApiFor(handle, slug, repo) });
    }
    return targets;
  }

  /** Record the transported commit before later PR metadata calls can fail. */
  function recordOriginPublication(taskId: string) {
    return async (repo: ReturnType<typeof worldRepos>[number], headSha: string) => {
      (await record(taskId, 'push.head', { repo: repo.name, branch: repo.branch, headSha }));
    };
  }

  async function publishTaskBranch(world: World, taskId: string, idleCheckpoint = false) {
    return brokerPublishBranch(world, (await brokerAuthFor(world.handle, taskId)),
      (await expectedTaskRemoteHeads(store, taskId)), recordOriginPublication(taskId), { omitUnchangedBase: idleCheckpoint });
  }

  async function pushTaskBranches(
    world: World,
    handle: WorldHandle,
    env: Record<string, string>,
    repos: ReturnType<typeof worldRepos>,
  ) {
    const expectedRemoteHeads = (await expectedTaskRemoteHeads(store, handle.id));
    if (isRemote(handle.kind))
      return brokerPushBranches(world, (await brokerAuthFor(handle, handle.id)), repos, expectedRemoteHeads,
        recordOriginPublication(handle.id));
    const pushed: string[] = [];
    const skipped: string[] = [];
    const errors: Record<string, string> = {};
    for (const repo of repos) {
      const tip = await world.exec('git', ['rev-parse', '--verify', `refs/heads/${repo.branch}`], { cwd: repo.root });
      if (tip.code !== 0) throw new Error(`could not resolve task branch ${repo.branch}: ${tip.stderr || tip.stdout}`);
      const headSha = tip.stdout.trim();
      const refspec = `${headSha}:refs/heads/${repo.branch}`;
      const repository = await enrolledRepositoryForCheckout(handle, repo);
      // GitHub App installation tokens are short-lived HTTPS credentials. Use
      // them from the trusted host even for a local/container worktree, so a
      // connected repository never needs the person's SSH private key or PAT.
      let push = repository?.gitConnectionId && deps.githubApp
        ? await hostGitWithRepositoryCredential(repository, repo.root, ['push', 'origin', refspec], env)
        : await world.exec('git', ['push', 'origin', refspec],
          { cwd: repo.root, env: { GIT_TERMINAL_PROMPT: '0', ...env } });
      const expected = expectedRemoteHeads[repo.name];
      if (push.code !== 0 && expected && /non-fast-forward|fetch first|rejected/i.test(push.stderr || push.stdout)) {
        const lease = `--force-with-lease=refs/heads/${repo.branch}:${expected}`;
        push = repository?.gitConnectionId && deps.githubApp
          ? await hostGitWithRepositoryCredential(repository, repo.root, ['push', lease, 'origin', refspec], env)
          : await world.exec('git', ['push', lease, 'origin', refspec],
            { cwd: repo.root, env: { GIT_TERMINAL_PROMPT: '0', ...env } });
      }
      if (push.code === 0) {
        (await recordOriginPublication(handle.id)(repo, headSha));
        pushed.push(repo.name);
      }
      else {
        skipped.push(repo.name);
        errors[repo.name] = (push.stderr || push.stdout).slice(0, 300);
      }
    }
    return { pushed, skipped, ...(skipped.length ? { errors } : {}) };
  }

  /** Count the commits a PR would propose. GitHub compares against its own
   * copy of the target, which a world knows only as of its last fetch: the
   * local target branch stays at its provisioning commit while refresh_upstream
   * advances just origin/<target>. Counting against the stale local branch made
   * a task that merged the refreshed target "propose" commits GitHub already
   * had, and its PR was refused with 422 "No commits between" (tasks 368, 369,
   * 372, 373) — so count only commits reachable from neither. Restored worlds
   * may hold the target only as origin/<target>; dynamically enrolled checkouts
   * intentionally receive no target ref at all, only the immutable starting
   * commit in `baseSha`. Keep the configured name for the GitHub PR; these refs
   * are only for local Git comparison. */
  async function commitsAheadOfPrBase(world: World, repo: ReturnType<typeof worldRepos>[number], base: string) {
    const dwim = () => world.exec('git', ['rev-list', '--count', `${base}..${repo.branch}`], { cwd: repo.root });
    if (base.startsWith('refs/') || /^[0-9a-f]{40,64}$/i.test(base)) return dwim();
    const candidates = [`refs/heads/${base}`, `refs/remotes/origin/${base}`];
    const listed = await world.exec('git', ['for-each-ref', '--format=%(refname)', ...candidates], { cwd: repo.root });
    const lines = listed.code === 0 ? listed.stdout.split('\n').map((line) => line.trim()) : [];
    const present = candidates.filter((ref) => lines.includes(ref));
    if (present.length) {
      return world.exec('git', ['rev-list', '--count', repo.branch, ...present.map((ref) => `^${ref}`)], { cwd: repo.root });
    }
    if (repo.baseSha) {
      const ancestor = await world.exec('git', ['merge-base', '--is-ancestor', repo.baseSha, repo.branch], { cwd: repo.root });
      if (ancestor.code === 0) {
        const recorded = await world.exec('git', ['rev-list', '--count', `${repo.baseSha}..${repo.branch}`], { cwd: repo.root });
        if (recorded.code === 0) return recorded;
      }
    }
    return dwim();
  }

  async function brokerAuthFor(handle: WorldHandle, taskId?: string): Promise<GitBrokerAuth> {
    const projectId = typeof handle.meta?.projectId === 'string' ? handle.meta.projectId : undefined;
    const project = projectId ? (await store.getProject(projectId)) : undefined;
    const linked = projectId ? (await store.listProjectRepositories(projectId)) : [];
    const wiki = projectId ? (await store.projectWiki(projectId))?.repository : undefined;
    const catalog = project?.organizationId ? (await store.listRepositories(project.organizationId)) : [];
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
        if (!repository && worldRepo.localPath) return { env: (await gitEnvFor(handle, taskId)) };
        if (!repository) throw new Error(`Git broker rejected repository outside project enrollment: ${source}`);
        return deps.githubApp!.brokerCredentials(repository);
      };
    }
    return (await gitEnvFor(handle, taskId));
  }

  /** A workflow's project config is a deterministic creation-time snapshot,
   * while repository attachment is intentionally live platform state. Reconcile
   * those two views inside the trusted activity before any operation that must
   * cover every checkout. */
  async function enrollLiveProjectRepositories(world: World, taskId: string): Promise<string[]> {
    const task = (await store.getTask(taskId));
    if (!task) throw new Error(`no task ${taskId}`);
    const linked = (await store.listProjectRepositories(task.projectId));
    const added = await enrollWorldRepositories(world, linked, (await brokerAuthFor(world.handle, taskId)), async (enrolled) => {
      const current = ((await store.currentWorld(taskId)) ?? world.handle) as WorldHandle;
      const durable = (await store.updateWorldCheckouts(current, world.handle.repos!));
      world.handle = durable as WorldHandle;
      (await record(taskId, 'world.repository-enrolled', {
        repo: enrolled.name, source: worldRepoSource(enrolled), branch: enrolled.branch,
      }));
    });
    return added.map((repo) => repo.name);
  }

  async function ensureRunnerLease(handleInput: WorldHandle, taskId: string): Promise<WorldHandle> {
    const handle = ((await store.currentWorld(handleInput.id)) ?? handleInput) as WorldHandle;
    if (!isRemote(handle.kind) || !deps.runners) return handle;
    const existing = typeof handle.meta?.worldLeaseId === 'string' ? (await store.worldLease(handle.meta.worldLeaseId)) : undefined;
    if (existing?.state === 'active') return handle;
    const projectId = String(handle.meta?.projectId ?? (await store.getTask(taskId))?.projectId ?? '');
    const project = (await store.getProject(projectId));
    if (!project) throw new Error('cloud world has no owning project');
    const ctx = activityContext.current();
    const acquired = await timed('world.runner.wait', async () => deps.runners!.acquire({ project, taskId, worldId: handle.id, provider: handle.kind,
      priority: Number((await store.getTask(taskId))?.params.priority ?? 0), signal: ctx.cancellationSignal,
      heartbeat: () => ctx.heartbeat({ waitingFor: 'world-capacity' }) }));
    const next = (await store.updateWorldMeta(handle, { worldLeaseId: acquired.leaseId, runnerPoolId: acquired.runnerPoolId }));
    (await store.setWorldState(next, 'ready'));
    (await record(taskId, 'world.lease-acquired', { leaseId: acquired.leaseId, runnerPoolId: acquired.runnerPoolId }));
    return next as WorldHandle;
  }

  async function openWorld(handle: WorldHandle, taskId = handle.id): Promise<World> {
    // Pin access before admission, but never wait for capacity while holding a
    // transition lock: the previous owner needs that lock to release its lease.
    const releaseAccess = await worlds.holdAccess?.(handle.id);
    const open = async (): Promise<World | undefined> => {
      const current = ((await store.currentWorld(handle.id)) ?? handle) as WorldHandle;
      if (isRemote(current.kind) && deps.runners) {
        const leaseId = current.meta?.worldLeaseId;
        if (typeof leaseId !== 'string' || (await store.worldLease(leaseId))?.state !== 'active') return undefined;
      }
      let world: World;
      try { world = await worlds.open(current); }
      catch (e) {
        const recovered = await recoverVanishedWorld(current, taskId, e);
        if (!recovered) throw e;
        world = recovered;
      }
      return deps.resources ? await deps.resources.prepare(world) : world;
    };
    try {
      for (;;) {
        await ensureRunnerLease(handle, taskId);
        const world = await (worlds.withOperation ? worlds.withOperation(handle.id, open) : open());
        if (world) return world;
        // A park already in flight may have released the lease while we waited
        // for its transition. Re-enter admission before opening the provider.
      }
    } finally { releaseAccess?.(); }
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
    if ((await store.worldState(handle.id)) === 'released') return undefined;
    const checkpointId = handle.checkpointId ?? ((await store.currentWorld(handle.id)) as WorldHandle | undefined)?.checkpointId;
    if (!checkpointId) return undefined;
    const state = await worlds.probe(handle).catch(() => undefined);
    if (state !== 'missing') return undefined; // transient/parked → keep the original error
    (await record(taskId, 'world.recovering', { checkpointId, reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 200) }));
    try {
      const restored = await deps.checkpoints.restore(checkpointId, handle.kind);
      const opened = await worlds.open(await ensureRunnerLease(restored, taskId));
      (await store.setWorldState(((await store.currentWorld(restored.id)) ?? restored) as WorldHandle, 'ready'));
      (await record(taskId, 'world.recovered', { checkpointId, generation: restored.generation }));
      return opened;
    } catch (error) {
      (await record(taskId, 'world.recover-failed', { checkpointId, detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) }));
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
      const snapshotFiles = new Map<string, string>();
      const listed = await world.exec('bash', ['-lc',
        "set -o pipefail; find . -type d '(' -name .git -o -name node_modules ')' -prune -o -type f '(' -name SKILL.md -o -name MEMORY.md ')' -print0 | head -c 2097153"],
        { cwd: repo.root, timeoutMs: 30_000 });
      if (listed.code !== 0 || Buffer.byteLength(listed.stdout) > 2 * 1024 * 1024)
        throw new Error('project wiki listing failed or exceeded its limit');
      const files = listed.stdout.split('\0').filter(Boolean);
      if (files.length > 2000) throw new Error('project wiki contains too many pages');
      for (const listedFile of files) {
        const file = path.posix.join(prefix, listedFile.replace(/^\.\//, ''));
        if (prefix && file !== prefix && !file.startsWith(`${prefix}/`)) continue;
        const rel = prefix ? file.slice(prefix.length).replace(/^\/+/, '') : file;
        if (!rel || rel === '.git' || rel.startsWith('.git/')) continue;
        const target = path.resolve(root, rel);
        if (target !== root && !target.startsWith(`${root}${path.sep}`))
          throw new Error('invalid file path in project wiki checkout');
        snapshotFiles.set(file, target);
      }
      await mapBatches([...snapshotFiles], async ([file, target]) => {
        const content = await world.readFileBuffer(file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      });
      return { root, release: () => fs.rmSync(root, { recursive: true, force: true }) };
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  async function maintainWaitingWorld(taskId: string, view: LifecyclePublication, fence: string, retryFailure = true): Promise<void> {
    const waitingWorld = (view.world ?? view.state.recoveryWorld) as WorldHandle | undefined;
    if ((view.status !== 'waiting' && view.status !== 'blocked') || hasLiveWorldWork(view)
      || !waitingWorld || !worlds.get(waitingWorld.kind).parkable) return;
    let ctx: ReturnType<typeof activityContext.current> | undefined;
    try { ctx = activityContext.current(); } catch { /* direct tests */ }
    // Carry the publication cursor in the opaque fence so retries and the
    // separate lifecycle activity use the same follow-up boundary. Historical
    // fences lack a cursor and retain their original behavior.
    const publicationSeq = Number(fence.split(':')[0]);
    const parkingTrace = await installationTiming(store, { taskId }, row => record(taskId, 'timing', { ...row }));
    const valid = async () => {
      ctx?.cancellationSignal.throwIfAborted();
      const superseding = Number.isSafeInteger(publicationSeq)
        ? (await store.eventsSince(taskId, publicationSeq, undefined, true)).find(event =>
          event.type === 'conversation.message' || event.type === 'task.cancel-requested'
            || event.type === 'task.transition-requested') : undefined;
      if (superseding) {
        await record(taskId, 'world.park-deferred', { reason: superseding.type === 'task.cancel-requested'
          ? 'accepted-cancellation' : superseding.type === 'task.transition-requested' ? 'accepted-transition' : 'accepted-follow-up' });
        return false;
      }
      if (await worlds.hasActiveAccess?.(waitingWorld.id)) return false;
      const current = (await store.currentWorld(waitingWorld.id)) as WorldHandle | undefined;
      if ((await store.worldState(waitingWorld.id)) === 'released') return false;
      if (current && (current.kind !== waitingWorld.kind
        || (current.generation ?? 1) !== (waitingWorld.generation ?? 1))) return false;
      const ownLease = typeof current?.meta?.worldLeaseId === 'string'
        && (await store.worldLease(current.meta.worldLeaseId))?.state === 'active' ? 1 : 0;
      if ((await store.activeWorldLeaseCount(waitingWorld.id)) > ownLease) return false;
      const task = (await store.taskMetadata(taskId));
      const saved = task?.lastView;
      return (await store.kvGet(`view-lifecycle:${taskId}`)) === fence
        && saved?.updatedAt === view.updatedAt && saved.status === view.status && saved.stage === view.stage
        && JSON.stringify(saved.waitingFor) === JSON.stringify(view.waitingFor)
        && (!task?.params._workflowRunId || !ctx
          || task.params._workflowRunId === ctx.info.workflowExecution?.runId);
    };
    const deferred = new Error('waiting-world maintenance superseded');
    const checkContinue = async () => { if (!(await valid())) throw deferred; };
    const maintain = async () => {
      if (!(await valid())) return;
      const before = await parkingTrace.measure('lifecycle.status', () => worlds.status(waitingWorld));
      if (!(await valid())) return;
      if (before === 'ready') {
        if (deps.checkpoints) {
          try {
            // The branch is the portable checkpoint's committed layer. Push
            // it through the trusted broker before capturing the dirty delta.
            if (isRemote(waitingWorld.kind)) {
              const remoteWorld = await parkingTrace.measure('lifecycle.open', () => withTiming(parkingTrace, () => openWorld(waitingWorld, taskId)));
              if (!(await valid())) return;
              const projectId = String(remoteWorld.handle.meta?.projectId ?? (await store.getTask(taskId))?.projectId ?? '');
              if ((await store.listProjectRepositories(projectId)).length) {
                await parkingTrace.measure('lifecycle.enroll-repositories', () => enrollLiveProjectRepositories(remoteWorld, taskId));
                if (!(await valid())) return;
                const pushed = await parkingTrace.measure('lifecycle.publish-branch', () => withTiming(parkingTrace, () => publishTaskBranch(remoteWorld, taskId, true)));
                if (pushed.skipped.length) throw new Error(`could not persist branch for ${describePublishFailures(pushed)}`);
                (await record(taskId, 'push.branch', { branch: remoteWorld.handle.branch, repos: pushed.pushed, reason: 'checkpoint' }));
              }
            }
            if (!(await valid())) return;
            const checkpoint = await parkingTrace.measure('lifecycle.checkpoint', () => deps.checkpoints!.checkpoint(waitingWorld, { checkContinue, reuseClean: true }));
            (await record(taskId, 'checkpoint.created', { checkpointId: checkpoint.id,
              generation: checkpoint.generation, bytes: checkpoint.filesystemDelta?.bytes ?? 0 }));
          } catch (error) {
            if (error === deferred) return;
            if (ctx?.cancellationSignal.aborted) throw error;
            (await record(taskId, 'checkpoint.warning', { warning: error instanceof Error ? error.message : String(error) }));
          }
        }

        if (!(await valid())) return;
        await parkingTrace.measure('lifecycle.park', () => withTiming(parkingTrace, () => worlds.park(waitingWorld)));
      }
      // Retry after a worker crash between parking and lease cleanup must finish
      // the accounting even when the provider is already parked.
      if ((before === 'ready' || before === 'parked') && await worlds.status(waitingWorld) === 'parked') {
        const current = ((await store.currentWorld(waitingWorld.id)) ?? waitingWorld) as WorldHandle;
        const leaseId = typeof current.meta?.worldLeaseId === 'string' ? current.meta.worldLeaseId : undefined;
        if (leaseId) {
          (await deps.runners?.release(leaseId, current.kind));
          (await store.updateWorldMeta(current, { worldLeaseId: null }));
        }
        (await store.setWorldState(((await store.currentWorld(waitingWorld.id)) ?? waitingWorld) as WorldHandle, 'parked'));
        (await record(taskId, 'world.parked', { provider: waitingWorld.kind, reason: view.waitingFor?.kind ?? view.stage }));
      }
    };
    try {
      // Keep quick replies and Review decisions out of expensive checkpoint work.
      // Do not hold the world's operation lock during this interruptible grace.
      const idleUntil = Math.min(view.updatedAt + 15_000, Date.now() + 15_000);
      while (Date.now() < idleUntil) {
        if (!(await valid())) return;
        await new Promise(resolve => setTimeout(resolve, Math.min(250, idleUntil - Date.now())));
      }
      await parkingTrace.measure('lifecycle.waiting-publication', () => worlds.withOperation ? worlds.withOperation(waitingWorld.id, maintain) : maintain());
    } catch (error) {
      if (ctx?.cancellationSignal.aborted) throw error;
      if (retryFailure) throw error; // Separate maintenance retries without republishing status.
      (await record(taskId, 'world.warning', { warning: `could not park waiting world: ${error instanceof Error ? error.message : String(error)}` }));
    }
  }

  return {
    async createWorld(args: CreateWorldArgs): Promise<WorldHandle> {
      let activitySignal: AbortSignal | undefined;
      let heartbeat: (() => void) | undefined;
      let cancellationHeartbeat: NodeJS.Timeout | undefined;
      {
        try {
          const ctx = activityContext.current();
          activitySignal = ctx.cancellationSignal;
          heartbeat = () => ctx.heartbeat({ waitingFor: 'world-capacity' });
          // Temporal delivers activity cancellation at heartbeat boundaries.
          // Keep that boundary live after admission while the provider allocates
          // and provisions the sandbox.
          cancellationHeartbeat = setInterval(() => {
            try { ctx.heartbeat({ provisioning: args.kind }); } catch { /* cancellation is checked by provisioning */ }
          }, 1_000);
          cancellationHeartbeat.unref();
        } catch {
          // Direct activity unit tests have no ambient Temporal context.
        }
      }
      const stopCancellationHeartbeat = () => {
        if (cancellationHeartbeat) clearInterval(cancellationHeartbeat);
        cancellationHeartbeat = undefined;
      };
      try {
      const trace = (await installationTiming(store, { taskId: args.taskId }, async row => (await record(args.taskId, 'timing', { ...row }))));
      try { trace.signal = activityContext.current().cancellationSignal; } catch { /* direct fixture */ }
      return (await withTiming(trace, () => trace.measure('world.prepare', async () => {
      const remote = isRemote(args.kind);
      if (store.hosted && !remote)
        throw new Error(`hosted deployments cannot run task code in the control plane (${args.kind}); select a remote runner`);
      (await record(args.taskId, 'world.provisioning', { provider: args.kind }));
      const projectId = args.projectId ?? (await store.getTask(args.taskId))?.projectId;
      const project = projectId ? (await store.getProject(projectId)) : undefined;
      const forkPlan = (await store.getTask(args.taskId))?.params._forkWorld as ForkWorldSource | undefined;
      const forkSource = forkPlan && forkPlan.base === args.base ? forkPlan : undefined;
      let forkCheckpoint: import('../domain/types.js').WorldCheckpoint | undefined;
      if (forkSource) {
        const sourceTask = (await store.getTask(forkSource.taskId));
        if (!sourceTask || sourceTask.projectId !== projectId)
          throw new Error('fork world does not belong to this project');
        if (forkSource.unpublished) {
          if (!deps.checkpoints) throw new Error('world checkpoints are required to fork unpublished work');
          const saved = (await store.kvGet(`fork-checkpoint:${args.taskId}`));
          if (saved) forkCheckpoint = (await store.getWorldCheckpoint(saved));
          if (!forkCheckpoint) {
            // Wait for an idle source, including workflow-owned Git operations.
            // A gap between two agent turns is not an idle world.
            const sourceBusy = async () => {
              const view = await store.taskExecutionState(forkSource.taskId);
              if (view && ['done', 'cancelled', 'failed'].includes(view.status ?? '')) return false;
              return view?.status === 'active' || Boolean(view?.agentTurn);
            };
            if ((await sourceBusy())) (await record(args.taskId, 'world.fork-waiting', { sourceTaskId: forkSource.taskId }));
            while ((await sourceBusy())) {
              let context: ReturnType<typeof activityContext.current> | undefined;
              try { context = activityContext.current(); } catch { /* direct activity test */ }
              context?.cancellationSignal.throwIfAborted();
              context?.heartbeat({ waitingFor: 'fork-source', taskId: forkSource.taskId });
              await new Promise((resolve) => setTimeout(resolve, 2_000));
            }
            const source = (await store.currentWorld(forkSource.taskId)) as WorldHandle | undefined;
            if (!source) throw new Error('source world is unavailable; choose another starting branch to fork only the conversation');
            // The source may finish while this fork waits for setup. Its world
            // is deliberately destroyed then; provider status can still say ready
            // (cached or after a worker restart). Never reopen that world or acquire
            // a new source lease: use its durable snapshot, preserving the fork's
            // original branch/files rather than silently switching to the target.
            const sourceStatus = (await store.getTask(forkSource.taskId))?.lastView?.status;
            const finished = (sourceStatus && ['done', 'cancelled', 'failed'].includes(sourceStatus))
              || (await store.worldState(source.id)) === 'released';
            if (finished) {
              forkCheckpoint = (await store.latestWorldCheckpoint(source.id));
              if (!forkCheckpoint || forkCheckpoint.generation !== (source.generation ?? 1))
                throw new Error('source world has finished without a checkpoint for its current generation; choose another starting branch to fork only the conversation');
            } else {
              const state = await worlds.status(source);
              if (state !== 'ready' && source.checkpointId)
                forkCheckpoint = (await store.getWorldCheckpoint(source.checkpointId));
            }
            if (!forkCheckpoint) {
              const sourceWorld = await openWorld(source, source.id);
              if (isRemote(source.kind)) {
                const pushed = await publishTaskBranch(sourceWorld, source.id);
                if (pushed.skipped.length) throw new Error(`could not persist fork branch: ${describePublishFailures(pushed)}`);
              }
              forkCheckpoint = await deps.checkpoints.checkpoint(sourceWorld.handle, { scrubSecrets: false });
            }
            (await store.pinWorldCheckpointForFork(args.taskId, forkCheckpoint.id));
          }
          if (forkCheckpoint.worldId !== forkSource.taskId || forkCheckpoint.projectId !== projectId)
            throw new Error('fork checkpoint does not belong to the source task');
        }
      }
      const organizationId = project?.organizationId ?? 'org_personal';
      // Resolve the human creator's profile. A tenant-wide identity is only valid
      // for a system-created task with no human ancestor.
      const gitBinding = (await developmentGitBinding(args.taskId, projectId, args.gitProfile));
      const { profile, profiles: gitProfiles } = gitBinding;
      let gitIdentity: WorldSpec['gitIdentity'];
      let gitCredentials: WorldSpec['gitCredentials'];
      try {
        gitIdentity = profile
          ? (await gitProfiles.identity(profile, { taskId: args.taskId }))
          : gitBinding.userId
            ? { name: 'karmax', email: `karmax+${gitBinding.userId.replace(/[^a-z0-9.-]/gi, '-')}@localhost` }
            : organizationId === 'org_personal'
              ? undefined
              : { name: 'karmax', email: `karmax+${organizationId.replace(/[^a-z0-9.-]/gi, '-')}@localhost` };
      } catch (e) {
        (await record(args.taskId, 'world.warning', { warning: `git profile "${profile?.name}": ${e instanceof Error ? e.message : e}` }));
      }
      try {
        gitCredentials = {
          ...(gitBinding.scope === 'org_personal' ? {} : { isolated: true }),
          ...(profile ? (await gitProfiles.worldCredentials(profile, { taskId: args.taskId })) : {}),
        };
        if (!Object.keys(gitCredentials).length) gitCredentials = undefined;
      } catch (e) {
        (await record(args.taskId, 'world.warning', { warning: `git profile "${profile?.name}" clone credentials: ${e instanceof Error ? e.message : e}` }));
      }
      // The project wiki is a platform-owned companion repository for source
      // work. A zero-repo task reads and mutates project state through the
      // platform API, so attaching the wiki there would secretly reintroduce a
      // branch, worktree, Git credential, and merge into an otherwise non-Git run.
      const wikiRoot = project
        ? ensureProjectWikiRepository(deps.contentDir ?? paths().content, project.id)
        : undefined;
      if (project && !(await store.projectWiki(project.id))) (await store.setProjectWikiRepository(project.id));
      const wikiRepository = project ? (await store.projectWiki(project.id))?.repository : undefined;
      const developmentSources = forkDevelopmentSources((args.repos?.length ? args.repos : args.repo ? [args.repo] : [])
        .map((source) => source.trim()).filter(Boolean), forkCheckpoint, [wikiRoot, wikiRepository?.sshUrl]);
      if (remote && developmentSources.length > 0 && project && (!wikiRepository || !wikiRepository.private))
        throw new Error('the project wiki needs a private GitHub remote before a cloud world can be created');
      const requestedSources = [
        ...developmentSources,
        ...(developmentSources.length > 0 && wikiRoot && (!remote || wikiRepository) ? [wikiRoot] : []),
      ];
      const executionConfig = project ? (await store.effectiveProjectConfig(project)) : undefined;
      const githubIsAuthority = remotePolicyOf(executionConfig) === 'pr';
      // Remote providers always need a network transport. Local PR worlds also
      // resolve one when available so GitHub-backed sources can fork from the
      // actual PR target; a local-only companion remains project-authoritative.
      const sourceResolutions: CloudGitSource[] = remote
        ? await Promise.all(requestedSources.map((source) => cloudGitSource(source)))
        : githubIsAuthority
          ? await Promise.all(requestedSources.map(async (source) => {
              try { return await cloudGitSource(source); }
              catch { return { source }; }
            }))
          : requestedSources.map((source) => ({ source }));
      const transportSources = sourceResolutions.map((resolved) => resolved.source);
      const worldSources = remote ? transportSources : requestedSources;
      for (let i = 0; i < sourceResolutions.length; i++) {
        if (remote && sourceResolutions[i]!.localPath)
          (await record(args.taskId, 'world.repository-resolved', {
            localPath: sourceResolutions[i]!.localPath, remote: sourceResolutions[i]!.source,
          }));
      }
      // Older/local workflow histories do not pass projectId into createWorld;
      // the durable task record is the compatibility source for repository
      // enrollment, credentials, and world ownership.
      const linkedRepositories = projectId ? (await store.listProjectRepositories(projectId)) : [];
      const organizationRepositories = project?.organizationId
        ? (await store.listRepositories(project.organizationId))
        : [];
      const hasCatalogedLocalSource = worldSources.some((_source, index) =>
        Boolean(sourceResolutions[index]?.localPath)
        && organizationRepositories.some((candidate) => sameRepository(candidate.sshUrl, transportSources[index]!)));
      const taskRecord = (await store.getTask(args.taskId));
      const commonBranchesResolved = taskRecord?.params[REPOSITORY_BRANCHES_RESOLVED_PARAM] === true;
      // A child is a stack on the parent's task branch in EVERY repository.
      // Project-level per-repository bases describe top-level task policy; they
      // must not detach one child checkout from the parent proposal it is meant
      // to merge back into. prepareChildTask publishes this parent ref before
      // provisioning, including repositories attached after the parent started.
      const childStack = Boolean(taskRecord?.parentTaskId && args.base);
      const repositoryBranches = Object.fromEntries(worldSources.flatMap((source, index) => {
        const candidate = linkedRepositories.find((entry) => sameRepository(entry.repository.sshUrl, transportSources[index]!));
        if (!candidate) return [];
        if (childStack) return [[source, { base: args.base, target: args.target ?? args.base }]];
        // New task records have already resolved the common base/target through
        // task → project → organization → repository fallback. Only an explicit
        // per-repository policy may override those values. Records without the
        // marker predate that resolver, so retain the old catalog fallback for
        // already-queued/in-flight work whose input may still say "main".
        if (commonBranchesResolved && !candidate.baseBranch && !candidate.targetBranch) return [];
        const base = candidate.baseBranch ?? (commonBranchesResolved ? args.base : candidate.repository.defaultBranch);
        const target = candidate.targetBranch
          ?? (candidate.baseBranch ? base : commonBranchesResolved ? args.target ?? base : candidate.repository.defaultBranch);
        return [[source, { base, target }]];
      }));
      const repositoryAuthorities: Record<string, 'project' | 'origin'> = Object.fromEntries(worldSources.flatMap((source, index) =>
        githubIsAuthority && githubSlug(transportSources[index]!) ? [[source, 'origin' as const]] : []));
      forkRecordedAuthority(forkCheckpoint, requestedSources).forEach((authority, index) => {
        if (authority) repositoryAuthorities[worldSources[index]!] = authority;
      });
      const repositoryOrigins = Object.fromEntries(worldSources.flatMap((source, index) =>
        !remote && sourceResolutions[index]?.localPath && transportSources[index] !== source
          ? [[source, transportSources[index]!]]
          : []));
      if (wikiRoot && requestedSources.includes(wikiRoot))
        repositoryBranches[remote ? worldSources[worldSources.length - 1]! : wikiRoot] = {
        base: PROJECT_WIKI_BRANCH, target: PROJECT_WIKI_BRANCH,
      };
      if (forkSource) {
        for (const [index, source] of worldSources.entries()) {
          const saved = forkSource.repos.find((repo) => sameRepository(repo.source, source)
            || sameRepository(repo.source, transportSources[index]!));
          if (saved) repositoryBranches[source] = { base: saved.base,
            // Companion and explicit repository destinations outrank the
            // task-wide target, including when an attempt inherits that field.
            target: repositoryBranches[source]?.target
              ?? (typeof taskRecord?.params.target === 'string' ? args.target || args.base
                : saved.target || args.target || args.base) };
        }
      }
      if (linkedRepositories.length || wikiRepository || hasCatalogedLocalSource) {
        if (!deps.githubApp && remote) throw new Error('hosted repositories require the configured GitHub App');
        const httpsTokens: Record<string, string> = {};
        await concurrentMap(worldSources, 3, async (source, index) => {
          const transportSource = transportSources[index]!;
          const linked = linkedRepositories.find((candidate) => sameRepository(candidate.repository.sshUrl, transportSource));
          const repository = linked?.repository
            ?? (wikiRepository && sameRepository(wikiRepository.sshUrl, transportSource) ? wikiRepository : undefined)
            // Local filesystem sources are explicitly configured project
            // authorities. In a cloud world their origin becomes the clone
            // transport; match that origin against the connected GitHub App
            // catalog even when the project predates repository attachments.
            ?? (sourceResolutions[index]?.localPath
              ? organizationRepositories.find((candidate) => sameRepository(candidate.sshUrl, transportSource))
              : undefined);
          if (!repository) {
            // A configured host checkout remains usable without catalog
            // enrollment. Under local policy it is the authority; under PR
            // policy an un-enrolled GitHub transport can still use an explicit
            // Git profile/host credential while origin owns the base.
            if (sourceResolutions[index]?.localPath) return;
            if (remote) throw new Error(`repository ${source} is not enrolled in this project`);
            return;
          }
          if (deps.githubApp) httpsTokens[source] = await deps.githubApp.repositoryCloneToken(repository);
        });
        // Repository-scoped read-only installation tokens exist only during
        // trusted provisioning and are removed before the agent starts.
        if (Object.keys(httpsTokens).length) gitCredentials = { ...gitCredentials, httpsTokens };
      }
      const environmentSelection = projectId
        ? (await selectProjectEnvironment(store, projectId, args.kind, executionConfig?.environment, forkCheckpoint?.environment))
        : { built: false, environment: executionConfig?.environment };
      let acquired: { leaseId: string; runnerPoolId: string } | undefined;
      if (remote && project && deps.runners) {
        try {
          acquired = await timed('world.runner.wait', async () => deps.runners!.acquire({ project, taskId: args.taskId, worldId: args.taskId, provider: args.kind,
            priority: Number((await store.getTask(args.taskId))?.params.priority ?? 0), signal: activitySignal,
            heartbeat }));
        } catch (error) {
          stopCancellationHeartbeat();
          throw error;
        }
      }
      // Keep provisioning and durable registration in the same transition as
      // allocation. The orphan reaper must not mistake an in-flight replacement
      // for a duplicate of the previously registered sandbox.
      const provision = async () => {
        let world: World;
        const generation = (((await store.currentWorld(args.taskId))?.generation ?? 0) + 1);
        try {
          world = await worlds.create(args.kind, {
            taskId: args.taskId,
            signal: activitySignal,
            generation,
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
            ...(remote ? { copySources: sourceResolutions.map((source) => source.localPath) } : {}),
            gitIdentity,
            gitCredentials,
            ...(Object.keys(repositoryBranches).length ? { repositoryBranches } : {}),
            ...(Object.keys(repositoryAuthorities).length ? { repositoryAuthorities } : {}),
            ...(Object.keys(repositoryOrigins).length ? { repositoryOrigins } : {}),
            network: executionConfig?.network,
            environment: environmentSelection.environment,
            resources: executionConfig?.resources,
          });
        } catch (error) {
          if (acquired) (await deps.runners?.release(acquired.leaseId, args.kind));
          stopCancellationHeartbeat();
          if (remote && isTransportError(error)) {
            const message = error instanceof Error ? error.message : String(error);
            throw ApplicationFailure.create({
              message,
              type: 'world-infra',
              nonRetryable: false,
              cause: error instanceof Error ? error : undefined,
            });
          }
          throw error;
        }
        try {
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
          // Provisioning may have replaced a missing base with an actual named
          // branch. Persist that fact, so views, retries and new attempts do not
          // reintroduce the missing name. Never let a companion wiki set task policy.
          const adjustment = developmentRepos[0]?.branchAdjustment;
          if (adjustment) {
            const patch: Record<string, string> = {};
            if (adjustment.requestedBase === args.base) {
              world.handle.base = adjustment.base;
              patch.base = adjustment.base;
            }
            if ((adjustment.requestedTarget ?? adjustment.requestedBase) === (args.target ?? args.base)) {
              world.handle.target = adjustment.target;
              patch.target = adjustment.target;
              // Other checkouts may legitimately retain the old common target.
              for (const repo of developmentRepos) {
                if (repo.target && repo.target !== adjustment.target) repo.targetPinned = true;
              }
            }
            if (taskRecord && Object.keys(patch).length) {
              const current = await store.getTask(args.taskId);
              // A target edit may have arrived while the clone was running.
              if (current?.params.target && current.params.target !== args.target) delete patch.target;
              await store.patchTaskParams(args.taskId, patch);
            }
          }

          if (forkCheckpoint) {
            activitySignal?.throwIfAborted();
            await timed('world.fork-restore', () => deps.checkpoints!.applyFork(forkCheckpoint.id, world, projectId!, { signal: activitySignal }));
            if (forkCheckpoint.ignored?.entries.length || forkCheckpoint.ignored?.truncated)
              world.handle.warnings = [...(world.handle.warnings ?? []),
                'The source checkpoint excludes unmanaged Git-ignored files. Recreate caches or attach required data as a project resource.'];
          }
          if (projectId && deps.resources) {
            const revisions = Object.fromEntries((forkCheckpoint?.resources ?? [])
              .map((resource) => [resource.attachmentId, resource.revisionId]));
            activitySignal?.throwIfAborted();
            world.handle = await timed('world.resources', () => deps.resources!.materialize(projectId, args.taskId, world, generation, revisions,
              { signal: activitySignal }));
          }
          if (projectId) {
            activitySignal?.throwIfAborted();
            const runtime = await activateProjectRuntime({ world, store, projectId, taskId: args.taskId,
              selection: environmentSelection, resources: deps.resources, services: forkCheckpoint?.services, runSetupIfUnbuilt: true });
            world.handle = runtime.handle;
            for (const warning of runtime.warnings) (await record(args.taskId, 'world.warning', { warning }));
          }
          if (profile) world.handle.meta = { ...world.handle.meta,
            gitProfile: profile.name, gitProfileScope: gitBinding.scope };
          if (projectId) world.handle.meta = { ...world.handle.meta, projectId,
            repositoryIds: [...linkedRepositories.map((candidate) => candidate.repository.id),
              ...(wikiRepository ? [wikiRepository.id] : [])] };
          if (acquired) world.handle.meta = { ...world.handle.meta, worldLeaseId: acquired.leaseId };
          activitySignal?.throwIfAborted();
          if (projectId) {
            world.handle = (await store.registerWorld(world.handle, projectId, {
              runnerPoolId: acquired?.runnerPoolId ?? (remote ? `managed-${args.kind}` : 'local'),
              environmentDigest: environmentSelection.digest
                ?? (remote ? String(world.handle.meta?.environmentArtifact
                  ?? `${args.kind}:${executionConfig?.environment?.flavor ?? 'headless'}`) : 'karmax-local'),
            })) as WorldHandle;
          }
          activitySignal?.throwIfAborted();
          (await record(args.taskId, 'world.created', { handle: world.handle }));
          if (forkPlan) (await record(args.taskId, 'world.forked', { sourceTaskId: forkPlan.taskId,
            base: args.base, checkpointId: forkCheckpoint?.id, unpublished: Boolean(forkCheckpoint) }));
          (await record(args.taskId, 'world.ready', { provider: world.handle.kind, generation: world.handle.generation ?? 1 }));
          for (const warning of world.handle.warnings ?? []) (await record(args.taskId, 'world.warning', { warning }));
        } catch (error) {
          // `world` is still live on this path — pass it, or teardown addresses the
          // HOST daemon while the containers live inside the world (a silent no-op).
          await deps.resources?.release(world.handle, world).catch(() => undefined);
          await destroyWorldServices(args.taskId, world).catch(() => undefined);
          await world.destroy().catch(() => undefined);
          if (acquired) (await deps.runners?.release(acquired.leaseId, args.kind));
          stopCancellationHeartbeat();
          throw error;
        }
        stopCancellationHeartbeat();
        return world.handle;
      };
      try {
        return await (worlds.withOperation ? worlds.withOperation(args.taskId, provision) : provision());
      } finally { stopCancellationHeartbeat(); }
      })));
      } finally { stopCancellationHeartbeat(); }
    },

    /** The effective provider for a role's turn (task override → seeded profile),
     *  so the workflow can lease an account of the right provider (SPEC §6.2). */
    async resolveProvider(args: { role: AgentRole; task: TaskInput }): Promise<string> {
      return (await turnProfile(args.task, args.role)).profile.provider;
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
      // Hosted plans cap every active agent run, including subscription CLIs
      // executing inside a remote world. The coordinator activity resolves this
      // request to an organization-scoped entitlement queue; private installs
      // retain the host-resource-only behavior below.
      if (store.hosted) return true;
      if (!isRemote(args.worldHandle.kind)) return true;
      if (args.accountCredentialKind === 'key') return true;
      if (args.accountCredentialKind === 'login' || args.accountCredentialKind === 'ambient') return false;

      // Replay compatibility for workflow histories recorded before credential
      // metadata accompanied the lease. A broker handle is an API rail; a config
      // home is a provider-hosted subscription rail.
      if (args.accountApiKeyHandle && deps.broker) return true;
      if (args.accountConfigHome) return false;

      const profile = (await turnProfile(args.task, args.role)).profile;
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
      const organizationId = (await store.getProject(args.projectId))?.organizationId ?? 'org_personal';
      const sources = gatherCredentialSources({ configHomes: deps.configHomes, broker: deps.broker, organizationId });
      const all = enumerateCredentials(sources);
      const layers = (await readPolicyLayers(async (k) => (await store.kvGet(k)), { organizationId, projectId: args.projectId, taskId: args.taskId }));
      const profile = args.role && args.task
        ? (await turnProfile(args.task, args.role)).profile
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
        const raw = (await store.kvGet(`sessionmeta:${resume.taskId}:${srcRole}`));
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
      if (!keys.length && profile && managedModelRailAvailable(store.hosted,
        await store.getOrganizationUsagePolicy(organizationId), profile)) return [];
      // An empty compatible set must not fall through to an ambient/profile
      // credential and bypass an explicit disable. A non-existent allow-list
      // entry makes the coordinator deny the turn with a credential action.
      return keys.length || profile?.provider === 'mock'
        ? keys
        : [`missing:${organizationId}:${missingNamespace}`];
    },

    async runAgentTurn(args: RunAgentTurnArgs) {
      const attemptStarted = Date.now();
      let timingAttempt = 1, timingTurnId = args.agentTurnId;
      let timingSignal: AbortSignal | undefined;
      let resultCheckpointed = false;
      let heartbeat: (() => void) | undefined;
      let hbSession: string | undefined;
      let workflowRunId: string | undefined;
      let scheduleToStartWallEstimateMs: number | undefined;
      try {
        const activity = activityContext.current();
        timingAttempt = activity.info.attempt;
        workflowRunId = activity.info.workflowExecution?.runId;
        timingSignal = activity.cancellationSignal;
        timingTurnId ??= `legacy:${activity.info.workflowExecution?.runId ?? 'standalone'}:${activity.info.activityId}`;
        hbSession = (activity.info.heartbeatDetails as { session?: string } | undefined)?.session
          ?? (activity.info.attempt > 1 ? (await store.kvGet(`turnsession:${timingTurnId}`)) : undefined);
        heartbeat = () => activity.heartbeat(hbSession ? { session: hbSession } : undefined);
        // Cross-clock estimate only: Temporal schedule to worker receipt.
        if ((await timingEnabled(store))) scheduleToStartWallEstimateMs = Date.now() - activity.info.currentAttemptScheduledTimestampMs;
      } catch { /* direct fixture */ }
      const requestIds = (await timingEnabled(store)) ? args.messages.slice(args.deliveredMessages ?? 0)
        .filter(m => m.role === 'user').map(m => `${args.taskId}:${m.id}`) : undefined;
      const trace = (await installationTiming(store, { taskId: args.taskId, turnId: timingTurnId, workflowRunId,
        attempt: timingAttempt, role: args.role, requestIds }, async row => (await record(args.taskId, 'timing', { ...row }))));
      trace.signal = timingSignal;
      // Sandbox resume, history/tool preparation and final artifact retention
      // can each outlast the heartbeat timeout. Keep this entire activity alive,
      // retaining the exact retry session even before world.open finishes, and
      // stop on every exit. This is the turn's one liveness timer: it also
      // delivers cancellation through a silent provider stretch (LT-13).
      const keepAlive = heartbeat ? setInterval(() => {
        try { heartbeat!(); } catch { /* cancellation is handled by the activity */ }
      }, 1_000) : undefined;
      keepAlive?.unref();
      try {
      return await withTiming(trace, () => trace.measure('agent.attempt', async () => {
      (await trace.mark('activity.started', { scheduleToStartWallEstimateMs }));
      const spec = args.task.agents?.[args.role];
      const selectedTurn = (await turnProfile(args.task, args.role, args.explicitProfileId));
      const avatar = selectedTurn.avatar;
      let profile = selectedTurn.profile;
      const leasedCredentialProvider = args.accountCredentialProvider
        ? canonicalModelProvider(args.accountCredentialProvider)
        : undefined;
      if (profile.provider === 'opencode' && leasedCredentialProvider) {
        // Internal, per-turn resolution only. Persisted/task modelProvider values
        // are stripped by applyAgentSpec; the credential actually leased by the
        // general policy is the sole authority for custom/unprefixed model ids.
        profile = { ...profile, modelProvider: leasedCredentialProvider };
      }
      const organizationId = (await store.getProject(args.task.projectId))?.organizationId ?? 'org_personal';
      let world: World;
      try {
        world = await timed('world.open', () => openWorld(args.worldHandle, args.taskId));
      } catch (error) {
        // Reconnecting/resuming a cloud sandbox is part of the turn's transport
        // boundary. A control-plane outage here is no more agent-actionable than
        // a PTY or filesystem request failing after the adapter starts.
        throw classifyTurnError(error, profile.provider);
      }

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
      let legacyAgentTurnId: string | undefined;
      let turnSessionKey: string | undefined;
      let delegationKey: string | undefined;
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
          legacyAgentTurnId = `legacy:${actx.info.workflowExecution?.runId}:${actx.info.activityId}`;
        }
        const stableTurnId = args.agentTurnId ?? legacyAgentTurnId;
        turnSessionKey = stableTurnId ? `turnsession:${stableTurnId}` : undefined;
        // Queued sub-task spawns/answers survive a retry of the same turn.
        delegationKey = stableTurnId ? `turnspawns:${stableTurnId}` : undefined;
        // Heartbeat details are Temporal's primary retry checkpoint. The per-turn
        // SQLite key closes the small hard-kill window before a heartbeat reaches the
        // service; unlike session:<task>:<role>, it cannot accidentally pick up a
        // stale session from an earlier turn.
        const prior =
          (actx.info.heartbeatDetails as { session?: string } | undefined)?.session ??
          (actx.info.attempt > 1 && turnSessionKey ? (await store.kvGet(turnSessionKey)) : undefined);
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
          const interruption = turnSessionKey ? parseInterruption(await store.kvGet(`${turnSessionKey}:interruption`)) : undefined;
          messages = [
            {
              id: `retry-${actx.info.attempt}`,
              role: 'user',
              text: interruption
                // Tell the agent what broke, or it reruns the command that froze the sandbox.
                ? `(This turn was interrupted mid-run: ${interruption.summary}.${interruption.memoryExhausted
                  ? ' Keep memory-hungry commands (type checks, test suites, builds) within the memory `free -m` reports as available.' : ''}`
                  + ' Continue from where you left off; if the work was already finished, restate the final result.)'
                : '(This turn was interrupted mid-run — the connection dropped or the host slept. Continue from where you left off; if the work was already finished, restate the final result.)',
              ts: 0,
            },
          ];
          (await record(args.taskId, 'turn.resumed', { role: args.role, attempt: actx.info.attempt }));
        }
      } catch {
        /* not running inside a Temporal activity (e.g. a direct unit test) */
      }

      // The workflow mints the agent's scoped credential (SPEC §8.3).
      // Every declared agent role preserves the selected task authorization.
      // Workflow duty is enforced by stage/decision handlers, not a hidden lower
      // permission level for Confirm, Resolve, or legacy Merge turns.
      // Approved credential escalations recorded after creation
      // (wiki plans/PLAN-passwords §7 approve-for-task) extend the stored grant here,
      // so the next minted token carries them without touching workflow input.
      const orgVaultItems = new VaultItems(store, deps.broker, undefined, organizationId);
      const approvedPermissions = (await new PermissionRequests(store, organizationId).extensionCaps(args.taskId, args.role));
      // Requesting human input is a non-removable safety valve for every task
      // agent. The API restricts task-scoped callers to their own task, so this
      // cannot be used to interrupt peer work or widen the agent's authority.
      const preparationTask = await store.getTask(args.taskId);
      const storedAuthorization = preparationTask?.params?._authorization as {
        capabilities?: string[];
        principal?: string;
        scope?: 'projects' | 'organization' | 'global';
        projectIds?: string[];
        organizationId?: string;
        delegationId?: string;
      } | undefined;
      const delegatedAuthorization = avatar?.authorization;
      // A task may have been authorized by a routed Avatar without itself using
      // that Avatar as its role profile. Re-evaluate that delegation on every
      // turn so disabling the authorizer, narrowing its authority, or revoking
      // its backing principal immediately attenuates the task as well.
      const authorizingAvatarId = !avatar && storedAuthorization?.principal?.startsWith('avatar:')
        ? storedAuthorization.principal.slice(7) : undefined;
      const authorizingAvatar = authorizingAvatarId ? (await store.getAvatar(authorizingAvatarId)) : undefined;
      const authorizingAvatarBackingCaps = authorizingAvatar
        ? (await avatarAuthorizationCapabilities(store, deps.authorization, authorizingAvatar, args.task.projectId))
        : [];
      const principalGrant = avatar
        ? (await avatarAuthorizationCapabilities(store, deps.authorization, avatar, args.task.projectId))
        : authorizingAvatarId
          ? attenuate(storedAuthorization?.capabilities ?? [], authorizingAvatarBackingCaps)
          : storedAuthorization?.capabilities ?? args.task.grant ?? DEFAULT_GRANT;
      const grant = [...new Set([
        ...principalGrant,
        ...(avatar ? [] : (await orgVaultItems.extensionCaps(args.taskId))),
        ...approvedPermissions,
        'task:escalate',
      ])];
      // Approved permission extensions join the task grant. The role ceiling
      // admits that grant for declared agent roles; it does not raise the
      // selected level or bypass the task's scope and durable approval checks.
      const ceiling = avatar
        ? [...new Set(grant)]
        : [...new Set([...roleCeiling(args.role), ...approvedPermissions])];
      const effective = attenuate(ceiling, grant);
      let token: string | undefined;
      if (deps.tokens) {
        const authorizationScope = storedAuthorization?.scope;
        const delegatedScope = delegatedAuthorization?.scope;
        const minted = (await deps.tokens.mint({
          taskId: args.taskId,
          profileId: profile.id,
          role: args.role,
          principal: avatar ? avatarPrincipal(avatar.id)
            : args.task.parentTaskId ? `task:${args.task.parentTaskId}` : (args.task.grantPrincipal ?? 'system:legacy-task'),
          projectId: avatar ? (delegatedScope ? undefined : args.task.projectId)
            : authorizationScope ? undefined : args.task.projectId,
          projectIds: avatar
            ? delegatedScope === 'projects' ? delegatedAuthorization?.projectIds : undefined
            : authorizationScope === 'projects' ? storedAuthorization?.projectIds : undefined,
          organizationId: avatar
            ? delegatedScope === 'global' ? undefined : (delegatedAuthorization?.organizationId ?? avatar.organizationId)
            : authorizationScope === 'global' ? undefined
              : (storedAuthorization?.organizationId ?? (await store.getProject(args.task.projectId))?.organizationId),
          audience: 'karmax-platform',
          executionId: args.agentTurnId ?? legacyAgentTurnId,
          executionAttempt: activityAttempt,
          executionRunId: workflowRunId,
          worldGeneration: args.worldHandle.generation,
          delegationId: avatar ? undefined : (storedAuthorization?.delegationId ?? args.task.delegationId),
          externalIdentities: avatar?.githubAccountId ? { githubAccountId: avatar.githubAccountId } : undefined,
          ceiling,
          grantorCaps: grant,
        }));
        token = minted.token;
        (await record(args.taskId, 'token.minted', { tokenId: minted.record.id, profile: profile.id, caps: effective,
          audience: minted.record.audience, executionId: minted.record.executionId, expiresAt: minted.record.expiresAt,
          ...(avatar ? { avatarId: avatar.id, avatarOwnerUserId: avatar.ownerUserId, promptVersion: avatar.promptVersion } : {}) }));
      }

      // JIT-resolve credentials via the broker (never journaled). Every current
      // turn receives its selection from the general Credentials policy.
      let resolvedAuth: { apiKey?: string; configHome?: string; oauthToken?: string } | undefined;
      // The coordinator's pool spans organizations; a leased home or key is used
      // only if it is one of THIS organization's credentials. (The mock agent
      // reads no credential; its pool entries exist only in tests.)
      if ((args.accountConfigHome || args.accountApiKeyHandle) && profile.provider !== 'mock') {
        const { gatherCredentialSources } = await import('../platform/credential-sources.js');
        const { enumerateCredentials } = await import('../platform/credentials.js');
        const own = enumerateCredentials(gatherCredentialSources({ configHomes: deps.configHomes, broker: deps.broker, organizationId }));
        if ((args.accountConfigHome && !own.some((c) => c.configHome && path.resolve(c.configHome) === path.resolve(args.accountConfigHome!)))
          || (args.accountApiKeyHandle && !own.some((c) => c.apiKeyHandle === args.accountApiKeyHandle)))
          throw ApplicationFailure.create({
            message: 'The credential leased for this turn is not available to this organization; reconnect the login or API key and retry.',
            type: 'agent-error',
            nonRetryable: true,
          });
      }
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
        const apiKey = deps.broker.resolve(args.accountApiKeyHandle, { taskId: args.taskId, profileId: profile.id, caps: [`use-credential:${args.accountApiKeyHandle}`] });
        resolvedAuth = { apiKey };
      }
      // A remote world cannot inherit the host CLI's ambient subscription by
      // process environment: the adapter has to seed that home into the remote
      // sandbox. Normally the account coordinator supplies it. Keep passthrough
      // correct too, both for installations with no coordinator and for recovery
      // histories that already recorded a transient pool-size probe as zero.
      // API keys still win and hosted tenants must never inherit operator auth.
      if (!resolvedAuth && organizationId === 'org_personal' && isRemote(args.worldHandle.kind)) {
        const envKey = profile.provider === 'claude' ? process.env.ANTHROPIC_API_KEY
          : profile.provider === 'codex' ? process.env.OPENAI_API_KEY
          : undefined;
        const ambientHome = profile.provider === 'claude'
          ? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
          : profile.provider === 'codex'
            ? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
            : undefined;
        if (!envKey && ambientHome) {
          const authPresent = profile.provider === 'codex'
            ? fs.existsSync(path.join(ambientHome, 'auth.json'))
            : fs.existsSync(path.join(ambientHome, '.credentials.json'))
              || fs.existsSync(path.join(path.dirname(ambientHome), '.credentials.json'));
          if (authPresent) {
            const tok = tokenToInject(ambientHome);
            resolvedAuth = { configHome: ambientHome, ...(tok ? { oauthToken: tok } : {}) };
          }
        }
      }
      const usagePolicy = (await store.getOrganizationUsagePolicy(organizationId));
      const managedInstallationRail = managedModelRailAvailable(store.hosted, usagePolicy, profile);
      if (
        organizationId !== 'org_personal'
        && profile.provider !== 'mock'
        && !args.accountConfigHome
        && !args.accountApiKeyHandle
        && !managedInstallationRail
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
      // Same-provider task forks use the provider's native branch operation. Cross-
      // provider histories, uploads, and public shares go through panagent; API rails
      // and unsupported native targets receive a guarded context message instead.
      if (!session && spec?.resumeFrom) {
        const srcRole = spec.resumeFrom.role ?? args.role; // a task has many agents; pick the source's role
        // A task fork reads the source's conversation, native session and world.
        // The API authorizes the pointer when it is set, but a pointer can
        // outlive that check (an old template's spawned run, a task created
        // before every agent spec was validated), so the turn re-checks it with
        // its own authority — the same check get_conversation would apply.
        if (spec.resumeFrom.taskId) {
          const source = (await store.getTask(spec.resumeFrom.taskId));
          const sourceOrganization = source ? (await store.getProject(source.projectId))?.organizationId ?? 'org_personal' : undefined;
          const readable = !!source && sourceOrganization === organizationId
            && (!deps.tokens || !token
              || (await deps.tokens.check(token, 'task:conversation:read', { taskId: source.id })).ok);
          if (!readable) {
            (await record(args.taskId, 'session.fork-failed', { from: spec.resumeFrom, reason: 'source-not-authorized' }));
            throw ApplicationFailure.create({
              message: `This agent cannot resume from task ${spec.resumeFrom.taskId}: it is not in this task's organization or its conversation is outside this task's authority.`,
              type: 'agent-error',
              nonRetryable: true,
            });
          }
        }
        // The config home THIS turn runs under — where the source session must be
        // visible for the provider to resolve it. Shared by both resume paths below.
        const ambientHome =
          profile.provider === 'codex' ? '.codex'
          : profile.provider === 'kimi' ? '.kimi-code'
          : profile.provider === 'grok' ? '.grok'
          : profile.provider === 'opencode' ? path.join('.local', 'share', 'opencode')
          : '.claude';
        const forkHome = resolvedAuth?.configHome || path.join(os.homedir(), ambientHome);
        const applyPanagent = async (source: PanagentSource, mode: 'context' | 'transcript') => {
          const imported = await importWithPanagent({
            source,
            provider: profile.provider,
            forkHome,
            worldPath: worldWorkingDirectory(world.handle),
            mode,
            native: !apiRail && ['claude', 'codex'].includes(profile.provider),
          });
          if (imported.kind === 'native') session = imported.sessionId;
          else {
            messages = [imported.message, ...args.messages];
            deliveredMessages = 0;
          }
          if (imported.warnings?.length) await record(args.taskId, 'session.import.warnings', { warnings: imported.warnings });
          return imported.kind;
        };
        const upload = spec.resumeFrom.upload;
        const share = spec.resumeFrom.sessionId ? publicConversationShare(spec.resumeFrom.sessionId) : undefined;
        const allowProviderId = deps.hostLocal ?? deploymentHostLocal();
        if (spec.resumeFrom.sessionId && !share && looksLikeConversationUrl(spec.resumeFrom.sessionId)) {
          throw ApplicationFailure.create({
            message: 'Use a public HTTPS ChatGPT or Claude share link, or upload a conversation file.',
            type: 'agent-error',
            nonRetryable: true,
          });
        }
        if (spec.resumeFrom.sessionId && !share && !allowProviderId) {
          throw ApplicationFailure.create({
            message: 'Provider conversation IDs are available only on a host-local Karmax. Upload the Codex/Claude conversation file or use a public HTTPS ChatGPT/Claude share link.',
            type: 'agent-error',
            nonRetryable: true,
          });
        }
        if (upload) {
          if (upload.projectId !== args.task.projectId)
            throw new Error('uploaded conversation belongs to a different project');
          if (!deps.objects) throw new Error('conversation import storage is unavailable');
          const data = await deps.objects.get(conversationImportObjectKey(args.task.projectId, upload.id));
          const kind = await applyPanagent({ data, name: upload.name }, 'transcript');
          (await record(args.taskId, 'session.imported', { source: 'upload', format: upload.format, provider: profile.provider, kind }));
        } else if (share) {
          const kind = await applyPanagent({ url: share }, 'context');
          (await record(args.taskId, 'session.imported', { source: 'share', provider: profile.provider, kind }));
        } else if (spec.resumeFrom.sessionId) {
          // A raw id is meaningful only on a host-local install, where the UI and
          // provider histories share one machine. Continue that exact session
          // (rather than branching it), copying its native file into the selected
          // config home/world when necessary.
          session = spec.resumeFrom.sessionId;
          let materialized =
            profile.provider === 'mock' || apiRail
              || profile.provider === 'opencode' || profile.provider === 'kimi' || profile.provider === 'grok'
              ? true
              : materializeFork({ provider: profile.provider, session, forkHome,
                worldPath: worldWorkingDirectory(world.handle), searchInstallation: true });
          // A local id may belong to the other native provider. Convert it into a
          // new independent destination session instead of rejecting the id merely
          // because the user selected a different agent above the source control.
          if (!materialized && (profile.provider === 'claude' || profile.provider === 'codex')) {
            const sourceProvider = profile.provider === 'claude' ? 'codex' : 'claude';
            const sourceFile = findProviderSession({ provider: sourceProvider, session, searchInstallation: true });
            if (sourceFile) {
              const kind = await applyPanagent({ path: sourceFile }, 'transcript');
              materialized = true;
              (await record(args.taskId, 'session.imported', { source: 'local-id', sourceProvider, provider: profile.provider, kind }));
            }
          }
          if (!materialized) {
            (await record(args.taskId, 'session.resume-failed', { session, provider: profile.provider }));
            throw ApplicationFailure.create({
              message: `Cannot find conversation "${session}" in this Karmax installation's Codex or Claude history. Check the provider conversation ID and try again.`,
              type: 'agent-error',
              nonRetryable: true,
            });
          }
          (await record(args.taskId, 'session.resumed', { session, materialized }));
        } else if (spec.resumeFrom.taskId) {
          const srcSession = (await store.kvGet(`session:${spec.resumeFrom.taskId}:${srcRole}`)) || undefined;
          let srcHome: string | undefined;
          let srcProvider: string | undefined;
          const metaRaw = (await store.kvGet(`sessionmeta:${spec.resumeFrom.taskId}:${srcRole}`));
          if (metaRaw) { try { const m = JSON.parse(metaRaw); srcHome = m.home || undefined; srcProvider = m.provider || undefined; } catch { /* ignore */ } }
          let prepared = false;
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
              (await record(args.taskId, 'session.fork-failed', {
                session: srcSession,
                reason: 'source-account-unavailable',
              }));
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
              prepared = true;
            } else if (profile.provider !== 'kimi' && profile.provider !== 'grok') {
              if (remoteSubscriptionRail) {
                const sourceHandle = (await store.currentWorld(spec.resumeFrom.taskId)) as WorldHandle | undefined;
                if (sourceHandle && isRemote(sourceHandle.kind)) {
                  try {
                    const sourceWorld = await openWorld(sourceHandle, spec.resumeFrom.taskId);
                    prepared = await materializeRemoteSession(sourceWorld, world, profile.provider, srcSession, forkHome);
                  } catch (error) {
                    if (error instanceof CodexHistoryError) throw error;
                    /* Source world may have expired; try the durable local home. */
                  }
                }
              }
              if (!prepared) prepared = materializeFork({ provider: profile.provider, session: srcSession,
                forkHome, worldPath: worldWorkingDirectory(world.handle), srcHome });
            }
            if (prepared) {
              session = srcSession;
              fork = true; // adapter branches a NEW session id from it (native fork)
              (await record(args.taskId, 'session.forked', { from: spec.resumeFrom, session: srcSession, native: true }));
            }
          }
          // When the selected destination agent differs, panagent translates the
          // source's real native history into a fresh destination session. A missing
          // native file still degrades safely to the stored visible transcript.
          if (!prepared && srcSession && srcProvider && srcProvider !== profile.provider
            && ['claude', 'codex'].includes(srcProvider)) {
            const sourceFile = findProviderSession({ provider: srcProvider, session: srcSession, srcHome });
            if (sourceFile) {
              try {
                const kind = await applyPanagent({ path: sourceFile }, 'transcript');
                prepared = true;
                (await record(args.taskId, 'session.forked', {
                  from: spec.resumeFrom, session: srcSession, native: kind === 'native', converted: true,
                  sourceProvider: srcProvider, provider: profile.provider,
                }));
              } catch (error) {
                if (error instanceof CodexHistoryError) throw error;
                (await record(args.taskId, 'session.fork-conversion-failed', {
                  from: spec.resumeFrom,
                  reason: error instanceof Error ? error.message : String(error),
                }));
              }
            }
          }
          if (!prepared) {
            if (srcSession && srcHome && profile.provider === 'codex' && !apiRail)
              throw new CodexHistoryError(`native source ${srcSession} is unavailable; preserving the task for recovery`);
            // Degraded fallback (no real source session file — e.g. the mock adapter,
            // a cleaned source, or a cross-provider jump): replay the source transcript
            // as context. NOT a native fork — flagged `native: false`.
            const srcView = (await store.getTask(spec.resumeFrom.taskId))?.lastView;
            const srcMsgs =
              srcView?.transcripts?.find((t) => t.role === srcRole)?.messages ??
              (srcRole === 'do' ? srcView?.messages : undefined) ??
              [];
            if (srcMsgs.length) {
              messages = [...srcMsgs, ...args.messages];
              (await record(args.taskId, 'session.forked', { from: spec.resumeFrom, replayed: srcMsgs.length, native: false }));
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
        const organizationId = (await store.getProject(args.task.projectId))?.organizationId ?? 'org_personal';
        bindings = { ...(bindings ?? {}), skills: renderSkillsIndex(listResolveSkills(paths().content, organizationId)) };
      }
      // Goal mode: the do agent is told to keep driving across turns until the
      // objective is verifiably complete. Appended to the built-in working
      // instructions so it flows through the wiki context and fallback alike.
      const promptEnd = (await trace.start('prompt.prepare'));
      const goalSuffix = args.role === 'do' && (args.task as { goalMode?: boolean }).goalMode
        ? `
- Goal mode is active. Continue autonomously across turns until the entire objective is complete and verified. A normal response does not finish the task: call signal_completion only when no required work remains. If you genuinely need a human decision, raise it with the appropriate task tool instead.`
        : '';
      const builtinInstructions = deps.globalInstructions;
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
        // Wiki pages the task references in its prompt/follow-ups (`[[proj:…]]`/`[[org:…]]`)
        // are inlined in full, as are the tokens in the task's wiki-context field
        // (`params.wikiContext`, read fresh here like the wiki content itself;
        // absent ⇒ the default `tag:default` tokens apply).
        const taggedText = [args.task.prompt, ...args.messages.filter((m) => m.role === 'user').map((m) => m.text)]
          .filter(Boolean)
          .join('\n');
        const wikiContext = preparationTask?.params?.wikiContext;
        try {
          wikiSnapshot = await trace.measure('prompt.wiki-snapshot', () => projectWikiPromptSnapshot(world));
        } catch { /* Keep organization and canonical project context available while the world is offline. */ }
        projectInstructions = buildWikiPromptContext({
          contentDir: deps.contentDir ?? paths().content,
          organizationId: (await store.getProject(args.task.projectId))?.organizationId,
          projectId: args.task.projectId,
          projectRoot: wikiSnapshot?.root,
          builtinInstructions,
          taggedText,
          contextTokens: Array.isArray(wikiContext) ? wikiContext.map(String) : undefined,
        }) || undefined;
        if (goalSuffix) projectInstructions = `${projectInstructions ?? ''}${goalSuffix}`;
      } catch {
        globalInstructions = `${deps.globalInstructions ?? GLOBAL_INSTRUCTIONS}${goalSuffix}`;
      } finally {
        wikiSnapshot?.release();
      }
      const liveTarget = preparationTask?.lastView?.targetBranch ?? args.task.target;
      const promptTask = liveTarget && liveTarget !== args.task.target
        ? { ...args.task, target: liveTarget }
        : args.task;
      const forkOrigin = preparationTask?.params._forkWorld as ForkWorldSource | undefined;
      const forkContext = forkOrigin ? `\n\nThis task forks the conversation of ${forkOrigin.taskId}. Starting branch: ${args.task.base}. `
        + (forkOrigin.base !== args.task.base
          ? 'The starting branch was changed. This world uses normal project initialization; the source task’s unpublished files and private resource snapshots were not copied. Verify remembered work against the files present here.'
          : forkOrigin.unpublished
            ? 'This independent world includes the source checkpoint’s unpublished work. Shared external services retain their configured sharing behavior.'
            : 'The source task landed. This world starts from its merge destination with the normal promoted project resources, rather than its old unpublished state.') : '';
      const attemptGroup = (await store.attemptGroup(args.taskId));
      const attemptContext = attemptGroup && attemptGroup.attempts.length > 1
        ? `\n\nThis task has ${attemptGroup.attempts.length} attempts. Other attempts: ${attemptGroup.otherAttempts ?? (await store.otherAttemptsDefault(args.taskId))}. `
          + (args.role === 'confirm' && !attemptGroup.committedAttemptId
            ? 'When accepting, set otherAttempts in confirm_decision to keep or cancel. Keep allows complementary proposals to continue and merge; cancel stops the alternatives. Follow an explicit project default; otherwise decide based on the value of the alternatives.'
            : 'If other attempts are kept, integrate against the latest target and assess combined behavior, redundant changes, and incompatible assumptions, as well as textual conflicts. Validate the combined result.')
        : '';
      const paymentService = deps.payments ? new BudgetService(store, deps.paymentRegistry ?? deps.payments) : undefined;
      const paymentCards = (await paymentService?.cards({ projectId: args.task.projectId, taskId: args.taskId, capabilities: args.task.grant })) ?? [];
      const paymentPolicy = (await paymentService?.policy(args.task.projectId, args.taskId));
      const paymentContext = paymentCards.length ? `\n\nPayment cards available to this task: ${JSON.stringify(paymentCards.map(c => ({ name: c.label, id: c.id })))}. `
        + `Task budget (${(paymentPolicy?.currency ?? 'usd').toUpperCase()}): ${paymentPolicy?.budget == null ? 'unlimited' : (paymentPolicy.budget / 100).toFixed(2)}. `
        + `Spent/reserved (${(paymentPolicy?.currency ?? 'usd').toUpperCase()}): ${((await store.paymentSpent(args.taskId, false, paymentPolicy?.currency)) / 100).toFixed(2)}. `
        + 'Use request_spend with card_name to choose a card. Follow the user’s restrictions on each card. Over-budget payments require approval.' : '';
      const systemPrompt = assemblePrompt({
        profile,
        role: args.role,
        task: promptTask,
        world: args.worldHandle,
        globalInstructions: (globalInstructions ?? '') + forkContext + attemptContext + paymentContext,
        projectInstructions,
        bindings,
      });
      // Snapshot the journaled turn input (SPEC §5.4).
      (await record(args.taskId, 'turn.prompt', { role: args.role, profile: profile.id, provider: profile.provider }));
      (await promptEnd());

      // Live follow-up poller (SPEC §5.6): a streaming adapter calls this mid-turn to
      // fetch follow-ups queued in the workflow at/after a `msgs` index and inject them
      // into the running session. Backed by the workflow's `pendingMessages` query;
      // absent when there's no client (unit tests) or the workflow doesn't define it
      // (the query throws → treated as "no new messages").
      // The query runs only once a follow-up has been journaled (LT-13).
      const pullFollowUps: ((fromIndex: number) => Promise<Message[]>) | undefined =
        deps.client && liveChannel
          ? gateFollowUps({
              query: async (fromIndex: number) => {
                try {
                  const handle = deps.client!.workflow.getHandle(args.taskId);
                  const out = (await handle.query('pendingMessages', args.role, fromIndex)) as Message[] | undefined;
                  return Array.isArray(out) ? await materializeFileAttachments(world, out) : [];
                } catch {
                  return []; // query not registered / workflow gone / transient — no injection
                }
              },
              cursor: () => store.latestEventSeq(),
              journaled: async (seq) => (await store.eventsOfType(args.taskId, ['conversation.message', 'view.updated', 'subtask.parent-response'], seq))
                .map(event => ({ seq: event.seq, pending: event.type === 'subtask.parent-response', messageId: event.type === 'conversation.message'
                  ? String((event.payload as { message?: { id?: string } }).message?.id ?? `seq:${event.seq}`) : undefined })),
            })
          : undefined;

      // Confirm turns for sibling attempts share one durable transcript and run
      // serially. Fresh provider sessions replay that canonical transcript, which
      // also works across account/config-home rotation (native sessions are home-bound).
      const releaseConfirm = args.role === 'confirm' ? await acquireConfirmLock(conversationTaskId, signal) : () => {};
      let confirmTranscript: Message[] | undefined;
      if (args.role === 'confirm') {
        let shared: Message[];
        try { shared = JSON.parse((await store.kvGet(`confirm-transcript:${conversationTaskId}`)) ?? '[]'); }
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
      const publishLegacyAgentState = async (state: 'waiting-slot' | 'running' | undefined) => {
        if (!legacyAgentTurnId) return;
        const taskRecord = (await store.getTask(args.taskId));
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
        (await store.saveView(args.taskId, next));
        (await record(args.taskId, 'view.updated', {
          stage: next.stage,
          status: next.status,
          waitingFor: next.waitingFor?.kind ?? null,
          waitingDetail: next.waitingFor?.detail ?? null,
          waitingSummary: next.waitingFor?.summary ?? null,
          waitingProvider: next.waitingFor?.provider ?? null,
          waitingResetAt: next.waitingFor?.earliestResetAt ?? null,
          agentTurn: next.agentTurn?.state ?? null,
          agentRole: next.agentTurn?.role ?? null,
          compatibility: 'legacy-agent-turn',
        }));
      };

      // Host-wide agent-turn admission (SPEC §12): cap concurrent model
      // subprocesses so a burst can't OOM the host. Acquired around the model
      // call ONLY — the setup above is cheap — and released in `finally` below.
      let releaseSlot: () => void | Promise<void> = () => {};
      let mcpCleanup: (() => Promise<void>) | undefined;
      let turnKeys: World | string | undefined;
      let lastEmit: string | undefined;
      let lastPressureDetail: string | undefined;
      let finalActivity: NonNullable<Message['sourceActivity']> | undefined;
      const resultKey = timingTurnId ? `turnresult:${args.taskId}:${args.role}:${timingTurnId}` : undefined;
      const savedResult = resultKey ? await store.kvGet(resultKey) : undefined;
      const checkpoint: { result: TurnResult; admissionId?: string } | undefined = savedResult ? JSON.parse(savedResult) : undefined;
      let result = checkpoint?.result;
      resultCheckpointed = !!checkpoint;
      let providerInvoked = false;
      let providerUsage: AdapterTurn['usage'];
      let usageAdmissionId: string | undefined = checkpoint?.admissionId;
      let usageAdmissionFinished = false;
      const fundingSource: 'managed' | 'byok' | 'customer' = store.hosted
        ? ((args.accountApiKeyHandle || args.accountConfigHome || args.accountCredentialKind === 'login') ? 'byok' : 'managed')
        : 'customer';
      const modelProvider = canonicalModelProvider(args.accountCredentialProvider ?? credentialProvider(profile));
      const managedReservationMicros = fundingSource === 'managed'
        ? managedModelCostCeiling(modelProvider, profile.model) : undefined;
      const finishUsage = async (completed: boolean | undefined) => {
        if (usageAdmissionId) {
          const usage = result?.usage ?? providerUsage;
          const completedUsageEvents: any[] = [];
          if (usage) {
            const quantity = usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
            completedUsageEvents.push({ id: `usage:tokens:${usageAdmissionId}`, organizationId, projectId: args.task.projectId,
              taskId: args.taskId, worldId: args.worldHandle.id, provider: modelProvider,
              kind: 'agent.tokens', quantity, unit: 'token', costMicros: 0, fundingSource, costClassification: 'none',
              startedAt: Date.now(), endedAt: Date.now(), metadata: { role: args.role, model: profile.model,
                metering: 'provider-reported', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                inputTokensIncludeCacheRead: usage.inputTokensIncludeCacheRead ?? false } });
          }
          if (fundingSource === 'managed') {
            const actualized = managedModelActualCost(modelProvider, profile.model, usage, managedReservationMicros!);
            completedUsageEvents.push({ id: `usage:cost:${usageAdmissionId}`, organizationId, projectId: args.task.projectId,
              taskId: args.taskId, worldId: args.worldHandle.id, provider: modelProvider,
              kind: 'agent.cost', quantity: 0, unit: 'request', costMicros: actualized.costMicros,
              fundingSource, costClassification: actualized.classification,
              startedAt: Date.now(), endedAt: Date.now(), metadata: { role: args.role, model: profile.model,
                ...actualized.metadata } });
          }
          // Completion and incurred/estimated cost actualization commit together:
          // no concurrent admission can observe the reservation released before
          // its durable replacement exists, and a duplicate retry sees completed.
          (await store.finishUsageAdmission(usageAdmissionId, completed, Date.now(), completedUsageEvents));
          usageAdmissionFinished = completed !== undefined;
        }
      };
      const admissionEnd = (await trace.start('admission.host'));
      try {
        if (!result) {
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
        // Trusted model admission: this runs inside the activity, immediately
        // before any provider process/API request. The stable turn id makes the
        // reservation retry-safe and binds every request to its org/project/task.
        if (profile.provider !== 'mock') {
          const turnId = args.agentTurnId ?? legacyAgentTurnId ?? `agent:${args.taskId}:${args.role}`;
          const admissionId = activityAttempt > 1 ? `${turnId}:attempt:${activityAttempt}` : turnId;
          (await store.admitAgentUsage({ id: admissionId, organizationId, projectId: args.task.projectId,
            taskId: args.taskId, provider: modelProvider, model: profile.model, fundingSource,
            ...(activityAttempt > 1 ? { retryOf: Array.from({ length: activityAttempt - 1 },
              (_, index) => index === 0 ? turnId : `${turnId}:attempt:${index + 1}`) } : {}),
            reservedCostMicros: managedReservationMicros }));
          // A rejected admission does not own the existing reservation and must
          // not release it in finally (it may belong to a different live turn).
          usageAdmissionId = admissionId;
          // Record the admitted request immediately, before the provider call. Its
          // stable id makes retries/duplicate delivery a no-op. The hard-cap debit
          // remains only on the active admission row; it is not incurred cost.
          (await store.recordUsage({ id: `usage:request:${usageAdmissionId}`, organizationId,
            projectId: args.task.projectId, taskId: args.taskId, worldId: args.worldHandle.id,
            provider: modelProvider, kind: 'agent.request', quantity: 1, unit: 'request',
            costMicros: 0, fundingSource, costClassification: 'none', startedAt: Date.now(), endedAt: Date.now(),
            metadata: { role: args.role, model: profile.model, costBasis: 'request-count-only' } }));
        }
        // Remote subscription CLIs consume provider-world CPU/RAM, not host
        // capacity. API rails and local subprocesses retain the host admission
        // queue; account-level concurrency is enforced separately for every rail.
        if (!remoteSubscriptionRail) {
          (await publishLegacyAgentState('waiting-slot'));
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
        (await admissionEnd());
        // The workflow publishes `waiting-slot` immediately after the account grant;
        // only admission itself can truthfully report that the model is now running.
        await signalTurnState('running');
        (await publishLegacyAgentState('running'));
        // File bytes never enter Temporal history or a provider attachment API.
        // Recreate their stable world paths immediately before every turn so a
        // restored cloud sandbox or a repeatedly-forked session can still read them.
        const turnMessages = await materializeFileAttachments(world, messages);
        const chosenMcp = profile.mcpConnections === undefined ? [] : await timed('tool.connection.prepare', () => prepareConnections(
          deps.broker ? new McpConnections(store, deps.broker, organizationId) : undefined, world, profile.mcpConnections!, args.task.projectId, args.taskId, (cleanup) => { mcpCleanup = cleanup; }));
        (await store.appendAudit({ principalId: `task:${args.taskId}`, action: 'mcp.selected', scopeKey: `project:${args.task.projectId}`, detail: { connections: profile.mcpConnections ?? [], role: args.role } }));
        let pullSecretEnv: (() => Promise<Record<string, string>>) | undefined;
        // Whatever the agent prints is archived (RT-12); scrub every value this
        // turn was handed, including secrets that arrive mid-turn.
        const secrets = new SecretScrubber();
        secrets.add(token, resolvedAuth?.apiKey, resolvedAuth?.oauthToken);
        result = await runRuntimeTurn({ version: KARMAX_RUNTIME_PROTOCOL, input: {
          profile,
          world,
          messages: turnMessages,
          session,
          deliveredMessages,
          fork,
          systemPrompt: systemPrompt + (profile.mcpConnections?.some(id => id.startsWith('composio:')) ? '\nSelected app accounts (use list_connections and the connection tools; existing sharing permissions still apply): ' + profile.mcpConnections.filter(id => id.startsWith('composio:')).map(id => id.slice(9)).join(', ') : ''),
          role: args.role,
          maxTurns: profile.maxTurns,
          ...(resolvedAuth ? { resolvedAuth } : {}),
          // Git-profile credentials for the agent subprocess (wiki plans/PLAN-git-config
          // §4B): an agent that pushes or runs `gh` acts as the project's account.
          ...(await (async () => {
            // Remote provider tools receive repository credentials through the
            // broker, but the local harness process must still have host Git
            // credentials scrubbed for non-personal organizations.
            const gitEnv = isRemote(args.worldHandle.kind) && organizationId === 'org_personal'
              ? {}
              : (await gitEnvFor(args.worldHandle, args.taskId));
            // Granted `auto` vault items materialize into the work-command env
            // (wiki plans/PLAN-passwords §5A): .env bags, API keys under their envVar,
            // SSH keys as 0600 files inside the receiving world, removed when the
            // turn ends (AU-33).
            // Item resolution is per-organization (the tenant boundary), so bind
            // to the task's org — not the module-level personal-org instance.
            turnKeys = isRemote(args.worldHandle.kind) ? world : turnKeyDirectory();
            const vaultEnv = await orgVaultItems.envFor(args.taskId, effective, turnKeys);
            // The platform MCP subprocess inherits this short-lived workflow
            // token. The gateway accepts it directly and enforces its project +
            // capability grant; no full-power browser session is ever acquired.
            const extraEnv = { ...gitEnv, ...(token ? { KARMAX_TOKEN: token } : {}) };
            // Values are resolved from resource leases and broker handles only
            // now, at the activity boundary. Keep application secrets separate
            // from runtime env so they cannot change model auth or startup.
            const secretEnv = { ...(await deps.resources?.environmentFor(world.handle)), ...vaultEnv };
            secrets.add(...Object.values(secretEnv),
              ...Object.entries(gitEnv).filter(([key]) => /token|password|secret|credential|key/i.test(key)).map(([, value]) => value));
            // Project settings keep applying while the agent runs (a secret added
            // after it started must reach the command it runs next), not only at
            // the next world open.
            const resources = deps.resources;
            if (resources) pullSecretEnv = async () => {
              const refreshed = { ...(await resources.refresh(world.withoutProjectEnvironment?.() ?? world)), ...vaultEnv };
              secrets.add(...Object.values(refreshed));
              return refreshed;
            };
            return {
              ...(Object.keys(extraEnv).length ? { extraEnv } : {}),
              ...(Object.keys(secretEnv).length ? { secretEnv } : {}),
            };
          })()),
          // MCP servers the workflow gives its agents (SPEC §7.5).
          agentMcp: [...(args.task.workflow ? manifest(args.task.workflow)?.agentMcp ?? [] : []), ...chosenMcp],
        } }, {
          adapters: deps.adapters,
          onProviderStart: async () => {
            // The estimate survives a killed worker that cannot run finally. A
            // provider-reported result refines it; unknown usage stays estimated.
            if (fundingSource === 'managed') await finishUsage(undefined);
            providerInvoked = true;
          },
          onProviderResult: turn => { providerUsage = turn.usage; },
          signal,
          heartbeat,
          pullFollowUps,
          pullSecretEnv: () => pullSecretEnv?.() ?? Promise.resolve({}),
          // Coalesce the live-output stream: adapters re-emit the growing *cumulative*
          // message text, so consecutive identical/prefix emits carry no new info.
          // Dropping them cuts the single biggest events-table growth driver
          // (one row per chunk) without changing what the UI renders.
          onEmit: async (t, source) => {
            // Assistant text is still being generated and may end mid-secret.
            const text = source === 'assistant' ? secrets.scrubPartial(t) : secrets.scrub(t);
            if (text === lastEmit || !text && source === 'assistant') return;
            lastEmit = text;
            const payload = { text, source, role: args.role, turnId: args.agentTurnId ?? legacyAgentTurnId, workflowRunId, attempt: activityAttempt };
            if (source !== 'assistant') { (await record(args.taskId, 'agent.output', payload)); return; }
            // Each publication supersedes the last (#396 review item 2).
            const event = { type: 'agent.output', taskId: args.taskId, ts: Date.now(), payload };
            deps.bus?.emit({ ...event, seq: (await store.appendLiveOutput(event)) });
          },
          ...(delegationKey ? {
            queuedDelegation: await store.kvGet(delegationKey).then(raw => raw ? JSON.parse(raw) : undefined),
            onDelegation: async (queued: QueuedDelegation) => { (await store.kvSet(delegationKey!, JSON.stringify(queued))); },
          } : {}),
          onReviewInfo: async (info, supplied) => {
            signal?.throwIfAborted();
            if (deps.objects) await preserveReviewArtifacts(store, deps.objects, world, args.taskId, supplied);
            (await store.checkpointReviewInfo(args.taskId, info));
            (await record(args.taskId, 'review.updated', {}));
          },
          onActivity: async (activity) => {
            const turnId = args.agentTurnId ?? legacyAgentTurnId;
            if (activity.kind === 'message' && turnId) {
              finalActivity = { turnId, id: activity.id, attempt: activityAttempt };
            }
            (await record(args.taskId, 'agent.activity', {
              ...activity,
              title: secrets.scrub(activity.title),
              ...(activity.detail !== undefined ? { detail: secrets.scrub(activity.detail) } : {}),
              role: args.role,
              attempt: activityAttempt, workflowRunId,
              ...(turnId ? { turnId } : {}),
            }));
          },
          // Publish the session id + its home the moment the adapter knows it (mid-turn),
          // so the drawer's live "fork this agent" command appears WHILE the turn runs,
          // not only at turn-end (RESOLVE-PLAN #3). Fire-once per session in the adapters.
          onSession: async (s) => {
            hbSession = s; // heartbeats now carry it → a retry resumes this session
            if (turnSessionKey) (await store.kvSet(turnSessionKey, s));
            // Do not wait for the 10-second liveness interval: checkpoint the newly
            // minted provider session immediately so a restart on the next instruction
            // still resumes this exact turn.
            heartbeat?.();
            (await store.kvSet(`session:${conversationTaskId}:${args.role}`, s));
            (await store.kvSet(
              `sessionmeta:${conversationTaskId}:${args.role}`,
              JSON.stringify({
                home: resolvedAuth?.configHome ?? '',
                provider: profile.provider,
                ...(profile.model ? { model: profile.model } : {}),
                ...(profile.effort ? { effort: profile.effort } : {}),
              }),
            ));
            (await record(args.taskId, 'session.started', { role: args.role }));
          },
          ...(deps.payments
            ? {
                budget: new BudgetService(store, deps.paymentRegistry ?? deps.payments),
                spendCtx: {
                  projectId: args.task.projectId,
                  taskId: args.taskId,
                  organizationId: (await store.getProject(args.task.projectId))?.organizationId,
                  capabilities: effective,
                },
                onSpend: async (req: any, outcome: any) => { await record(args.taskId, 'spend.requested', { ...req, status: outcome.status, reason: outcome.reason }); },
                fillPaymentCard: async (fill: {
                  requestId: string;
                  selectors: import('../autonomy/card-fill.js').CardFillSelectors;
                }) => {
                  // Fill the browser the agent's MCP drives: inside the world whenever
                  // the agent itself runs there (cloud sandboxes and containers), else
                  // the one this task's agent launched on the host (AU-32). Found
                  // before a fill attempt is counted against the reservation.
                  const cdpUrl = isRemoteAgentWorld(world) ? WORLD_CDP_URL : localTaskBrowserUrl(args.taskId);
                  const { request, domain } = await new BudgetService(store, deps.paymentRegistry ?? deps.payments!).claimFill({
                    projectId: args.task.projectId, taskId: args.taskId, capabilities: effective,
                  }, fill.requestId);
                  const card = request.cardId ? (await store.getCard(request.cardId)) : undefined;
                  if (!card) throw new Error('secure fill requires a reserved card');
                  if (!(await new BudgetService(store, deps.paymentRegistry ?? deps.payments!).cards({
                    projectId: args.task.projectId, taskId: args.taskId, capabilities: effective,
                  })).some(c => c.id === card.id)) throw new Error('card is no longer selected for this task');
                  // Any rail that can resolve a card's secret half is fillable; the
                  // mock rail deliberately cannot, because it moves no real money.
                  const provider = deps.paymentRegistry?.forCard(card as any);
                  if (!provider?.retrieveCardDetails)
                    throw new Error(`the ${card.provider} rail has no card that can be filled into a checkout`);
                  if (!fill.selectors.number || !fill.selectors.cvc
                    || (!fill.selectors.expiry && !(fill.selectors.expMonth && fill.selectors.expYear)))
                    throw new Error('number, CVC, and either combined expiry or month/year selectors are required');
                  const details = await provider.retrieveCardDetails(card.id);
                  const expected = [domain];
                  let origin: string;
                  if (isRemoteAgentWorld(world)) {
                    origin = (await fillCardInWorld(world, {
                      cdpUrl, domain, selectors: fill.selectors, details,
                    })).origin;
                  } else {
                    origin = (await fillViaCdp({ cdpUrl, selector: fill.selectors.number,
                      text: details.number, expectDomains: expected })).origin;
                    const month = String(details.expMonth).padStart(2, '0');
                    if (fill.selectors.expiry) {
                      origin = (await fillViaCdp({ cdpUrl, selector: fill.selectors.expiry,
                        text: `${month}/${String(details.expYear).slice(-2)}`, expectDomains: expected })).origin;
                    } else {
                      origin = (await fillViaCdp({ cdpUrl, selector: fill.selectors.expMonth!,
                        text: month, expectDomains: expected })).origin;
                      origin = (await fillViaCdp({ cdpUrl, selector: fill.selectors.expYear!,
                        text: String(details.expYear), expectDomains: expected })).origin;
                    }
                    origin = (await fillViaCdp({ cdpUrl, selector: fill.selectors.cvc,
                      text: details.cvc, expectDomains: expected })).origin;
                    // Billing fields, where the card carries one and the form asks.
                    for (const field of BILLING_FIELDS) {
                      const selector = fill.selectors[field];
                      const value = details.billing?.[field];
                      if (selector && value) origin = (await fillViaCdp({ cdpUrl,
                        selector, text: value, expectDomains: expected })).origin;
                    }
                  }
                  (await store.appendAudit({ principalId: `task:${args.taskId}`, action: 'payment.card.filled',
                    detail: { taskId: args.taskId, requestId: request.id, cardId: card.id, origin } }));
                  return { filled: true as const, origin };
                },
              }
            : {}),
          ...(token
            ? {
                platformRequest: (method: string, requestPath: string, body?: unknown) =>
                  turnPlatformRequest({ token, method, path: requestPath, body, signal }),
              }
            : {}),
        },
        );
        // The final answer becomes a conversation message in the task view.
        if (result.output) result = { ...result, output: secrets.scrub(result.output) };
        if (result.output?.trim() && finalActivity) result.finalActivity = finalActivity;
        if (resultKey) {
          await store.kvSet(resultKey, JSON.stringify({ result, admissionId: usageAdmissionId }));
          resultCheckpointed = true;
          // The checkpointed result now carries every queued spawn and answer.
          if (delegationKey) (await store.kvDelete(delegationKey));
        }
        }
        // Defence in depth around the activity boundary. `runTurn` rejects an
        // adapter return after abort, but cancellation can race the few synchronous
        // instructions between that check and this await continuation. Never report
        // a normal Temporal activity result once shutdown/cancellation is visible.
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('agent turn cancelled');
        }
        await finishUsage(true);
        if (result.output?.trim() && finalActivity) {
          result.finalActivity = finalActivity;
        }
        if (args.role === 'confirm' && result.confirmDecision?.action === 'confirm' && result.confirmDecision.otherAttempts) {
          (await store.kvSet(`attempt-choice:${args.taskId}`, result.confirmDecision.otherAttempts));
        }
        if (confirmTranscript) {
          const outputId = timingTurnId ? `${timingTurnId}:out` : `${args.taskId}:out:${confirmTranscript.length}`;
          if (result.output?.trim() && !confirmTranscript.some(m => m.id === outputId))
            confirmTranscript.push({ id: outputId, role: 'agent', text: result.output, ts: confirmTranscript.length });
          if (result.confirmDecision) {
            const d = result.confirmDecision;
            const decisionId = timingTurnId ? `${timingTurnId}:decision` : `${args.taskId}:decision:${confirmTranscript.length}`;
            if (!confirmTranscript.some(m => m.id === decisionId)) confirmTranscript.push({ id: decisionId, role: 'system', text: `confirm_decision: ${d.action}${d.otherAttempts ? `; other attempts: ${d.otherAttempts}` : ''}${d.text ? ` — ${d.text}` : ''}`, ts: confirmTranscript.length });
          }
          (await store.kvSet(`confirm-transcript:${conversationTaskId}`, JSON.stringify(confirmTranscript)));
        }
      } catch (err) {
        (await admissionEnd(signal?.aborted ? 'cancelled' : 'failed'));
        if (token) (await deps.tokens?.revoke(token));
        // Providers often surface their own generic AbortError after the activity
        // cancellation signal fires. Throw Temporal's cancellation reason instead
        // so WAIT_CANCELLATION_COMPLETED records an acknowledged cancellation,
        // rather than turning a user cancel into an ordinary workflow failure.
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : err;
        }
        const failure = classifyTurnError(err, profile.provider);
        // Provider limits and policy rejections are authoritative; anything else
        // in a remote world may be the sandbox's fault, which its metrics can show.
        if (!world.diagnose || !(failure instanceof ApplicationFailure) || !['agent-error', 'agent-infra'].includes(failure.type ?? '')) throw failure;
        const diagnosis = await world.diagnose({ since: attemptStarted }).catch(() => undefined);
        if (diagnosis && turnSessionKey) (await store.kvSet(`${turnSessionKey}:interruption`, JSON.stringify(diagnosis)));
        throw classifyTurnError(err, profile.provider, { diagnosis });
      } finally {
        try {
          if (usageAdmissionId && !usageAdmissionFinished) {
            if (providerInvoked || result) await finishUsage(false);
            else await store.finishUsageAdmission(usageAdmissionId, false);
          }
        } finally {
          try { await releaseSlot(); }
          finally {
            releaseConfirm();
            try { await mcpCleanup?.(); }
            finally {
              // A world that cannot be reached now drops its keys with the world.
              try { if (turnKeys) await removeTurnKeys(turnKeys).catch((e) => console.warn(`[vault] turn key files not removed: ${e instanceof Error ? e.message : e}`)); }
              finally { await publishLegacyAgentState(undefined); }
            }
          }
        }
      }
      if (token) (await deps.tokens?.revoke(token));
      // Persist the session id so other tasks can resume from this one (§10.5), plus
      // which config home + provider minted it — provider sessions are home-bound, so
      // the CLI resume-command needs the right CONFIG_DIR/CODEX_HOME (§2.5, #2/#3).
      if (result.session) {
        (await store.kvSet(`session:${conversationTaskId}:${args.role}`, result.session));
        (await store.kvSet(
          `sessionmeta:${conversationTaskId}:${args.role}`,
          JSON.stringify({
            home: resolvedAuth?.configHome ?? '',
            provider: profile.provider,
            ...(profile.model ? { model: profile.model } : {}),
            ...(profile.effort ? { effort: profile.effort } : {}),
          }),
        ));
      }

      // A branch the agent added with `create_branch` exists on disk now, but the
      // DURABLE handle is what merge, the PR stage and check-in re-open the world
      // from — so persist it here as well as returning it for the workflow to
      // adopt. Recorded before the turn result is consumed, so a checkout can
      // never be live on disk yet invisible to the stages that must land it.
      if (result.worldHandle?.repos?.length) {
        try {
          (await store.updateWorldCheckouts(args.worldHandle, result.worldHandle.repos));
          (await record(args.taskId, 'world.checkout_added', {
            checkouts: result.worldHandle.repos.map((repo) => ({ name: repo.name, branch: repo.branch, base: repo.base })),
          }));
        } catch (error) {
          // A stale generation means this turn's world was already replaced; the
          // branch belongs to a world nobody will merge, so say so rather than
          // failing a turn whose actual work succeeded.
          (await record(args.taskId, 'world.checkout_orphaned', { error: error instanceof Error ? error.message : String(error) }));
        }
      }

      if (result.skills?.length) {
        for (const s of result.skills) (await record(args.taskId, 'skill.saved', { name: s.name }));
      }
      // Adapters can also return review info directly without invoking the tool.
      if (deps.objects) await preserveReviewArtifacts(store, deps.objects, world, args.taskId, result.reviewInfo, true);
      if (result.subTaskResponses?.length) {
        const { kept, refused } = await ownSubTaskResponses(store, args.taskId, result.subTaskResponses);
        result.subTaskResponses = kept;
        if (refused.length) (await record(args.taskId, 'subtask.response_refused', { childTaskIds: refused }));
        // The workflow pushes a comment to its child as a follow-up once this
        // result returns. Journal it for the child now so a running child's
        // follow-up gate asks at its next poll, not at the backstop (#396 review item 8).
        const commented = (result.subTaskResponses ?? []).filter((response) => response.action === 'comment' && response.text);
        const children = commented.some((response) => !response.childTaskId) ? (await store.childTasks(args.taskId))
          .filter((child) => !['done', 'cancelled', 'failed'].includes(child.lastView?.status ?? '')).map((child) => child.id) : [];
        for (const childTaskId of new Set(commented.flatMap((response) => response.childTaskId ? [response.childTaskId] : children)))
          (await record(childTaskId, 'subtask.parent-response', { parentTaskId: args.taskId }));
      }
      (await record(args.taskId, 'turn.result', {
        completed: result.completed,
        providerCompleted: result.providerCompleted,
        providerTermination: result.providerTermination,
        subTasks: result.subTasks?.length ?? 0,
        hasReview: !!result.reviewInfo,
        output: result.output.slice(0, 2000),
      }));
      return result;
      }, undefined, timingSignal));
      } catch (error) {
        if (timingSignal?.aborted) throw timingSignal.reason instanceof Error ? timingSignal.reason : error;
        if (resultCheckpointed) throw ApplicationFailure.create({ type: 'agent-infra', nonRetryable: false,
          message: error instanceof Error ? error.message : String(error), cause: error instanceof Error ? error : undefined });
        if (error instanceof ApplicationFailure) throw error;
        throw classifyTurnError(error);
      } finally {
        if (keepAlive) clearInterval(keepAlive);
      }
    },

    /** Auto-derive the changed-files summary so Review always shows what changed
     *  (§5.5). Diffs are intentionally NOT computed — they were removed from the
     *  review packet; reviewers use the changed-files list + the in-world terminal. */
    async buildReview(handle: WorldHandle, base: string): Promise<{ summary: string; changedFiles: string[] }> {
      const world = await openWorld(handle);
      const repos = worldRepos(handle);
      if (!repos.length) {
        const files = (await world.listFiles()).map((file) => `${file} (new)`);
        const { changedFiles, truncated } = reviewFiles(files);
        const summary = files.length ? `${files.length} file(s) in the task workspace.${truncated ? ` Showing ${changedFiles.length}; inspect the workspace for the full list.` : ''}` : 'No file changes detected.';
        (await record(handle.id, 'review.built', { files: changedFiles.length }));
        return { summary, changedFiles };
      }
      const roots = repos;
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
        // NUL-separated output is never C-quoted, whatever the world's Git config
        // (non-ASCII, quotes and newlines in names survive verbatim; WD-27).
        const tracked = await world.exec('git', ['diff', '-z', '--name-only', since], { cwd: repo.root });
        const untracked = await world.exec('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: repo.root });
        // A companion wiki must not make the sole development checkout appear
        // artificially nested. Keep a stable prefix for wiki changes, while
        // genuine multi-development-repo worlds retain repository prefixes.
        const prefix = 'role' in repo && repo.role === 'project-wiki'
          ? `${repo.name}/`
          : developmentRepos.length > 1
            ? `${repo.name}/`
            : '';
        changedFiles.push(
          ...tracked.stdout.split('\0').filter(Boolean).map((file) => `${prefix}${file}`),
          ...untracked.stdout.split('\0').filter(Boolean).map((file) => `${prefix}${file} (new)`),
        );
      }
      const bounded = reviewFiles(changedFiles);
      const summary = changedFiles.length ? `${changedFiles.length} file(s) changed.${bounded.truncated ? ` Showing ${bounded.changedFiles.length}; inspect the checkouts for the full list.` : ''}` : 'No file changes detected.';
      (await record(handle.id, 'review.built', { files: changedFiles.length }));
      return { summary, changedFiles: bounded.changedFiles };
    },

    /** Readiness check for the explicit Open PR transition. The Do agent owns
     * commit-vs-ignore judgment; machinery refuses unresolved/uncommitted state
     * and may add the narrow, content-neutral ancestry repair described below. */
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
        const unresolved = await world.exec('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U'], { cwd: repo.root });
        if (unresolved.stdout.trim()) {
          conflicts.push(...unresolved.stdout.trim().split('\n').filter(Boolean).map((file) => `${repo.name}/${file}`));
        }
        const status = await world.exec('git', ['-c', 'core.quotePath=false', 'status', '--porcelain'], { cwd: repo.root });
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
      // Publication's immutable baseSha check used to be the first place a
      // reset/reparented recovery branch was discovered. Check at the explicit
      // Do → PR boundary instead. The helper repairs only the safe target-based,
      // content-neutral case and otherwise fails closed with local Git guidance.
      const liveTarget = (await store.getTask(handle.id))?.lastView?.targetBranch
        ?? world.handle.target ?? handle.target ?? world.handle.base;
      const ancestry = await ensureTaskBranchAncestry(world, liveTarget);
      if (ancestry.repaired.length) {
        for (const repair of ancestry.repaired) (await record(handle.id, 'branch.ancestry-repaired', repair));
      }
      if (Object.keys(ancestry.errors).length) {
        return {
          ready: false,
          conflict: Object.entries(ancestry.errors).map(([repo, detail]) => `${repo}: ${detail}`).join('\n'),
          note: 'the proposal lost its recorded task-branch ancestry',
        };
      }
      return { ready: true };
    },

    async finalizeMergeActivity(handle: WorldHandle, target: string): Promise<MergeResult> {
      const world = await openWorld(handle);
      // Merge commits carry the world's profile identity too (wiki plans/PLAN-git-config
      // §4A) — they land on the target, where worktree-scoped config doesn't reach.
      let identity;
      const profileName = handle.meta?.gitProfile;
      if (typeof profileName === 'string' && profileName) {
        try {
          const binding = (await gitBindingFromHandle(handle, handle.id));
          identity = binding.profile ? (await binding.profiles.identity(binding.profile, { taskId: handle.id })) : undefined;
        } catch {
          identity = undefined; // fall back to ensureIdentity inside finalizeMerge
        }
      }
      const result = isRemote(handle.kind)
        ? await brokerFinalizeMerge(world, target, identity, (await brokerAuthFor(handle, handle.id)))
        : await finalizeMerge(world, target, identity);
      (await record(handle.id, 'merge.result', { merged: result.merged, sha: result.sha, conflict: result.conflict, dirty: result.dirty }));
      return result;
    },

    async runScript(args: { taskId: string; worldHandle: WorldHandle; command: string }): Promise<{ code: number; output: string }> {
      let context: ReturnType<typeof activityContext.current> | undefined;
      try { context = activityContext.current(); } catch { /* direct invocation */ }
      const pulse = setInterval(() => { try { context?.heartbeat(); } catch { /* completion */ } }, 10_000);
      try {
        const world = await openWorld(args.worldHandle, args.taskId);
        (await record(args.taskId, 'script.start', { command: args.command }));
        const r = await world.exec('bash', ['-lc', args.command], { timeoutMs: 30 * 60_000 });
        const output = scriptOutput(`${r.stdout}${r.stderr}`);
        (await record(args.taskId, 'script.done', { code: r.code, output: output.slice(0, 4000) }));
        return { code: r.code, output };
      } finally { clearInterval(pulse); }
    },

    async runWorkflowChecks(args: { taskId: string; worldHandle: WorldHandle }): Promise<{ passed: boolean; detail?: string }> {
      const world = await openWorld(args.worldHandle, args.taskId);
      const hasPkg = (await world.exec('bash', ['-lc', 'test -f package.json && echo yes || echo no'])).stdout.includes('yes');
      if (!hasPkg) {
        (await record(args.taskId, 'checks.skip', { reason: 'no package.json' }));
        return { passed: true, detail: 'no test suite found' };
      }
      const r = await world.exec('bash', ['-lc', 'set -o pipefail; npm test --silent 2>&1 | tail -40'], { timeoutMs: 10 * 60_000 });
      (await record(args.taskId, 'checks.done', { code: r.code }));
      if (r.code !== 0) return { passed: false, detail: r.stdout.slice(-600) };

      // Compare this organization's running tasks against the current bundle.
      // Shared coordinator histories belong to the installation release gate.
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
        (await record(args.taskId, 'checks.replay', { skipped: 'repo carries no karmax workflow bundle' }));
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
        const snapshot = await snapshotReplayHistories(store, deps.client, args.taskId);
        try {
          const { Worker } = await import('@temporalio/worker');
          const replay = async (workflowBundle: WorkflowBundle) => {
            const failures = new Map<string, string>();
            for await (const result of Worker.runReplayHistories({ workflowBundle }, snapshot.histories())) {
              if (result.error) failures.set(result.workflowId, result.error.message);
            }
            return failures;
          };
          const baselineBundle = deps.workflowBundle?.() ?? await buildVersionedBundle([]);
          const baselineFailures = await replay(baselineBundle);
          const candidateFailures = await replay(await buildVersionedBundle([], { workflowsPath: candidatePath, cache: !mirror }));
          const regressions = [...candidateFailures.entries()].filter(([id]) => !baselineFailures.has(id));
          const fixed = [...baselineFailures.keys()].filter((id) => !candidateFailures.has(id));
          const existing = [...candidateFailures.keys()].filter((id) => baselineFailures.has(id));
          (await record(args.taskId, 'checks.replay', {
            histories: snapshot.count,
            regressions: regressions.map(([id]) => id),
            preExisting: existing,
            fixed,
          }));
          if (regressions.length) {
            const detail = regressions.map(([id, error]) => `${id}: ${error}`).join('\n');
            return { passed: false, detail: `tests passed; replay REGRESSED ${regressions.length}/${snapshot.count} active histories:\n${detail}`.slice(-4000) };
          }
          return {
            passed: true,
            detail: `tests + replay passed (${snapshot.count} active histories; ${existing.length} pre-existing incompatibilities${fixed.length ? `; ${fixed.length} repaired` : ''})`,
          };
        } finally { snapshot.release(); }
      } catch (e) {
        return { passed: false, detail: `tests passed, but replay compatibility failed to run: ${e instanceof Error ? e.message : String(e)}` };
      } finally {
        if (mirror) fs.rmSync(mirror, { recursive: true, force: true });
      }
    },

    /**
     * Head commit of every checkout in the world, keyed by checkout name.
     *
     * Review approval for a multi-PR task is bound to `(checkout, head sha)`,
     * so the gate needs the heads to tell an approval that
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

    /** The current world, including checkouts added during Do, determines whether
     * Git persistence is needed. A missing configured checkout is never treated
     * as a resource-only success. Checkpoint before releasing remote compute:
     * ordinary reports and reviewed resource revisions survive independently of
     * Git, without promoting any project resource head. */
    async checkpointResourceOnlyWork(handle: WorldHandle, configuredRepos: string[]): Promise<boolean> {
      const world = await openWorld(handle);
      if (worldRepos(world.handle).length) return false;
      const projectId = (await store.getTask(handle.id))?.projectId ?? String(world.handle.meta?.projectId ?? '');
      const project = (await store.getProject(projectId));
      if (configuredRepos.length || project?.config.repos?.length || (await store.listProjectRepositories(projectId)).length)
        throw new Error('configured repositories are missing from the task world');
      if (deps.checkpoints) {
        const checkpoint = await deps.checkpoints.checkpoint(world.handle);
        (await record(handle.id, 'checkpoint.created', { checkpointId: checkpoint.id,
          generation: checkpoint.generation, bytes: checkpoint.filesystemDelta?.bytes ?? 0 }));
      } else if (isRemote(world.handle.kind) || world.handle.meta?.releaseOnCompletion === true) {
        throw new Error('world checkpoints are required to preserve resource-only task output');
      }
      // Local worlds that are retained remain directly inspectable even when
      // the caller does not configure the optional checkpoint service.
      return true;
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
      (await record(handle.id, 'work.committed', { committed, repos: roots.length }));
      return { committed, sha };
    },

    /** Persist a cloud task branch before releasing its sandbox. Unlike the
     * best-effort post-merge push policy, this is the only durable copy of a
     * just-do world's result, so any skipped repository is a hard failure. */
    async publishTaskBranch(handle: WorldHandle): Promise<{ pushed: string[] }> {
      if (!isRemote(handle.kind)) return { pushed: [] };
      const world = await openWorld(handle);
      await enrollLiveProjectRepositories(world, handle.id);
      const ancestry = await ensureTaskBranchAncestry(world,
        (await store.getTask(handle.id))?.lastView?.targetBranch ?? world.handle.target ?? world.handle.base);
      if (Object.keys(ancestry.errors).length)
        throw new Error(`cloud task branch was not persisted for: ${Object.entries(ancestry.errors)
          .map(([repo, detail]) => `${repo}: ${detail}`).join('; ')}`);
      for (const repair of ancestry.repaired) (await record(handle.id, 'branch.ancestry-repaired', repair));
      const result = await publishTaskBranch(world, handle.id);
      if (!result.pushed.length || result.skipped.length) {
        throw new Error(`cloud task branch was not persisted${result.skipped.length ? ` for: ${describePublishFailures(result)}` : ' because it has no remote repository'}`);
      }
      (await record(handle.id, 'push.branch', { branch: handle.branch, repos: result.pushed }));
      return { pushed: result.pushed };
    },

    async destroyWorld(handle: WorldHandle): Promise<void> {
      let runId: string | undefined;
      try { runId = activityContext.current().info.workflowExecution?.runId; } catch { /* direct tests */ }
      const destroy = async () => {
        const current = ((await store.currentWorld(handle.id)) ?? handle) as WorldHandle;
        const ownerRun = (await store.taskMetadata(handle.id))?.params._workflowRunId;
        // A restored sandbox can legitimately advance generation within the
        // same workflow run. Without that proof, a stale handle cannot authorize
        // destroying whichever replacement the resolver currently returns.
        if (ownerRun && runId && ownerRun !== runId) return;
        if ((current.kind !== handle.kind || (current.generation ?? 1) !== (handle.generation ?? 1))
          && (!runId || ownerRun !== runId)) return;
        const owns = async () => {
          const latest = await store.currentWorld(handle.id);
          const latestRun = (await store.taskMetadata(handle.id))?.params._workflowRunId;
          return (!latest || latest.kind === current.kind && (latest.generation ?? 1) === (current.generation ?? 1))
            && latestRun === ownerRun;
        };
        const leaseId = typeof current.meta?.worldLeaseId === 'string' ? current.meta.worldLeaseId : undefined;
        const alreadyReleased = await store.worldState(handle.id) === 'released';
        // A failed artifact upload must propagate before best-effort teardown:
        // this world may hold the only remaining copy of a review attachment.
        if (!alreadyReleased && deps.objects
          && (await unsavedReviewArtifacts(store, handle.id, (await store.getTask(handle.id))?.lastView?.reviewInfo))) {
          const world = await worlds.open(current);
          if (!(await owns())) return;
          await preserveReviewArtifacts(store, deps.objects, world, handle.id,
            (await store.getTask(handle.id))?.lastView?.reviewInfo, true);
        }
        try {
          if (!(await owns()) || alreadyReleased) return;
          if ((await store.taskMetadata(handle.id))?.lastView?.status === 'cancelled')
            await deps.resources?.discardTaskCandidates(handle.id, 'system:task-cancel');
          if (!(await owns())) return;
          await deps.resources?.release(current);
          if (!(await owns())) return;
          const world = await worlds.open(current);
          if (!(await owns())) return;
          await world.destroy();
          if (!(await owns())) return;
          await store.setWorldState(current, 'released');
          await record(handle.id, 'world.destroyed', {});
        } catch (error) {
          if (!(await owns())) return;
          // A transient provider failure remains visible, without rewriting a
          // replacement generation's state or retaining this run's capacity.
          const pending = await store.updateWorldMeta(current, { teardownPending: true });
          await store.setWorldState(pending, 'degraded');
          await record(handle.id, 'world.destroy_failed', { error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (await owns()) {
            await destroyWorldServices(handle.id).catch(() => undefined);
            if (leaseId && await owns()) await deps.runners?.release(leaseId, current.kind);
          }
        }
      };
      await (worlds.withOperation ? worlds.withOperation(handle.id, destroy) : destroy());
    },

    /** Preserve a reversible task cancellation without retaining billable
     * compute where the provider can park. Draft/reset remains the operation
     * that deliberately discards this state. */
    async suspendWorldForRecovery(handle: WorldHandle): Promise<void> {
      let ctx: ReturnType<typeof activityContext.current> | undefined;
      try { ctx = activityContext.current(); } catch { /* direct tests */ }
      const valid = async () => {
        const current = await store.currentWorld(handle.id);
        const task = await store.taskMetadata(handle.id);
        return !!current && current.kind === handle.kind
          && (current.generation ?? 1) === (handle.generation ?? 1)
          && !['released', 'hibernated'].includes((await store.worldState(handle.id)) ?? '')
          && task?.lastView?.status === 'cancelled'
          && (!task.params._workflowRunId || !ctx
            || task.params._workflowRunId === ctx.info.workflowExecution?.runId);
      };
      try {
        if (!(await valid())) return;
        let current = (await store.currentWorld(handle.id)) as WorldHandle;
        // Capacity admission cannot hold the transition lock: an existing
        // accessor may need that lock to release the capacity we are awaiting.
        const prepared = deps.checkpoints && isRemote(current.kind) && worldRepos(current).length
          ? await openWorld(current, current.id) : undefined;
        const suspend = async () => {
          if (!(await valid())) return;
          current = (await store.currentWorld(handle.id)) as WorldHandle;
          const idle = async () => {
            if (await worlds.hasActiveAccess?.(handle.id))
              throw new Error('world remains in use; preserving it for recovery');
          };
          await idle();
          if (deps.checkpoints) {
            if (prepared) {
              const projectId = String(current.meta?.projectId ?? '');
              if ((await store.listProjectRepositories(projectId)).length) {
                const pushed = await publishTaskBranch(prepared, current.id);
                if (pushed.skipped.length)
                  throw new Error(`could not persist branch for ${describePublishFailures(pushed)}`);
              }
            }
            await deps.checkpoints.checkpoint(current);
          }
          if (!(await valid())) return;
          await idle();
          const provider = worlds.get(current.kind);
          if (provider.parkable) {
            await worlds.park(current);
            if (await worlds.status(current) === 'parked') {
              const parked = ((await store.currentWorld(current.id)) ?? current) as WorldHandle;
              const leaseId = typeof parked.meta?.worldLeaseId === 'string' ? parked.meta.worldLeaseId : undefined;
              if (leaseId) {
                (await deps.runners?.release(leaseId, parked.kind));
                (await store.updateWorldMeta(parked, { worldLeaseId: null }));
              }
              (await store.setWorldState(((await store.currentWorld(current.id)) ?? parked) as WorldHandle, 'parked'));
            }
          }
          (await record(current.id, 'world.suspended', { provider: current.kind, parkable: !!provider.parkable }));
        };
        await (worlds.withOperation ? worlds.withOperation(handle.id, suspend) : suspend());
      } catch (error) {
        // Cancellation itself remains reliable. Persistence, parking, or busy
        // access failures leave the world intact and emit a diagnostic.
        (await record(handle.id, 'world.suspend_failed', {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },

    async pendingServiceConnections(taskId: string): Promise<number> {
      return (await store.kvEntries('service-connection:')).filter(row => {
        const c = JSON.parse(row.value);
        return c.taskId === taskId && (['requested', 'connecting'].includes(c.status) || !c.notifiedAt);
      }).length;
    },

    async beginResourceReview(taskId: string, reviewId: string): Promise<void> {
      await deps.resources?.beginReview(taskId, reviewId);
    },

    async settleResourceReview(taskId: string): Promise<void> {
      let context: ReturnType<typeof activityContext.current> | undefined;
      try { context = activityContext.current(); } catch { /* direct tests */ }
      const pulse = setInterval(() => {
        try { context?.heartbeat({ taskId, operation: 'applying-resources' }); } catch { /* activity completion/cancellation */ }
      }, 5_000);
      try { await deps.resources?.settleReview(taskId); }
      finally { clearInterval(pulse); }
    },

    async pendingResourceCandidates(taskId: string): Promise<number> {
      return (await store.listResourceCandidates(taskId)).filter((candidate) =>
        candidate.state === 'pending' || candidate.state === 'discarding').length;
    },

    /**
     * The PR stage under remote policy 'pr' (SPEC §5.2, wiki plans/PLAN-git-config §5):
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
      const task = (await store.getTask(handle.id));
      const workflowMinor = Number(String(task?.workflowVersion ?? '').split('.')[1] ?? 0);
      if (workflowMinor >= 21) {
        const githubCheckoutNames = new Set(targets.map(({ repo }) => repo.name));
        const changedWithoutPr: string[] = [];
        for (const repo of repos.filter((candidate) => !githubCheckoutNames.has(candidate.name))) {
          const base = worldRepoTarget(repo, target);
          const ahead = await commitsAheadOfPrBase(world, repo, base);
          if (ahead.code !== 0) {
            throw new Error(`could not verify non-GitHub checkout "${repo.name}" before opening the multi-repository proposal:`
              + ` ${ahead.stderr || ahead.stdout || 'git rev-list failed'}`);
          }
          if (Number(ahead.stdout.trim()) > 0) changedWithoutPr.push(repo.name);
        }
        // A project-wide PR policy cannot silently declare success after only
        // its GitHub participants land.  Hybrid provider/local sagas need an
        // explicit landing contract; until one exists, reject before any branch
        // is pushed or PR opened so no partial publication can occur.
        if (changedWithoutPr.length) {
          throw new Error(`remote policy "pr" cannot publish this multi-repository proposal because changed checkout(s) `
            + `${changedWithoutPr.map((name) => `"${name}"`).join(', ')} have no GitHub PR target. `
            + 'Configure GitHub origins for every changed checkout, or use a non-PR workflow for an explicitly local landing.');
        }
      }
      const changed: Array<(typeof targets)[number] & { base: string }> = [];
      for (const { repo, slug, api } of targets) {
        // A checkout whose base is a SIBLING's branch is a stacked pull request:
        // open it against that branch so GitHub renders the stack and its diff
        // shows only this branch's own change, not the base's as well.
        const stacked = repos.some((other) => other !== repo && other.branch === repo.base);
        const base = stacked ? repo.base : worldRepoTarget(repo, target);
        // karmax's own model lets a worktree stay dirty until the merge stage
        // (wiki plans/PLAN-git-config §6 loops that back to the merge agent), so arriving
        // here with nothing committed is a state the design produces. GitHub
        // answers it with an opaque 422 — diagnose it ourselves instead.
        const ahead = await commitsAheadOfPrBase(world, repo, base);
        if (ahead.code !== 0) {
          throw new Error(`could not compare branch "${repo.branch}" of repo "${repo.name}" with "${base}":`
            + ` ${ahead.stderr || ahead.stdout || 'git rev-list failed'}`);
        }
        if (ahead.stdout.trim() === '0') {
          (await record(handle.id, 'pr.skipped', { repo: repo.name, reason: `no commits ahead of ${base}` }));
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
      const pushed = await pushTaskBranches(world, handle, (await gitEnvFor(handle, handle.id)), changed.map(({ repo }) => repo));
      const opened: TaskPullRequest[] = [];
      for (const { repo, slug, api, base } of changed) {
        if (!pushed.pushed.includes(repo.name)) {
          const pushError = pushed.errors?.[repo.name] ?? '';
          if (isGithubWorkflowPermissionRejection(pushError)) {
            const repository = await enrolledRepositoryForCheckout(handle, repo);
            const guidance = repository && deps.githubApp
              ? await deps.githubApp.workflowPermissionGuidance(repository).catch(() =>
                'Grant the krmax GitHub App Workflows: read and write, approve the updated installation permission, then retry the task.')
              : 'Grant the krmax GitHub App Workflows: read and write, approve the updated installation permission, then retry the task.';
            throw ApplicationFailure.create({
              message: `GitHub App workflow permission required for ${slug}. ${guidance}`,
              type: 'github-workflows-permission',
              nonRetryable: true,
            });
          }
          if (/non-fast-forward|fetch first|stale info/i.test(pushError)) {
            throw ApplicationFailure.create({
              message: `Could not publish ${repo.name}/${repo.branch}: ${pushError}\n`
                + `Use refresh_upstream with branch "${repo.branch}", inspect and integrate origin/${repo.branch} `
                + 'into the task branch, resolve conflicts, verify the result, then call open_pr again.',
              type: 'task-branch-conflict',
              nonRetryable: true,
            });
          }
          throw new Error(`could not push branch "${repo.branch}" of repo "${repo.name}" to origin`
            + `${pushError ? `: ${pushError}` : ''}`);
        }
        let opening: Awaited<ReturnType<typeof api.openOrUpdate>>;
        try {
          opening = await api.openOrUpdate(slug, {
            head: repo.branch, base,
            // With several branches in flight the task title alone names none of
            // them; say which pull request this one is.
            title: changed.length > 1
              ? `${details.title?.trim() || 'karmax'} (${repo.name})`
              : details.title?.trim() || `karmax: ${repo.branch}`,
            body: prBody(handle, details, (await store.getTask(handle.id))?.num, changed.length > 1 ? repo.name : undefined),
          });
        } catch (error) {
          // GitHub decides what the PR would contain. The local count can only
          // overstate it (a fetch older than GitHub's target), never hide work,
          // so its refusal of an empty proposal is a skip, not a failure.
          if (!(error instanceof GithubApiError && error.status === 422 && /no commits between/i.test(error.message)))
            throw error;
          (await record(handle.id, 'pr.skipped', { repo: repo.name, reason: `GitHub has no commits between ${base} and ${repo.branch}` }));
          continue;
        }
        const { pr, created } = opening;
        const ref: TaskPullRequest = {
          repo: repo.name, slug, number: pr.number, url: pr.url, state: pr.state, merged: pr.merged,
          ...(pr.headSha ? { headSha: pr.headSha } : {}),
          ...(pr.nodeId ? { nodeId: pr.nodeId } : {}),
        };
        (await record(handle.id, created ? 'pr.opened' : 'pr.updated', { ...ref, base }));
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
    async mergeGithubPrs(handle: WorldHandle, prs: TaskPullRequest[], options?: {
      mode?: 'submit' | 'observe' | 'inspect-exact' | 'submit-exact' | 'preflight' | 'claim-provider' | 'submit-fallback';
      authority?: LandingAuthority;
    }): Promise<GitHubMergeAuthorization> {
      // A PR-policy task may legitimately make no changes. There is nothing
      // external to authorize in that case, so do not manufacture a human gate.
      if (!prs.length) return { status: 'merged', prs };
      const task = (await store.getTask(handle.id));
      if (!task || !deps.githubApp) {
        return { status: 'needs-authorizer', prs, detail: 'GitHub is not connected for human-attributed merges.' };
      }
      const workflowMinor = Number(String(task.workflowVersion ?? '').split('.')[1] ?? 0);
      const intentAuthorizedLanding = workflowMinor >= 16;
      const fairLanding = workflowMinor >= 20;
      const landingAuthority = options?.authority
        ?? landingAuthorityOf((await store.effectiveProjectConfig(task.projectId)));
      const observeOnly = intentAuthorizedLanding && options?.mode === 'observe';
      const participantPreflight = workflowMinor >= 21 && options?.mode === 'preflight';
      const claimProviderOnly = workflowMinor >= 21 && options?.mode === 'claim-provider';
      const inspectExact = workflowMinor >= 17 && options?.mode === 'inspect-exact';
      const submitExact = workflowMinor >= 17 && options?.mode === 'submit-exact';
      const frontHeldExact = inspectExact || submitExact;
      const creator = (await store.taskCreatorUserId(handle.id));
      const events = await store.eventsOfTypes(handle.id, [
        'task.confirmation-voted', 'github.merge.authorization-revoked', 'github.merge.review-stale',
        'github.ci.external-wait', 'github.ci.cancelled-reconciled', 'github.ci.repair-requested',
        'github.ci.rerun-requested', 'github.ci.superseded', 'github.ci.terminal-observed',
        'github.ci.validation-current', 'github.pr.branch-update-requested', 'github.pr.queued',
        'github.pr.review-approved', 'github.pr.review-skipped',
      ]);
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
      const accountFor = async (userId: string) => userId === creator
        ? (typeof task.params?._githubAccountId === 'string' ? task.params._githubAccountId : (await deps.githubApp!.activeUserAccountId(userId)))
        : (await deps.githubApp!.activeUserAccountId(userId));

      let actorUserId: string | undefined;
      let actorPermissions = new Map<string, GitHubRepositoryPermission>();
      for (const userId of candidates) {
        const accountId = (await accountFor(userId));
        if (!accountId) continue;
        // A configured external authority lands under its own repository
        // integration. Karmax only needs an account able to read the PR it
        // already opened; requiring that person to have merge rights would
        // defeat external ownership before observation even began.
        if (fairLanding && landingAuthority === 'external') {
          actorUserId = userId;
          break;
        }
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
        for (const userId of (await store.humanAudience(handle.id, ['@project']))) {
          const accountId = (await deps.githubApp.activeUserAccountId(userId));
          if (!accountId) continue;
          const checks = await Promise.all(prs.filter((ref) => !ref.merged).map((ref) =>
            deps.githubApp!.repositoryPermission(userId, ref.slug, accountId).catch(() => undefined)));
          if (checks.length && checks.every((permission) => permission?.canMerge)) eligibleUserIds.push(userId);
        }
        (await record(handle.id, 'github.merge.authorization-required', { eligibleUserIds, repositories: prs.map((ref) => ref.slug) }));
        return {
          status: 'needs-authorizer', prs,
          detail: eligibleUserIds.length
            ? 'The task creator cannot merge these pull requests. Ask a listed project member with GitHub merge access to confirm the merge.'
            : 'No connected project member currently has GitHub merge access for every pull request.',
          eligibleUserIds,
        };
      }

      const accountId = (await accountFor(actorUserId));
      const api = prApiForUser(actorUserId, accountId);
      // PR authorship, approval and landing remain attributable to the selected
      // human. Read-only policy/CI inspection belongs to the repository
      // installation instead: it has the exact repository-scoped Checks and
      // Commit-status permissions declared by the App, without lending those
      // observations the human's identity.
      const inspectionFor = async (slug: string): Promise<{ api: GithubPrApi; actions?: GithubActionsApi; connectionId?: string }> => {
        const repository = (await enrolledGithubRepository(task.projectId, slug));
        const connection = repository?.gitConnectionId
          ? (await store.getGitConnection(repository.gitConnectionId))
          : undefined;
        return connection && typeof (deps.githubApp as any).installationToken === 'function'
          ? {
            api: new GithubPrApi(
              () => deps.githubApp!.installationToken(connection, [repository!.providerId ?? '']),
              deps.githubPr ?? {},
            ),
            ...(repository && typeof (deps.githubApp as any).actions === 'function'
              ? { actions: (await deps.githubApp!.actions(repository)) }
              : {}),
            connectionId: connection.id,
          }
          : { api };
      };
      const settled: TaskPullRequest[] = [];
      const participants: GithubLandingParticipant[] = [];
      const observations: string[] = [];
      let lastSha: string | undefined;
      let queued = false;
      let queuedOwner: GitHubMergeAuthorization['landingOwner'];
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
      // `brief` is for people: a line of each check's output, not its log.
      const ciFailureDetail = (ref: TaskPullRequest, readiness: GithubPullRequestReadiness, brief = false) => {
        const failures = (readiness.failedChecks ?? []).slice(0, 12).map((check) => {
          const detail = check.detail?.trim();
          const limit = brief ? 300 : 12_000;
          const shown = detail && detail.length > limit ? `${detail.slice(0, limit)}…` : detail;
          return `- ${check.name}: ${check.state}${check.url ? ` (${check.url})` : ''}${shown ? `\n${shown}` : ''}`;
        });
        return [
          `Pull request ${ref.slug}#${ref.number} has terminally failing CI (${readiness.checks}).`,
          ...(failures.length ? failures : ['GitHub did not expose an individual failed-check summary; inspect the PR checks page.']),
        ].join('\n').slice(0, 64_000);
      };
      const ciFailureDecision = async (
        ref: TaskPullRequest,
        readiness: GithubPullRequestReadiness,
        current: TaskPullRequest[],
        inspection: Awaited<ReturnType<typeof inspectionFor>>,
      ): Promise<GitHubMergeAuthorization | { status: 'checks-satisfied' }> => {
        const summary = ciFailureDetail(ref, readiness);
        const briefSummary = ciFailureDetail(ref, readiness, true);
        const runIds = [...new Set((readiness.failedChecks ?? [])
          .map((check) => githubActionsRunIdFromUrl(check.url)).filter((id): id is number => Boolean(id)))];
        const fallbackIdentityKey = githubRequiredCheckKey({
          repository: ref.slug, pullRequest: ref.number, headSha: ref.headSha ?? 'unknown', workflowId: 0,
          check: (readiness.failedChecks ?? []).map((check) => check.name).sort().join('|') || 'unknown',
        });
        const recordedObservations = new Set(events
          .filter((event) => event.type === 'github.ci.terminal-observed')
          .map((event) => String(event.payload?.observationKey ?? event.payload?.key ?? '')));
        const recordedCurrents = new Set(events
          .filter((event) => event.type === 'github.ci.validation-current')
          .map((event) => `${event.payload?.key}:${event.payload?.runId}:${event.payload?.attempt}:${event.payload?.state}`));
        const recordedSupersessions = new Set(events
          .filter((event) => event.type === 'github.ci.superseded')
          .map((event) => `${event.payload?.key}:${event.payload?.runId}:${event.payload?.attempt}:${event.payload?.supersedingRunId}:${event.payload?.supersedingAttempt}`));
        const terminalObservation = async (decision: GithubActionsFailureDecision, key: string) => {
          const run = decision.inspection.run;
          const state = String(run.conclusion ?? run.status).toLowerCase();
          const observationKey = `${key}:run:${run.id}:attempt:${run.attempt}:state:${state}`;
          if (!recordedObservations.has(observationKey)) {
            (await record(handle.id, 'github.ci.terminal-observed', {
              key, observationKey, slug: ref.slug, number: ref.number, candidateHead: ref.headSha,
              runId: run.id, attempt: run.attempt, state, disposition: decision.disposition,
            }));
            recordedObservations.add(observationKey);
          }
          return { decision, key };
        };
        const currentObservation = async (key: string, run: { id: number; attempt: number; status: string; conclusion?: string }) => {
          const state = String(run.conclusion ?? run.status).toLowerCase();
          const observation = `${key}:${run.id}:${run.attempt}:${state}`;
          if (recordedCurrents.has(observation)) return;
          (await record(handle.id, 'github.ci.validation-current', {
            key, slug: ref.slug, number: ref.number, candidateHead: ref.headSha,
            runId: run.id, attempt: run.attempt, state,
          }));
          recordedCurrents.add(observation);
        };
        const externalWait = async (key: string, detail: string): Promise<GitHubMergeAuthorization> => {
          const previous = events.filter((event) => event.type === 'github.ci.external-wait'
            && event.payload?.key === key).length;
          (await record(handle.id, 'github.ci.external-wait', { key, slug: ref.slug, number: ref.number,
            candidateHead: ref.headSha, poll: previous + 1 }));
          if (previous + 1 >= MAX_SUPERSEDED_CI_POLLS) return {
            status: 'needs-human', prs: current, actorUserId, releaseAdmission: true,
            detail: `${detail}\n\nGitHub still exposes the same externally blocked CI state after ${MAX_SUPERSEDED_CI_POLLS} bounded observations and no newer terminal result. Inspect the repository concurrency/runner configuration, then retry. The task owns no admission slot while parked.`,
            eligibleUserIds: [actorUserId],
          };
          return { status: 'waiting', prs: current, actorUserId, releaseAdmission: true, detail };
        };
        const fallbackObservation = async (key: string, disposition: string) => {
          const observationKey = `${key}:run:${runIds[0] ?? 0}:attempt:0:state:${disposition}`;
          const repeated = recordedObservations.has(observationKey);
          if (!repeated) {
            (await record(handle.id, 'github.ci.terminal-observed', {
              key, observationKey, slug: ref.slug, number: ref.number, candidateHead: ref.headSha,
              runId: runIds[0] ?? 0, attempt: 0, disposition, inspectionUnavailable: true,
            }));
            recordedObservations.add(observationKey);
          }
          return repeated;
        };
        const decisions: Array<Awaited<ReturnType<typeof terminalObservation>>> = [];
        const inspectionFailures: Array<{ runId: number; error: unknown }> = [];
        const followed: Array<{ key: string; run: { id: number; attempt: number; status: string; conclusion?: string } }> = [];
        const satisfied: Array<{ key: string; run: { id: number; attempt: number; status: string; conclusion?: string } }> = [];
        const satisfiedRunIds = new Set<number>();
        const reconciling: string[] = [];
        let actionReconciliationFailed = false;
        const listedRuns = new Map<number, Awaited<ReturnType<GithubActionsApi['listRuns']>>>();
        if (inspection.actions) {
          for (const runId of runIds.slice(0, 4)) {
            try {
              let inspected = await inspection.actions.inspectFailure(ref.slug, runId);
              // A stale check URL must never cause a rerun or repair of a
              // different revision than the proposal whose landing is held.
              // pull_request Actions run against refs/pull/N/merge, however,
              // legitimately carries the synthetic merge SHA rather than the
              // PR head. The URL came from this current PR's readiness packet,
              // so that event remains safely correlated to this candidate.
              if (inspected.run.headSha && ref.headSha && inspected.run.headSha !== ref.headSha
                && inspected.run.event !== 'pull_request') continue;
              const check = (readiness.failedChecks ?? [])
                .find((candidate) => githubActionsRunIdFromUrl(candidate.url) === runId);
              const identity = {
                repository: ref.slug,
                pullRequest: ref.number,
                headSha: ref.headSha ?? inspected.run.headSha ?? 'unknown',
                workflowId: inspected.run.workflowId,
                check: check?.name ?? inspected.run.name,
              };
              let listed = listedRuns.get(inspected.run.workflowId);
              if (!listed) {
                const options = {
                  workflow: inspected.run.workflowId || undefined,
                  event: inspected.run.event || undefined,
                  perPage: 100,
                };
                listed = await inspection.actions.listRuns(ref.slug, options);
                // Reconciliation is bounded but not first-page-only. Duplicate
                // deliveries can push the relevant same-head run off page one
                // in a busy repository.
                for (let page = 2; page <= 5 && listed.runs.length < listed.total; page++) {
                  const next = await inspection.actions.listRuns(ref.slug, { ...options, page });
                  listed = { ...listed, runs: [...listed.runs, ...next.runs] };
                  if (!next.runs.length) break;
                }
                listedRuns.set(inspected.run.workflowId, listed);
              }
              const reconciliation = reconcileGithubActionsRuns(identity, inspected.run, listed.runs);
              (await currentObservation(reconciliation.key, reconciliation.current));
              if (reconciliation.successful) {
                if (String(inspected.run.conclusion ?? '').toLowerCase() === 'cancelled'
                  && reconciliation.successful.id !== inspected.run.id) {
                  const supersession = `${reconciliation.key}:${inspected.run.id}:${inspected.run.attempt}:${reconciliation.successful.id}:${reconciliation.successful.attempt}`;
                  if (!recordedSupersessions.has(supersession)) {
                    (await record(handle.id, 'github.ci.superseded', {
                      key: reconciliation.key, slug: ref.slug, number: ref.number,
                      candidateHead: ref.headSha, runId: inspected.run.id, attempt: inspected.run.attempt,
                      supersedingRunId: reconciliation.successful.id,
                      supersedingAttempt: reconciliation.successful.attempt,
                    }));
                    recordedSupersessions.add(supersession);
                  }
                }
                satisfied.push({ key: reconciliation.key, run: reconciliation.successful });
                satisfiedRunIds.add(runId);
                continue;
              }
              const currentState = String(reconciliation.current.conclusion
                ?? reconciliation.current.status).toLowerCase();
              if (['requested', 'queued', 'pending', 'waiting', 'in_progress'].includes(currentState)) {
                followed.push({ key: reconciliation.key, run: reconciliation.current });
                continue;
              }
              // A newer terminal duplicate, rather than the stale check URL,
              // owns classification for this validation identity.
              if (reconciliation.current.id !== inspected.run.id
                || reconciliation.current.attempt !== inspected.run.attempt)
                inspected = await inspection.actions.inspectFailure(ref.slug, reconciliation.current.id);
              const conclusion = String(inspected.run.conclusion ?? '').toLowerCase();
              if (conclusion === 'cancelled') {
                const prior = events.filter((event) => event.type === 'github.ci.cancelled-reconciled'
                  && event.payload?.key === reconciliation.key
                  && Number(event.payload?.runId) === inspected.run.id
                  && Number(event.payload?.attempt) === inspected.run.attempt).length;
                if (prior + 1 < CANCELLED_RUN_RECONCILIATIONS) {
                  (await record(handle.id, 'github.ci.cancelled-reconciled', {
                    key: reconciliation.key, slug: ref.slug, number: ref.number,
                    candidateHead: ref.headSha, runId: inspected.run.id,
                    attempt: inspected.run.attempt, observation: prior + 1,
                  }));
                  reconciling.push(reconciliation.key);
                  continue;
                }
              }
              const checkContext = inspected.run.id === runId && check ? `${check.name}: ${check.state}\n${check.detail ?? ''}` : '';
              decisions.push((await terminalObservation(
                classifyGithubActionsFailure(inspected, { checkContext }),
                reconciliation.key,
              )));
            } catch (error) {
              inspectionFailures.push({ runId, error });
              actionReconciliationFailed = true;
              (await record(handle.id, 'github.ci.inspection-failed', {
                ...ref, runId, detail: error instanceof Error ? error.message : String(error),
              }));
            }
          }
        }
        if (!decisions.length) {
          const everyFailedCheckSatisfied = Boolean(readiness.failedChecks?.length)
            && readiness.failedChecks!.every((check) => {
              const id = githubActionsRunIdFromUrl(check.url);
              return Boolean(id && satisfiedRunIds.has(id));
            });
          if (satisfied.length && everyFailedCheckSatisfied) return { status: 'checks-satisfied' };
          if (followed.length) {
            const replacement = followed[0]!;
            const state = String(replacement.run.conclusion ?? replacement.run.status).toLowerCase();
            return {
              status: 'waiting', prs: current, actorUserId,
              detail: `Following equivalent same-head GitHub Actions run ${replacement.run.id} (attempt ${replacement.run.attempt}), currently ${state}. The older cancellation is informational; no rerun, proposal change, or human action is needed.`,
            };
          }
          if (reconciling.length) return {
            status: 'waiting', prs: current, actorUserId,
            detail: 'A current GitHub Actions run was cancelled with no replacement yet visible. Karmax is performing bounded exact-head reconciliation before classification or rerun.',
          };
          const providerFailure = classifyGithubCheckStates((readiness.failedChecks ?? []).map(check => check.state));
          if (providerFailure?.disposition === 'human') return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `${briefSummary}\n\n${providerFailure.reason}`,
            waitReason: providerFailure.waitReason,
            eligibleUserIds: [actorUserId],
          };
          if (providerFailure?.disposition === 'retry') {
            (await fallbackObservation(fallbackIdentityKey, providerFailure.disposition));
            return (await externalWait(fallbackIdentityKey,
              `${briefSummary}\n\nGitHub reports an interrupted check, but exact-head Actions inspection is unavailable. Waiting for a replacement without rerunning or reopening the proposal; admission is released while inspection is unavailable.`));
          }
          const permissionFailure = inspectionFailures.find(({ error }) =>
            error instanceof GithubActionsApiError && [401, 403].includes(error.status));
          if (permissionFailure || (runIds.length > 0 && !inspection.actions)) return {
            status: 'needs-human', prs: current, actorUserId, releaseAdmission: true,
            waitReason: 'GitHub Actions inspection unavailable',
            detail: `${briefSummary}\n\nExact-head Actions inspection is unavailable. Restore the GitHub App Actions read permission or inspect the run on GitHub before deciding whether code needs repair. Check text alone cannot establish the cause.`,
            eligibleUserIds: [actorUserId],
          };
          if (actionReconciliationFailed && runIds.length && !permissionFailure) return {
            status: 'retryable-error', prs: current, actorUserId,
            detail: `${briefSummary}\n\nExact-head GitHub Actions reconciliation was unavailable. Retrying inspection without rerunning or reopening the proposal.`,
          };
          const fallbackKey = fallbackIdentityKey;
          (await fallbackObservation(fallbackKey, 'revision'));
          const repairRequested = events.some((event) => event.type === 'github.ci.repair-requested'
            && event.payload?.key === fallbackKey);
          if (repairRequested) return (await externalWait(fallbackKey,
            `${briefSummary}\n\nThis exact terminal CI result was already sent for repair, but the pull-request candidate is unchanged. Waiting for a new run or candidate instead of waking Do again.`));
          (await record(handle.id, 'github.ci.repair-requested', {
            key: fallbackKey, slug: ref.slug, number: ref.number, candidateHead: ref.headSha,
            runId: runIds[0] ?? 0, attempt: 0,
          }));
          return {
            status: 'needs-revision', prs: current, actorUserId,
            detail: summary,
            ...(intentAuthorizedLanding ? { repair: { kind: 'ci' as const, preserveAuthorization: true,
              fingerprint: fallbackKey } } : {}),
          };
        }
        const detail = decisions.map(({ decision }) => renderGithubActionsFailure(decision)).join('\n\n').slice(0, 128_000);
        // Full diagnostics are for the agent; a person gets the brief form.
        const brief = decisions.map(({ decision }) => summarizeGithubActionsFailure(decision)).join('\n\n');
        // Reruns the failed jobs of one exact run; returns a decision only when
        // GitHub refuses.
        const rerun = async (
          { decision, key }: (typeof decisions)[number], rerunNumber: number, reason?: string,
        ): Promise<GitHubMergeAuthorization | undefined> => {
          const { id, attempt } = decision.inspection.run;
          try {
            await inspection.actions!.rerun(ref.slug, id, true);
          } catch (error) {
            const blocked = error instanceof GithubActionsApiError && [401, 403, 404, 422].includes(error.status);
            return {
              status: blocked ? 'needs-human' : 'retryable-error', prs: current, actorUserId,
              detail: `${brief}\n\nGitHub rejected the automatic rerun: ${error instanceof Error ? error.message : String(error)}`,
              ...(blocked ? { eligibleUserIds: [actorUserId] } : {}),
            };
          }
          (await record(handle.id, 'github.ci.rerun-requested', {
            ...ref, key, runId: id, observedAttempt: attempt, rerunNumber, ...(reason ? { reason } : {}),
          }));
          return undefined;
        };
        const human = decisions.find(({ decision }) => decision.disposition === 'human');
        if (human) return {
          status: 'needs-human', prs: current, actorUserId,
          detail: `${brief}\n\n${human.decision.reason}`,
          waitReason: human.decision.waitReason,
          eligibleUserIds: [actorUserId],
        };
        const revision = decisions.find(({ decision }) => decision.disposition === 'revision');
        if (revision) {
          const repairRequested = events.some((event) => event.type === 'github.ci.repair-requested'
            && event.payload?.key === revision.key);
          // The key pins the head, so a repair that is already recorded means
          // Do resubmitted the exact revision: it found nothing to fix. Only a
          // new run can change GitHub's answer, so start one (task 389). A
          // second failure on the same revision is evidence the agent missed
          // something, which a person must weigh.
          if (repairRequested) {
            const run = revision.decision.inspection.run;
            const reruns = events.filter((event) => event.type === 'github.ci.rerun-requested'
              && event.payload?.key === revision.key && event.payload?.reason === 'unchanged-after-repair');
            if (reruns.some((event) => Number(event.payload?.runId) === run.id
              && Number(event.payload?.observedAttempt) === run.attempt))
              return { status: 'waiting', prs: current, actorUserId, detail: 'Rerunning CI' };
            if (reruns.length) return {
              status: 'needs-human', prs: current, actorUserId,
              waitReason: 'CI failed again after a rerun',
              detail: `The agent found no code problem, but CI failed again after an automatic rerun of the same commit.\n${brief}\n\nSend a follow-up to return it to the agent, or rerun CI on GitHub and confirm.`,
              eligibleUserIds: [actorUserId],
            };
            return (await rerun(revision, reruns.length + 1, 'unchanged-after-repair'))
              ?? { status: 'waiting', prs: current, actorUserId, detail: 'Rerunning CI' };
          }
          (await record(handle.id, 'github.ci.repair-requested', {
            key: revision.key, slug: ref.slug, number: ref.number, candidateHead: ref.headSha,
            runId: revision.decision.inspection.run.id, attempt: revision.decision.inspection.run.attempt,
          }));
          return {
            status: 'needs-revision', prs: current, actorUserId, detail,
            ...(intentAuthorizedLanding ? { repair: { kind: 'ci' as const, preserveAuthorization: true,
              fingerprint: revision.key } } : {}),
          };
        }
        const retry = decisions.find(({ decision }) => decision.disposition === 'retry');
        if (retry && inspection.actions) {
          const reruns = events.filter((event) => event.type === 'github.ci.rerun-requested'
            && event.payload?.key === retry.key);
          const alreadyRequested = reruns.some((event) =>
            Number(event.payload?.runId) === retry.decision.inspection.run.id
            && Number(event.payload?.observedAttempt) === retry.decision.inspection.run.attempt);
          if (!alreadyRequested && reruns.length < 2) {
            const rejected = await rerun(retry, reruns.length + 1);
            if (rejected) return rejected;
          } else if (!alreadyRequested && reruns.length >= 2) {
            return {
              status: 'needs-human', prs: current, actorUserId,
              detail: `${brief}\n\nThe exact workflow run remained transiently broken after two automatic reruns. Inspect GitHub's runner or repository configuration before retrying.`,
              eligibleUserIds: [actorUserId],
            };
          }
          return { status: 'waiting', prs: current, actorUserId, detail: 'Waiting for CI' };
        }
        return {
          status: 'needs-revision', prs: current, actorUserId, detail,
          ...(intentAuthorizedLanding ? { repair: { kind: 'ci' as const, preserveAuthorization: true } } : {}),
        };
      };
      for (let ref of prs) {
        let live;
        try {
          live = await api.get(ref.slug, ref.number);
        } catch (error) {
          return errorDecision(error, [...settled, ref, ...prs.slice(settled.length + 1)]);
        }
        let next: TaskPullRequest = {
          ...ref, state: live.state, merged: live.merged,
          ...(live.headSha ? { headSha: live.headSha } : {}),
          ...(live.nodeId ? { nodeId: live.nodeId } : {}),
        };
        let current = [...settled, next, ...prs.slice(settled.length + 1)];
        const participant = (
          owner: GithubLandingParticipant['owner'],
          state: GithubLandingParticipant['state'],
        ): GithubLandingParticipant | undefined => live.base ? {
          key: `${ref.slug.toLowerCase()}#${ref.number}`,
          repo: ref.repo,
          slug: ref.slug,
          number: ref.number,
          ...(live.headSha ? { headSha: live.headSha } : ref.headSha ? { headSha: ref.headSha } : {}),
          target: live.base,
          domain: `github:${ref.slug.toLowerCase()}:${live.base}`,
          owner,
          state,
        } : undefined;
        if (live.merged) {
          if (ref.headSha && live.headSha !== ref.headSha) return {
            status: 'needs-revision', prs: current, actorUserId,
            detail: 'The merged pull request does not contain the reviewed head. Open a new pull request for the current proposal.',
          };
          if (!live.base) {
            return {
              status: 'retryable-error', prs: current, actorUserId,
              detail: `GitHub reports pull request ${ref.slug}#${ref.number} merged but did not report its target branch; local coherence cannot be established yet.`,
            };
          }
          const localSync = await syncGithubTargetToLocal(handle, ref, live.base, live.mergeCommitSha);
          lastSha = live.mergeCommitSha ?? localSync.sha ?? lastSha;
          const landedParticipant = participant('merged', 'merged');
          if (landedParticipant) participants.push(landedParticipant);
          settled.push(next);
          continue;
        }
        if (live.state === 'closed') {
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `Pull request ${ref.slug}#${ref.number} was closed without merging. Reopen it on GitHub and retry, send the task back to Do, or cancel it.`,
          };
        }
        if (fairLanding && ref.headSha && live.headSha && ref.headSha !== live.headSha) {
          const requested = events.findLast((event) => event.type === 'github.pr.branch-update-requested'
            && event.payload?.slug === ref.slug && Number(event.payload?.number) === ref.number
            && event.payload?.expectedHeadSha === ref.headSha);
          if (requested) {
            (await record(handle.id, 'github.pr.branch-updated', {
              ...ref, actorUserId, previousHeadSha: ref.headSha, headSha: live.headSha,
            }));
            ref = { ...next, headSha: live.headSha };
            next = ref;
            current = [...settled, next, ...prs.slice(settled.length + 1)];
          }
        }
        if (!ref.headSha || !live.headSha || ref.headSha !== live.headSha) {
          (await record(handle.id, 'github.merge.review-stale', { ...ref, reviewedHead: ref.headSha, liveHead: live.headSha }));
          if (intentAuthorizedLanding) {
            (await record(handle.id, 'github.merge.authorization-revoked', {
              ...ref, reason: 'head-changed-outside-repair', reviewedHead: ref.headSha, liveHead: live.headSha,
            }));
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
        let readinessError: unknown;
        const inspection = (await inspectionFor(ref.slug));
        const inspectionApi = inspection.api;
        const repairFingerprint = (kind: 'conflict' | 'base-moved', suffix?: string) =>
          readiness?.baseSha ? `${ref.slug.toLowerCase()}#${ref.number}:${ref.headSha ?? 'unknown'}:${readiness.baseSha}:${kind}${suffix ? `:${suffix}` : ''}` : undefined;
        if (live.nodeId) {
          try {
            readiness = await inspectionApi.readiness(ref.slug, ref.number);
          } catch (error) {
            // Readiness enriches the decision, but a head-bound REST landing
            // may still succeed when GraphQL is degraded or incomplete.
            readinessError = error;
          }
          if (readiness?.mergeable === 'CONFLICTING' || readiness?.mergeStateStatus === 'DIRTY') {
            return {
              status: 'needs-revision',
              prs: current,
              actorUserId,
              detail: intentAuthorizedLanding
                ? fairLanding
                  ? `Pull request ${ref.slug}#${ref.number} conflicts with the latest target or landing candidate. It has no Karmax admission slot; resolve it against the newest target, verify it, and request landing again.`
                  : `Pull request ${ref.slug}#${ref.number} conflicts with the latest target or merge group. GitHub has ejected this entry; resolve it against the newest target and reopen it for automated integration review.`
                : `Pull request ${ref.slug}#${ref.number} conflicts with its target. Resolve it in the task branch, reopen the proposal, and review the new head.`,
              ...(intentAuthorizedLanding ? { repair: { kind: 'conflict' as const, preserveAuthorization: true,
                ...(repairFingerprint('conflict') ? { fingerprint: repairFingerprint('conflict') } : {}) } } : {}),
            };
          }
          if (readiness?.draft) {
            return {
              status: 'needs-human', prs: current, actorUserId,
              detail: `Pull request ${ref.slug}#${ref.number} is a draft. Mark it ready for review on GitHub and retry, send it back to Do, or cancel it.`,
            };
          }
          if (readiness?.checks === 'FAILURE' || readiness?.checks === 'ERROR') {
            const checkDecision = await ciFailureDecision(ref, readiness, current, inspection);
            if (checkDecision.status !== 'checks-satisfied') return checkDecision;
            // GitHub's rollup can briefly retain an older cancelled duplicate
            // after an equivalent run on this exact head succeeds. The
            // canonical validation is green even though that stale projection
            // still says FAILURE/UNSTABLE.
            readiness = { ...readiness, checks: 'SUCCESS', failedChecks: undefined,
              ...(readiness.mergeStateStatus === 'UNSTABLE' ? { mergeStateStatus: 'CLEAN' as const } : {}) };
          }
          if (readiness?.reviewDecision === 'CHANGES_REQUESTED') {
            if (intentAuthorizedLanding)
              (await record(handle.id, 'github.merge.authorization-revoked', { ...ref, reason: 'changes-requested' }));
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `GitHub reviewers requested changes on pull request ${ref.slug}#${ref.number}. Inspect their review comments and update the proposal.`,
              ...(intentAuthorizedLanding ? { repair: { kind: 'changes-requested' as const, preserveAuthorization: false } } : {}),
            };
          }
          if (!intentAuthorizedLanding && readiness?.mergeStateStatus === 'BEHIND') {
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `Pull request ${ref.slug}#${ref.number} must be updated with its target branch before it can merge. Refresh the task branch, resolve any resulting conflict, and review the new head.`,
            };
          }
        }
        // Native queue CI runs on a speculative merge-group commit, so the PR
        // head can remain completely green after GitHub ejects it. Correlate
        // the durable timeline removal with *our latest enqueue event*; older
        // removals must not poison a repaired PR that has since rejoined.
        if (fairLanding && observeOnly && !readiness?.mergeQueueEntryId
          && readiness?.removedFromMergeQueue) {
          const latestEnqueue = events.findLast((event) => event.type === 'github.pr.queued'
            && event.payload?.slug === ref.slug && Number(event.payload?.number) === ref.number
            && (!event.payload?.headSha || event.payload.headSha === ref.headSha));
          const removedAt = Date.parse(readiness.removedFromMergeQueue.createdAt);
          if (latestEnqueue && Number.isFinite(removedAt) && removedAt >= latestEnqueue.ts - 2_000) {
            const removal = readiness.removedFromMergeQueue;
            const failedChecks = removal.beforeCommitSha
              ? await inspectionApi.failedChecksForRef(ref.slug, removal.beforeCommitSha).catch(() => [])
              : [];
            const reason = removal.reason?.trim() || 'GitHub did not expose a removal reason.';
            const renderedChecks = failedChecks.slice(0, 12).map((check) => {
              const detail = check.detail?.trim();
              return `- ${check.name}: ${check.state}${check.url ? ` (${check.url})` : ''}${detail ? `\n${detail.slice(0, 12_000)}` : ''}`;
            });
            (await record(handle.id, 'github.pr.queue-ejected', {
              ...ref, actorUserId, reason, removedAt: removal.createdAt,
              ...(removal.beforeCommitSha ? { mergeGroupSha: removal.beforeCommitSha } : {}),
              failedChecks: failedChecks.map((check) => ({ name: check.name, state: check.state, url: check.url })),
            }));
            const detail = [
              `GitHub removed pull request ${ref.slug}#${ref.number} from its merge queue: ${reason}`,
              ...(removal.beforeCommitSha
                ? [`Speculative merge-group commit: ${removal.beforeCommitSha}`]
                : []),
              ...(renderedChecks.length
                ? ['Failed merge-group checks:', ...renderedChecks]
                : ['GitHub exposed no failed check output for the speculative commit; the queue removal reason above is the complete available diagnostic.']),
            ].join('\n').slice(0, 64_000);
            // A deliberate human dequeue is an external decision: never undo
            // it by entering fallback or re-enqueueing. Automated ejections go
            // to Do with the exact failure unless structured check states require
            // inspection or retry. Check descriptions never establish ownership.
            if (/\buser\b|manual|request(?:ed|ing)? (?:a )?remov|dequeue/i.test(reason)) {
              return {
                status: 'needs-human', prs: current, actorUserId, detail,
                eligibleUserIds: [actorUserId],
              };
            }
            const conflict = /conflict/i.test(reason);
            if (!conflict) {
              const providerFailure = classifyGithubCheckStates(failedChecks.map(check => check.state));
              if (providerFailure) {
                const runId = failedChecks.map((check) => githubActionsRunIdFromUrl(check.url))
                  .find((id): id is number => Boolean(id)) ?? 0;
                const key = githubRequiredCheckKey({
                  repository: ref.slug, pullRequest: ref.number, headSha: ref.headSha ?? 'unknown',
                  workflowId: 0, check: failedChecks.map((check) => check.name).sort().join('|') || 'merge-group',
                });
                const observationKey = `${key}:run:${runId}:attempt:0:state:${providerFailure.disposition}`;
                const observed = events.some((event) => event.type === 'github.ci.terminal-observed'
                  && (event.payload?.observationKey === observationKey || event.payload?.key === key));
                if (!observed) (await record(handle.id, 'github.ci.terminal-observed', {
                  key, observationKey, slug: ref.slug, number: ref.number, candidateHead: ref.headSha,
                  runId, attempt: 0, disposition: providerFailure.disposition, inspectionUnavailable: true,
                }));
                if (providerFailure.disposition === 'human') return {
                  status: 'needs-human', prs: current, actorUserId, detail, releaseAdmission: true,
                  waitReason: providerFailure.waitReason,
                  eligibleUserIds: [actorUserId],
                };
                if (providerFailure.disposition === 'retry') return {
                  status: 'retryable-error', prs: current, actorUserId, detail: `${detail}\n\nThe speculative queue check failed transiently. Retrying GitHub inspection without reopening the proposal.`,
                  releaseAdmission: true,
                };
              }
            }
            return {
              status: 'needs-revision', prs: current, actorUserId, detail,
              repair: { kind: conflict ? 'conflict' : 'ci', preserveAuthorization: true,
                ...(conflict && removal.beforeCommitSha
                  ? { fingerprint: `${ref.slug.toLowerCase()}#${ref.number}:${ref.headSha ?? 'unknown'}:${removal.beforeCommitSha}:conflict` }
                  : {}) },
            };
          }
        }
        if (frontHeldExact && (readiness?.mergeQueueEntryId || readiness?.autoMerge)) {
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `Pull request ${ref.slug}#${ref.number} is already controlled by GitHub's merge queue or auto-merge. Remove it there before retrying: this workflow keeps one authoritative karmax queue position through exact-candidate review and repair.`,
            eligibleUserIds: [actorUserId],
          };
        }
        if (frontHeldExact && readiness?.checksUnavailable) {
          if (inspection.connectionId && typeof (deps.githubApp as any).invalidateInstallationToken === 'function')
            deps.githubApp.invalidateInstallationToken(inspection.connectionId);
          const appSlug = typeof (deps.githubApp as any).status === 'function'
            ? (await deps.githubApp.status()).appSlug
            : undefined;
          return {
            status: 'waiting', prs: current, actorUserId,
            detail: `GitHub has not granted krmax read access to CI for ${ref.slug}#${ref.number}. `
              + 'Grant the GitHub App read-only Checks and Commit statuses permissions, then approve the updated installation permissions; '
              + `this task will retain the front landing slot and retry automatically.${appSlug
                ? ` App settings: https://github.com/settings/apps/${appSlug}/permissions`
                : ''}`,
          };
        }
        if (!frontHeldExact && intentAuthorizedLanding && (readiness?.mergeQueueEntryId
          || (readiness?.autoMerge && (!fairLanding || readiness.mergeStateStatus !== 'BEHIND')))) {
          const entryIds = readiness.mergeQueueEntryId ? [readiness.mergeQueueEntryId] : [];
          if (fairLanding) {
            queued = true;
            queuedOwner = readiness.mergeQueueEntryId ? 'provider'
              : landingAuthority === 'external' ? 'external' : 'provider';
            pendingDetail = readiness.mergeQueueEntryId
              ? 'GitHub is validating the pull requests in its merge queue.'
              : 'GitHub auto-merge is waiting for repository requirements.';
            const activeParticipant = participant(queuedOwner, 'queued');
            if (activeParticipant) participants.push(activeParticipant);
            settled.push(next);
            continue;
          }
          return {
            status: 'queued', prs: current, actorUserId,
            detail: readiness.mergeQueueEntryId
              ? 'GitHub is validating this pull request in its merge queue.'
              : 'GitHub auto-merge is waiting for repository requirements.',
            providerQueue: { state: 'validating', ...(entryIds.length ? { entryIds } : {}) },
            landingOwner: readiness.mergeQueueEntryId ? 'provider' : landingAuthority === 'external' ? 'external' : 'provider',
          };
        }
        const reviewEvents = events;
        const mirroredReviews = reviewEvents.filter((event) =>
          event.type === 'github.pr.review-approved'
          && event.payload?.slug === ref.slug && event.payload?.number === ref.number
          && event.payload?.actorUserId === actorUserId);
        const alreadyMirrored = reviewEvents.some((event) =>
          (event.type === 'github.pr.review-approved'
            || (event.type === 'github.pr.review-skipped'
              && /cannot approve your own pull request|can not approve your own pull request/i.test(String(event.payload?.detail ?? ''))))
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
            .then(async () => (await record(handle.id, 'github.pr.review-approved', { ...ref, actorUserId })))
            .catch(async (error) => (await record(handle.id, 'github.pr.review-skipped', {
              ...ref, actorUserId, detail: error instanceof Error ? error.message : String(error),
            })));
        }
        // A mirrored approval may have satisfied GitHub's own required-review
        // rule. Re-read only when that rule was previously blocking; if it still
        // is, this is a real external-human wait rather than an opaque merge poll.
        if (readiness?.reviewDecision === 'REVIEW_REQUIRED') {
          try {
            readiness = await inspectionApi.readiness(ref.slug, ref.number);
          } catch (error) {
            return errorDecision(error, current);
          }
          if (readiness.checks === 'FAILURE' || readiness.checks === 'ERROR') {
            const checkDecision = await ciFailureDecision(ref, readiness, current, inspection);
            if (checkDecision.status !== 'checks-satisfied') return checkDecision;
            readiness = { ...readiness, checks: 'SUCCESS', failedChecks: undefined,
              ...(readiness.mergeStateStatus === 'UNSTABLE' ? { mergeStateStatus: 'CLEAN' as const } : {}) };
          }
          if (readiness.reviewDecision === 'CHANGES_REQUESTED') {
            if (intentAuthorizedLanding)
              (await record(handle.id, 'github.merge.authorization-revoked', { ...ref, reason: 'changes-requested' }));
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
        // v1.21 separates read-only participant classification from every
        // landing mutation.  The workflow first preflights ALL PRs; only after
        // that barrier succeeds may it ask provider queues to claim unowned
        // participants or acquire the exact fallback domains.
        if (participantPreflight) {
          if (!readiness) {
            if (readinessError) return { ...errorDecision(readinessError, current), participants };
            return {
              status: 'retryable-error', prs: current, actorUserId, participants,
              detail: `GitHub did not expose policy and check state for ${ref.slug}#${ref.number}; the multi-repository preflight will not mutate any participant without it.`,
            };
          }
          if (!live.base) return {
            status: 'retryable-error', prs: current, actorUserId, participants,
            detail: `GitHub did not report the target branch for pull request ${ref.slug}#${ref.number}; multi-repository landing cannot identify its scheduler domain.`,
          };
          observations.push(createHash('sha256').update(JSON.stringify([ref.slug, ref.number, readiness])).digest('hex'));
          const planned = participant(
            landingAuthority === 'external' ? 'external'
              : landingAuthority === 'karmax' ? 'karmax' : 'unowned',
            landingAuthority === 'external' ? 'queued' : 'ready',
          );
          if (planned) participants.push(planned);
          settled.push(next);
          continue;
        }
        if (frontHeldExact) {
          if (!readiness) {
            if (readinessError) return errorDecision(readinessError, current);
            return {
              status: 'retryable-error', prs: current, actorUserId,
              detail: `GitHub did not expose policy and check state for ${ref.slug}#${ref.number}; karmax cannot certify the exact candidate yet.`,
            };
          }
          if (readiness.mergeStateStatus === 'BEHIND') {
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `Pull request ${ref.slug}#${ref.number} is behind its target. While this task retains the front landing slot, update the task branch from the target, resolve any conflicts, and rebuild the exact candidate.`,
              repair: { kind: 'base-moved', preserveAuthorization: true,
                ...(repairFingerprint('base-moved') ? { fingerprint: repairFingerprint('base-moved') } : {}) },
            };
          }
          if (['PENDING', 'EXPECTED'].includes(readiness.checks ?? '')) {
            return {
              status: 'waiting', prs: current, actorUserId,
              detail: 'Waiting for CI on the exact pull-request head while this task retains the front landing slot.',
            };
          }
          // GitHub commonly reports UNKNOWN for a short window while it
          // recomputes mergeability after the target moves. That is neither a
          // repository-policy decision nor grounds to eject the task: keep the
          // authoritative front slot and poll until GitHub has a real answer.
          if (readiness.mergeable === 'UNKNOWN' || readiness.mergeStateStatus === 'UNKNOWN') {
            return {
              status: 'waiting', prs: current, actorUserId,
              detail: `GitHub is still computing mergeability for ${ref.slug}#${ref.number}; this task retains the front landing slot and will retry automatically.`,
            };
          }
          if (readiness.mergeStateStatus !== 'CLEAN') {
            return {
              status: 'needs-human', prs: current, actorUserId,
              detail: `GitHub reports ${readiness.mergeStateStatus} for ${ref.slug}#${ref.number}. The task is being released from the landing queue until repository policy or PR state is resolved.`,
              eligibleUserIds: [actorUserId],
            };
          }
          const mergeMethod = actorPermissions.get(ref.slug)?.mergeMethod ?? 'merge';
          if (mergeMethod !== 'merge') {
            return {
              status: 'needs-human', prs: current, actorUserId,
              detail: `Repository policy requests ${mergeMethod} landing for ${ref.slug}, but an exact reviewed head can only be advanced atomically with a merge commit strategy. Change the repository landing policy or use a workflow that can validate the provider-generated ${mergeMethod} candidate.`,
              eligibleUserIds: [actorUserId],
            };
          }
          if (!live.base) {
            return {
              status: 'retryable-error', prs: current, actorUserId,
              detail: `GitHub did not report the target branch for pull request ${ref.slug}#${ref.number}; exact landing cannot proceed safely.`,
            };
          }
          if (inspectExact) {
            settled.push(next);
            continue;
          }
          let advanced;
          try { advanced = await api.fastForwardTarget(ref.slug, live.base, ref.headSha); }
          catch (error) { return errorDecision(error, current); }
          if (advanced.updated) {
            const landed: TaskPullRequest = { ...next, state: 'closed', merged: true };
            const localSync = await syncGithubTargetToLocal(handle, ref, live.base, ref.headSha);
            lastSha = ref.headSha;
            settled.push(landed);
            (await record(handle.id, 'github.pr.merged', {
              ...ref, sha: ref.headSha, actorUserId, strategy: 'front-held-exact-fast-forward',
            }));
            continue;
          }
          if (/fast.?forward|behind|reference update failed|not a valid head/i.test(advanced.message)) {
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `The target moved outside karmax's landing coordinator before exact head ${ref.headSha} could land for ${ref.slug}#${ref.number}: ${advanced.message}. Repair against that live target while retaining the front slot.`,
              repair: { kind: 'base-moved', preserveAuthorization: true,
                ...(repairFingerprint('base-moved', advanced.message) ? { fingerprint: repairFingerprint('base-moved', advanced.message) } : {}) },
            };
          }
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `GitHub refused the exact landing for ${ref.slug}#${ref.number}: ${advanced.message}. The task is being released from the landing queue until repository policy is fixed.`,
            eligibleUserIds: [actorUserId],
          };
        }
        if (observeOnly && !fairLanding) {
          return {
            status: 'needs-revision', prs: current, actorUserId,
            detail: `GitHub ejected pull request ${ref.slug}#${ref.number} from its merge queue without merging it. Inspect the merge-group checks and the newest target, repair the branch if needed, and revalidate before requeueing.`,
            repair: { kind: 'ci', preserveAuthorization: true },
          };
        }
        if (fairLanding && observeOnly && landingAuthority !== 'external') {
          // The provider previously owned this PR but no queue/auto-merge entry
          // is visible now. Observation must not mutate a stale branch without
          // admission. Hand control back to the workflow; its next iteration
          // acquires fair fallback admission before update/requeue/direct merge.
          return {
            status: 'waiting', prs: current, actorUserId,
            detail: `The provider no longer reports an active landing entry for ${ref.slug}#${ref.number}; requesting fair fallback admission before any mutation.`,
            landingOwner: 'karmax',
          };
        }
        if (fairLanding) {
          // An explicitly configured third-party authority is triggered by the
          // repository/PR itself. Karmax observes terminal checks, conflicts and
          // merge completion above, but never creates a competing order or
          // mutates the branch merely because it is behind.
          if (landingAuthority === 'external') {
            queued = true;
            queuedOwner = 'external';
            pendingDetail = 'The configured external landing authority owns landing; Karmax is observing the PRs and will act only on a terminal failure or merge.';
            const externalParticipant = participant('external', 'queued');
            if (externalParticipant) participants.push(externalParticipant);
            settled.push(next);
            continue;
          }

          // Prefer a real provider queue. It can accept an out-of-date PR and
          // construct speculative candidates without rewriting the PR branch.
          if (landingAuthority !== 'karmax' && live.nodeId) {
            let queueResult;
            let queueError: unknown;
            try { queueResult = await api.enqueue(live.nodeId, ref.headSha); }
            catch (error) { queueError = error; }
            if (queueResult?.queued) {
              queued = true;
              queuedOwner = 'provider';
              pendingDetail = 'GitHub accepted the pull requests into its merge queue and now owns landing order.';
              const providerParticipant = participant('provider', 'queued');
              if (providerParticipant) participants.push(providerParticipant);
              settled.push(next);
              (await record(handle.id, 'github.pr.queued', { ...ref, actorUserId }));
              continue;
            }
            // GraphQL mutation errors are commonly the capability probe saying
            // this branch has no native queue. Authentication/transport errors
            // still surface; a returned mutation message falls through safely.
            if (queueError) return errorDecision(queueError, current);
          }

          if (claimProviderOnly) {
            // Auto-merge is also provider ownership, but enabling it for an
            // already-behind branch does not make the provider update that
            // branch.  Such a participant belongs to guarded fallback instead.
            if (landingAuthority !== 'karmax' && live.nodeId
              && readiness?.mergeStateStatus !== 'BEHIND') {
              const mergeMethod = actorPermissions.get(ref.slug)?.mergeMethod ?? 'merge';
              let autoMerge;
              try { autoMerge = await api.enableAutoMerge(live.nodeId, ref.headSha, mergeMethod); }
              catch { /* Capability probe: absence means fallback owns it. */ }
              if (autoMerge?.enabled) {
                const providerParticipant = participant('provider', 'queued');
                if (providerParticipant) participants.push(providerParticipant);
                settled.push(next);
                (await record(handle.id, 'github.pr.auto-merge-enabled', { ...ref, actorUserId, mergeMethod }));
                continue;
              }
            }
            const fallbackParticipant = participant('karmax', 'ready');
            if (fallbackParticipant) participants.push(fallbackParticipant);
            settled.push(next);
            continue;
          }

          // Behind is scheduling state, not agent work. Only the proposal that
          // owns fallback admission is updated, using GitHub's expected-head
          // guarded mechanical operation. A conflict is the only branch-update
          // outcome that returns to Do.
          if (readiness?.mergeStateStatus === 'BEHIND') {
            (await record(handle.id, 'github.pr.branch-update-requested', {
              ...ref, actorUserId, expectedHeadSha: ref.headSha,
            }));
            let update;
            try { update = await api.updateBranch(ref.slug, ref.number, ref.headSha); }
            catch (error) { return errorDecision(error, current); }
            if (!update.requested) {
              return {
                status: 'needs-revision', prs: current, actorUserId,
                detail: `GitHub could not mechanically update ${ref.slug}#${ref.number} from its target: ${update.message}. Resolve the actual conflict in Do; this task has already released fallback admission.`,
                repair: { kind: 'conflict', preserveAuthorization: true,
                  ...(repairFingerprint('conflict', update.message) ? { fingerprint: repairFingerprint('conflict', update.message) } : {}) },
              };
            }
            const refreshed = update.headSha ? { ...next, headSha: update.headSha } : next;
            if (update.headSha) (await record(handle.id, 'github.pr.branch-updated', {
              ...ref, actorUserId, previousHeadSha: ref.headSha, headSha: update.headSha,
            }));
            return {
              status: 'waiting',
              prs: [...settled, refreshed, ...prs.slice(settled.length + 1)],
              actorUserId,
              detail: update.headSha
                ? `GitHub mechanically updated ${ref.slug}#${ref.number} to ${update.headSha.slice(0, 8)}; fallback admission is waiting for repository checks.`
                : `GitHub accepted the mechanical update for ${ref.slug}#${ref.number}; fallback admission is waiting for the new head and its checks.`,
              landingOwner: 'karmax',
            };
          }

          // Auto-merge is provider-owned completion. It is safe to release
          // Karmax admission while current; if strict freshness later reports
          // BEHIND, reconciliation enters fallback admission and updates only
          // that one candidate instead of waking every stale task.
          if (landingAuthority !== 'karmax' && live.nodeId) {
            const mergeMethod = actorPermissions.get(ref.slug)?.mergeMethod ?? 'merge';
            let autoMerge;
            try { autoMerge = await api.enableAutoMerge(live.nodeId, ref.headSha, mergeMethod); }
            catch { /* Not available or immediately mergeable: fall through. */ }
            if (autoMerge?.enabled) {
              queued = true;
              queuedOwner = 'provider';
              pendingDetail = 'GitHub auto-merge owns completion while repository requirements are pending.';
              settled.push(next);
              (await record(handle.id, 'github.pr.auto-merge-enabled', { ...ref, actorUserId, mergeMethod }));
              continue;
            }
          }

          if (readiness && ['PENDING', 'EXPECTED'].includes(readiness.checks ?? '')) {
            return {
              status: 'waiting', prs: current, actorUserId,
              detail: 'Fallback admission is waiting for required checks on the current pull-request head.',
              landingOwner: 'karmax',
            };
          }
          if (!readiness || readiness.mergeable === 'UNKNOWN' || readiness.mergeStateStatus === 'UNKNOWN') {
            return {
              status: 'waiting', prs: current, actorUserId,
              detail: `GitHub is still computing landing readiness for ${ref.slug}#${ref.number}.`,
              landingOwner: 'karmax',
            };
          }
          if (!['CLEAN', 'UNSTABLE'].includes(readiness.mergeStateStatus)) {
            return {
              status: 'needs-human', prs: current, actorUserId,
              detail: `GitHub policy is blocking ${ref.slug}#${ref.number} (${readiness.mergeStateStatus}). Resolve that repository or PR policy before requesting landing again.`,
              eligibleUserIds: [actorUserId],
            };
          }

          let merged;
          try {
            merged = await api.merge(ref.slug, ref.number, ref.headSha,
              actorPermissions.get(ref.slug)?.mergeMethod ?? 'merge');
          } catch (error) { return errorDecision(error, current); }
          if (merged.merged) {
            if (!live.base) return {
              status: 'retryable-error', prs: current, actorUserId,
              detail: `GitHub merged ${ref.slug}#${ref.number} but did not report its target branch; local coherence cannot be established yet.`,
            };
            const landed: TaskPullRequest = { ...next, state: 'closed', merged: true };
            const localSync = await syncGithubTargetToLocal(handle, ref, live.base, merged.sha);
            settled.push(landed);
            lastSha = merged.sha ?? localSync.sha ?? lastSha;
            (await record(handle.id, 'github.pr.merged', { ...ref, sha: merged.sha, actorUserId, strategy: 'provider-policy' }));
            continue;
          }
          const refusal = merged.message ?? 'GitHub refused the merge';
          if (/conflict|not mergeable/i.test(refusal)) return {
            status: 'needs-revision', prs: current, actorUserId,
            detail: `GitHub reports an actual conflict for ${ref.slug}#${ref.number}: ${refusal}`,
            repair: { kind: 'conflict', preserveAuthorization: true,
              ...(repairFingerprint('conflict', refusal) ? { fingerprint: repairFingerprint('conflict', refusal) } : {}) },
          };
          if (/checks?|pending|expected|behind|update.*branch/i.test(refusal)) return {
            status: 'waiting', prs: current, actorUserId,
            detail: `Fallback admission is waiting for GitHub policy: ${refusal}`,
            landingOwner: 'karmax',
          };
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `GitHub refused to land ${ref.slug}#${ref.number}: ${refusal}`,
            eligibleUserIds: [actorUserId],
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
            (await record(handle.id, 'github.pr.queued', { ...ref, actorUserId }));
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
              repair: { kind: 'base-moved', preserveAuthorization: true,
                ...(repairFingerprint('base-moved') ? { fingerprint: repairFingerprint('base-moved') } : {}) },
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
            const landed: TaskPullRequest = { ...next, state: 'closed', merged: true };
            const localSync = await syncGithubTargetToLocal(handle, ref, live.base, ref.headSha);
            lastSha = ref.headSha;
            settled.push(landed);
            (await record(handle.id, 'github.pr.merged', {
              ...ref, sha: ref.headSha, actorUserId, strategy: 'exact-fast-forward',
            }));
            continue;
          }
          if (/fast.?forward|behind|reference update failed|not a valid head/i.test(advanced.message)) {
            return {
              status: 'needs-revision', prs: current, actorUserId,
              detail: `The target moved before GitHub could land exact head ${ref.headSha} for ${ref.slug}#${ref.number}: ${advanced.message}`,
              repair: { kind: 'base-moved', preserveAuthorization: true,
                ...(repairFingerprint('base-moved', advanced.message) ? { fingerprint: repairFingerprint('base-moved', advanced.message) } : {}) },
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
          return errorDecision(error, current);
        }
        if (merged.merged) {
          if (!live.base) {
            return {
              status: 'retryable-error', prs: current, actorUserId,
              detail: `GitHub merged pull request ${ref.slug}#${ref.number} but did not report its target branch; local coherence cannot be established yet.`,
            };
          }
          const landed: TaskPullRequest = { ...next, state: 'closed', merged: true };
          const localSync = await syncGithubTargetToLocal(handle, ref, live.base, merged.sha);
          lastSha = merged.sha ?? localSync.sha ?? lastSha;
          settled.push(landed);
          (await record(handle.id, 'github.pr.merged', { ...ref, sha: merged.sha, actorUserId }));
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
          (await record(handle.id, 'github.pr.queued', { ...ref, actorUserId }));
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
          (await record(handle.id, 'github.pr.auto-merge-enabled', { ...ref, actorUserId, mergeMethod }));
          continue;
        }
        const refusal = [merged.message, queueResult?.message, autoMerge?.message].filter(Boolean).join('; ');
        if (/head branch was modified|head (?:sha|oid).*(?:changed|mismatch)|expected head/i.test(refusal)) {
          return {
            status: 'stale-review', prs: current, actorUserId,
            detail: `Pull request ${ref.slug}#${ref.number} changed while GitHub was attempting to merge it. Re-inspect and repair the live head before opening it for Review again.`,
            eligibleUserIds: [actorUserId],
          };
        }
        if (/merge conflicts?|conflict(?:ing)? with (?:the )?(?:base|target)|not mergeable|base branch was modified|update (?:the )?branch/i.test(refusal)) {
          return {
            status: 'needs-revision', prs: current, actorUserId,
            detail: `Pull request ${ref.slug}#${ref.number} conflicts with its target. ${refusal} Resolve it in the task branch, then reopen and review the updated proposal.`,
          };
        }
        if (/changes? (?:have been |were )?requested/i.test(refusal)) {
          return {
            status: 'needs-revision', prs: current, actorUserId,
            detail: `GitHub reviewers requested changes on pull request ${ref.slug}#${ref.number}. Inspect their comments and update the proposal.`,
          };
        }
        if (/draft pull request|pull request is (?:a )?draft|review is required|required approving review/i.test(refusal)) {
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `GitHub requires a human PR-state or review decision for ${ref.slug}#${ref.number}: ${refusal}`,
          };
        }
        if (fallbackError) return errorDecision(fallbackError, current);
        if (readinessError) return errorDecision(readinessError, current);
        if (readiness
          && !['PENDING', 'EXPECTED'].includes(readiness.checks ?? '')
          && ['BLOCKED', 'DRAFT', 'HAS_HOOKS'].includes(readiness.mergeStateStatus)) {
          return {
            status: 'needs-human', prs: current, actorUserId,
            detail: `GitHub policy is blocking pull request ${ref.slug}#${ref.number} (${readiness.mergeStateStatus}). Inspect the repository rule or PR state, then retry or send the task back to Do.`,
          };
        }
        const explicitlyPending = Boolean(readiness && ['PENDING', 'EXPECTED'].includes(readiness.checks ?? ''))
          || /(?:checks?|status checks?).*(?:pending|expected)|(?:pending|expected).*(?:checks?|status checks?)/i.test(refusal);
        if (!explicitlyPending) return {
          status: 'retryable-error', prs: current, actorUserId,
          detail: `GitHub refused to merge pull request ${ref.slug}#${ref.number}: ${refusal || merged.message}`,
        };
        (await record(handle.id, 'github.pr.merge-waiting', { ...ref, actorUserId, detail: merged.message }));
        return {
          status: 'waiting', prs: [...settled, next, ...prs.slice(settled.length + 1)], actorUserId,
          detail: merged.message,
        };
      }
      if (participantPreflight) return {
        status: 'planned', prs: settled, actorUserId, participants, observationKey: observations.join(':'),
        detail: 'Every pull request passed the read-only multi-repository landing preflight.',
      };
      if (claimProviderOnly) {
        const fallback = participants.some((candidate) => candidate.owner === 'karmax');
        const external = participants.length > 0 && participants.every((candidate) => candidate.owner === 'external');
        return {
          status: fallback ? 'waiting' : 'queued',
          prs: settled,
          actorUserId,
          participants,
          landingOwner: fallback ? 'karmax' : external ? 'external' : 'provider',
          detail: fallback
            ? 'No repository landing scheduler accepted this participant; it requires guarded Karmax fallback admission.'
            : pendingDetail ?? 'The repository landing authority accepted this participant.',
          ...(!fallback ? { providerQueue: { state: 'queued' as const } } : {}),
        };
      }
      if (inspectExact && settled.length === prs.length)
        return {
          status: 'candidate-ready', prs: settled, actorUserId, participants,
          detail: 'The exact pull-request head is current, CI-complete, and ready for integration review.',
        };
      if (settled.every((ref) => ref.merged))
        return { status: 'merged', prs: settled, actorUserId, participants, ...(lastSha ? { sha: lastSha } : {}) };
      return {
        status: queued ? 'queued' : 'waiting', prs: settled, actorUserId, participants,
        detail: queued ? pendingDetail : 'Waiting for GitHub merge policy.',
        ...(intentAuthorizedLanding && queued ? { providerQueue: { state: 'queued' as const } } : {}),
        ...(queuedOwner ? { landingOwner: queuedOwner } : {}),
      };
    },

    /** Stop still-pending provider participants after a sibling fails.  This is
     * best-effort saga cleanup: a participant that already crossed GitHub's
     * atomic merge point remains merged and is reconciled on the next preflight. */
    async withdrawGithubPrs(
      handle: WorldHandle,
      prs: TaskPullRequest[],
      actorUserId?: string,
    ): Promise<{ withdrawn: string[]; failed: Record<string, string>; reconciled: TaskPullRequest[] }> {
      const task = (await store.getTask(handle.id));
      const actor = actorUserId ?? (await store.taskCreatorUserId(handle.id));
      if (!task || !actor || !deps.githubApp) return {
        withdrawn: [], failed: Object.fromEntries(prs.map((ref) => [`${ref.slug}#${ref.number}`, 'no GitHub actor is available'])),
        reconciled: prs,
      };
      const accountId = actor === (await store.taskCreatorUserId(handle.id))
        ? (typeof task.params?._githubAccountId === 'string'
            ? task.params._githubAccountId
            : (await deps.githubApp.activeUserAccountId(actor)))
        : (await deps.githubApp.activeUserAccountId(actor));
      const api = prApiForUser(actor, accountId);
      const withdrawn: string[] = [];
      const failed: Record<string, string> = {};
      const reconciled: TaskPullRequest[] = [];
      for (const ref of prs.filter((candidate) => !candidate.merged && candidate.nodeId)) {
        const key = `${ref.slug.toLowerCase()}#${ref.number}`;
        try {
          const live = await api.get(ref.slug, ref.number);
          if (live.merged) {
            const landed = { ...ref, state: 'closed' as const, merged: true,
              ...(live.headSha ? { headSha: live.headSha } : {}) };
            reconciled.push(landed);
            if (live.base) await syncGithubTargetToLocal(handle, ref, live.base, live.mergeCommitSha).catch(() => undefined);
            (await record(handle.id, 'github.pr.merged', { ...ref, sha: live.mergeCommitSha, actorUserId: actor, strategy: 'provider-raced-cleanup' }));
            continue;
          }
        } catch { /* Continue with best-effort withdrawal under the known node id. */ }
        const outcomes = await Promise.allSettled([
          api.dequeue(ref.nodeId!),
          api.disableAutoMerge(ref.nodeId!),
        ]);
        const accepted = outcomes.some((outcome) => outcome.status === 'fulfilled' && outcome.value.withdrawn);
        if (accepted) {
          withdrawn.push(key);
          reconciled.push(ref);
          (await record(handle.id, 'github.pr.landing-withdrawn', { ...ref, actorUserId: actor, reason: 'sibling-failed' }));
        } else {
          reconciled.push(ref);
          const details = outcomes.map((outcome) => outcome.status === 'fulfilled'
            ? outcome.value.message
            : outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
          failed[key] = details.join('; ').slice(0, 2_000);
          (await record(handle.id, 'github.pr.landing-withdraw-failed', { ...ref, actorUserId: actor, detail: failed[key] }));
        }
      }
      return { withdrawn, failed, reconciled };
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
          await worlds.withOperation(handle.id, () => api.commentOnce(ref.slug, ref.number,
            after.merged ? `Merged into \`${outcome.target}\` by karmax${as}.`
            : landed ? `karmax merged this branch into \`${outcome.target}\`${as} and pushed it. Closing.`
            : `karmax merged this branch into \`${outcome.target}\` locally${as}, but could not push`
              + ` \`${outcome.target}\` to origin. This pull request stays open until that target lands.`,
            JSON.stringify([handle.id, 'finalize', outcome.target, outcome.sha, landed])));
          const next = { ...ref, state: after.state, merged: after.merged };
          (await record(handle.id, after.merged ? 'pr.merged' : after.state === 'closed' ? 'pr.closed' : 'pr.open', next));
          settled.push(next);
        } catch (error) {
          (await record(handle.id, 'pr.finalize_failed', { ...ref, error: error instanceof Error ? error.message : String(error) }));
          settled.push(ref);
        }
      }
      return settled;
    },

    /** Close the task's still-open PRs (cancellation), returning GitHub's live
     *  state for the task view. Best-effort: a task that is going away must not
     *  be held up by GitHub being unreachable. */
    async closePrs(handle: WorldHandle, prs: TaskPullRequest[], reason: string): Promise<TaskPullRequest[]> {
      // Opening a PR can authorize a local checkout by matching its configured
      // GitHub origin against the organization repository catalog. Preserve the
      // same checkout context here; resolving only by project attachment made
      // cancellation unable to close exactly those otherwise-valid PRs.
      const world = await openWorld(handle).catch(() => undefined);
      const checkouts = world ? worldRepos(world.handle) : [];
      const reconciled: TaskPullRequest[] = [];
      for (const ref of prs) {
        try {
          const checkout = checkouts.find((candidate) => candidate.name === ref.repo);
          const api = await prApiFor(handle, ref.slug, checkout);
          const live = await api.get(ref.slug, ref.number);
          if (live.state === 'closed') {
            const next = { ...ref, state: live.state, merged: live.merged,
              ...(live.headSha ? { headSha: live.headSha } : {}) };
            reconciled.push(next);
            if (live.merged) (await record(handle.id, 'pr.merged', next));
            continue;
          }
          await worlds.withOperation(handle.id, () => api.commentOnce(ref.slug, ref.number, reason,
            JSON.stringify([handle.id, 'close', reason])));
          const closed = await api.update(ref.slug, ref.number, { state: 'closed' });
          const next = { ...ref, state: closed.state, merged: closed.merged,
            ...(closed.headSha ? { headSha: closed.headSha } : {}) };
          reconciled.push(next);
          (await record(handle.id, closed.merged ? 'pr.merged' : 'pr.closed', { ...next, reason }));
        } catch (error) {
          (await record(handle.id, 'pr.close_failed', { ...ref, error: error instanceof Error ? error.message : String(error) }));
          reconciled.push(ref);
        }
      }
      return reconciled;
    },

    /**
     * Push the landed target branch to each repo's origin (remote policy
     * 'push'/'pr', wiki plans/PLAN-git-config §5). Best-effort by contract: the local
     * merge is the deliverable; every skip/failure is recorded, never thrown.
     */
    async pushTarget(handle: WorldHandle, target: string): Promise<{ pushed: string[]; skipped: string[] }> {
      const env = { GIT_TERMINAL_PROMPT: '0', ...(await gitEnvFor(handle, handle.id)) };
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
            (await record(handle.id, 'push.done', { repo: r.name, target: repoTarget }));
          } else {
            skipped.push(r.name);
            (await record(handle.id, 'push.failed', { repo: r.name, target: repoTarget, detail: (push.stderr || push.stdout).slice(0, 300) }));
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
          (await record(handle.id, 'push.skipped', { repo: r.name, reason: 'no origin remote' }));
          continue;
        }
        const push = appConnected
          ? await hostGitWithRepositoryCredential(repository, r.repo, ['push', 'origin', repoTarget], env)
          : await world.exec('git', ['push', 'origin', repoTarget], { cwd: r.repo, env });
        if (push.code === 0) {
          pushed.push(r.name);
          (await record(handle.id, 'push.done', { repo: r.name, target }));
        } else {
          skipped.push(r.name);
          (await record(handle.id, 'push.failed', { repo: r.name, target, detail: (push.stderr || push.stdout).slice(0, 300) }));
        }
      }
      return { pushed, skipped };
    },

    async confirmManualPr(taskId: string, userId: string): Promise<boolean> {
      const task = (await store.getTask(taskId));
      if (deps.authorization && !allows((await deps.authorization.capabilities(
        `user:${userId}`, task?.projectId)), 'task:signal')) return false;
      const view = task?.lastView;
      if (view?.stage !== 'review' || view.waitingFor?.kind !== 'human'
        || !view.actions.some((action) => action.name === 'confirm' && action.enabled)
        || !(await store.humanMayAct(taskId, userId))) return false;
      (await recordHumanConfirmation(store, taskId, userId));
      return true;
    },

    async publishView(taskId: string, publication: PublishedView, conversationReference?: string, options?: { separateLifecycle: boolean }): Promise<string | undefined> {
      // WF-27: an attempt that timed out still completes, and a stopped run's
      // last publication can land after its successor's. Drop what the task has
      // already moved past, before it can rewrite the view. A full publication
      // still records its snapshot first: the run's next frames may refer to it.
      let order: ViewPublicationOrder | undefined;
      try {
        const runId = activityContext.current().info.workflowExecution?.runId;
        const revision = runId && conversationReference?.startsWith(`${runId}:`)
          ? Number(conversationReference.slice(runId.length + 1)) : undefined;
        if (runId && typeof publication.updatedAt === 'number')
          order = { runId, seq: publication.updatedAt, ...(Number.isSafeInteger(revision) ? { revision } : {}) };
      } catch { /* direct invocation has no run to order by */ }
      const stale = order !== undefined && (await store.viewPublicationStale(taskId, order));
      if (stale && !(conversationReference && publication.messages !== undefined)) return;
      let view: TaskView;
      if (conversationReference) {
        // Immutable, task-scoped snapshots survive worker restarts and activity
        // retries, including retries after another publication has completed.
        const key = `view-conversation:${taskId}:${conversationReference}`;
        if (publication.messages !== undefined) {
          const json = JSON.stringify({ messages: publication.messages, transcripts: publication.transcripts });
          const existing = (await store.kvGet(key));
          if (existing !== undefined && existing !== json)
            throw ApplicationFailure.nonRetryable('Conversation publication reference was reused', 'view-publication');
          (await store.kvSet(key, json));
          if (stale) return;
        }
        if (!(await store.kvHas(key)) && !(await store.conversationSupersedesReference(taskId, conversationReference))) {
          // A concurrent, newer publication of this run may have replaced and
          // dropped the snapshot since the order check above (DB-2). A stored
          // newer revision of the run makes the snapshot unnecessary: saveView
          // then keeps that conversation and applies this frame's status.
          if (order && (await store.viewPublicationStale(taskId, order))) return;
          throw ApplicationFailure.nonRetryable('Conversation publication snapshot is missing', 'view-publication');
        }
        // The store can reuse the immutable conversation directly in SQL. A
        // status publication must never parse/rewrite the historical transcript.
        view = { ...publication, messages: publication.messages ?? [] };
      } else {
        if (publication.messages === undefined)
          throw ApplicationFailure.nonRetryable('Full view publication requires messages', 'view-publication');
        view = publication as TaskView;
      }
      // A platform lifecycle replacement asks the old workflow to wind down via
      // its cancellation cleanup so turns, children, leases, and worlds settle
      // cleanly. Its final `cancelled` view is an implementation frame, not a
      // logical task state: publishing it briefly hid conversation controls and,
      // more seriously, fired terminal side effects (auto-archive, output pruning,
      // dependency/collaboration settlement) before the successor run started.
      //
      // Keep this compatibility guard in the activity boundary: activity code may
      // change without replaying immutable workflow histories, so already-running
      // v1.22 executions receive the repair too.
      if (view.status === 'cancelled') {
        let runId: string | undefined;
        try { runId = activityContext.current().info.workflowExecution?.runId; }
        catch { /* direct activity invocation in tests */ }
        const key = lifecycleReplacementKey(taskId);
        if (lifecycleReplacementMatches((await store.kvGet(key)), runId)) return;
      }
      // A replacement paused for human input first publishes its bootstrap
      // frame, before setting waitingFor. That is not a real resumption: the
      // humanPauseOrigin marker remains until the hold actually wakes. Publishing
      // it deletes the live escalation and recreates it at normal urgency on the
      // next frame (Task 201). It can also overwrite the platform's audience
      // before task.escalated is routed. Suppress only this transient frame at
      // the activity boundary so existing workflow histories receive the fix.
      // Persist conversation snapshots above even for suppressed frames: the
      // next publication may reference the same immutable snapshot.
      if (view.state?.humanPauseOrigin && view.status === 'active' && !view.waitingFor) return;
      if ((await timingEnabled(store))) {
        let workflowRunId: string | undefined;
        try { workflowRunId = activityContext.current().info.workflowExecution?.runId; } catch { /* direct call */ }
        const previousView = (await store.taskMetadata(taskId))?.lastView;
        const accountBefore = previousView?.waitingFor?.kind === 'account';
        const accountAfter = view.waitingFor?.kind === 'account';
        if (accountBefore !== accountAfter) {
          const trace = (await installationTiming(store, { taskId, workflowRunId, role: view.agentTurn?.role }, async row => (await record(taskId, 'timing', { ...row }))));
          (await trace.mark(accountAfter ? 'account.wait.observed.start' : 'account.wait.observed.end'));
        }
        const before = previousView?.agentTurn;
        const after = view.agentTurn;
        if (before?.turnId !== after?.turnId || before?.state !== after?.state) {
          const trace = (await installationTiming(store, { taskId, workflowRunId, turnId: after?.turnId ?? before?.turnId,
            role: after?.role ?? before?.role }, async row => (await record(taskId, 'timing', { ...row }))));
          (await trace.mark(`queue.observed.${after?.state ?? 'released'}`));
        }
      }
      if (!(await store.saveView(taskId, view, conversationReference, order))) return;
      await notifyChildSettlement(store, deps.client, view);
      if (view.status === 'done' || view.status === 'cancelled' || view.status === 'failed') {
        let runId: string | undefined;
        try { runId = activityContext.current().info.workflowExecution?.runId; } catch { /* direct call */ }
        await store.clearTurnCheckpoints(taskId, runId);
      }
      // First Merge admission freezes whether sibling proposals remain eligible.
      // Branch integration still uses the ordinary merge queue and validation.
      if (view.stage === 'merge') {
        const claim = (await store.claimAttempt(taskId));
        for (const siblingId of claim.cancel) {
          const sibling = (await store.getTask(siblingId));
          if (sibling?.params.draft) {
            (await store.markDraftSuperseded(siblingId, taskId));
            continue;
          }
          await deps.client?.workflow.getHandle(siblingId).signal('cancel').catch(() => undefined);
        }
        if (!claim.accepted) throw ApplicationFailure.nonRetryable('Another attempt cancelled this proposal at Merge admission', 'attempt-superseded');
      }
      const publicationSeq = (await record(taskId, 'view.updated', {
        stage: view.stage,
        status: view.status,
        waitingFor: view.waitingFor?.kind ?? null,
        waitingDetail: view.waitingFor?.detail ?? null,
        waitingSummary: view.waitingFor?.summary ?? null,
        waitingProvider: view.waitingFor?.provider ?? null,
        waitingResetAt: view.waitingFor?.earliestResetAt ?? null,
        agentTurn: view.agentTurn?.state ?? null,
        agentRole: view.agentTurn?.role ?? null,
      }));
      let fence = `${publicationSeq}:${newId('publication')}`;
      // Legacy publishView performs maintenance inline. Its retry must retain
      // the FIRST publication's message boundary, including replies accepted
      // before the worker restarted. Claim atomically for overlapping attempts.
      let publicationKey: string | undefined;
      try {
        const { workflowExecution, activityId } = activityContext.current().info;
        if (workflowExecution) publicationKey = `view-publication-fence:${taskId}:${workflowExecution.runId}:${activityId}`;
      } catch { /* direct invocation has no retry identity */ }
      if (publicationKey) {
        await store.kvClaim(publicationKey, fence);
        fence = (await store.kvGet(publicationKey))!;
      }
      (await store.kvSet(`view-lifecycle:${taskId}`, fence));
      if (options?.separateLifecycle) return fence;
      await maintainWaitingWorld(taskId, view, fence, false);

    },

    async parkWaitingWorld(taskId: string, view: LifecyclePublication, fence: string): Promise<void> {
      let ctx: ReturnType<typeof activityContext.current> | undefined;
      try { ctx = activityContext.current(); } catch { /* direct tests */ }
      ctx?.heartbeat({ phase: 'waiting-world' });
      const timer = ctx ? setInterval(() => ctx!.heartbeat({ phase: 'waiting-world' }), 5_000) : undefined;
      try { await maintainWaitingWorld(taskId, view, fence); }
      finally { if (timer) clearInterval(timer); }
    },

    async recordEvent(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
      (await record(taskId, type, payload));
    },

    async prepareChildTask(args: PrepareChildArgs): Promise<TaskInput> {
      const parent = (await store.getTask(args.parentTaskId));
      const currentProject = (await store.getProject(args.projectId));
      const project = currentProject ? (await store.effectiveProjectConfig(currentProject)) : args.project;
      const parentHandle = (await store.currentWorld(args.parentTaskId)) as WorldHandle | undefined;
      if (parentHandle && isRemote(parentHandle.kind)) {
        const parentWorld = await openWorld(parentHandle);
        await enrollLiveProjectRepositories(parentWorld, args.parentTaskId);
        const persisted = await publishTaskBranch(parentWorld, args.parentTaskId);
        if (!persisted.pushed.length || persisted.skipped.length)
          throw new Error(`could not seed the parent branch for the child task${persisted.skipped.length ? `: ${describePublishFailures(persisted)}` : ''}`);
        (await record(args.parentTaskId, 'push.branch', {
          branch: parentWorld.handle.branch, repos: persisted.pushed, reason: 'subtask-bootstrap',
        }));
      }
      let idempotencyKey: string | undefined;
      try {
        const { info } = activityContext.current();
        if (info.workflowExecution) idempotencyKey = `${args.parentTaskId}:${info.workflowExecution.runId}:${info.activityId}`;
      } catch { /* Direct calls represent distinct requests. */ }
      let child = (await store.createTask({
        projectId: args.projectId,
        idempotencyKey,
        listId: parent?.listId,
        title: args.title,
        workflow: 'software-dev',
        workflowVersion: parent?.workflowVersion ?? '1.0.0',
        params: { prompt: args.prompt, base: args.base, target: args.target,
          [REPOSITORY_BRANCHES_RESOLVED_PARAM]: true },
        parentTaskId: args.parentTaskId,
        createdBy: { kind: 'task-agent', taskId: args.parentTaskId, role: 'do' },
        assignee: { kind: 'task-agent', taskId: args.parentTaskId, role: 'do' },
      }));
      (await record(args.parentTaskId, 'subtask.created', { childTaskId: child.id, title: args.title }));
      // Least-privilege grant (SPEC §8.2): the child's delegation caps are attenuated
      // by the parent's own grant, and its merge cap is scoped to EXACTLY the parent's
      // branch (which the parent owns and merges into). If no branch is known,
      // the child gets no merge capability — never a broad fallback.
      let currentGrant = [
        ...((parent?.params?._authorization as { capabilities?: string[] } | undefined)?.capabilities ?? args.parentGrant ?? []),
        ...await new PermissionRequests(store, currentProject?.organizationId ?? 'org_personal').extensionCaps(args.parentTaskId, 'do'),
      ];
      const authorizer = (parent?.params?._authorization as { principal?: string } | undefined)?.principal;
      const parentAvatarId = (parent?.params?.['agent:do'] as { avatarId?: string } | undefined)?.avatarId
        ?? (authorizer?.startsWith('avatar:') ? authorizer.slice(7) : undefined);
      if (parentAvatarId) {
        const avatar = await store.getAvatar(parentAvatarId);
        currentGrant = attenuate(currentGrant, avatar
          ? await avatarAuthorizationCapabilities(store, deps.authorization, avatar, args.projectId) : []);
      }
      const delegation = attenuate(CHILD_TASK_CEILING, currentGrant);
      const mergeBack = args.parentBranch && allows(currentGrant, `merge-into:${args.parentBranch}`)
        ? [`merge-into:${args.parentBranch}`] : [];
      const grant = [...delegation, ...mergeBack];
      const parentAuthorization = parent?.params?._authorization as { delegationId?: string } | undefined;
      const humanDelegation = parentAuthorization?.delegationId && deps.tokens
        ? (await deps.tokens.deriveHumanDelegation(parentAuthorization.delegationId, {
            taskId: child.id, projectId: args.projectId,
            organizationId: (await store.getProject(args.projectId))?.organizationId,
          }))
        : undefined;
      (await store.updateTaskParams(child.id, {
        ...child.params,
        _authorization: { profileId: 'inherited-child', principal: `task:${args.parentTaskId}`,
          capabilities: grant, attenuated: true, ...(humanDelegation ? { delegationId: humanDelegation.id } : {}) },
        ...(humanDelegation?.externalIdentities?.githubAccountId
          ? { _githubAccountId: humanDelegation.externalIdentities.githubAccountId } : {}),
      }));
      child = (await store.getTask(child.id))!;
      return {
        taskId: child.id,
        projectId: args.projectId,
        title: args.title,
        prompt: args.prompt,
        base: args.base,
        target: args.target,
        parentTaskId: args.parentTaskId,
        project,
        profiles: args.profiles,
        resolveAgentEnabled: args.resolveAgentEnabled,
        grant,
        grantPrincipal: `task:${args.parentTaskId}`,
        delegationId: humanDelegation?.id,
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
      const wf = (await store.getTask(args.taskId))?.workflow;
      const rules = wf ? manifest(wf)?.resolveRules : undefined;
      // A typed provider failure has already been classified at the adapter boundary;
      // do not discard that ground truth and re-interpret provider prose here.
      const r = args.limit?.limited
        ? { resolved: true, action: 'retry' as const, note: 'provider account unavailable — retrying without a Resolve agent' }
        : runAutoResolve(args.stage, args.error, rules);
      (await record(args.taskId, 'resolve.auto', {
        stage: args.stage,
        resolved: r.resolved,
        action: r.action,
        source: args.limit?.limited ? 'provider-metadata' : 'message-rule',
        ...(args.limit?.kind ? { failureKind: args.limit.kind } : {}),
        ...(args.limit?.provider ? { provider: args.limit.provider } : {}),
        ...(args.limit?.window ? { window: args.limit.window } : {}),
        ...(args.limit?.resetHint ? { resetHint: args.limit.resetHint } : {}),
        ...(args.limit?.diagnostic ? { diagnostic: args.limit.diagnostic } : {}),
      }));
      return r;
    },

    /** Used by the gateway-side too; generates ids deterministically off the worker. */
    async newTaskId(): Promise<string> {
      return newId('task');
    },
  };
}

/** Installation-side authorization boundary for platform-funded model calls.
 * Values are worst-case micro-dollar debits per admitted request, keyed by
 * `provider/model`, `provider/*`, or `provider`. Invalid/absent configuration
 * fails managed admission closed and never affects BYOK. */
function managedModelRailAvailable(
  hosted: boolean,
  policy: { managedSpendCapMicros?: number | null; managedModelProviders: string[] },
  profile: import('../domain/types.js').AgentProfile,
): boolean {
  const provider = canonicalModelProvider(credentialProvider(profile));
  return hosted && !!policy.managedSpendCapMicros && policy.managedModelProviders.includes(provider)
    && !!managedModelCostCeiling(provider, profile.model)
    && ((profile.provider === 'claude' && !!process.env.ANTHROPIC_API_KEY)
      || (profile.provider === 'codex' && !!process.env.OPENAI_API_KEY)
      || (profile.provider === 'opencode' && !!process.env[apiKeyEnv(provider)]));
}

function managedModelCostCeiling(provider: string, model?: string): number | undefined {
  const raw = process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS;
  if (!raw) return undefined;
  let values: Record<string, unknown>;
  try { values = JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; }
  const value = values[`${provider}/${model ?? '*'}`] ?? values[`${provider}/*`] ?? values[provider];
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

type PriceableUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokensIncludeCacheRead?: boolean;
} | undefined;

/** Actualize an active managed reservation from provider token counters. If the
 * installation has no complete price for the counters returned, retain the
 * admission ceiling as an explicitly estimated charge so completed requests
 * can never bypass the monthly hard cap. */
function managedModelActualCost(provider: string, model: string | undefined, usage: PriceableUsage,
  reservationMicros: number): { costMicros: number; classification: 'incurred' | 'estimated'; metadata: Record<string, unknown> } {
  const raw = process.env.KARMAX_MANAGED_MODEL_PRICING;
  let values: Record<string, unknown> = {};
  try { values = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* estimate below */ }
  const keys = [`${provider}/${model ?? '*'}`, `${provider}/*`, provider];
  const pricingKey = keys.find((key) => values[key] && typeof values[key] === 'object');
  const pricing = pricingKey ? values[pricingKey] as Record<string, unknown> : undefined;
  if (usage && pricing) {
    const cacheReadTokens = Math.max(0, Number(usage.cacheReadTokens ?? 0));
    const cacheWriteTokens = Math.max(0, Number(usage.cacheWriteTokens ?? 0));
    const inputTokens = Math.max(0, Number(usage.inputTokens ?? 0));
    const outputTokens = Math.max(0, Number(usage.outputTokens ?? 0));
    const uncachedInputTokens = usage.inputTokensIncludeCacheRead
      ? Math.max(0, inputTokens - cacheReadTokens) : inputTokens;
    const rate = (name: string, tokens: number): number | undefined => {
      if (!tokens) return 0;
      const value = Number(pricing[name]);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const inputRate = rate('inputMicrosPerMillionTokens', uncachedInputTokens);
    const outputRate = rate('outputMicrosPerMillionTokens', outputTokens);
    const cacheReadRate = rate('cacheReadMicrosPerMillionTokens', cacheReadTokens);
    const cacheWriteRate = rate('cacheWriteMicrosPerMillionTokens', cacheWriteTokens);
    if ([inputRate, outputRate, cacheReadRate, cacheWriteRate].every((value) => value != null)) {
      const costMicros = Math.ceil((uncachedInputTokens * inputRate! + outputTokens * outputRate!
        + cacheReadTokens * cacheReadRate! + cacheWriteTokens * cacheWriteRate!) / 1_000_000);
      if (Number.isSafeInteger(costMicros)) return { costMicros, classification: 'incurred', metadata: {
        costBasis: 'configured-provider-token-pricing', pricingKey, uncachedInputTokens, outputTokens,
        cacheReadTokens, cacheWriteTokens,
      } };
    }
  }
  return { costMicros: reservationMicros, classification: 'estimated', metadata: {
    costBasis: 'admission-ceiling-estimate', estimateReason: usage ? 'incomplete-model-pricing' : 'provider-usage-unavailable',
  } };
}

export type coreActivities = ReturnType<typeof makeCoreActivities>;
