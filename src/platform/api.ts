import { randomUUID } from 'node:crypto';
import { timingEnabled, installationTiming, timingReport } from '../timing/index.js';
import { requireHumanSubject } from './identity.js';
import { expectedTaskRemoteHeads, recordTaskPublication } from '../world/publication.js';
import { recordHumanConfirmation } from './review-confirmation.js';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError, type Client } from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { Store, type CollaborationRequest } from '../store/db.js';
import { TokenAuthority, type HumanDelegationArgs, type ScopedToken } from './tokens.js';
import { TOOL_CAPABILITY, Capability, allows } from './capabilities.js';
import { WORKFLOW_TYPE, SIG, pinnedType } from '../workflows/names.js';
import { bundledStart, StartResolution } from './resolve-start.js';
import { MANIFESTS, WorkflowManifest, eventCatalog } from '../contrib/manifests.js';
import { organizationSkillsDir } from '../resolve/skills.js';
import { validGitBranch } from '../util/git-ref.js';
import type { WorkflowManager, WorkflowSummary } from '../packages/manager.js';
import {
  mergeQueueId,
  agentQueueId,
  accountCoordinatorId,
  SIG_CANCEL_MERGE,
  SIG_CANCEL_AGENT,
  SIG_CANCEL_ACCOUNT,
  SIG_PRIORITIZE,
  SIG_REORDER,
  SIG_SET_AGENT_CAPACITY,
  QRY_AGENT_QUEUE,
  QRY_ACCOUNT_TASK_LEASES,
  QRY_ACCOUNT_LEASE,
  MERGE_QUEUE_WORKFLOW,
  AGENT_QUEUE_WORKFLOW,
} from '../coordinators/names.js';
import { TaskRecord, TaskView, Message, Project, TaskInput, ImageRef, FileRef, Tag, SavedView, TaskQuery, AgentRole, AgentSpec, FieldSpec, Provider, PrincipalRef, ConfirmationPolicy, OrganizationExecutionPolicy, Stage, StageTransition, TaskRecoveryCheckpoint, AuthorizationSelection, mergeQueueDomains, Urgency, DEFAULT_URGENCY, normalizeUrgency, remotePolicyOf, ResourceAccess, ResourceTarget } from '../domain/types.js';
import { hasActiveTriggers, cloneParamsWithoutTriggers, normalizeTriggers, validateTriggers, forcesRepeatable } from '../domain/triggers.js';
import { evaluateQuery, fieldCatalogue, tagPath, EvalResult } from '../domain/search.js';
import { parseQuery } from '../domain/query-language.js';
import { resolveParamsLayers, assembleTaskInput, projectSettingsFor, globalSettingsFor, quickProjectSettingsFor, quickGlobalSettingsFor, effectiveRepos, ValueMap } from './params.js';
import { REPOSITORY_BRANCHES_RESOLVED_PARAM, repositoryBranchDefaults } from './branch-defaults.js';
import { withTimeout } from '../util/timeout.js';
import path from 'node:path';
import fs from 'node:fs';
import { paths } from '../config/paths.js';
import { defaultProvider } from '../agent/adapters.js';
import { MAX_FILE_BYTES, MAX_FILES_BYTES_PER_MESSAGE, MAX_FILES_PER_MESSAGE, sanitizeAttachmentName } from '../store/attachments.js';
import { WikiScope, wikiRoot, listWiki, readWikiPage, writeWikiPage, deleteWikiPage, moveWikiPage, collectDefaultPages, isDefaultDelivered, searchWiki, suggestWiki, safeWikiPath, parseFrontmatter, renderWikiToc, resolveBuiltins, BUILTIN_WIKI_ENTRIES, BUILTIN_WIKI_PREFIX } from '../wiki/wiki.js';
import { commitProjectWiki, ensureProjectWikiRepository, mutateAndPublishProjectWiki, projectWikiBranches, projectWikiBranchView, PROJECT_WIKI_BRANCH } from '../wiki/repository.js';
import { applyAgentSpec, defaultModel, defaultEffort, ProfileResolver, roleDefaultProfile } from '../agent/profiles.js';
import { looksLikeConversationUrl, publicConversationShare } from '../agent/panagent.js';
import { hostLocal as deploymentHostLocal } from '../config/deployment.js';
import { AuthorizationGrantError, type AuthorizationService } from './authorization.js';
import { PermissionRequests, exactCapability, type PermissionRequest } from './permission-requests.js';
import { AuthorizationRequests, type AuthorizationRequest } from './authorization-requests.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';
import { confirmLayersOf } from '../domain/confirm.js';
import type { KarmaxBus } from '../contrib/bus.js';
import type { WorldRegistry } from '../world/registry.js';
import type { WorldHandle } from '../world/types.js';
import { worldRepos, worldRepoSource } from '../world/types.js';
import { brokerImportTaskBranch, brokerPublishBranch, brokerRefreshUpstream, describePublishFailures, type GitBrokerAuth } from '../world/git-broker.js';
import { sameRepository } from '../world/repository-identity.js';
import { forkWorldSource, type ForkWorldSource } from '../world/fork.js';
import { enrollWorldRepositories } from '../world/repository-enrollment.js';
import { ensureTaskBranchAncestry } from '../world/task-branch.js';
import type { WorldAccessService } from '../world/access.js';
import type { RunnerPoolService } from '../world/runners.js';
import { VaultItems, type VaultItemPolicy, type VaultTaskPolicyOverrides } from '../autonomy/vault-items.js';
import { itemHandle } from '../autonomy/vault-items.js';
import { applyAvatarProfile, avatarAuthorizationCapabilities, avatarCallableBy, avatarEnabled } from './avatars.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { ProjectResourceService } from '../world/resources.js';
import { lifecycleReplacementKey } from './lifecycle-replacement.js';
import type { GithubActionsStatus, GithubActionsInspectOptions } from '../integrations/github-actions.js';

export class CapabilityError extends Error {
  code = 'capability_denied';
  /** HTTP status the gateway answers with. Kept on the class so one mapping in
   *  `Gateway.fail` covers every route instead of each handler wrapping locally. */
  status = 403;
}

/**
 * A named identifier did not resolve. An agent has to be able to tell this from
 * a denial (escalate) and from a server fault (back off) — `no such task <id>`
 * used to reach the client as a 500, which reads as "karmax is broken" rather
 * than "you passed the wrong id".
 */
export class NotFoundError extends Error {
  code = 'not_found';
  status = 404;
}

/** Caller-supplied input was rejected. A 400, never a 500. */
export class ValidationError extends Error {
  code = 'invalid_request';
  status = 400;
}

/**
 * The dispatcher hook (SPEC §3.3). A triggered task is stored-not-started and
 * *armed* through this so the in-process scheduler can start it when a trigger
 * fires. Kept structural (not an import) so the API doesn't depend on the
 * scheduler, and so tests can pass a fake. Optional everywhere: with no armer
 * wired, triggered tasks are simply held as armed rows and picked up on the next
 * boot's re-arm (the store is the durable source of truth).
 */
export interface TriggerArmer {
  arm(task: TaskRecord): void;
  disarm(taskId: string): void;
  /** Graph-aware validation (self-dependency, cycles, dangling dependency ids).
   *  Only the armer can do this half — it needs the store to resolve dependency
   *  ids — so `armStoredTask` asks for it before mutating anything. */
  validationErrors?(task: TaskRecord): string[];
}

const firstLine = (s: string) => (s.split('\n')[0] ?? 'Task').slice(0, 80) || 'Task';
// Human-facing stage names. `do` is the replay-stable internal key; a person
// reads it as "Working" (the console's stageLabel says the same).
const stageName = (stage: string) => stage === 'human'
  ? 'Waiting for human input'
  : stage === 'do' ? 'Working'
    : stage.charAt(0).toUpperCase() + stage.slice(1);
const agentSnapshotKey = (taskId: string) => `task-agents:${taskId}`;
const wikiFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file);
      else out.push(file);
    }
  };
  walk('');
  return out;
};

function principalRefOf(principal: string, kind?: 'agent' | 'human' | 'system'): PrincipalRef | undefined {
  if (principal.startsWith('user:')) return { kind: 'user', userId: principal.slice(5) };
  if (principal.startsWith('avatar:')) return { kind: 'avatar', avatarId: principal.slice(7) };
  const taskAgent = principal.match(/^task-agent:([^:]+):(.+)$/);
  if (taskAgent) return { kind: 'task-agent', taskId: taskAgent[1]!, role: taskAgent[2]! };
  // Older callers used the bare user id as the token principal. Token kind is
  // authoritative here; retain that human provenance so @creator remains a
  // useful route for migrated installations and API clients.
  return kind === 'human' ? { kind: 'user', userId: principal } : undefined;
}

/** Deepest cause message — unwraps Temporal's WorkflowUpdateFailedError → the
 *  validator's ApplicationFailure so the user sees the real "why". */
function unwrapCause(e: unknown): string {
  let cur: any = e;
  let msg = e instanceof Error ? e.message : String(e);
  for (let i = 0; cur && i < 8; i++) {
    if (typeof cur.message === 'string' && cur.message) msg = cur.message;
    cur = cur.cause;
  }
  return msg;
}

/** How long to wait on a live workflow query before falling back to the snapshot. */
const QUERY_TIMEOUT_MS = 3000;

/**
 * How long to wait for the durable engine to *accept* a new workflow before we
 * give up. A healthy server accepts in well under a second; this only trips when
 * Temporal is wedged/unreachable — in which case we surface a real error and undo
 * the task row instead of hanging the request and stranding an orphan task (the
 * "clicked queue, nothing happened, pile of tasks stuck at setup" failure mode).
 */
const START_TIMEOUT_MS = 12_000;

/**
 * Which workflows can start a replacement run from a failed execution's
 * persisted world/conversation checkpoint.
 *
 * `goal` belongs here and used to be excluded by a bare `=== 'software-dev'`
 * string test: every `goalV1_x` delegates to the matching `softwareDevV1_x`, so
 * `input.recovery` was already fully supported and only the check rejected it.
 * The exclusion also caught a task *created* as software-dev and switched to
 * Goal in flight — `changeWorkflow` persists the new name, so its recovery
 * controls silently vanished mid-task. Matches the `resumable` predicate below.
 *
 * `merge-only` is deliberately NOT here: `recoverFailedTask` injects a
 * "continue from the existing worktree" message and reads `session:<id>:do`,
 * and merge-only has no Do agent to resume. Adding it needs that assumption
 * removed first, not just a name in this set.
 */
const RECOVERABLE_WORKFLOWS = new Set(['software-dev', 'goal']);

/**
 * Reject a queue reorder aimed at a domain this task does not hold.
 *
 * A multi-repo task takes ONE merge slot PER REPO, so the check has to be
 * against the whole set. Views published before software-dev@1.9.0 / merge-only
 * @1.5.0 carry only `mergeDomain` — the *first* domain — which made this guard
 * reject a perfectly legitimate request to reorder any later one. So the
 * complete `mergeDomains` list wins when present, and the known-partial singular
 * is treated as evidence of membership rather than an exclusive whitelist: a
 * mismatch there falls through to the coordinator, which is authoritative and
 * safely no-ops when the task is not actually queued in that domain.
 */
function assertInMergeDomain(task: TaskRecord, domain: string): void {
  const state = task.lastView?.state as { mergeDomain?: unknown; mergeDomains?: unknown } | undefined;
  const all = Array.isArray(state?.mergeDomains) ? (state!.mergeDomains as string[]) : undefined;
  if (all && !all.includes(domain)) throw new Error('task is not in that merge queue domain');
}


/** A failed execution is terminal, but a recoverable workflow can start a
 * replacement run from its persisted world/conversation checkpoint. These mirror
 * escalation's controls; signalTask gives them terminal-aware semantics. */
const RETRY_ACTION = (): TaskView['actions'][number] =>
  ({ name: 'retry', kind: 'signal', label: 'Retry', enabled: true });

const FAILED_RECOVERY_ACTIONS = (): TaskView['actions'] => [
  RETRY_ACTION(),
  {
    name: 'followUp',
    kind: 'signal',
    label: 'Send follow-up',
    enabled: true,
    args: [{ name: 'text', type: 'text', label: 'Message', required: true }],
  },
  { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true },
];

const FOLLOW_UP_ACTION = (role?: AgentRole): TaskView['actions'][number] => ({
  name: 'followUp',
  kind: 'signal',
  label: 'Send follow-up',
  enabled: true,
  args: [{ name: 'text', type: 'text', label: 'Message', required: true }],
  ...(role ? { roles: [role] } : {}),
});

const GOAL_RESUME_MESSAGE =
  'Workflow switched to Goal. Continue autonomously until the entire task is complete; do not stop after partial progress.';

type CollaborationTargetIssue = {
  admission: string;
  result: string;
};

/**
 * Whether a target can still satisfy a background agent action. Keep this
 * classification shared by admission, live event routing, and startup repair:
 * otherwise one path can accept a request that another path will never settle.
 *
 * PR/Merge are admission-only failures. A request accepted while the target was
 * still in Do may legitimately observe PR before the platform emits the
 * succeeding push.branch event, so an in-flight request waits for that push or
 * a genuinely terminal/blocked state.
 */
function collaborationTargetIssue(
  view: Pick<TaskView, 'stage' | 'status' | 'pointOfNoReturnPassed'> | undefined,
  phase: 'admission' | 'pending',
): CollaborationTargetIssue | undefined {
  if (!view) return undefined;
  if (view.status === 'done' || view.stage === 'done') return {
    admission: 'target task is already done',
    result: 'target task completed without publishing its branch',
  };
  if (view.status === 'cancelled' || view.stage === 'cancelled') return {
    admission: 'target task is already cancelled',
    result: 'target task became cancelled',
  };
  if (view.status === 'failed' || view.stage === 'failed') return {
    admission: 'target task is already failed',
    result: 'target task became failed',
  };
  if (view.status === 'blocked' || view.stage === 'escalated') return {
    admission: 'target task is blocked and cannot run its Do agent; resume it before requesting collaboration',
    result: 'target task became blocked before publishing its branch',
  };
  if (phase === 'admission'
    && (view.pointOfNoReturnPassed || view.stage === 'pr' || view.stage === 'merge')) return {
      admission: 'target task has passed its agent-work stage and can no longer publish on request',
      result: 'target task passed its agent-work stage without publishing its branch',
    };
  return undefined;
}

function collaborationTargetIssueFromViewEvent(
  payload: unknown,
  current?: TaskView,
): CollaborationTargetIssue | undefined {
  const event = (payload ?? {}) as { stage?: unknown; status?: unknown };
  if (!current && (typeof event.stage !== 'string' || typeof event.status !== 'string')) return undefined;
  return collaborationTargetIssue({
    stage: typeof event.stage === 'string' ? event.stage as Stage : current!.stage,
    status: typeof event.status === 'string' ? event.status as TaskView['status'] : current!.status,
    pointOfNoReturnPassed: current?.pointOfNoReturnPassed,
  }, 'pending');
}

export interface KarmaxApiDeps {
  store: Store;
  client: Client;
  taskQueue: string;
  tokens: TokenAuthority;
  contentDir?: string;
  /**
   * Optional workflow-package manager (§21d). When present, tasks can run
   * installed (git-loaded) workflows and `installWorkflow`/`listWorkflows` work;
   * when absent the API serves only the built-in workflows (unchanged behavior).
   */
  workflows?: WorkflowManager;
  authorization?: AuthorizationService;
  /** Provider selected by the host/harness; avoids re-detecting ambient creds. */
  defaultAgentProvider?: Provider;
  /** Enforce hosted control-plane invariants without consulting mutable ambient env. */
  hosted?: boolean;
  /** Gate host-filesystem affordances without consulting mutable ambient env. */
  hostLocal?: boolean;
  /** Organization-scoped cloud provider credentials. Kept optional for the
   * small unit-test API harnesses; production always supplies it. */
  providerConnections?: import('../world/connections.js').WorldProviderConnectionService;
  /** World access for permission-checked collaboration tools. */
  worlds?: WorldRegistry;
  worldAccess?: WorldAccessService;
  /** Durable execution-capacity leases. Production always supplies this; small
   * unit harnesses may omit it and still get direct store-level release. */
  runners?: RunnerPoolService;
  resources?: ProjectResourceService;
  broker?: CredentialBroker;
  githubApp?: import('../integrations/github-app.js').GitHubAppService;
  /** Wake live gateway subscribers when platform-side actions append events. The
   * durable event table remains the source of truth when this is absent. */
  bus?: KarmaxBus;
  /** Re-arm eligible automatic credential quarantines before replaying a credential
   * escalation. Production supplies this; lightweight API tests may omit it. */
  refreshCredentialHealth?: (task: TaskRecord, provider?: string) => Promise<void>;
}

/**
 * The single service layer agents and humans act through. Both the gateway
 * (HTTP, for users) and the platform MCP server (for agents) translate into
 * these calls; every call is capability-checked against a scoped token (§8.3),
 * so authz lives in exactly one place.
 */
export class KarmaxApi {
  private resolvingPermissions = new Set<string>();
  /** A workflow id can have several unrelated runs after a lifecycle recovery.
   * Temporal's id-only handle may resolve an earlier closed run; replacements
   * persist their exact run id so every later query/signal targets the live run. */
  private workflowHandle(taskId: string): any {
    const runId = this.deps.store.getTask(taskId)?.params?._workflowRunId;
    return this.deps.client.workflow.getHandle(taskId,
      typeof runId === 'string' && runId ? runId : undefined);
  }

  private armer?: TriggerArmer;
  private collaborationNotificationRetries = new Map<string, number>();
  constructor(private deps: KarmaxApiDeps) {
    deps.bus?.onAny((event) => {
      void this.routeCollaborationEvent(event).catch(() => {
        // Settlement is durable and startup reconciliation retries notification.
      });
    });
    queueMicrotask(() => {
      void this.reconcileCollaborationRequests().catch(() => {
        // Temporal may still be coming up. The next relevant event retries this,
        // and unnotified settlements remain durable in SQLite.
      });
    });
  }

  /** Attach the trigger dispatcher after construction (resolves the ctor cycle). */
  setTriggerArmer(armer: TriggerArmer) {
    this.armer = armer;
  }

  private collaborationTask(token: string, tool: 'publish_task_branch' | 'import_task_branch' | 'refresh_upstream') {
    const caller = this.require(token, tool);
    if (!caller.taskId || caller.taskId === '*') throw new CapabilityError(`${tool} requires a task-agent token`);
    const task = this.deps.store.getTask(caller.taskId);
    if (!task) throw new Error('calling task not found');
    const project = this.deps.store.getProject(task.projectId);
    if (!project?.organizationId) throw new Error('calling task project is unavailable');
    const handle = (this.deps.store.currentWorld(task.id) ?? task.lastView?.world) as WorldHandle | undefined;
    if (!handle) throw new Error('calling task has no recoverable world');
    return { task, project, handle };
  }

  private gitBrokerAuth(projectId: string): GitBrokerAuth {
    const linked = this.deps.store.listProjectRepositories(projectId);
    const wiki = this.deps.store.projectWiki(projectId)?.repository;
    return async (repo) => {
      if (!this.deps.githubApp) throw new Error('Connect GitHub in organization settings, then try again.');
      const source = worldRepoSource(repo);
      const repository = linked.find((candidate) => sameRepository(candidate.repository.sshUrl, source))?.repository
        ?? (wiki && sameRepository(wiki.sshUrl, source) ? wiki : undefined);
      if (!repository) throw new Error(`repository is not enrolled in this project: ${repo.repo}`);
      return this.deps.githubApp!.brokerCredentials(repository);
    };
  }

  /** Reconcile a live world against the project's current repository
   * attachments. Project metadata is deliberately live while a workflow input
   * is a replay-safe snapshot, so collaboration operations must close that gap
   * before they can truthfully claim every checkout was published/imported. */
  private async enrollProjectRepositories(task: TaskRecord, world: import('../world/types.js').World): Promise<string[]> {
    const linked = this.deps.store.listProjectRepositories(task.projectId);
    const added = await enrollWorldRepositories(world, linked, this.gitBrokerAuth(task.projectId), async (enrolled) => {
      const current = (this.deps.store.currentWorld(task.id) ?? world.handle) as WorldHandle;
      const durable = this.deps.store.updateWorldCheckouts(current, world.handle.repos!);
      world.handle = durable as WorldHandle;
      const event = { taskId: task.id, type: 'world.repository-enrolled', ts: Date.now(), payload: {
        repo: enrolled.name, source: worldRepoSource(enrolled), branch: enrolled.branch,
      } };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
    });
    return added.map((repo) => repo.name);
  }

  /** Attach a repository and, for a live task-agent caller, atomically enroll
   * it into that task's already-provisioned world. A failed enrollment restores
   * the previous project metadata instead of leaving a checkout the task can
   * see but neither use nor publish. */
  async attachProjectRepository(token: string, input: {
    projectId: string; repositoryId: string; baseBranch?: string; targetBranch?: string; order?: number;
  }) {
    const project = this.deps.store.getProject(input.projectId);
    if (!project) throw new NotFoundError('project not found');
    const caller = this.require(token, 'repository:write', {
      projectId: input.projectId, organizationId: project.organizationId,
    });
    const previous = this.deps.store.listProjectRepositories(input.projectId)
      .find((candidate) => candidate.repositoryId === input.repositoryId);
    const attached = this.deps.store.attachProjectRepository(input);
    const task = caller.actor.kind === 'task-agent' ? this.deps.store.getTask(caller.actor.taskId) : undefined;
    const handle = task?.projectId === input.projectId
      ? this.deps.store.currentWorld(task.id) as WorldHandle | undefined
      : undefined;
    if (!task || !handle) return attached;
    try {
      const access = await this.openCollaborationWorld(task.id, handle);
      try {
        const enrolled = await this.enrollProjectRepositories(task, access.world);
        return { ...attached, ...(enrolled.length ? { enrollment: { taskId: task.id, checkouts: enrolled } } : {}) };
      } finally { await access.release(); }
    } catch (error) {
      if (previous) this.deps.store.attachProjectRepository({
        projectId: previous.projectId,
        repositoryId: previous.repositoryId,
        baseBranch: previous.baseBranch,
        targetBranch: previous.targetBranch,
        order: previous.order,
      });
      else this.deps.store.detachProjectRepository(input.projectId, input.repositoryId);
      throw new Error(`repository attachment was rolled back because the running task checkout could not be enrolled: ${unwrapCause(error)}. Retry the task after fixing the repository or world configuration.`);
    }
  }

  private async openCollaborationWorld(taskId: string, handle: WorldHandle) {
    if (this.deps.worldAccess) return this.deps.worldAccess.open(taskId, handle);
    if (!this.deps.worlds) throw new Error('world access is unavailable');
    return { world: await this.deps.worlds.open(handle), handle, release: async () => {} };
  }

  private collaborationCaller(token: string) {
    const caller = this.require(token, 'request_agent_action');
    if (!caller.taskId || caller.taskId === '*')
      throw new CapabilityError('request_agent_action requires a task-agent token');
    const task = this.deps.store.getTask(caller.taskId);
    if (!task) throw new Error('calling task not found');
    return task;
  }

  /**
   * Register work with another task without synchronously waiting for it. The
   * requester workflow records the durable request before the target is nudged;
   * at its turn boundary it can therefore park without racing a fast publish.
   */
  async requestAgentAction(token: string, input: {
    taskId: string;
    role?: string;
    action: 'publish_branch';
    message?: string;
  }): Promise<CollaborationRequest> {
    const requester = this.collaborationCaller(token);
    const target = this.deps.store.getTask(input.taskId);
    if (!target || target.projectId !== requester.projectId)
      throw new Error('target task must belong to the same project');
    if (target.id === requester.id) throw new Error('a task cannot request collaboration from itself');
    if (input.action !== 'publish_branch') throw new Error(`unsupported agent action: ${input.action}`);
    const unavailable = collaborationTargetIssue(target.lastView, 'admission');
    if (unavailable) throw new Error(unavailable.admission);

    const request = this.deps.store.createCollaborationRequest({
      requesterTaskId: requester.id,
      targetTaskId: target.id,
      targetRole: input.role ?? 'do',
      action: input.action,
    });

    // New software-dev workers understand this signal and hold the requester in
    // Do at its turn boundary. Other workflow types still receive the eventual
    // follow-up notification, so an unknown signal is a safe compatibility case.
    try {
      await this.deps.client.workflow.getHandle(requester.id)
        .signal(SIG.collaborationRequested, request.id);
    } catch (error) {
      this.deps.store.deleteCollaborationRequest(request.id);
      throw new Error(`could not register collaboration with the requesting workflow: ${unwrapCause(error)}`);
    }

    const instruction = [
      `[Collaboration request ${request.id}]`,
      input.message?.trim() || `Task ${requester.num ? `#${requester.num}` : requester.id} needs your current branch.`,
      'Continue your work as needed, then commit all intended changes and call publish_task_branch.',
      'Krmax will notify the requester automatically when publication succeeds or this task terminates; do not message it back just to report status.',
    ].join('\n\n');
    try {
      await this.deliverWorkflowMessage(target.id, instruction, input.role ?? 'do');
    } catch (error) {
      const failed = this.deps.store.settleCollaborationRequest(request.id, 'failed', {
        requestId: request.id,
        reason: `could not deliver the request: ${unwrapCause(error)}`,
      });
      if (failed) await this.notifyCollaborationRequest(failed);
      return this.deps.store.getCollaborationRequest(request.id) ?? request;
    }
    // The target can cross into a blocked/terminal state between the admission
    // check and signal delivery. Re-read the durable view after delivery so that
    // race cannot strand the requester waiting for an event that already fired.
    const raced = collaborationTargetIssue(
      this.deps.store.getTask(target.id)?.lastView,
      'pending',
    );
    if (raced) {
      const failed = this.deps.store.settleCollaborationRequest(request.id, 'failed', {
        requestId: request.id,
        reason: raced.result,
      });
      if (failed) await this.notifyCollaborationRequest(failed);
    }
    return this.deps.store.getCollaborationRequest(request.id) ?? request;
  }

  /** Withdraw one background collaboration owned by the calling task. A
   * requester must be able to abandon work that can no longer complete (for
   * example, when the target is escalated), otherwise its Do-stage join is a
   * permanent circular dependency. */
  async cancelAgentAction(token: string, requestId: string): Promise<CollaborationRequest> {
    const requester = this.collaborationCaller(token);
    const request = this.deps.store.getCollaborationRequest(requestId);
    if (!request || request.requesterTaskId !== requester.id)
      throw new Error('collaboration request not found for the calling task');
    if (request.status !== 'pending') return request;

    const settled = this.deps.store.settleCollaborationRequest(request.id, 'failed', {
      reason: 'request withdrawn by the requesting task',
    });
    if (!settled) return this.deps.store.getCollaborationRequest(request.id) ?? request;
    await this.notifyCollaborationRequest(settled);
    return this.deps.store.getCollaborationRequest(request.id) ?? settled;
  }

  private async deliverWorkflowMessage(taskId: string, text: string, role = 'do'): Promise<Message> {
    const now = Date.now();
    const message: Message = { id: `u${randomUUID()}`, role: 'user', text, ts: now };
    await this.workflowHandle(taskId).signal(SIG.followUp, message, role);
    this.publishConversationMessage(taskId, role, message);
    return message;
  }

  /**
   * Resume a task after a credential decision without requiring the approver to
   * send a mechanical follow-up. The decision is already authorization-checked
   * by the gateway; this method only delivers the durable workflow message that
   * makes the blocked agent retry (or continue after a denial).
   */
  async resumeAfterCredentialDecision(taskId: string, text: string, role = 'do'): Promise<
    { resumed: true; messageId: string } | { resumed: false; reason: string }
  > {
    const task = this.deps.store.getTask(taskId);
    if (!task) return { resumed: false, reason: 'task no longer exists' };
    if (['done', 'cancelled', 'failed'].includes(task.lastView?.status ?? ''))
      return { resumed: false, reason: `task is already ${task.lastView!.status}` };
    try {
      const message = await this.deliverWorkflowMessage(taskId, text, role);
      return { resumed: true, messageId: message.id };
    } catch (error) {
      return { resumed: false, reason: `could not resume the task: ${unwrapCause(error)}` };
    }
  }

  async publishTaskBranch(token: string): Promise<{ branch: string; pushed: string[] }> {
    const { task, handle } = this.collaborationTask(token, 'publish_task_branch');
    const access = await this.openCollaborationWorld(task.id, handle);
    try {
      await this.enrollProjectRepositories(task, access.world);
      for (const repo of worldRepos(access.world.handle)) {
        const dirty = await access.world.exec('git', ['status', '--porcelain'], { cwd: repo.root });
        if (dirty.code !== 0) throw new Error(`could not inspect ${repo.name}: ${dirty.stderr || dirty.stdout}`);
        if (dirty.stdout.trim()) throw new Error(`repo "${repo.name}" has uncommitted changes; commit them before publishing`);
      }
      const ancestry = await ensureTaskBranchAncestry(access.world,
        task.lastView?.targetBranch ?? access.world.handle.target ?? access.world.handle.base);
      if (Object.keys(ancestry.errors).length)
        throw new Error(`could not publish ${Object.entries(ancestry.errors).map(([repo, detail]) => `${repo}: ${detail}`).join('; ')}`);
      for (const repair of ancestry.repaired) {
        this.deps.store.appendEvent({ taskId: task.id, type: 'branch.ancestry-repaired', ts: Date.now(), payload: repair });
      }
      const result = await brokerPublishBranch(access.world, this.gitBrokerAuth(task.projectId),
        expectedTaskRemoteHeads(this.deps.store, task.id), recordTaskPublication(this.deps.store, task.id));
      if (!result.pushed.length || result.skipped.length)
        throw new Error(`could not publish ${result.skipped.length ? describePublishFailures(result) : 'task branch'}`);
      const event = { taskId: task.id, type: 'push.branch', ts: Date.now(), payload: {
        branch: access.handle.branch, repos: result.pushed, reason: 'agent-collaboration' } };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
      await this.routeCollaborationEvent({ ...event, seq });
      return { branch: access.handle.branch, pushed: result.pushed };
    } finally { await access.release(); }
  }

  async proposeProjectResource(token: string, input: {
    source: { kind: 'path'; path: string } | { kind: 'vault-item'; itemId: string; field?: string };
    name: string;
    driver?: 'volume@1' | 'object-tree@1' | 'secret@1' | 'service@1' | 'database@1';
    target: ResourceTarget;
    access?: ResourceAccess;
    publish?: 'discard' | 'review';
  }) {
    const caller = this.require(token, 'propose_project_resource');
    if (!caller.taskId || caller.taskId === '*') throw new CapabilityError('propose_project_resource requires a task-agent token');
    if (!this.deps.resources) throw new Error('project resources are unavailable');
    const task = this.deps.store.getTask(caller.taskId);
    if (!task) throw new NotFoundError('calling task not found');
    const resourceReviewMinor = task.workflow === 'software-dev' || task.workflow === 'goal' ? 19
      : task.workflow === 'just-do' ? 5 : undefined;
    const [taskMajor, taskMinor] = task.workflowVersion.split('.').map(Number);
    const supportsResourceReview = resourceReviewMinor !== undefined && Number.isFinite(taskMajor)
      && Number.isFinite(taskMinor) && (taskMajor! > 1 || (taskMajor === 1 && taskMinor! >= resourceReviewMinor));
    if (!supportsResourceReview)
      throw new ValidationError('this task workflow version does not support review-gated project resource adoption');
    const project = this.deps.store.getProject(task.projectId);
    if (!project?.organizationId) throw new NotFoundError('calling task project is unavailable');
    this.require(token, 'propose_project_resource', { taskId: task.id, projectId: task.projectId,
      organizationId: project.organizationId });
    const current = this.deps.store.currentWorld(task.id) as WorldHandle | undefined;
    if (caller.worldGeneration == null || current?.generation == null || caller.worldGeneration !== current.generation)
      throw new CapabilityError('project resource proposals require a token for the task’s current world generation');
    if (input.source.kind === 'path') {
      if (input.driver && !['volume@1', 'object-tree@1'].includes(input.driver))
        throw new ValidationError('filesystem candidates require volume@1 or object-tree@1');
      return this.deps.resources.proposePath(task.id, { path: input.source.path, name: input.name,
        target: input.target, access: input.access, publish: input.publish,
        driver: input.driver as 'volume@1' | 'object-tree@1' | undefined });
    }
    if (!this.deps.broker) throw new Error('credential broker is unavailable');
    const vault = new VaultItems(this.deps.store, this.deps.broker, undefined, project.organizationId);
    const item = vault.get(input.source.itemId);
    if (!item) throw new NotFoundError('vault item not found');
    // The narrow vault:store capability lets an agent preserve credentials it
    // created, not silently repurpose somebody else's credential as a project
    // default. Existing-item attachment requires explicit credential administration.
    if (item.provenance.taskId !== task.id)
      throw new CapabilityError('only a vault item created by this task can be proposed as a project resource');
    const field = input.source.field ?? item.fields[0];
    if (!field || !item.fields.includes(field as any)) throw new ValidationError('vault item field is not stored');
    const driver = input.driver ?? 'secret@1';
    if (!['secret@1', 'service@1', 'database@1'].includes(driver))
      throw new ValidationError('vault-item candidates require secret@1, service@1, or database@1');
    if ((driver === 'service@1' || driver === 'database@1') && input.access === 'write'
      && !allows(caller.caps, 'project:resource:shared-write'))
      throw new CapabilityError('a writable shared service or database requires project:resource:shared-write');
    return this.deps.resources.proposeCredential(task.id, { itemId: item.id, field,
      credentialHandle: itemHandle(item.id, field as any), name: input.name,
      driver: driver as 'secret@1' | 'service@1' | 'database@1', target: input.target,
      access: input.access, source: { vaultItemLabel: item.label, vaultItemType: item.type } });
  }

  async adoptProjectResource(token: string, taskId: string, candidateId: string) {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError('task not found');
    const project = this.deps.store.getProject(task.projectId);
    const caller = this.require(token, 'adopt_project_resource', { taskId, projectId: task.projectId,
      organizationId: project?.organizationId });
    if (!this.deps.resources) throw new Error('project resources are unavailable');
    const result = this.deps.resources.adoptCandidate(taskId, candidateId, caller.principal);
    // The durable store transition is authoritative. The signal only wakes a
    // Review workflow that is currently parked on this decision; if the workflow
    // has already closed, the adopted resource must remain adopted.
    try { await this.workflowHandle(taskId).signal(SIG.resourceResolved); }
    catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
    return result;
  }

  async discardProjectResource(token: string, taskId: string, candidateId: string) {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError('task not found');
    const project = this.deps.store.getProject(task.projectId);
    const caller = this.require(token, 'discard_project_resource', { taskId, projectId: task.projectId,
      organizationId: project?.organizationId });
    if (!this.deps.resources) throw new Error('project resources are unavailable');
    const result = await this.deps.resources.discardCandidate(taskId, candidateId, caller.principal);
    try { await this.workflowHandle(taskId).signal(SIG.resourceResolved); }
    catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
    return result;
  }

  async importTaskBranch(token: string, sourceTaskId: string) {
    const { task, handle } = this.collaborationTask(token, 'import_task_branch');
    const source = this.deps.store.getTask(sourceTaskId);
    if (!source || source.projectId !== task.projectId) throw new Error('source task must belong to the same project');
    const sourceHandle = (this.deps.store.currentWorld(sourceTaskId) ?? source.lastView?.world) as WorldHandle | undefined;
    if (!sourceHandle) throw new Error('source task has no published world branch');
    const requiredSourceRepos = this.deps.store.listProjectRepositories(task.projectId).flatMap((attachment) => {
      const checkout = worldRepos(sourceHandle).find((repo) => sameRepository(worldRepoSource(repo), attachment.repository.sshUrl));
      return checkout ? [checkout.name] : [];
    });
    const sourceMissing = this.deps.store.listProjectRepositories(task.projectId)
      .filter((attachment) => !worldRepos(sourceHandle)
        .some((repo) => sameRepository(worldRepoSource(repo), attachment.repository.sshUrl)));
    if (sourceMissing.length) throw new Error(`source task is missing newly attached checkout(s): ${sourceMissing.map((entry) => entry.repository.name).join(', ')}; ask its agent to call publish_task_branch to enroll and publish them`);
    const published = this.deps.store.eventsSince(sourceTaskId, 0).some((event) => {
      if (event.type !== 'push.branch') return false;
      const payload = event.payload as { branch?: string; repos?: string[] } | undefined;
      return payload?.branch === sourceHandle.branch
        && requiredSourceRepos.every((repo) => payload.repos?.includes(repo));
    });
    if (!published) throw new Error('source branch is not published yet; message its agent and ask it to commit and call publish_task_branch');
    const access = await this.openCollaborationWorld(task.id, handle);
    try {
      await this.enrollProjectRepositories(task, access.world);
      const refs = await brokerImportTaskBranch(access.world, sourceHandle, sourceTaskId,
        this.gitBrokerAuth(task.projectId));
      return { sourceTaskId, refs };
    } finally { await access.release(); }
  }

  async refreshUpstream(token: string, branch?: string) {
    const { task, handle } = this.collaborationTask(token, 'refresh_upstream');
    const access = await this.openCollaborationWorld(task.id, handle);
    try {
      const project = this.deps.store.getProject(task.projectId);
      const targetAuthority = remotePolicyOf(project ? this.deps.store.effectiveProjectConfig(project) : undefined) === 'pr'
        ? 'origin'
        : 'project';
      return await brokerRefreshUpstream(access.world, this.gitBrokerAuth(task.projectId), branch, targetAuthority);
    } finally { await access.release(); }
  }

  listWorldProviderConnections(token: string, organizationId: string) {
    this.require(token, 'organization:read', { organizationId });
    return this.deps.providerConnections?.list(organizationId) ?? [];
  }

  saveWorldProviderConnection(token: string, input: {
    organizationId: string;
    provider: string;
    apiKey?: string;
    name?: string;
    config?: import('../domain/types.js').WorldProviderConnection['config'];
    enabled?: boolean;
  }) {
    this.require(token, 'organization:edit', { organizationId: input.organizationId });
    if (!this.deps.providerConnections) throw new Error('world provider connections are unavailable');
    return this.deps.providerConnections.save(input);
  }

  async testWorldProviderConnection(token: string, organizationId: string, provider: string) {
    this.require(token, 'organization:edit', { organizationId });
    if (!this.deps.providerConnections) throw new Error('world provider connections are unavailable');
    return this.deps.providerConnections.test(organizationId, provider);
  }

  deleteWorldProviderConnection(token: string, organizationId: string, provider: string) {
    this.require(token, 'organization:edit', { organizationId });
    if (!this.deps.providerConnections) throw new Error('world provider connections are unavailable');
    const active = this.deps.store.organizationResources(organizationId).worlds
      .filter((handle) => (handle.provider ?? handle.kind) === provider);
    if (active.length) throw new Error(`${active.length} task world(s) still use ${provider}; finish or delete them first`);
    return { deleted: Boolean(this.deps.providerConnections.delete(organizationId, provider)) };
  }

  getExecutionPolicy(token: string, input: { organizationId: string; projectId?: string }) {
    if (!input.projectId) {
      this.require(token, 'organization:read', { organizationId: input.organizationId });
      return { organization: this.deps.store.getOrganizationExecutionPolicy(input.organizationId) };
    }
    const project = this.deps.store.getProject(input.projectId);
    if (!project || project.organizationId !== input.organizationId) throw new Error('project does not belong to this organization');
    this.require(token, 'project:settings:read', { organizationId: input.organizationId, projectId: project.id });
    return {
      organization: this.deps.store.getOrganizationExecutionPolicy(input.organizationId),
      override: executionConfigOf(project.config),
      effective: executionConfigOf(this.deps.store.effectiveProjectConfig(project)),
    };
  }

  setExecutionPolicy(token: string, input: { organizationId: string; projectId?: string;
    policy: Partial<OrganizationExecutionPolicy> & Record<string, unknown> }) {
    const project = input.projectId ? this.deps.store.getProject(input.projectId) : undefined;
    if (input.projectId && (!project || project.organizationId !== input.organizationId))
      throw new Error('project does not belong to this organization');
    this.require(token, project ? 'project:settings:write' : 'organization:edit',
      { organizationId: input.organizationId, ...(project ? { projectId: project.id } : {}) });
    // Null means "inherit" for project overrides. At organization scope it
    // means "restore the built-in default", so never persist null policy values.
    const policy = project ? input.policy
      : Object.fromEntries(Object.entries(input.policy).map(([key, value]) => [key, value == null ? undefined : value]));
    const candidate = project
      ? this.deps.store.effectiveProjectConfig({ ...project, config: applyExecutionConfig(project.config, policy) })
      : policy;
    const provider = typeof candidate.worldProvider === 'string' ? candidate.worldProvider : undefined;
    if (provider && !['worktree', 'container', 'memory'].includes(provider)
      && !this.deps.providerConnections?.available(input.organizationId, provider))
      throw new Error(`${provider} is not connected and verified`);
    const runnerPoolId = typeof candidate.runnerPoolId === 'string' ? candidate.runnerPoolId : undefined;
    if (runnerPoolId) {
      const pool = this.deps.store.getRunnerPool(runnerPoolId);
      if (!pool || pool.organizationId !== input.organizationId) throw new Error('runner pool does not belong to this organization');
      if (provider && pool.provider !== provider) throw new Error('runner pool provider must match the execution provider');
    }
    if (project) this.deps.store.setProjectExecutionPolicy(project.id, policy);
    else this.deps.store.setOrganizationExecutionPolicy(input.organizationId, policy as OrganizationExecutionPolicy);
    return this.getExecutionPolicy(token, input);
  }

  private require(token: string, tool: string, scope?: { projectId?: string; taskId?: string; organizationId?: string }) {
    const cap = TOOL_CAPABILITY[tool] ?? tool;
    const r = this.deps.tokens.check(token, cap, scope);
    if (!r.ok) throw new CapabilityError(r.reason ?? `denied: ${cap}`);
    return r.record!;
  }

  /**
   * Validate each agent resume source, then authorize every
   * `agent:<role>.resumeFrom.taskId` against the **source** task, not just the
   * task being created/edited. A `sessionId` is accepted only when it is a
   * supported public share URL, unless this is a host-local install where the
   * browser and provider histories intentionally share one machine.
   *
   * `resumeFrom` makes the activity runtime (`src/activities/core.ts`) load
   * another task's provider session and splice its transcript into the new
   * agent's messages. That is a conversation read of the source task, so it has
   * to be checked at the source's project/organization — otherwise a token
   * holding only `task:create` in its own project could replay any conversation
   * from any sibling project or tenant into an agent it controls. `forkTaskAgent`
   * already models the intended check; this closes the same door on the raw
   * params path (POST /api/tasks, PATCH /api/tasks/:id/params).
   */
  private validateAndAuthorizeResumeSources(token: string, params: Record<string, unknown> | undefined): void {
    for (const [key, value] of Object.entries(params ?? {})) {
      if (!key.startsWith('agent:') || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const resumeFrom = (value as Record<string, unknown>).resumeFrom;
      if (!resumeFrom || typeof resumeFrom !== 'object' || Array.isArray(resumeFrom)) continue;
      const sessionId = (resumeFrom as Record<string, unknown>).sessionId;
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim()
        || (looksLikeConversationUrl(sessionId) && !publicConversationShare(sessionId))))
        throw new ValidationError('use a public HTTPS ChatGPT/Claude share link or upload a conversation file');
      if (typeof sessionId === 'string' && !publicConversationShare(sessionId)
        && !(this.deps.hostLocal ?? deploymentHostLocal()))
        throw new ValidationError('provider conversation IDs are available only on a host-local Karmax; upload the Codex/Claude conversation file or use a public HTTPS ChatGPT/Claude share link');
      const sourceId = (resumeFrom as Record<string, unknown>).taskId;
      if (typeof sourceId !== 'string' || !sourceId) continue;
      const source = this.deps.store.getTask(sourceId);
      if (!source) throw new NotFoundError(`no task ${sourceId} to resume from`);
      this.require(token, 'get_conversation', { projectId: source.projectId, taskId: sourceId });
    }
  }

  /** Carry file handles across task-agent forks. A provider session remembers the
   * old prompt text, including old world paths; copying the refs onto the new task
   * lets every generation rematerialize them at its own current path. */
  private inheritedResumeFiles(params: Record<string, unknown> | undefined): FileRef[] {
    const files: FileRef[] = [];
    for (const [key, value] of Object.entries(params ?? {})) {
      if (!key.startsWith('agent:') || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const resumeFrom = (value as Record<string, any>).resumeFrom;
      if (!resumeFrom?.taskId) continue;
      const source = this.deps.store.getTask(String(resumeFrom.taskId));
      if (!source) continue;
      files.push(...((source.params.files as FileRef[] | undefined) ?? []));
      const view = source.lastView;
      if (!view) continue;
      const role = String(resumeFrom.role ?? key.slice('agent:'.length));
      const messages = role === 'do'
        ? view.messages
        : view.transcripts?.find((transcript) => transcript.role === role)?.messages ?? [];
      for (const message of messages) files.push(...(message.files ?? []));
    }
    return uniqueFileRefs(files);
  }

  private validatePromptFiles(projectId: string, files: FileRef[]): void {
    if (files.length > MAX_FILES_PER_MESSAGE) throw new Error(`a prompt can attach at most ${MAX_FILES_PER_MESSAGE} files`);
    const total = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
    if (total > MAX_FILES_BYTES_PER_MESSAGE)
      throw new Error(`attached files exceed the ${MAX_FILES_BYTES_PER_MESSAGE / 1024 / 1024} MiB prompt limit`);
    for (const file of files) {
      if (!file || !/^[a-f0-9]{64}$/.test(String(file.id)) || typeof file.name !== 'string'
        || sanitizeAttachmentName(file.name) !== file.name || typeof file.mediaType !== 'string'
        || !/^[a-z0-9][a-z0-9!#$&^_.+\-]*\/[a-z0-9][a-z0-9!#$&^_.+\-]*$/.test(file.mediaType)
        || !Number.isInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_FILE_BYTES)
        throw new Error('invalid file attachment reference');
      if (!this.deps.store.attachmentAllowed(file.id, projectId))
        throw new Error(`file attachment is not available in this project: ${file.name}`);
    }
  }

  /** Validate configured repository selections without making repositories a
   * prerequisite. An empty effective list is the supported zero-repo form of a
   * workflow; hosted repository enrollment applies only when a repo was chosen. */
  /** `base`/`target`/`branch` become positional `git` arguments on the host: a
   *  value git would not accept as a branch name (or that starts with `-`) is
   *  refused at intake, whichever route — form, MCP, in-flight edit — set it. */
  private assertBranchParams(values: Record<string, unknown>): void {
    for (const key of ['base', 'target', 'branch'] as const) {
      const value = values[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' || !validGitBranch(value.trim())) throw new Error(`invalid ${key} branch name`);
    }
  }

  private assertRepositoriesValid(manifest: WorkflowManifest, project: Project, resolved: ValueMap) {
    const needsRepo = (manifest.params ?? []).some((p) => p.name === 'repos');
    if (!needsRepo) return;
    const repositories = effectiveRepos(resolved, project.config);
    if (!repositories.length) return;
    if (this.deps.hosted) {
      const linked = this.deps.store.listProjectRepositories(project.id);
      if (!linked.length) {
        throw new Error('Please connect GitHub in organization settings, then add a git repo in project settings.');
      }
      const enrolled = linked.map((candidate) => candidate.repository.sshUrl);
      const outside = repositories
        .filter((repository) => !enrolled.some((candidate) => sameRepository(candidate, repository)));
      if (outside.length) throw new Error('Please choose a GitHub repo attached to this project in project settings.');
    }
  }

  /** Resolve every Avatar referenced by the task's role fields and Review-agent
   * layers. Invocation is checked against the human who initiated the calling
   * chain, not against an arbitrary task-agent id. */
  private validateTaskAvatars(caller: ScopedToken, project: Project, manifest: WorkflowManifest, resolved: ValueMap) {
    const callerUserId = caller.humanSubject?.userId
      ?? (caller.taskId !== '*' ? this.deps.store.taskCreatorUserId(caller.taskId) : undefined);
    const selected: Array<{ avatar: import('../domain/types.js').Avatar; role: string }> = [];
    const add = (spec: unknown, role: string) => {
      const record = spec && typeof spec === 'object' && !Array.isArray(spec)
        ? spec as Record<string, unknown> : undefined;
      const avatarId = record?.avatarId;
      if (typeof avatarId !== 'string' || !avatarId) return;
      const avatar = this.deps.store.getAvatar(avatarId);
      if (!avatar || avatar.projectId !== project.id) throw new ValidationError('the selected Avatar is not available in this project');
      if (!avatarEnabled(this.deps.store, avatar)) throw new ValidationError(`Avatar "${avatar.name}" is disabled`);
      const purpose = typeof record?.avatarPurpose === 'string' ? record.avatarPurpose : role;
      if (avatar.roles.length && !avatar.roles.includes(purpose))
        throw new ValidationError(`Avatar "${avatar.name}" cannot be used for the ${purpose} role`);
      if (!callerUserId || !avatarCallableBy(this.deps.store, avatar, callerUserId))
        throw new CapabilityError(`you are not allowed to call Avatar "${avatar.name}"`);
      selected.push({ avatar, role });
    };
    for (const field of manifest.params) {
      if (field.type === 'agent') add(resolved[field.name], field.role ?? field.name.replace(/^agent:/, ''));
      if (field.type === 'confirmer') {
        for (const layer of confirmLayersOf(resolved[field.name] as any)) if (layer.kind === 'agent') add(layer, field.role ?? 'confirm');
      }
    }
    return selected;
  }

  private prepareForkWorld(projectId: string, params: ValueMap, previous?: ValueMap): void {
    // Never accept a caller-supplied checkpoint or repository manifest.
    delete params._forkWorld;
    const spec = (params['agent:do'] ?? params['agent:unified']) as AgentSpec | undefined;
    const sourceId = spec?.resumeFrom?.taskId;
    if (!sourceId) return;
    const source = this.deps.store.getTask(sourceId);
    // Cross-project conversation reuse does not grant access to private worlds.
    if (!source || source.projectId !== projectId) return;
    const retained = previous?._forkWorld as ForkWorldSource | undefined;
    const start = retained?.taskId === sourceId ? retained
      : forkWorldSource(source, this.deps.store.currentWorld(sourceId) as WorldHandle | undefined);
    if (!start) return;
    params._forkWorld = start;
    if (!previous && params.base === undefined) params.base = start.base;
  }

  async createTask(
    token: string,
    args: {
      projectId: string;
      title?: string;
      prompt?: string;
      /** Images attached to the initial prompt (references, never inline bytes). */
      images?: ImageRef[];
      /** Files attached to the initial prompt (references, never inline bytes). */
      files?: FileRef[];
      /** Wiki context to inline, as `[[proj:…]]`/`[[org:…]]` references (see TaskParams.wikiContext). */
      wikiContext?: string[];
      workflow?: string;
      base?: string;
      target?: string;
      command?: string;
      branch?: string;
      profiles?: Record<string, string>;
      /** Full task-form field values (SPEC §10.4); takes precedence over the flat fields. */
      params?: ValueMap;
      /** Free-form human notes (cosmetic, UI-only — stored off `params` so they never reach the agent). */
      notes?: string;
      /** Save without starting the workflow (SPEC §10.4 drafts). */
      draft?: boolean;
      /** Added from the quick-task box (not the full form): layer the quick-task
       *  defaults over the general defaults when resolving (SPEC §10.4). */
      quick?: boolean;
      /** Job-shaped permission profile for every agent spawned by this workflow. */
      authorizationProfile?: string;
      /** Canonical level plus its project-list / organization / global scope. */
      authorization?: AuthorizationSelection;
      /** Draft auto-save may preserve an over-broad selection as an explicitly
       * unaccepted attenuated package. `acceptAttenuation` is the user's choice
       * to run with that limited package. */
      allowAttenuation?: boolean;
      acceptAttenuation?: boolean;
      /** Per-task vault item grants (PLAN-passwords.md §6): `use-credential:item:…`
       *  / `:tag:…` / `:domain:…` caps layered onto the profile package. */
      credentialGrants?: string[];
      /** Sparse blind-use/plaintext policy overrides for the credentials this
       * task was granted. Missing values inherit organization defaults. */
      credentialPolicies?: VaultTaskPolicyOverrides;
      /** Total mutually-exclusive attempts to create and queue up front. */
      attempts?: number;
      /** Ordinal priority (index into PRIORITY_NAMES). Part of the creation
       *  payload, so it is applied under `task:create` — see `applyTagPatch`. */
      priority?: number;
      /** Tag names or `a/b` paths, created on demand. Applied under
       *  `task:create` for the same reason as `priority`. */
      tags?: string[];
      assignee?: PrincipalRef;
      delegate?: PrincipalRef;
      confirmationPolicy?: ConfirmationPolicy;
    },
    receivedAt = timingEnabled(this.deps.store) ? { monoMs: performance.now(), wallMs: Date.now() } : undefined,
  ): Promise<TaskRecord> {
    const caller = this.require(token, 'create_task', { projectId: args.projectId });
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new NotFoundError(`no project ${args.projectId}`);
    const workflow = args.workflow ?? 'software-dev';
    // Honor a per-project version pin (§21d) so a project can hold on a specific
    // version while others take the latest; unpinned → latest.
    const start = this.resolveStart(workflow, this.workflowPinFor(args.projectId, workflow), project.organizationId);
    if (!start) throw new Error(`unknown workflow "${workflow}"`);
    const { manifest, startType } = start;
    const requestedAuthorization = args.authorization ?? args.authorizationProfile;
    const grantorCaps = this.authorizationGrantorCaps(token, caller, requestedAuthorization, project.organizationId ?? 'org_personal');
    const authorization = this.deps.authorization
      ? this.deps.authorization.taskGrant(caller.principal, args.projectId, requestedAuthorization, grantorCaps)
      : { profileId: args.authorizationProfile ?? 'caller', capabilities: caller.caps, attenuated: false };
    const profileAttenuated = authorization.attenuated;
    if (args.authorization && profileAttenuated
      && !(args.draft && args.allowAttenuation) && !args.acceptAttenuation)
      throw new AuthorizationGrantError('you cannot grant the agent more authorization than you have');
    this.applyCredentialGrants(authorization, args.credentialGrants, caller.caps);
    const credentialPolicies = this.credentialPolicyOverrides(
      project.organizationId ?? 'org_personal', args.credentialPolicies, caller.caps, authorization,
    );

    // Task-scope overrides: the form's `params` plus the legacy flat fields.
    const taskOverrides: ValueMap = { ...(args.params ?? {}) };
    // Authority-owned fields are minted below. An API caller may never inject a
    // delegated subject or substitute the task-pinned external account through
    // the otherwise-open workflow params bag.
    delete taskOverrides._authorization;
    delete taskOverrides._githubAccountId;
    for (const [k, v] of Object.entries({ prompt: args.prompt, base: args.base, target: args.target, command: args.command, branch: args.branch })) {
      if (v !== undefined && taskOverrides[k] === undefined) taskOverrides[k] = v;
    }
    // Image attachments ride alongside the prompt but aren't a manifest param, so
    // carry them explicitly (references only — bytes live in the attachment store).
    if (args.images?.length && taskOverrides.images === undefined) taskOverrides.images = args.images;
    if (args.files?.length && taskOverrides.files === undefined) taskOverrides.files = args.files;
    // Wiki context (which pages to inline) isn't a manifest param either; a
    // top-level arg (MCP/API) is folded in like the form sends it via `params`.
    if (args.wikiContext && taskOverrides.wikiContext === undefined) taskOverrides.wikiContext = args.wikiContext;
    this.assertBranchParams(taskOverrides);
    // A `resumeFrom` pointer reads another task's conversation — authorize it
    // against that task's project before anything is created.
    this.validateAndAuthorizeResumeSources(token, taskOverrides);
    this.prepareForkWorld(args.projectId, taskOverrides);
    const inheritedFiles = this.inheritedResumeFiles(taskOverrides);
    // Resume authorization above grants conversation-read authority. Extend each
    // inherited content hash into the destination project before validating it.
    for (const file of inheritedFiles) this.deps.store.grantAttachment(file.id, args.projectId);
    const promptFiles = uniqueFileRefs([
      ...((taskOverrides.files as FileRef[] | undefined) ?? []),
      ...inheritedFiles,
    ]);
    if (promptFiles.length) {
      this.validatePromptFiles(args.projectId, promptFiles);
      taskOverrides.files = promptFiles;
    }
    const resolved = await this.resolveTaskParams(manifest, project, taskOverrides, !!args.quick);
    const selectedAvatars = this.validateTaskAvatars(caller, project, manifest, resolved);
    for (const { avatar } of selectedAvatars) {
      if (avatar.credentialPolicies) Object.assign(credentialPolicies, avatar.credentialPolicies);
    }
    // Validate any repository selection after resolution so this sees the exact
    // effective list the world will. An empty list is a supported zero-repo run.
    if (!args.draft) this.assertRepositoriesValid(manifest, project, resolved);

    const title = args.title ?? firstLine(String(resolved.prompt ?? resolved.command ?? 'Task'));
    const callerRef = principalRefOf(caller.principal, caller.kind);
    // A legacy unscoped human token may predate organization membership. Do not
    // persist it as an organization principal (which would also auto-subscribe
    // an outsider); claimed/current installations always retain the creator.
    const createdBy = callerRef?.kind === 'user'
      && !this.deps.store.organizationMembership(project.organizationId ?? 'org_personal', callerRef.userId)
      ? undefined : callerRef;
    // Pin the connected account when the task is created. Switching the user's
    // active account later must not silently change an existing task's commit or
    // pull-request actor.
    const avatarGithubAccountId = selectedAvatars.find(({ role }) => role === 'do')?.avatar.githubAccountId;
    const githubAccountId = avatarGithubAccountId ?? (caller.kind === 'agent'
      ? caller.externalIdentities?.githubAccountId
      : caller.humanSubject
        ? this.deps.githubApp?.activeUserAccountId(caller.humanSubject.userId)
        : undefined);
    // Human routing belongs to each workflow confirm layer. Keep accepting the
    // old task-level policy only for API/backward compatibility; the UI never
    // creates one and new workflows publish their current audience with the wait.
    const confirmationPolicy = args.confirmationPolicy;
    // A repeatable "series" (Model A) — forced on by a cron/recurring trigger.
    const repeatable = !!taskOverrides.repeatable || forcesRepeatable(normalizeTriggers(taskOverrides));
    // Persist only the task's OWN overrides (sparse), not the resolved snapshot.
    // A baked snapshot would freeze inherited values, so later changes to the
    // project/global defaults could never reach an unqueued task. Keeping the
    // task sparse means it re-resolves against the live defaults when it's
    // finally queued (createTask below for immediate start, queueTask for drafts).
    let task = this.deps.store.createTask({
      projectId: args.projectId,
      title,
      workflow,
      workflowVersion: manifest.version,
      params: {
        ...taskOverrides,
        prompt: String(taskOverrides.prompt ?? resolved.prompt ?? ''),
        // Once an immediate task is queued, branch policy is execution state,
        // not an inheritable form default. Persist the exact pair provisioning
        // receives so recovery/fork/retarget paths cannot reconstruct a
        // different base from changed project settings.
        ...(!args.draft && typeof resolved.base === 'string' && resolved.base ? { base: resolved.base } : {}),
        ...(!args.draft && typeof resolved.target === 'string' && resolved.target ? { target: resolved.target } : {}),
        [REPOSITORY_BRANCHES_RESOLVED_PARAM]: true,
        profiles: args.profiles,
        draft: !!args.draft,
        _authorization: { ...authorization, profileAttenuated, principal: caller.principal, credentialPolicies,
          ...(profileAttenuated ? { attenuationAccepted: args.acceptAttenuation === true } : {}) },
        ...(githubAccountId ? { _githubAccountId: githubAccountId } : {}),
        ...(repeatable ? { repeatable: true } : {}),
      },
      confirmer: (() => {
        const field = manifest.params.find((f) => f.type === 'confirmer');
        return field ? resolved[field.name] : undefined;
      })(),
      createdBy,
      assignee: args.assignee,
      delegate: args.delegate,
      confirmationPolicy,
    });
    const authorizationScope = authorization as typeof authorization & {
      scope?: 'projects' | 'organization' | 'global'; projectIds?: string[]; organizationId?: string;
    };
    const delegation = this.delegateTaskHuman(token, caller, {
      taskId: task.id,
      projectId: authorizationScope.scope ? undefined : task.projectId,
      projectIds: authorizationScope.scope === 'projects' ? authorizationScope.projectIds : undefined,
      organizationId: authorizationScope.scope === 'global' ? undefined
        : (authorizationScope.organizationId ?? project.organizationId),
      externalIdentities: githubAccountId ? { githubAccountId } : undefined,
    });
    if (delegation) {
      this.deps.store.updateTaskParams(task.id, {
        ...task.params,
        _authorization: { ...(task.params._authorization as object), delegationId: delegation.id },
      });
      task = this.deps.store.getTask(task.id)!;
    }
    this.persistTaskCredentialPolicies(task);
    // Advisory only: GitHub is an external policy authority, so this can become
    // stale and is always revalidated at Merge. Still, catching the common
    // missing-reviewer setup at queue time is much kinder than discovering it
    // after CI. Never turn the observation into a krmax capability or reject the
    // task—the creator may intentionally arrange the reviewer later.
    if (!args.draft && String(resolved.remote ?? project.config.remote ?? 'none') === 'pr'
      && createdBy?.kind === 'user' && this.deps.githubApp) {
      const wikiRepository = this.deps.store.projectWiki(project.id)?.repository;
      const slugs = [...new Set([
        ...this.deps.store.listProjectRepositories(project.id)
          .map((linked) => `${linked.repository.owner}/${linked.repository.name}`),
        ...(wikiRepository ? [`${wikiRepository.owner}/${wikiRepository.name}`] : []),
      ])];
      const accountId = githubAccountId;
      const creatorCanMerge = Boolean(accountId && slugs.length && (await Promise.all(slugs.map((slug) =>
        this.deps.githubApp!.repositoryPermission(createdBy.userId, slug, accountId).catch(() => undefined))))
        .every((permission) => permission?.canMerge));
      if (!creatorCanMerge && slugs.length) {
        const confirmer = manifest.params.find((field) => field.type === 'confirmer');
        const layers = confirmer ? confirmLayersOf(resolved[confirmer.name] as any) : [];
        const routedUsers = [...new Set(layers.filter((layer) => layer.kind === 'human')
          .flatMap((layer) => this.deps.store.humanAudience(task.id, layer.audience)))];
        let routedEligible = false;
        for (const userId of routedUsers) {
          const reviewerAccount = this.deps.githubApp.activeUserAccountId(userId);
          if (!reviewerAccount) continue;
          const permissions = await Promise.all(slugs.map((slug) =>
            this.deps.githubApp!.repositoryPermission(userId, slug, reviewerAccount).catch(() => undefined)));
          if (permissions.every((permission) => permission?.canMerge)) { routedEligible = true; break; }
        }
        if (!routedEligible) {
          const warning = 'The task creator cannot merge every GitHub repository and no selected human Review step currently routes to a connected person who can. The task may proceed, but it will stop at Merge for an eligible human.';
          this.deps.store.appendEvent({ taskId: task.id, type: 'github.merge.preflight-warning', ts: Date.now(),
            payload: { warning, repositories: slugs } });
          (task as TaskRecord & { warnings?: string[] }).warnings = [warning];
        }
      }
    }
    if (!args.draft) {
      try { this.assertHumanRoutes(task, manifest, resolved); }
      catch (error) { this.deps.store.deleteTask(task.id); throw error; }
    }
    // Cosmetic human notes live in a dedicated column, never in `params`, so they
    // are structurally incapable of reaching the agent (SPEC §10). Persist them the
    // same way whether the task is queued now or saved as a draft.
    if (typeof args.notes === 'string') {
      this.deps.store.setTaskNotes(task.id, args.notes);
      task.notes = args.notes || undefined;
    }
    // Organizational metadata supplied WITH the create, applied here under the
    // caller's `task:create` rather than as follow-up `task:edit` calls. Both
    // are set before the task can be queued, so a created task is never briefly
    // visible without the priority/tags it was asked for.
    if (args.priority) this.deps.store.setTaskPriority(task.id, args.priority);
    if (args.tags?.length) this.applyTagPatch(task.id, task.projectId, { add: args.tags });
    // Materialize up-front alternates before the first workflow can start. Draft
    // creation keeps all of them editable; immediate creation queues all of them.
    const createdAlternates: TaskRecord[] = [];
    const attemptCount = Math.max(1, Math.min(8, Math.floor(args.attempts ?? 1)));
    if (repeatable && attemptCount > 1) {
      this.deps.store.deleteTask(task.id);
      throw new Error('repeatable task templates cannot have alternate attempts; each spawned run is already a separate execution');
    }
    if (!repeatable) {
      // Keep declarative triggers for up-front siblings: queueing a triggered
      // attempt means arming it alongside the others, never starting it early.
      const { triggerState: _triggerState, repeatable: _repeatable, runOf: _runOf,
        archived: _archived, draft: _draft, ...copied } = task.params;
      for (let n = 1; n < attemptCount; n++) {
        let alt = this.deps.store.createTask({ projectId: task.projectId, listId: task.listId, title: task.title,
          workflow: task.workflow, workflowVersion: task.workflowVersion, params: { ...copied, draft: true, archived: false },
          parentTaskId: task.parentTaskId, intentId: task.intentId, createdBy: task.createdBy,
          assignee: task.assignee, delegate: task.delegate, confirmationPolicy: task.confirmationPolicy });
        if (delegation) {
          const alternateDelegation = this.deps.tokens.deriveHumanDelegation(delegation.id, {
            taskId: alt.id, projectId: delegation.projectId, projectIds: delegation.projectIds,
            organizationId: delegation.organizationId,
          });
          this.deps.store.updateTaskParams(alt.id, { ...alt.params,
            _authorization: { ...(alt.params._authorization as object), delegationId: alternateDelegation.id } });
          alt = this.deps.store.getTask(alt.id)!;
        }
        this.persistTaskCredentialPolicies(alt);
        if (task.notes) this.deps.store.setTaskNotes(alt.id, task.notes);
        createdAlternates.push(alt);
      }
    }
    const undoCreation = () => {
      for (const alt of [...createdAlternates].reverse()) this.deps.store.deleteTask(alt.id);
      this.deps.store.deleteTask(task.id);
    };
    const queueCreatedAlternates = async () => Promise.all(createdAlternates.map(async (alternate) => {
      try {
        await this.queueTask(token, alternate.id);
      } catch (e) {
        // The principal is already durable and cannot be rolled back. Preserve a
        // failed sibling as a draft and leave an actionable audit event instead of
        // falsely reporting that the entire logical task was never created.
        this.deps.store.appendEvent({
          taskId: alternate.id,
          type: 'attempt.queue-failed',
          ts: Date.now(),
          payload: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }));
    if (args.draft) return task; // stored but not queued

    // A repeatable series never runs its own workflow — it spawns run records.
    // With no trigger, spawn its first run now so it isn't inert; with a trigger,
    // it arms below (each fire spawns a run — see fireTriggeredTask/'clone').
    if (task.params.repeatable && !hasActiveTriggers(task.params)) {
      await this.spawnRun(token, task.id);
      return this.deps.store.getTask(task.id)!;
    }

    // Triggered tasks are stored-not-started and *armed* (SPEC §3.3): the
    // dispatcher starts them when a trigger fires. This is generic and
    // workflow-agnostic — a trigger gates *when* the workflow starts, not what
    // it does, so it applies to any task with any workflow.
    if (hasActiveTriggers(task.params)) {
      try {
        const armed = this.armStoredTask(task.id);
        await queueCreatedAlternates();
        if (typeof args.notes === 'string') armed.notes = args.notes || undefined;
        return armed;
      } catch (e) {
        undoCreation(); // undo the whole logical task on an invalid trigger
        throw e;
      }
    }

    const input = assembleTaskInput(manifest, resolved, {
      taskId: task.id,
      projectId: args.projectId,
      title,
      project: this.deps.store.effectiveProjectConfig(project),
    });
    input.createdAt = task.createdAt;
    input.workflow = workflow;
    input.grant = authorization.capabilities;
    input.grantPrincipal = caller.principal;
    input.delegationId = delegation?.id;
    input.authorizationProfile = authorization.profileId;
    input.resolveAgentEnabled = RESOLVE_AGENT_ENABLED;
    input.intentId = task.intentId ?? task.id;
    if (args.profiles) input.profiles = args.profiles;
    const initialImages = taskOverrides.images as ImageRef[] | undefined;
    if (initialImages?.length) input.images = initialImages;
    const initialFiles = taskOverrides.files as FileRef[] | undefined;
    if (initialFiles?.length) input.files = initialFiles;

    const requestTiming = installationTiming(this.deps.store, { taskId: task.id, requestIds: [`${task.id}:m0`] }, row => {
      this.deps.store.appendEvent({ taskId: task.id, type: 'timing', ts: row.wallMs, payload: { ...row } });
    });
    requestTiming.mark('request.received', { requestId: `${task.id}:m0` }, receivedAt);
    const dispatchEnd = requestTiming.start('workflow.dispatch');
    // Pin the execution to the manifest version stamped on the task (§21b), so a
    // later version upgrade only affects new tasks, never this running one.
    // Bounded + compensated: if the engine won't accept it (wedged/unreachable),
    // delete the row we just wrote so it can't linger as an orphan stuck at
    // "setup", and surface a real error instead of hanging.
    try {
      await withTimeout(
        this.deps.client.workflow.start(startType, { taskQueue: this.deps.taskQueue, workflowId: task.id, args: [input] }),
        START_TIMEOUT_MS,
      );
    } catch (e) {
      undoCreation();
      throw new Error(
        `Could not start "${title}": the durable engine didn't accept the task (${e instanceof Error ? e.message : String(e)}). ` +
          `Nothing was queued — check that Temporal is healthy and try again.`,
      );
    }
    dispatchEnd();
    this.saveAgentSnapshot(task.id, manifest, input);
    // These attempts were explicitly requested as part of creation, so start all
    // of them. addAttempt() remains intentionally different: it creates one draft
    // for inspection/editing and never queues it implicitly.
    await queueCreatedAlternates();
    return task;
  }

  /**
   * Resolve a task's effective field values from its own overrides layered over
   * the CURRENT project + global defaults (SPEC §10.4 overlay). Shared by task
   * creation and draft queueing so both pick up the live defaults, and so an
   * unqueued task inherits any default change made after it was saved.
   */
  private async resolveTaskParams(manifest: WorkflowManifest, project: Project, taskOverrides: ValueMap, quick = false): Promise<ValueMap> {
    const getSettings = (s: string, w: string) => this.deps.store.getSettings(s, w);
    const projectVals = projectSettingsFor(getSettings, project, manifest.name);
    const globalVals = globalSettingsFor(getSettings, manifest.name, project.organizationId);
    // Quick tasks layer the quick-task defaults (project-quick → global-quick) above
    // the general defaults; a full-form task skips them entirely (SPEC §10.4).
    const layers: (ValueMap | undefined)[] = quick
      ? [taskOverrides, quickProjectSettingsFor(getSettings, project.id, manifest.name), quickGlobalSettingsFor(getSettings, manifest.name, project.organizationId), projectVals, globalVals]
      : [taskOverrides, projectVals, globalVals];
    const resolved = resolveParamsLayers(manifest, layers);
    // `none` means a completed merge may remain only in its local world. That is
    // a valid self-hosted choice, but never a valid outcome for a disposable
    // hosted GitHub world. Coerce legacy settings rows here so every newly
    // started task in an existing hosted project gets the new PR contract. An
    // already-running Temporal execution keeps its recorded input unchanged.
    if (this.deps.hosted && (resolved.remote === undefined || resolved.remote === 'none'))
      resolved.remote = 'pr';
    this.materializeUnifiedAgents(resolved, project.id);

    // Auto-detect the repo's branch policy when base/target weren't set anywhere,
    // instead of guessing "main" (which would make hosted task views disagree
    // with the enrolled repository policy used later during provisioning).
    const firstSet = (name: string) => layers.map((l) => l?.[name]).find((v) => v !== undefined && v !== null && v !== '');
    const explicitBase = firstSet('base');
    const explicitTarget = firstSet('target');
    const repo0 = effectiveRepos(resolved, project.config)[0];
    if (repo0 && (!explicitBase || !explicitTarget)) {
      const branches = await repositoryBranchDefaults(this.deps.store, project, repo0);
      if (branches) {
        if (!explicitBase) resolved.base = branches.base;
        if (!explicitTarget) resolved.target = branches.target;
      }
    }
    return resolved;
  }

  /** Resolve one full-form field without materializing agents or probing repository
   * defaults. Used by sparse reset handling, where only the inherited value matters. */
  private resolveTaskField(manifest: WorkflowManifest, project: Project, taskOverrides: ValueMap, field: string): unknown {
    const getSettings = (scope: string, workflow: string) => this.deps.store.getSettings(scope, workflow);
    return resolveParamsLayers(manifest, [
      taskOverrides,
      projectSettingsFor(getSettings, project, manifest.name),
      globalSettingsFor(getSettings, manifest.name, project.organizationId),
    ])[field];
  }

  /** Turn the compact Agent setting into concrete per-role input. Profile defaults
   * live outside parameter settings, so this final materialization must happen
   * after the parameter overlays have selected the child scope's form shape. */
  private materializeUnifiedAgents(resolved: ValueMap, projectId: string): void {
    if (resolved.separateAgents !== false) return;
    let spec = resolved['agent:do'] as AgentSpec | undefined;
    if (!spec?.provider) {
      const resumeFrom = spec?.resumeFrom;
      const profile = roleDefaultProfile(this.deps.store, 'do', projectId);
      const provider = (profile?.provider ?? this.deps.defaultAgentProvider ?? defaultProvider().provider) as Provider;
      const model = profile?.model ?? defaultModel(provider);
      const effort = profile?.effort ?? defaultEffort(provider);
      spec = {
        provider,
        ...(model ? { model } : {}),
        ...(effort ? { effort: effort as AgentSpec['effort'] } : {}),
        ...(resumeFrom ? { resumeFrom } : {}),
        ...(profile?.mcpConnections !== undefined ? { mcpConnections: profile.mcpConnections } : {}),
      };
    }
    resolved['agent:do'] = spec;
    const { resumeFrom: _resumeFrom, ...shared } = spec;
    resolved['agent:merge'] = shared;
    if (RESOLVE_AGENT_ENABLED) resolved['agent:resolve'] = shared;
  }

  /** Capture the exact provider/model/effort selection that the activity runtime
   * will use for every declared agent role. This is execution metadata, kept in
   * KV rather than task params: task params remain sparse/inheritable until queue,
   * while a queued task's UI and audit trail stay pinned to what actually ran. */
  private effectiveAgents(manifest: WorkflowManifest, input: TaskInput): Record<string, AgentSpec> {
    const resolver = new ProfileResolver(this.deps.store, this.deps.defaultAgentProvider ?? defaultProvider().provider);
    const out: Record<string, AgentSpec> = {};
    const seen = new Set<string>();
    for (const field of manifest.params) {
      if (field.type !== 'agent' || !field.role || seen.has(field.role)) continue;
      seen.add(field.role);
      const role = field.role as AgentRole;
      const selected = input.agents?.[role];
      const base = resolver.resolve(role, input.profiles, undefined, input.projectId);
      const avatar = selected?.avatarId ? this.deps.store.getAvatar(selected.avatarId) : undefined;
      const profile = applyAvatarProfile(base, selected, avatar);
      out[role] = {
        provider: profile.provider,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
        ...(profile.mcpConnections !== undefined ? { mcpConnections: profile.mcpConnections } : {}),
        ...(selected?.resumeFrom ? { resumeFrom: selected.resumeFrom } : {}),
        ...(selected?.avatarId ? { avatarId: selected.avatarId } : {}),
        ...(selected?.avatarPurpose ? { avatarPurpose: selected.avatarPurpose } : {}),
      };
    }
    return out;
  }

  private saveAgentSnapshot(taskId: string, manifest: WorkflowManifest, input: TaskInput): void {
    const agents = this.effectiveAgents(manifest, input);
    if (Object.keys(agents).length) this.deps.store.kvSet(agentSnapshotKey(taskId), JSON.stringify(agents));
  }

  private readAgentSnapshot(taskId: string): Record<string, AgentSpec> | undefined {
    const raw = this.deps.store.kvGet(agentSnapshotKey(taskId));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** `_discardProgress` is serialized into one accepted start only. Keeping it on
   * the record would make a later cancellation recovery delete the new work. */
  private consumeDiscardProgress(taskId: string): void {
    const task = this.deps.store.getTask(taskId);
    if (!task?.params._discardProgress) return;
    const { _discardProgress: _used, ...params } = task.params as Record<string, unknown>;
    this.deps.store.updateTaskParams(taskId, params as any);
  }

  /** Keep the execution snapshot aligned with a workflow-accepted in-flight
   * agent retune. Rejected fields never reach here, so the stored display cannot
   * claim a change that the running workflow refused. */
  private updateAgentSnapshot(taskId: string, patch: Record<string, unknown>, applied: string[]): void {
    const agents = this.readAgentSnapshot(taskId);
    if (!agents) return; // legacy task: the UI still has the stored-override fallback
    let changed = false;
    for (const name of applied) {
      if (!name.startsWith('agent:')) continue;
      const role = name.slice('agent:'.length);
      const raw = patch[name];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const incoming = raw as Partial<AgentSpec>;
      const current = agents[role];
      if (!current) continue;
      const provider = incoming.provider ?? current.provider;
      const providerChanged = provider !== current.provider;
      const model = incoming.model ?? (providerChanged ? defaultModel(provider) : current.model);
      const effort = incoming.effort ?? (providerChanged ? undefined : current.effort);
      agents[role] = {
        provider,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(!providerChanged && current.resumeFrom ? { resumeFrom: current.resumeFrom } : {}),
        ...(incoming.resumeFrom ? { resumeFrom: incoming.resumeFrom } : {}),
        ...(incoming.avatarId ?? current.avatarId ? { avatarId: incoming.avatarId ?? current.avatarId } : {}),
        ...(incoming.avatarPurpose ?? current.avatarPurpose
          ? { avatarPurpose: incoming.avatarPurpose ?? current.avatarPurpose } : {}),
      };
      changed = true;
    }
    if (changed) this.deps.store.kvSet(agentSnapshotKey(taskId), JSON.stringify(agents));
  }

  /** Resolve a workflow's start type + manifest via the manager (installed) or built-ins. */
  private resolveStart(workflow: string, version?: string, organizationId = 'org_personal'): StartResolution | undefined {
    return this.deps.workflows?.resolveStart(workflow, version, organizationId) ?? bundledStart(workflow, version);
  }

  private pinKey(projectId: string, workflow: string): string {
    return `wfpin:${projectId}:${workflow}`;
  }

  /** The version a project pins `workflow` to, or undefined for latest. */
  private workflowPinFor(projectId: string, workflow: string): string | undefined {
    const v = this.deps.store.kvGet(this.pinKey(projectId, workflow));
    return v || undefined;
  }

  /** Pin a project to a version of a workflow for new tasks (§21d); empty clears to latest. */
  pinWorkflow(token: string, args: { projectId: string; workflow: string; version?: string }): { workflow: string; version: string } {
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new NotFoundError(`no project ${args.projectId}`);
    this.require(token, 'edit_workflow', { projectId: args.projectId, organizationId: project.organizationId });
    if (!this.resolveStart(args.workflow, args.version && args.version !== 'latest' ? args.version : undefined, project.organizationId))
      throw new Error(`workflow "${args.workflow}" is not available to this organization`);
    const v = args.version && args.version !== 'latest' ? args.version : '';
    this.deps.store.kvSet(this.pinKey(args.projectId, args.workflow), v);
    return { workflow: args.workflow, version: v || 'latest' };
  }

  /** The version each installed/built-in workflow is pinned to for a project (else 'latest'). */
  workflowPins(token: string, projectId: string): Record<string, string> {
    const project = this.deps.store.getProject(projectId);
    if (!project) throw new NotFoundError(`no project ${projectId}`);
    this.require(token, 'list_workflows', { projectId, organizationId: project.organizationId });
    const out: Record<string, string> = {};
    for (const w of this.deps.workflows?.list(project.organizationId) ?? []) out[w.name] = this.workflowPinFor(projectId, w.name) ?? 'latest';
    return out;
  }

  /**
   * Resolve a stored task into the (startType, TaskInput) needed to launch its
   * workflow. Shared by draft queueing and trigger firing so both re-resolve
   * against the CURRENT project/global defaults and pin the stamped version.
   * Meta fields (profiles/draft/archived/triggers) aren't workflow overrides.
   */
  private async buildStart(task: TaskRecord, migrateToLatest = false, caller?: ScopedToken): Promise<{ startType: string; input: TaskInput; version: string }> {
    const project = this.deps.store.getProject(task.projectId);
    const start = this.resolveStart(task.workflow, migrateToLatest ? undefined : task.workflowVersion, project?.organizationId);
    if (!project || !start) throw new Error(`cannot start task ${task.id}`);
    const { manifest, startType } = start;
    // Re-resolve against the CURRENT project/global defaults. The task stored only
    // its own overrides, so a draft queued after a default change picks up the new
    // default (SPEC §10.4). Meta fields (profiles/draft/archived/triggers) aren't overrides.
    const { profiles, draft: _d, archived: _a, triggers: _t, triggerState: _ts, images, files, _authorization,
      _discardProgress, _workflowRunId, ...overrides } = task.params as Record<string, unknown>;
    const resolved = await this.resolveTaskParams(manifest, project, overrides as ValueMap);
    if (caller) this.validateTaskAvatars(caller, project, manifest, resolved);
    // Drafts re-resolve at queue time. Stamp that the resulting common branch
    // values already include repository fallback so provisioning must not apply
    // the repository default again over a project/task override.
    // Concurrent lifecycle requests can arrive here with the same old snapshot.
    // A slower preparation must not overwrite the winner's _workflowRunId even
    // if its own subsequent Temporal start is rejected as already running.
    this.deps.store.patchTaskParams(task.id, {
      ...(typeof resolved.base === 'string' && resolved.base ? { base: resolved.base } : {}),
      ...(typeof resolved.target === 'string' && resolved.target ? { target: resolved.target } : {}),
      [REPOSITORY_BRANCHES_RESOLVED_PARAM]: true,
    });
    // The confirmer belongs to the logical task, not an attempt. Snapshotting it
    // once prevents attempts queued days apart from inheriting different reviewers.
    const group = this.deps.store.attemptGroup(task.id);
    const confirmerField = manifest.params.find((f) => f.type === 'confirmer');
    if (confirmerField && group?.confirmer !== undefined) resolved[confirmerField.name] = group.confirmer;
    this.assertHumanRoutes(task, manifest, resolved);
    // Same guard as createTask, on the resolved effective repos, before we clear the draft.
    this.assertRepositoriesValid(manifest, project, resolved);
    const input = assembleTaskInput(manifest, resolved, {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      project: this.deps.store.effectiveProjectConfig(project),
    });
    input.createdAt = task.createdAt;
    input.workflow = task.workflow;
    const auth = _authorization as { capabilities?: string[]; principal?: string; profileId?: string; delegationId?: string } | undefined;
    input.grant = auth?.capabilities ?? ['task:signal'];
    input.grantPrincipal = auth?.principal ?? 'system:legacy-task';
    input.delegationId = auth?.delegationId;
    input.authorizationProfile = auth?.profileId ?? 'legacy';
    input.resolveAgentEnabled = RESOLVE_AGENT_ENABLED;
    input.intentId = task.intentId ?? task.id;
    if (profiles) input.profiles = profiles as Record<string, string>;
    if ((images as ImageRef[] | undefined)?.length) input.images = images as ImageRef[];
    if ((files as FileRef[] | undefined)?.length) input.files = files as FileRef[];
    if (_discardProgress === true) input.discardProgress = true;
    return { startType, input, version: manifest.version };
  }

  private assertHumanRoutes(task: TaskRecord, manifest: WorkflowManifest, resolved: ValueMap): void {
    const routes: { label: string; audience: string[] }[] = [];
    const confirmer = manifest.params.find((candidate) => candidate.type === 'confirmer');
    const confirmValue = confirmer && resolved[confirmer.name];
    if (confirmValue && typeof confirmValue === 'object') {
      for (const layer of confirmLayersOf(confirmValue as import('../domain/types.js').ConfirmConfig)) {
        if (layer.kind === 'human') routes.push({
          label: 'Review route', audience: layer.audience?.length ? layer.audience : ['@creator'],
        });
      }
    }
    const responder = manifest.params.find((candidate) => candidate.type === 'responder');
    const responderValue = responder && resolved[responder.name];
    if (responderValue && typeof responderValue === 'object'
      && (responderValue as import('../domain/types.js').ResponderConfig).kind !== 'agent') {
      const value = responderValue as import('../domain/types.js').ResponderConfig;
      routes.push({ label: 'Responder', audience: value.audience?.length ? value.audience : ['@creator'] });
    }
    for (const route of routes) {
      const audience = route.audience;
      if (!this.deps.store.humanAudience(task.id, audience).length) {
        const project = this.deps.store.getProject(task.projectId);
        // A pre-collaboration/local database can contain historical tasks before
        // its personal organization is claimed. Do not make those tasks
        // unrecoverable; once an organization has people, every route must
        // resolve before new work can run.
        if (project?.organizationId
          && this.deps.store.listOrganizationMemberships(project.organizationId).length === 0) continue;
        throw new Error(`${route.label} ${audience.join(', ')} does not resolve to a human in this organization`);
      }
    }
  }

  /**
   * Mark a stored task as *armed* on its triggers and register it with the
   * dispatcher (SPEC §3.3). Shared by createTask and queueTask so both the
   * "create with triggers" and "save draft → queue" paths gate correctly.
   * Clears any draft flag — an armed task is live (waiting), not a draft.
   */
  private armStoredTask(taskId: string): TaskRecord {
    const task = this.deps.store.getTask(taskId)!;
    // Validate BEFORE any mutation, and prefer the armer's graph-aware check.
    // Two bugs here: the pure `validateTriggers` cannot see self-dependencies,
    // cycles, or dangling dependency ids (it has no store), so those only surfaced
    // later inside `arm()` — by which point `clearDraft` and `triggerState: armed`
    // had already been persisted, leaving a rejected task marked armed but never
    // registered with the dispatcher, i.e. waiting forever with nothing to fire it.
    const errs = this.armer?.validationErrors?.(task) ?? validateTriggers(normalizeTriggers(task.params));
    if (errs.length) throw new Error(`invalid trigger(s): ${errs.join('; ')}`);
    // Arming is the queue transition for triggered work, so this also assigns
    // the logical task's human-facing number if it has never been queued before.
    this.deps.store.clearDraft(taskId);
    const queued = this.deps.store.getTask(taskId)!;
    this.deps.store.updateTaskParams(taskId, { ...queued.params, triggerState: 'armed' });
    const armed = this.deps.store.getTask(taskId)!;
    this.armer?.arm(armed);
    return armed;
  }

  /**
   * A stored grant (`params._authorization`) was minted for the principal who
   * saved the draft or series. Anyone else who queues, arms, spawns or clones it
   * — a project developer with `task:create`, or a Do agent that rewrote its
   * prompt via `task:edit` — must themselves be able to grant every capability
   * in it; otherwise an administrator's draft is a privilege-escalation template.
   */
  private assertStoredGrantQueueable(token: string, caller: ScopedToken, task: TaskRecord): void {
    if (!this.deps.authorization || caller.kind === 'system') return;
    const stored = task.params?._authorization as { principal?: string; capabilities?: string[] } | undefined;
    if (!stored?.capabilities?.length || stored.principal === caller.principal) return;
    const { authorization: selection } = previousTaskGrants(task);
    if (!selection) return;
    const organizationId = this.deps.store.getProject(task.projectId)?.organizationId ?? 'org_personal';
    const grantorCaps = this.authorizationGrantorCaps(token, caller, selection, organizationId);
    const held = this.deps.authorization.taskGrant(caller.principal, task.projectId, selection, grantorCaps).capabilities;
    const missing = stored.capabilities.filter((capability) => !allows(held, capability));
    if (missing.length) {
      throw new AuthorizationGrantError(`this task was authorized by ${stored.principal ?? 'another principal'}; `
        + `you cannot start it with authorization you do not hold (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`);
    }
  }

  /** Start a previously-saved draft (SPEC §10.4). */
  async queueTask(token: string, taskId: string): Promise<TaskRecord> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    const caller = this.require(token, 'create_task', { projectId: task.projectId, taskId });
    const storedAuthorization = task.params?._authorization as {
      profileAttenuated?: boolean; attenuationAccepted?: boolean;
    } | undefined;
    if (storedAuthorization?.profileAttenuated && !storedAuthorization.attenuationAccepted)
      throw new AuthorizationGrantError('you cannot grant the agent more authorization than you have');
    this.assertStoredGrantQueueable(token, caller, task);
    const group = this.deps.store.attemptGroup(taskId);
    if (group?.committedAttemptId && group.otherAttempts !== 'keep' && group.committedAttemptId !== taskId) {
      throw new Error('another attempt has entered Merge; this task is committed and no other attempt can be queued');
    }
    // Queuing a task that carries triggers ARMS it (activates its triggers) rather
    // than starting now — otherwise a triggered draft would start immediately and
    // its triggers would be pointless. `fired` tasks have already started.
    if (hasActiveTriggers(task.params) && task.params.triggerState !== 'fired') {
      return this.armStoredTask(taskId);
    }
    // A repeatable series never runs its own workflow — queueing it spawns a run.
    if (task.params.repeatable) {
      this.deps.store.clearDraft(taskId);
      await this.spawnRun(token, taskId);
      return this.deps.store.getTask(taskId)!;
    }
    // Pin to the version stamped when the draft was created, not whatever is
    // current now — queueing a draft after an upgrade must not silently swap code.
    const { startType, input } = await this.buildStart(task, false, caller);
    const hadNumber = task.num != null;
    this.deps.store.clearDraft(taskId);
    // Bounded + compensated: on a wedged engine, restore the draft and release a
    // number minted by this failed transition. Previously established permalinks
    // remain stable when already-numbered work is queued again.
    try {
      const started = await withTimeout(
        this.deps.client.workflow.start(startType, {
          taskQueue: this.deps.taskQueue,
          workflowId: task.id,
          // Queueing is idempotent. In particular, never create a second run if
          // the first one finished before a lost start acknowledgement is retried.
          workflowIdReusePolicy: input.discardProgress
            ? WorkflowIdReusePolicy.ALLOW_DUPLICATE
            : WorkflowIdReusePolicy.REJECT_DUPLICATE,
          args: [input],
        }),
        START_TIMEOUT_MS,
      );
      const runId = (started as any)?.firstExecutionRunId ?? (started as any)?.runId;
      if (typeof runId === 'string' && runId) {
        this.deps.store.patchTaskParams(taskId, { _workflowRunId: runId });
      }
    } catch (e) {
      // A start acknowledgement can be lost after Temporal durably accepted the
      // workflow. The retry then reports "already started"; that is proof of
      // acceptance for this task's unique workflow ID, not a queue failure.
      // Keep the task queued and repair the stale draft metadata.
      if (!(e instanceof WorkflowExecutionAlreadyStartedError)) {
        this.deps.store.restoreDraft(taskId, !hadNumber);
        throw new Error(
          `Could not queue task: the durable engine didn't accept it (${e instanceof Error ? e.message : String(e)}). ` +
            `It's still saved as a draft — check that Temporal is healthy and try again.`,
        );
      }
    }
    const started = this.resolveStart(task.workflow, task.workflowVersion,
      this.deps.store.getProject(task.projectId)?.organizationId);
    if (started) this.saveAgentSnapshot(task.id, started.manifest, input);
    this.consumeDiscardProgress(taskId);
    return this.deps.store.getTask(taskId)!;
  }

  /**
   * Layer per-task vault item grants onto the attenuated profile package
   * (PLAN-passwords.md §6). A creator can attach only items its own grant
   * covers — or any item when it holds credential administration — so a
   * confused deputy cannot mint credential access it does not have. Dropped
   * grants mark the task attenuated rather than failing creation.
   */
  private applyCredentialGrants(
    authorization: { capabilities: Capability[]; attenuated: boolean },
    requested: string[] | undefined,
    callerCaps: Capability[],
  ): void {
    for (const raw of requested ?? []) {
      const cap = String(raw);
      if (!cap.startsWith('use-credential:')) throw new Error(`credentialGrants entries must be use-credential:… capabilities (got ${cap})`);
      if (allows(callerCaps, cap) || allows(callerCaps, 'credential:write')) {
        if (!authorization.capabilities.includes(cap)) authorization.capabilities.push(cap);
      } else {
        authorization.attenuated = true;
      }
    }
  }

  private credentialPolicyOverrides(
    organizationId: string,
    requested: VaultTaskPolicyOverrides | undefined,
    callerCaps: Capability[],
    authorization: { attenuated: boolean },
  ): VaultTaskPolicyOverrides {
    const vault = new VaultItems(this.deps.store, undefined, undefined, organizationId);
    const out: VaultTaskPolicyOverrides = {};
    const canAdminister = allows(callerCaps, 'credential:write');
    const useRank: Record<VaultItemPolicy['use'], number> = { auto: 0, ask: 1 };
    const revealRank: Record<VaultItemPolicy['reveal'], number> = { auto: 0, ask: 1, never: 2 };
    for (const [itemId, raw] of Object.entries(requested ?? {})) {
      const item = vault.get(itemId);
      if (!item || (!canAdminister && !allows(callerCaps, `use-credential:item:${itemId}`))) {
        authorization.attenuated = true;
        continue;
      }
      const policy: Partial<VaultItemPolicy> = {};
      if (raw?.use === 'auto' || raw?.use === 'ask') {
        if (canAdminister || useRank[raw.use] >= useRank[item.policy.use]) policy.use = raw.use;
        else authorization.attenuated = true;
      }
      if (raw?.reveal === 'auto' || raw?.reveal === 'ask' || raw?.reveal === 'never') {
        if (canAdminister || revealRank[raw.reveal] >= revealRank[item.policy.reveal]) policy.reveal = raw.reveal;
        else authorization.attenuated = true;
      }
      if (Object.keys(policy).length) out[itemId] = policy;
    }
    return out;
  }

  private persistTaskCredentialPolicies(task: TaskRecord): void {
    const organizationId = this.deps.store.getProject(task.projectId)?.organizationId ?? 'org_personal';
    const authorization = task.params?._authorization as { credentialPolicies?: VaultTaskPolicyOverrides } | undefined;
    new VaultItems(this.deps.store, undefined, undefined, organizationId)
      .setTaskPolicies(task.id, authorization?.credentialPolicies ?? {});
  }

  private inheritTaskDelegation(source: TaskRecord, target: TaskRecord): TaskRecord {
    const sourceAuthorization = source.params?._authorization as { delegationId?: string } | undefined;
    if (!sourceAuthorization?.delegationId) return target;
    const parent = this.deps.tokens.deriveHumanDelegation(sourceAuthorization.delegationId, {
      taskId: target.id, projectId: target.projectId,
      organizationId: this.deps.store.getProject(target.projectId)?.organizationId,
    });
    this.deps.store.updateTaskParams(target.id, { ...target.params,
      _authorization: { ...(target.params._authorization as object), delegationId: parent.id },
      ...(parent.externalIdentities?.githubAccountId
        ? { _githubAccountId: parent.externalIdentities.githubAccountId } : {}) });
    return this.deps.store.getTask(target.id)!;
  }

  /** Change the job-shaped grant on a task — before it starts, or in-flight while
   * it runs (SPEC §5.5). The selected profile is always re-attenuated against the
   * immediate bearer, so an agent cannot use a human principal recorded on the
   * draft as a confused deputy. For a running task the change is pushed into the
   * live workflow (which validates the lifecycle window and re-points its grant so
   * the next turn mints from it) BEFORE it's persisted — mirroring updateParams. */
  async setTaskAuthorization(
    token: string,
    taskId: string,
    requested: string | AuthorizationSelection,
    credentialGrants?: string[],
    credentialPolicies?: VaultTaskPolicyOverrides,
    options: { allowAttenuation?: boolean; acceptAttenuation?: boolean; preserveCredentialGrants?: boolean } = {},
  ): Promise<TaskRecord> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    // Drafts, armed triggers, and repeatable series have no running workflow — edit
    // their stored authorization in place. Everything else routes through the live
    // workflow update below (frozen only once it's cancelled/terminal).
    const editInPlace = !!task.params?.draft || task.params?.triggerState === 'armed' || !!task.params?.repeatable;
    const caller = this.require(token, 'create_task', { projectId: task.projectId, taskId });
    const organizationId = this.deps.store.getProject(task.projectId)?.organizationId ?? 'org_personal';
    const grantorCaps = this.authorizationGrantorCaps(token, caller, requested, organizationId);
    const authorization = this.deps.authorization
      ? this.deps.authorization.taskGrant(caller.principal, task.projectId, requested, grantorCaps)
      : { profileId: typeof requested === 'string' ? requested : requested.level, capabilities: caller.caps, attenuated: false };
    const profileAttenuated = authorization.attenuated;
    this.applyCredentialGrants(authorization, credentialGrants, caller.caps);
    const priorAuthorization = task.params?._authorization as {
      credentialPolicies?: VaultTaskPolicyOverrides; delegationId?: string; principal?: string;
      attenuationAccepted?: boolean; level?: string; scope?: string; projectIds?: string[]; capabilities?: string[];
    } | undefined;
    if (options.preserveCredentialGrants) for (const capability of priorAuthorization?.capabilities ?? []) {
      if (capability.startsWith('use-credential:') && !authorization.capabilities.includes(capability))
        authorization.capabilities.push(capability);
    }
    const priorPolicies = priorAuthorization?.credentialPolicies;
    const policies = credentialPolicies === undefined
      ? (priorPolicies ?? {})
      : this.credentialPolicyOverrides(
        this.deps.store.getProject(task.projectId)?.organizationId ?? 'org_personal',
        credentialPolicies,
        caller.caps,
        authorization,
      );
    const sameSelection = typeof requested === 'string'
      ? requested === priorAuthorization?.level
      : requested.level === priorAuthorization?.level
        && requested.scope === priorAuthorization?.scope
        && JSON.stringify(requested.projectIds ?? []) === JSON.stringify(priorAuthorization?.projectIds ?? []);
    const attenuationAccepted = profileAttenuated
      && (options.acceptAttenuation === true || sameSelection && priorAuthorization?.attenuationAccepted === true);
    if (typeof requested !== 'string' && profileAttenuated
      && !(editInPlace && options.allowAttenuation) && !attenuationAccepted)
      throw new AuthorizationGrantError('you cannot grant the agent more authorization than you have');
    const authorizationScope = authorization as typeof authorization & {
      scope?: 'projects' | 'organization' | 'global'; projectIds?: string[]; organizationId?: string;
    };
    // Every authorization update must mint fresh delegated provenance with the
    // new scope. Reusing the old delegation is not merely stale metadata: a
    // project-scoped draft promoted to Administrator would otherwise keep its
    // project-only human delegation, then fail before its first agent turn when
    // the workflow mints an organization-scoped token from it. An authorization
    // update is itself carried by a verified bearer, so it is the correct
    // authority boundary both for backfilling historical tasks and for changing
    // scope. Never infer a subject from `principal`, and never replace a task's
    // already-pinned account with the caller's currently-active account.
    const pinnedGithubAccountId = typeof task.params?._githubAccountId === 'string'
      ? task.params._githubAccountId : undefined;
    const delegatedGithubAccountId = pinnedGithubAccountId
      ?? (caller.kind === 'agent'
        ? caller.externalIdentities?.githubAccountId
        : caller.humanSubject
          ? this.deps.githubApp?.activeUserAccountId(caller.humanSubject.userId)
          : undefined);
    const delegation = this.delegateTaskHuman(token, caller, {
      taskId,
      projectId: authorizationScope.scope ? undefined : task.projectId,
      projectIds: authorizationScope.scope === 'projects' ? authorizationScope.projectIds : undefined,
      organizationId: authorizationScope.scope === 'global' ? undefined
        : (authorizationScope.organizationId ?? organizationId),
      externalIdentities: delegatedGithubAccountId ? { githubAccountId: delegatedGithubAccountId } : undefined,
    });
    if (!editInPlace) {
      // The workflow validator is the single source of truth for the in-flight
      // window; if it rejects (cancelled / past the point of no return / already
      // finished) we surface that and leave the stored authorization untouched.
      try {
        await this.deps.client.workflow.getHandle(taskId).executeUpdate('updateAuthorization', {
          args: [{
            grant: authorization.capabilities,
            grantPrincipal: caller.principal,
            authorizationProfile: authorization.profileId ?? (typeof requested === 'string' ? requested : requested.level),
          }],
        });
      } catch (e) {
        throw new Error(unwrapCause(e));
      }
    }
    const { delegationId: _staleDelegationId, ...priorAuthorizationWithoutDelegation } = priorAuthorization ?? {};
    this.deps.store.patchTaskParams(taskId, {
      _authorization: { ...priorAuthorizationWithoutDelegation, ...authorization, profileAttenuated,
        principal: caller.principal, credentialPolicies: policies,
        ...(delegation ? { delegationId: delegation.id } : {}),
        ...(profileAttenuated ? { attenuationAccepted } : { attenuationAccepted: undefined }) },
      ...(!pinnedGithubAccountId && delegation?.externalIdentities?.githubAccountId
        ? { _githubAccountId: delegation.externalIdentities.githubAccountId } : {}),
    });
    const updated = this.deps.store.getTask(taskId)!;
    this.persistTaskCredentialPolicies(updated);
    const requests = new PermissionRequests(this.deps.store, organizationId);
    for (const request of requests.requests({ taskId, status: 'pending' })) {
      // A manual decision may itself be updating the task's scope.
      if (this.resolvingPermissions.has(`${organizationId}:${request.id}`)) continue;
      if (requests.requests().find((candidate) => candidate.id === request.id)?.status !== 'pending') continue;
      if (this.permissionRequestSatisfied(this.deps.store.getTask(taskId)!, request))
        await this.finishPermissionDecision(requests, request, 'approve', caller.principal, true);
    }
    return updated;
  }

  private authorizationGrantorCaps(
    token: string,
    caller: ScopedToken,
    requested: string | AuthorizationSelection | undefined,
    organizationId: string,
  ): Capability[] | undefined {
    // An authenticated human's durable grants are evaluated independently for
    // every selected project. A task/system bearer must use only its immediate
    // token: looking up the named human would turn it into a confused deputy.
    if (caller.kind === 'human' && caller.principal.startsWith('user:')) return undefined;
    if (!requested || typeof requested === 'string') return caller.caps;
    if (requested.scope === 'projects') {
      for (const projectId of requested.projectIds ?? []) {
        const checked = this.deps.tokens.check(token, 'task:create', { projectId, organizationId });
        if (!checked.ok) throw new CapabilityError(`you cannot delegate access to project ${projectId}: ${checked.reason}`);
      }
    } else if (requested.scope === 'organization') {
      if (caller.organizationId !== organizationId || caller.projectId || caller.projectIds?.length)
        throw new CapabilityError('this token cannot delegate organization-wide access');
    } else if (caller.projectId || caller.projectIds?.length || caller.organizationId) {
      throw new CapabilityError('this token cannot delegate global access');
    }
    return caller.caps;
  }

  /** `taskGrant` has already checked an interactive human's durable grants for
   * the selected scope. Preserve that wider authorization when the browser's
   * short-lived API token is intentionally narrowed to the current route's
   * project; non-human callers still attenuate strictly from their bearer. */
  private delegateTaskHuman(token: string, caller: ScopedToken, args: HumanDelegationArgs) {
    return this.deps.authorization && caller.kind === 'human' && caller.principal.startsWith('user:')
      ? this.deps.tokens.delegateAuthorizedInteractiveHuman(token, args)
      : this.deps.tokens.delegateHuman(token, args);
  }

  /**
   * Spawn a **run** from a series (repeatable template) and start it — a fresh
   * task record linked to the series via `runOf`, with trigger/series metadata
   * stripped so it's a plain one-off execution with its own history. Used on
   * each trigger fire of a repeatable series, and by "Run again".
   */
  async spawnRun(token: string, seriesId: string): Promise<TaskRecord> {
    const series = this.deps.store.getTask(seriesId);
    // Scope the check to the series' own project (the run inherits it), so a
    // project-scoped token cannot spawn a run from another project's series.
    const caller = this.require(token, 'create_task', { projectId: series?.projectId, taskId: seriesId });
    if (!series) throw new NotFoundError(`no task ${seriesId}`);
    this.assertStoredGrantQueueable(token, caller, series);
    let run = this.deps.store.createTask({
      projectId: series.projectId,
      listId: series.listId,
      title: series.title,
      workflow: series.workflow,
      workflowVersion: series.workflowVersion,
      params: { ...cloneParamsWithoutTriggers(series.params), runOf: seriesId },
      parentTaskId: series.parentTaskId,
      createdBy: principalRefOf(caller.principal) ?? series.createdBy,
      assignee: series.assignee,
      delegate: series.delegate,
      confirmationPolicy: series.confirmationPolicy,
    });
    run = this.inheritTaskDelegation(series, run);
    this.persistTaskCredentialPolicies(run);
    const { startType, input } = await this.buildStart(run);
    try {
      await withTimeout(
        this.deps.client.workflow.start(startType, { taskQueue: this.deps.taskQueue, workflowId: run.id, args: [input] }),
        START_TIMEOUT_MS,
      );
    } catch (e) {
      this.deps.store.deleteTask(run.id); // no orphan run row on a wedged engine
      throw e;
    }
    const started = this.resolveStart(run.workflow, run.workflowVersion,
      this.deps.store.getProject(run.projectId)?.organizationId);
    if (started) this.saveAgentSnapshot(run.id, started.manifest, input);
    return run;
  }

  /** "Run again": spawn a fresh run from a series on demand. */
  async runAgain(token: string, seriesId: string): Promise<{ startedTaskId: string }> {
    return { startedTaskId: (await this.spawnRun(token, seriesId)).id };
  }

  /**
   * Start an armed triggered task because a trigger fired (called by the
   * dispatcher). `self` starts the armed task itself (a non-repeatable one-off);
   * `clone` spawns a run from the series and leaves the armed template in place
   * (a repeatable series — cron, or any recurring trigger). Re-arms the task on a
   * start failure so a fire is never silently lost.
   */
  async fireTriggeredTask(token: string, taskId: string, mode: 'self' | 'clone'): Promise<{ startedTaskId: string }> {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'create_task', { projectId: task?.projectId, taskId });
    if (!task) throw new NotFoundError(`no task ${taskId}`);

    if (mode === 'clone') return { startedTaskId: (await this.spawnRun(token, taskId)).id };

    const fired: Record<string, unknown> = { ...(task.params as Record<string, unknown>), triggerState: 'fired' };
    delete fired.triggerPending;
    this.deps.store.updateTaskParams(taskId, fired as any);
    try {
      const { startType, input } = await this.buildStart({ ...task, params: fired as any });
      await withTimeout(
        this.deps.client.workflow.start(startType, { taskQueue: this.deps.taskQueue, workflowId: task.id, args: [input] }),
        START_TIMEOUT_MS,
      );
      const started = this.resolveStart(task.workflow, task.workflowVersion,
        this.deps.store.getProject(task.projectId)?.organizationId);
      if (started) this.saveAgentSnapshot(task.id, started.manifest, input);
      this.consumeDiscardProgress(taskId);
    } catch (e) {
      // "Already started" is not a failure to compensate for: the execution IS
      // running under this task's workflow id (a duplicate fire, a retried
      // dispatch). Re-arming would leave the row claiming `armed` while the
      // workflow runs, and `src/platform/reconcile.ts` then excludes it from
      // reconciliation forever — the task is permanently invisible to recovery.
      if (e instanceof WorkflowExecutionAlreadyStartedError) return { startedTaskId: taskId };
      this.deps.store.updateTaskParams(taskId, { ...(task.params as Record<string, unknown>), triggerState: 'armed' } as any);
      throw e;
    }
    return { startedTaskId: taskId };
  }

  /**
   * Start an armed task immediately, bypassing the wait (the UI "Run now"). A
   * repeatable series spawns a run and stays armed; a one-off starts itself and
   * is disarmed.
   */
  async runArmedNow(token: string, taskId: string): Promise<{ startedTaskId: string }> {
    const task = this.deps.store.getTask(taskId);
    if (task?.params?.repeatable) return this.runAgain(token, taskId);
    this.armer?.disarm(taskId); // take it off the dispatcher so no later event double-fires
    return this.fireTriggeredTask(token, taskId, 'self');
  }

  /** Cancel a task's triggers: disarm it and keep it as an editable draft. */
  async cancelTrigger(token: string, taskId: string): Promise<TaskRecord> {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'edit_task', { projectId: task?.projectId, taskId });
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    this.armer?.disarm(taskId);
    // Drop dispatcher bookkeeping along with the armed state. Keeping
    // `triggerLastFiredAt` while disarming meant a task paused for days and then
    // re-queued looked, to `catchUpCron`, like a task that had missed an
    // occurrence — so it fired once immediately on being re-queued. Pausing is
    // not missing: a task that was deliberately not armed has nothing to catch up.
    const { triggerState: _s, triggerLastFiredAt: _f, triggerPending: _p, ...rest } = task.params as Record<string, unknown>;
    this.deps.store.updateTaskParams(taskId, { ...rest, draft: true } as any);
    return this.deps.store.getTask(taskId)!;
  }

  /**
   * Edit a waiting (armed) task in place — its workflow hasn't started, so its
   * stored params (including its triggers) are freely editable, exactly like a
   * draft. `keepArmed` re-arms with the new triggers (Save); otherwise it disarms
   * back to a draft (Save as draft). Removing all triggers also drops it to a draft.
   */
  async updateArmedParams(
    token: string,
    taskId: string,
    params: Record<string, unknown>,
    opts: { replace?: boolean; keepArmed?: boolean } = {},
  ): Promise<TaskRecord> {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'edit_task', { projectId: task?.projectId, taskId });
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    this.assertBranchParams(params);
    // Editing params can introduce a `resumeFrom` pointer at another task, so
    // the same source-side conversation check as createTask applies here.
    this.validateAndAuthorizeResumeSources(token, params);
    const inheritedFiles = this.inheritedResumeFiles(params);
    for (const file of inheritedFiles) this.deps.store.grantAttachment(file.id, task.projectId);
    const promptFiles = uniqueFileRefs([
      ...((params.files as FileRef[] | undefined) ?? []),
      ...inheritedFiles,
    ]);
    if (promptFiles.length) {
      this.validatePromptFiles(task.projectId, promptFiles);
      params.files = promptFiles;
    }
    const { archived, profiles, priority, _authorization } = task.params;
    const meta = {
      ...(archived !== undefined ? { archived } : {}),
      ...(profiles !== undefined ? { profiles } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(_authorization !== undefined ? { _authorization } : {}),
    };
    const start = this.resolveStart(task.workflow, task.workflowVersion,
      this.deps.store.getProject(task.projectId)?.organizationId);
    const confirmerField = start?.manifest.params.find((f) => f.type === 'confirmer');
    if (confirmerField) {
      let confirmer = Object.prototype.hasOwnProperty.call(params, confirmerField.name)
        ? params[confirmerField.name]
        : undefined;
      // Full-form replacement is sparse: a field reset to its inherited default
      // is intentionally omitted. The logical task also owns an effective confirmer
      // snapshot shared by all attempts, so refresh that snapshot from the current
      // defaults instead of leaving a previously autosaved partial value behind.
      if (confirmer === undefined && opts.replace && start) {
        const project = this.deps.store.getProject(task.projectId);
        if (project) confirmer = this.resolveTaskField(start.manifest, project, params as ValueMap, confirmerField.name);
      }
      if (confirmer !== undefined) {
        this.deps.store.setIntentConfirmer(task.intentId ?? task.id, confirmerField.name, confirmer);
      }
    }
    const base: Record<string, unknown> = opts.replace ? { ...meta, ...params } : { ...task.params, ...params };
    this.prepareForkWorld(task.projectId, base, task.params);
    // Authorization is platform metadata, never a workflow-form field.
    if (_authorization !== undefined) base._authorization = _authorization;
    delete base.triggerState; // lifecycle flags are managed below, never taken from the form
    delete base.draft;
    // Keep the display title tracking the (edited) prompt — the title was derived
    // from the prompt at creation, so an edit should carry through (SPEC §10).
    if (typeof base.prompt === 'string' && base.prompt.trim()) this.deps.store.setTaskTitle(taskId, firstLine(String(base.prompt)));
    // A cron/recurring trigger forces the series flag on (mirrors createTask).
    if (forcesRepeatable(normalizeTriggers(base))) base.repeatable = true;
    // A repeatable series stays a series when saved: persist, then arm it if it
    // has triggers (each fire spawns a run) or leave it as a manual template.
    if (base.repeatable && opts.keepArmed !== false) {
      this.deps.store.updateTaskParams(taskId, base as any);
      if (hasActiveTriggers(base)) return this.armStoredTask(taskId);
      this.armer?.disarm(taskId);
      return this.deps.store.getTask(taskId)!;
    }
    if (opts.keepArmed !== false && hasActiveTriggers(base)) {
      this.deps.store.updateTaskParams(taskId, base as any);
      return this.armStoredTask(taskId); // re-validate + re-arm (disarm old, arm new)
    }
    this.armer?.disarm(taskId);
    this.deps.store.updateTaskParams(taskId, { ...base, draft: true } as any);
    return this.deps.store.getTask(taskId)!;
  }

  async getTaskView(
    token: string,
    taskId: string,
    opts?: { live?: boolean },
  ): Promise<TaskView | undefined> {
    const rec = this.deps.store.getTask(taskId);
    this.require(token, 'get_task', { projectId: rec?.projectId, taskId });
    const snapshot = () => this.deps.store.getTask(taskId)?.lastView;
    // Cosmetic notes and the queue-time effective agent snapshot live outside the
    // workflow history, so mirror both onto whichever view we return. Keeping the
    // agent snapshot platform-side avoids changing immutable workflow replay payloads.
    const enrich = async (view: TaskView | undefined): Promise<TaskView | undefined> => {
      if (!view) return view;
      view = this.deps.store.withPendingReviewInfo(taskId, view);
      // Existing parked executions recorded only "account". Read the small
      // coordinator projection to explain that wait without replaying the task
      // or restarting its agent. New lease results already carry this detail.
      if (view.waitingFor?.kind === 'account' && !view.waitingFor.detail) {
        try {
          const lease = await withTimeout(this.deps.client.workflow.getHandle(accountCoordinatorId())
            .query(QRY_ACCOUNT_LEASE, { taskId }) as Promise<{
              waiting: boolean; earliestResetAt?: number; detail?: string;
            }>, 500);
          if (lease.waiting && lease.detail) view = { ...view, waitingFor: {
            ...view.waitingFor, detail: lease.detail,
            ...(lease.earliestResetAt !== undefined ? { earliestResetAt: lease.earliestResetAt } : {}),
          } };
        } catch { /* A coordinator outage must not block reading the task. */ }
      }
      const agents = this.readAgentSnapshot(taskId);
      const task = this.deps.store.getTask(taskId);
      return {
        ...view,
        notes: task?.notes,
        ...(agents ? { agents } : {}),
        ...(task ? { stageTransitions: this.availableStageTransitions(task, view) } : {}),
        ...(view.status === 'failed' && RECOVERABLE_WORKFLOWS.has(view.workflow) && !view.pointOfNoReturnPassed
          ? { actions: FAILED_RECOVERY_ACTIONS() }
          : { actions: this.lifecycleActions(view) }),
      };
    };
    // Snapshot-first (the default). The workflow persists `lastView` to the store on
    // every change via the `publishView` activity AND pushes a `view.updated` event
    // over the bus/WebSocket in the same call — so the stored snapshot is kept fresh
    // push-style and any open UI refetches the instant it changes. Serving it directly
    // avoids a live workflow `query('view')`, which on a sticky-cache miss forces the
    // worker to replay the whole (never-trimmed) history — seconds of latency, paid on
    // *every* drawer open and once per row on the task list. `opts.live` opts back into
    // the authoritative query for the few callers that must not read a lagging snapshot
    // (post-`updateParams` responses, review-action resolution). We also fall through to
    // a live query when there is no snapshot yet (a brand-new task, pre-first-publish).
    const snap = snapshot();
    // softwareDev@1.0.0 could persist "waiting for account" immediately before
    // scheduling a turn, then clear it only in workflow memory after the grant.
    // It cannot add a publish at that point without breaking replay. Treat that
    // one legacy shape as stale-prone and query its authoritative live state;
    // current workflows carry agentTurn and remain snapshot-fast.
    const legacyAccountWait =
      this.deps.store.getTask(taskId)?.workflowVersion === '1.0.0' &&
      snap?.waitingFor?.kind === 'account' &&
      !snap.agentTurn;
    if (snap && !opts?.live && !legacyAccountWait) return enrich(snap);
    // Live path — bound it: a wedged workflow (e.g. stuck in a workflow-task-failure
    // loop) makes a query hang without rejecting, which would otherwise freeze the
    // caller. Fall back fast to whatever snapshot we have.
    try {
      const q = this.workflowHandle(taskId).query('view') as Promise<TaskView>;
      q.catch(() => undefined); // swallow the late rejection if we time out first
      const view = await withTimeout(q, QUERY_TIMEOUT_MS);
      return enrich((view as TaskView) ?? snapshot());
    } catch {
      return enrich(snapshot());
    }
  }

  /** Lifecycle mutations must not act on `lastView`: publishing that snapshot is
   * an activity, so the deterministic workflow can already be in the next stage
   * while the store still shows the previous one. A stale read here can hold,
   * terminate, or restore the wrong stage. Terminal views have no live execution
   * to query; every active/waiting mutation requires the authoritative query and
   * fails closed when it cannot be obtained. */
  private async transitionSourceView(task: TaskRecord): Promise<TaskView> {
    const snapshot = task.lastView;
    if (!snapshot) throw new Error('task has no lifecycle state yet');
    if (['done', 'cancelled', 'failed'].includes(snapshot.status)) return this.deps.store.withPendingReviewInfo(task.id, snapshot);
    try {
      const query = this.workflowHandle(task.id).query('view') as Promise<TaskView>;
      query.catch(() => undefined);
      const view = await withTimeout(query, QUERY_TIMEOUT_MS);
      if (!view || typeof view !== 'object' || !view.stage || !view.status)
        throw new Error('the workflow returned no lifecycle view');
      return this.deps.store.withPendingReviewInfo(task.id, view);
    } catch (error) {
      throw new Error(`Cannot move ${task.title}: the live workflow stage is unavailable (${unwrapCause(error)}). Try again once the worker is healthy.`);
    }
  }

  /** Drawer-only projection for an unqueued attempt, which has no workflow view. */
  getDraftView(
    token: string,
    taskId: string,
    group?: { committedAttemptId?: string },
  ): TaskView | undefined {
    this.require(token, 'get_task');
    const record = this.deps.store.getTask(taskId);
    if (!record?.params?.draft) return undefined;
    const view: TaskView = {
      taskId: record.id,
      title: record.title,
      workflow: record.workflow,
      stage: 'setup',
      status: 'waiting',
      notes: record.notes,
      messages: record.params.prompt
        ? [{ id: 'draft-prompt', role: 'user', text: String(record.params.prompt), ts: record.createdAt }]
        : [],
      actions: [],
      state: { draft: true },
      updatedAt: record.createdAt,
    };
    view.stageTransitions = this.availableStageTransitions(record, view, group);
    return view;
  }

  async listTasks(token: string, projectId: string): Promise<TaskRecord[]> {
    this.require(token, 'list_tasks', { projectId });
    return this.deps.store.listTasks(projectId);
  }

  async listTaskSummaries(token: string, projectId: string): Promise<TaskRecord[]> {
    this.require(token, 'list_tasks', { projectId });
    return this.deps.store.listTaskSummaries(projectId);
  }

  /** Create an editable, unqueued alternate by cloning an existing attempt. */
  async addAttempt(token: string, sourceTaskId: string): Promise<TaskRecord> {
    const source = this.deps.store.getTask(sourceTaskId);
    const caller = this.require(token, 'create_task', { projectId: source?.projectId, taskId: sourceTaskId });
    if (!source) throw new NotFoundError(`no task ${sourceTaskId}`);
    this.assertStoredGrantQueueable(token, caller, source);
    const group = this.deps.store.attemptGroup(sourceTaskId);
    if (!group) throw new Error('task has no attempt group');
    if (group.committedAttemptId) throw new Error('no more attempts can be added after an attempt enters Merge');
    const { archived: _archived, draft: _draft, triggers: _triggers, triggerState: _triggerState,
      repeatable: _repeatable, runOf: _runOf, ...workflowParams } = source.params;
    const start = this.resolveStart(source.workflow, source.workflowVersion,
      this.deps.store.getProject(source.projectId)?.organizationId);
    const confirmerField = start?.manifest.params.find((f) => f.type === 'confirmer');
    if (confirmerField && group.confirmer !== undefined) workflowParams[confirmerField.name] = group.confirmer;
    let attempt = this.deps.store.createTask({
      projectId: source.projectId,
      listId: source.listId,
      title: source.title,
      workflow: source.workflow,
      workflowVersion: source.workflowVersion,
      params: { ...workflowParams, draft: true, archived: false },
      parentTaskId: source.parentTaskId,
      intentId: group.intentId,
      createdBy: source.createdBy,
      assignee: source.assignee,
      delegate: source.delegate,
      confirmationPolicy: source.confirmationPolicy,
    });
    attempt = this.inheritTaskDelegation(source, attempt);
    this.persistTaskCredentialPolicies(attempt);
    if (source.notes) this.deps.store.setTaskNotes(attempt.id, source.notes);
    if (source.tags?.length) this.deps.store.setTaskTags(attempt.id, source.tags);
    // If the former principal is cancelled/failed, the new draft naturally takes over.
    this.deps.store.electPrincipal(group.intentId);
    return this.deps.store.getTask(attempt.id)!;
  }

  setPrincipalAttempt(token: string, taskId: string) {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'edit_task', { projectId: task?.projectId, taskId });
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    this.deps.store.setPrincipalAttempt(taskId);
    return this.deps.store.attemptGroup(taskId);
  }

  private attemptsReachMerge(task: TaskRecord): boolean {
    return !!this.resolveStart(task.workflow, task.workflowVersion,
      this.deps.store.getProject(task.projectId)?.organizationId)?.manifest.stages?.some((stage) => stage.key === 'merge');
  }

  attemptGroup(token: string, taskId: string) {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'get_task', { projectId: task?.projectId, taskId });
    const group = this.deps.store.attemptGroup(taskId);
    if (!group) return group;
    return {
      ...group,
      otherAttemptsChoiceAvailable: !!task && this.attemptsReachMerge(task),
      otherAttemptsDefault: this.deps.store.otherAttemptsDefault(taskId),
      canSaveOtherAttemptsDefault: this.deps.tokens.check(token, 'project:settings:write', { projectId: task?.projectId }).ok,
      attempts: group.attempts.map((attempt) => attempt.params.draft
        ? { ...attempt, lastView: this.getDraftView(token, attempt.id, group) }
        : attempt.lastView
          ? { ...attempt, lastView: {
              ...attempt.lastView,
              actions: this.lifecycleActions(attempt.lastView),
              stageTransitions: this.availableStageTransitions(attempt, attempt.lastView, group),
            } }
          : attempt),
    };
  }

  /** The agent conversation that can supply input to a cross-cutting hold. */
  private humanHoldRole(view: TaskView): AgentRole | undefined {
    if (
      view.status !== 'waiting'
      || view.waitingFor?.kind !== 'human'
      || !view.state?.humanPauseOrigin
    ) return undefined;
    const origin = view.state.humanPauseOrigin as Stage;
    const hasTranscript = (role: AgentRole) =>
      !!view.transcripts?.some((transcript) => transcript.role === role);
    if (origin === 'do' || origin === 'review') return 'do';
    if (origin === 'merge' && hasTranscript('merge')) return 'merge';
    // A hold can land in a stage whose own agent never ran — pausing during
    // `merge` while the task is still queued for its slot is the ordinary case,
    // and it leaves no merge transcript to talk to. Resolving to `undefined`
    // there made the task inert: `lifecycleActions` strips `followUp` and
    // splices nothing back, so a task carrying hours of Do context offered no
    // conversation at all and Cancel was the only way out. Do always exists
    // once a task has done any work, and it owns the context a follow-up about
    // the pending merge is actually about.
    return hasTranscript('do') ? 'do' : undefined;
  }

  /**
   * Back-compatible action projection for holds created by pre-1.7 workflows.
   * A displayed action must either release the hold or be a deliberate non-waking
   * edit; roles prevents an unrelated, stale conversation from accepting input.
   */
  private lifecycleActions(view: TaskView): TaskView['actions'] {
    const actions = [...view.actions];
    // software-dev's infrastructure path deliberately remains in its public
    // stage while it backs off, and its retry signal can wake that timer early.
    // The workflow used to advertise Retry only after the outage exhausted every
    // backoff and escalated, making its already-supported early recovery signal
    // unreachable from the UI (task #5). Project it here instead of changing the
    // deterministic workflow so already-running version-pinned executions are
    // repaired too. Match the workflow-owned retry message narrowly: an ordinary
    // Do error must not acquire a control that has no corresponding parked wait.
    const infrastructureBackoff = RECOVERABLE_WORKFLOWS.has(view.workflow)
      && (view.status === 'active' || view.status === 'waiting')
      && view.waitingFor?.kind !== 'human'
      && view.error?.startsWith('infrastructure: ')
      && / — retrying .+ in \d+s \(\d+\/\d+\)$/.test(view.error);
    if (infrastructureBackoff && !actions.some((action) => action.name === 'retry'))
      actions.unshift(RETRY_ACTION());

    const origin = view.state?.humanPauseOrigin as Stage | undefined;
    if (view.status !== 'waiting' || view.waitingFor?.kind !== 'human' || !origin)
      return actions;
    const role = this.humanHoldRole(view);
    const heldActions = actions
      .filter((action) => action.name !== 'followUp' && (action.name !== 'confirm' || origin === 'review'));
    if (role) heldActions.splice(origin === 'review' ? 1 : 0, 0, FOLLOW_UP_ACTION(role));
    return heldActions;
  }

  /** Honest action set for the short replacement-start window before first publish. */
  private resumedActions(actions: TaskView['actions'], stage: Stage): TaskView['actions'] {
    const allowed = stage === 'do'
      ? new Set(['openPr', 'followUp', 'setTarget', 'cancel'])
      : stage === 'review'
        ? new Set(['confirm', 'followUp', 'setTarget', 'cancel'])
        : stage === 'escalated'
          ? new Set(['retry', 'followUp', 'cancel'])
          : new Set(['cancel']);
    return actions.filter((action) => allowed.has(action.name));
  }

  /** Resolve/Escalated are stack frames around a failed public operation, not
   * restartable pipeline positions. Historical views did not persist that
   * operation, so Do is the conservative replacement destination: it preserves
   * the branch and conversation without pretending to replay a lost closure. */
  private safeRecoveryStage(stage: Stage): Stage {
    return stage === 'resolve' || stage === 'escalated' ? 'do' : stage;
  }

  /** The single transition policy shared by the selected task header, every
   * attempt row, and the mutation endpoint. */
  private availableStageTransitions(
    task: TaskRecord,
    view: TaskView,
    knownGroup?: { committedAttemptId?: string },
  ): StageTransition[] {
    const group = knownGroup ?? this.deps.store.attemptGroup(task.id);
    const jayadratha = !!group?.committedAttemptId;
    const resumable = task.workflow === 'software-dev' || task.workflow === 'goal';
    const origin = view.state?.humanPauseOrigin as Stage | undefined;
    const cancelledFrom = view.state?.cancelledFrom as Stage | undefined;
    const manuallyDoneFrom = view.state?.manuallyDoneFrom as Stage | 'draft' | 'human' | undefined;
    const result: StageTransition[] = [];
    const add = (move: StageTransition) => {
      if (!result.some((candidate) => candidate.target === move.target)) result.push(move);
    };

    if (task.params.draft) {
      add({ target: 'do', label: 'Run task', description: 'Start this draft.' });
      add({ target: 'done', label: 'Done', description: 'Mark this draft done without running it.' });
      return result;
    }
    if (view.status === 'done') {
      if (manuallyDoneFrom) {
        const terminalSnapshot = manuallyDoneFrom === 'cancelled' || manuallyDoneFrom === 'failed';
        if (resumable || terminalSnapshot || manuallyDoneFrom === 'draft' || manuallyDoneFrom === 'human') {
          const restore = manuallyDoneFrom === 'draft' || manuallyDoneFrom === 'human' || terminalSnapshot
            ? manuallyDoneFrom
            : this.safeRecoveryStage(manuallyDoneFrom);
          add({
            target: restore,
            label: restore === 'draft' ? 'Back to Draft' : `Restore ${stageName(restore)}`,
            description: restore === manuallyDoneFrom
              ? 'Undo the manual completion and restore its prior stage and prerequisites.'
              : `The prior ${stageName(manuallyDoneFrom)} frame cannot be replayed safely; recover the preserved work in ${stageName(restore)}.`,
          });
        }
      }
      return result; // natural completion is immutable
    }
    if (view.status === 'cancelled') {
      if (resumable && cancelledFrom && cancelledFrom !== 'cancelled') {
        const restore = this.safeRecoveryStage(cancelledFrom);
        add({
          target: restore,
          label: `Restore ${stageName(restore)}`,
          description: restore === cancelledFrom
            ? 'Recreate the stage prerequisites, then resume where this attempt was cancelled.'
            : `The cancelled ${stageName(cancelledFrom)} frame cannot be replayed safely; recover the preserved work in ${stageName(restore)}.`,
        });
      }
      if (!jayadratha) add({ target: 'draft', label: 'Draft', description: 'Discard progress and make this attempt editable again.', danger: true });
      add({ target: 'done', label: 'Done', description: 'Mark this cancelled attempt done manually.' });
      return result;
    }
    if (view.status === 'failed') {
      if (resumable && !view.pointOfNoReturnPassed)
        add({ target: 'do', label: 'Retry', description: 'Recover the preserved work and retry the task.' });
      if (!jayadratha && !view.pointOfNoReturnPassed)
        add({ target: 'draft', label: 'Draft', description: 'Discard failed progress and start over later.', danger: true });
      add({ target: 'done', label: 'Done', description: 'Stop treating this failure as active work.' });
      return result;
    }

    // The workflow publishes this interlock immediately before invoking an
    // activity that may atomically land a reviewed head. Its external outcome
    // is unknowable until the activity returns, so no replacement is safe here.
    if (view.state?.lifecycleTransitionBlocked) return result;

    // Once any participant has landed, workflow reconciliation is the only safe
    // continuation. A synthetic hold/Done/cancel could strand a partial saga.
    if (view.pointOfNoReturnPassed) return result;

    if (origin) {
      add({ target: origin, label: `Resume ${stageName(origin)}`, description: 'Leave the human hold and resume the originating stage.' });
    // Resolve is an internal recovery frame rather than a resumable public
    // pipeline position: restarting merely at "resolve" loses the failed
    // operation it was repairing. Do not advertise a transition we cannot
    // restore faithfully.
    } else if (resumable && view.stage !== 'escalated' && view.stage !== 'resolve' && view.waitingFor?.kind !== 'human') {
      add({ target: 'human', label: 'Waiting for human input', description: 'Stop current activity and hold this attempt for a person.' });
    }
    if (resumable && (view.stage === 'pr' || view.stage === 'review' || view.stage === 'merge') && !origin)
      add({
        target: 'do',
        label: 'Back to Working',
        description: view.stage === 'merge'
          ? 'Return the pending pull request to the agent for repair; preserved intent authorization is revalidated automatically unless the repair changes scope.'
          : view.stage === 'review'
            ? 'Return the proposal to the agent for repair; the current head approval lapses and the repaired proposal returns through Review.'
            : 'Stop proposal publication and return the preserved branch to the agent.',
      });
    if (!jayadratha && !view.pointOfNoReturnPassed)
      add({ target: 'draft', label: 'Draft', description: 'Discard all execution progress and make the attempt editable.', danger: true });
    add({ target: 'done', label: 'Done', description: 'Stop all activity and mark this attempt done manually.' });
    return result;
  }

  private transitionCheckpoint(
    view: TaskView,
    resumeStage: Stage,
    pausedForHuman = false,
    humanWait?: { audience: string[]; detail: string },
    reviewConfirmed = false,
  ): TaskRecoveryCheckpoint {
    const saved = view.state?.transitionCheckpoint as TaskRecoveryCheckpoint | undefined;
    const viewWorld = (view.world ?? view.state?.recoveryWorld) as WorldHandle | undefined;
    const recoverableWorld = view.status === 'cancelled'
      && this.deps.store.worldState(view.taskId) === 'released'
      ? undefined
      : viewWorld;
    const source = saved ?? {
      // v1.22 cancellation suspends rather than destroys its world. Historical
      // cancelled views may have no handle, in which case Setup reconstructs as
      // before; when the handle exists it is the authoritative preserved state.
      world: recoverableWorld,
      messages: view.messages,
      transcripts: view.transcripts,
      reviewInfo: view.reviewInfo,
      prs: view.prs?.map((pr) => ({ ...pr })),
      seen: typeof view.state?.turnsSeen === 'number' ? view.state.turnsSeen : view.messages.length,
      target: view.targetBranch,
      // Carry multi-PR Review approvals across a replacement execution so a human
      // is not asked to re-approve branches nothing has touched. Each is still
      // pinned to the head it was given at, so a moved branch lapses regardless.
      ...(view.checkouts?.some((checkout) => checkout.approved)
        ? { checkoutApprovals: Object.fromEntries(view.checkouts.filter((c) => c.approved && c.head).map((c) => [c.name, c.head!])) }
        : {}),
      ...(view.landing ? { landing: { ...view.landing, authorizedHeads: { ...(view.landing.authorizedHeads ?? {}) } } } : {}),
    };
    const {
      humanWait: savedHumanWait,
      reviewConfirmed: _savedReviewConfirmed,
      pausedForHuman: _savedPausedForHuman,
      ...stableSource
    } = source;
    const held = humanWait ?? savedHumanWait ?? (view.waitingFor?.kind === 'human'
      ? {
          audience: view.waitingFor.audience?.length ? [...view.waitingFor.audience] : ['@creator'],
          detail: view.waitingFor.detail ?? `Paused during ${resumeStage}`,
        }
      : { audience: ['@creator'], detail: `Paused during ${resumeStage}` });
    const preservesHeldQuestion = pausedForHuman
      || Boolean(view.state?.humanPauseOrigin && view.waitingFor?.kind === 'human');
    // A lifecycle replacement is a new Temporal history, not a new agent
    // conversation. Resume the Do provider session when its credential home can
    // be leased again; the copied transcript remains the provider-independent
    // fallback when it cannot.
    const session = source.session ?? (this.deps.store.kvGet(`session:${view.taskId}:do`) || undefined);
    let sessionHome = source.sessionHome;
    if (!sessionHome) {
      try {
        const meta = JSON.parse(this.deps.store.kvGet(`sessionmeta:${view.taskId}:do`) ?? '{}');
        sessionHome = typeof meta.home === 'string' ? meta.home || '(profile)' : undefined;
      } catch {
        /* malformed legacy metadata: the transcript still preserves context */
      }
    }
    return {
      ...stableSource,
      ...(session ? { session } : {}),
      ...(sessionHome ? { sessionHome } : {}),
      messages: source.messages.map((message) => ({ ...message })),
      transcripts: source.transcripts?.map((transcript) => ({
        ...transcript,
        messages: transcript.messages.map((message) => ({ ...message })),
      })),
      // A saved checkpoint predates the current human hold. Prefer the live PR
      // refs so a recovered Review/Merge can authorize the exact opened heads.
      prs: (view.prs ?? source.prs)?.map((pr) => ({ ...pr })),
      ...(view.landing ? { landing: { ...view.landing, authorizedHeads: { ...(view.landing.authorizedHeads ?? {}) } } } : {}),
      resumeStage,
      // A deliberate Landing → Do move is an integration repair, not a fresh
      // proposal. Keep intent authorization but require automated review of the
      // changed head before it can be re-admitted to the landing queue.
      ...(resumeStage === 'do' && (view.stage === 'merge' || view.stage === 'escalated')
        && view.landing?.authorization === 'authorized'
        ? {
            repairValidationPending: true,
            landing: {
              ...view.landing,
              validation: 'failed' as const,
              provider: 'ejected' as const,
              detail: view.landing.detail ?? 'Returned from Landing for repair.',
            },
          }
        : {}),
      ...(pausedForHuman ? { pausedForHuman: true } : {}),
      ...(preservesHeldQuestion ? { humanWait: { audience: [...held.audience], detail: held.detail } } : {}),
      ...(reviewConfirmed ? { reviewConfirmed: true } : {}),
    };
  }

  /** Clone a view and append one accepted message to exactly one agent transcript. */
  private withConversationMessage(view: TaskView, role: AgentRole, message: Message): TaskView {
    const messages = view.messages.map((candidate) => ({ ...candidate }));
    if (role === 'do' && !messages.some((candidate) => candidate.id === message.id))
      messages.push({ ...message });
    const transcripts = view.transcripts?.map((transcript) => ({
      ...transcript,
      messages: transcript.messages.map((candidate) => ({ ...candidate })),
    })) ?? [];
    let transcript = transcripts.find((candidate) => candidate.role === role);
    if (!transcript) {
      transcript = {
        role,
        label: role === 'do' ? 'Agent' : role === 'merge' ? 'Merge agent' : role === 'resolve' ? 'Resolve agent' : 'Confirm agent',
        messages: [],
      };
      transcripts.push(transcript);
    }
    if (!transcript.messages.some((candidate) => candidate.id === message.id))
      transcript.messages.push({ ...message });
    return { ...view, messages, transcripts };
  }

  /** Stop every execution-owned source of activity before replacing or
   * terminalizing a run. Coordinator cancellation is explicit because workflow
   * termination cannot run deterministic finally blocks. */
  private async stopTaskActivity(
    task: TaskRecord,
    view: TaskView,
    reason: string,
    disposition: 'replace' | 'cancel' | 'discard' = 'replace',
    gracefulTimeoutMs = 30_000,
  ): Promise<void> {
    const handle = this.workflowHandle(task.id);
    const minor = Number(String(task.workflowVersion ?? '').split('.')[1] ?? 0);
    let stoppedGracefully = false;
    if (minor >= 22 && disposition !== 'discard' && typeof (handle as any).result === 'function') {
      if (disposition === 'replace') {
        const runId = task.params?._workflowRunId;
        this.deps.store.kvSet(lifecycleReplacementKey(task.id), JSON.stringify({
          ...(typeof runId === 'string' && runId ? { runId } : {}),
          requestedAt: Date.now(),
        }));
      }
      try {
        await handle.signal(disposition === 'cancel' ? 'cancel' : 'prepareLifecycleReplacement');
        await withTimeout(Promise.resolve((handle as any).result()), gracefulTimeoutMs);
        stoppedGracefully = true;
      } catch {
        // A wedged/older execution still has the bounded termination fallback.
      }
    }
    if (!stoppedGracefully) {
      await handle.terminate(reason).catch((error: unknown) => {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
      });
    }

    // Do not trust only the projected turn: pre-1.7 account waits did not expose
    // their turnId, and a stale snapshot can lag a just-enqueued agent request.
    // Query both coordinators and withdraw every request owned by this task.
    const turnIds = new Set<string>(view.agentTurn?.turnId ? [view.agentTurn.turnId] : []);
    await Promise.all([
      this.deps.client.workflow.getHandle(agentQueueId()).query(QRY_AGENT_QUEUE)
        .then((queue: any) => {
          for (const item of [...(queue?.queue ?? []), ...(queue?.current ?? [])])
            if (item?.taskId === task.id && item?.turnId) turnIds.add(String(item.turnId));
        })
        .catch(() => undefined),
      this.deps.client.workflow.getHandle(accountCoordinatorId()).query(QRY_ACCOUNT_TASK_LEASES, task.id)
        .then((ids: unknown) => {
          if (Array.isArray(ids)) for (const id of ids) if (id) turnIds.add(String(id));
        })
        .catch(() => undefined),
    ]);

    const signals: Promise<unknown>[] = [];
    for (const turnId of turnIds) {
      signals.push(this.deps.client.workflow.getHandle(agentQueueId()).signal(SIG_CANCEL_AGENT, { taskId: task.id, turnId }));
      signals.push(this.deps.client.workflow.getHandle(accountCoordinatorId()).signal(SIG_CANCEL_ACCOUNT, { taskId: task.id, turnId }));
    }
    const world = (view.world ?? view.state?.recoveryWorld) as WorldHandle | undefined;
    const rememberedDomain = typeof view.state?.mergeDomain === 'string' ? view.state.mergeDomain : undefined;
    const domains = world
      ? mergeQueueDomains(world, view.targetBranch ?? world.target ?? 'main', task.projectId)
      : view.stage === 'merge'
        ? [rememberedDomain ?? mergeQueueDomains(undefined, view.targetBranch ?? 'main', task.projectId)[0]!]
        : rememberedDomain
          ? [rememberedDomain]
          : [];
    for (const domain of [...new Set(domains)]) {
      signals.push(this.deps.client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
        workflowId: mergeQueueId(domain),
        taskQueue: this.deps.taskQueue,
        args: [{ domain }],
        signal: SIG_CANCEL_MERGE,
        signalArgs: [{ taskId: task.id }],
      }));
    }
    await Promise.all(signals.map((signal) => signal.catch(() => undefined)));
  }

  /** Setup can be terminated before a WorldHandle containing `worldLeaseId` is
   * ever published. Reclaim by durable task ownership instead of relying on an
   * in-memory activity finally block that may never run after failover. */
  private releaseTaskRunnerLeases(taskId: string): void {
    for (const lease of this.deps.store.worldLeasesForTask(taskId)) {
      if (this.deps.runners) this.deps.runners.release(String(lease.id), 'unknown');
      else this.deps.store.releaseWorldLease(String(lease.id));
    }
  }

  private async startTransitionReplacement(
    task: TaskRecord,
    view: TaskView,
    resumeStage: Stage,
    pausedForHuman = false,
    humanWait?: { audience: string[]; detail: string },
    reviewConfirmed = false,
  ): Promise<TaskView> {
    const { startType, input, version } = await this.buildStart(task, true);
    input.recovery = this.transitionCheckpoint(view, resumeStage, pausedForHuman, humanWait, reviewConfirmed);
    const started = await withTimeout(this.deps.client.workflow.start(startType, {
      taskQueue: this.deps.taskQueue,
      workflowId: task.id,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      args: [input],
    }), START_TIMEOUT_MS);
    this.deps.store.setTaskWorkflowVersion(task.id, version);
    this.deps.store.setTaskExecutionWorkflow(task.id, task.workflow);
    const runId = (started as any)?.firstExecutionRunId ?? (started as any)?.runId;
    this.deps.store.patchTaskParams(task.id, {
      archived: false,
      draft: false,
      ...(typeof runId === 'string' && runId ? { _workflowRunId: runId } : {}),
    });
    // The new run is now durable and its run id (when available) is pinned. Its
    // first view may race this platform-side projection, but neither belongs to
    // the stopped run, so the old-run terminal suppression is no longer needed.
    this.deps.store.kvDelete(lifecycleReplacementKey(task.id));
    const {
      manuallyDoneFrom: _manuallyDoneFrom,
      manuallyDoneView: _manuallyDoneView,
      transitionCheckpoint: _transitionCheckpoint,
      humanPauseOrigin: _humanPauseOrigin,
      cancelledFrom: _cancelledFrom,
      restoringTo: _restoringTo,
      ...priorState
    } = view.state;
    const restoringProposal = !pausedForHuman && ['pr', 'review', 'merge'].includes(resumeStage);
    const initialStage: Stage = restoringProposal ? 'pr' : resumeStage;
    const starting: TaskView = {
      ...view,
      stage: initialStage,
      status: pausedForHuman ? 'waiting' : 'active',
      actions: pausedForHuman ? this.lifecycleActions(view) : this.resumedActions(view.actions, initialStage),
      waitingFor: pausedForHuman
        ? {
            kind: 'human',
            audience: input.recovery.humanWait?.audience ?? ['@creator'],
            detail: input.recovery.humanWait?.detail ?? `Paused during ${resumeStage}`,
          }
        : undefined,
      agentTurn: undefined,
      error: undefined,
      state: {
        ...priorState,
        cancelled: false,
        ...(pausedForHuman ? { humanPauseOrigin: resumeStage } : {}),
        ...(restoringProposal ? { restoringTo: resumeStage } : {}),
        recoveryWorld: input.recovery.world,
      },
      updatedAt: Date.now(),
    };
    this.deps.store.saveView(task.id, starting);
    return {
      ...starting,
      actions: this.lifecycleActions(starting),
      stageTransitions: this.availableStageTransitions(this.deps.store.getTask(task.id)!, starting),
    };
  }

  /** Move one attempt to an explicitly advertised lifecycle destination. */
  async moveTaskStage(token: string, taskId: string, target: string): Promise<TaskView> {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'signal_task', { projectId: task?.projectId, taskId });
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    const view = task.params.draft ? this.getDraftView(token, taskId) : await this.transitionSourceView(task);
    if (!view) throw new Error('task has no lifecycle state yet');
    const move = this.availableStageTransitions(task, view).find((candidate) => candidate.target === target);
    if (!move) throw new Error(`cannot move this attempt from ${stageName(view.stage)} to ${stageName(target)}`);

    if (task.params.draft && target === 'do') {
      await this.queueTask(token, taskId);
      return (await this.getTaskView(token, taskId, { live: true }))!;
    }

    if (target === 'done') {
      const from = task.params.draft ? 'draft' : view.state?.humanPauseOrigin ? 'human' : view.stage;
      const checkpoint = task.params.draft ? undefined : this.transitionCheckpoint(view, view.stage);
      if (!task.params.draft && !['done', 'cancelled', 'failed'].includes(view.status))
        await this.stopTaskActivity(task, view, 'Task marked done manually', 'cancel');
      if (task.params.draft) this.deps.store.clearDraft(taskId);
      const done: TaskView = {
        ...view,
        stage: 'done',
        status: 'done',
        waitingFor: undefined,
        agentTurn: undefined,
        actions: [],
        state: {
          ...view.state,
          draft: false,
          manuallyDoneFrom: from,
          ...(checkpoint ? { transitionCheckpoint: checkpoint } : {}),
          ...(['cancelled', 'failed'].includes(view.status) ? { manuallyDoneView: view } : {}),
        },
        updatedAt: Date.now(),
      };
      this.deps.store.saveView(taskId, done);
      return { ...done, stageTransitions: this.availableStageTransitions(this.deps.store.getTask(taskId)!, done) };
    }

    const manuallyDoneFrom = view.state?.manuallyDoneFrom as Stage | 'draft' | 'human' | undefined;
    if (view.status === 'done' && manuallyDoneFrom === 'draft' && target === 'draft') {
      this.deps.store.updateTaskParams(taskId, { ...task.params, draft: true, archived: false });
      return this.getDraftView(token, taskId)!;
    }
    if (view.status === 'done' && (target === 'cancelled' || target === 'failed')) {
      const previous = view.state?.manuallyDoneView as TaskView | undefined;
      if (!previous || previous.stage !== target) throw new Error(`the prior ${target} state is unavailable`);
      const restored = { ...previous, updatedAt: Date.now() };
      this.deps.store.saveView(taskId, restored);
      this.deps.store.updateTaskParams(taskId, { ...task.params, archived: false });
      return { ...restored, stageTransitions: this.availableStageTransitions(this.deps.store.getTask(taskId)!, restored) };
    }
    if (view.status === 'done' && manuallyDoneFrom === 'human' && target === 'human') {
      const checkpoint = view.state?.transitionCheckpoint as TaskRecoveryCheckpoint | undefined;
      const origin = checkpoint?.resumeStage;
      if (!origin) throw new Error('the prior human hold origin is unavailable');
      return this.startTransitionReplacement(task, view, origin, true);
    }

    if (target === 'draft') {
      if (!['done', 'cancelled', 'failed'].includes(view.status))
        await this.stopTaskActivity(task, view, 'Task moved back to Draft', 'discard');
      const world = (view.world ?? view.state?.recoveryWorld) as WorldHandle | undefined;
      if (world && this.deps.worlds) {
        const opened = await this.deps.worlds.open(world).catch(() => undefined);
        await opened?.destroy().catch(() => undefined);
      }
      this.deps.store.kvDelete(`attempt-choice:${taskId}`);
      const draftParams = { ...task.params };
      delete (draftParams as any)._workflowRunId;
      this.deps.store.updateTaskParams(taskId, {
        ...draftParams,
        draft: true,
        archived: false,
        _discardProgress: true,
      });
      this.deps.store.electPrincipal(task.intentId ?? task.id);
      return this.getDraftView(token, taskId)!;
    }

    if (view.state?.humanPauseOrigin === target) {
      await this.workflowHandle(taskId).signal(SIG.retry);
      return (await this.getTaskView(token, taskId, { live: true }))!;
    }

    if (!['done', 'cancelled', 'failed'].includes(view.status))
      await this.stopTaskActivity(task, view, target === 'human' ? 'Task paused for human input' : `Task moved to ${target}`);
    const resumeStage = target === 'human' ? view.stage : target as Stage;
    return this.startTransitionReplacement(task, view, resumeStage, target === 'human');
  }

  /**
   * Pause the calling task at its exact current stage and route a concrete
   * question to selected humans. Task-scoped callers may only escalate
   * themselves; this makes the capability safe to grant to every agent role.
   */
  async escalateToHuman(
    token: string,
    args: { taskId?: string; audience: string[]; message: string; urgency?: Urgency },
  ): Promise<TaskView> {
    const caller = this.require(token, 'escalate_to_human');
    const taskId = args.taskId ?? (caller.taskId !== '*' ? caller.taskId : undefined);
    if (!taskId) throw new Error('taskId is required for a non-task caller');
    if (caller.taskId !== '*' && caller.taskId !== taskId)
      throw new CapabilityError('a task agent may only escalate its own task');

    const task = this.deps.store.getTask(taskId);
    this.require(token, 'escalate_to_human', { projectId: task?.projectId, taskId });
    if (!task) throw new Error(`no task ${taskId}`);
    const view = await this.transitionSourceView(task);
    if (!this.availableStageTransitions(task, view).some((move) => move.target === 'human'))
      throw new Error(`cannot request human input from ${stageName(view.stage)}`);

    const audience = [...new Set((args.audience ?? []).map((selector) => String(selector).trim()).filter(Boolean))];
    if (!audience.length) throw new Error('choose at least one person, team, or Avatar');
    if (audience.length > 32) throw new Error('at most 32 audience selectors may be used');
    const avatarRecipients: import('../domain/types.js').Avatar[] = [];
    const initiatingUserId = this.deps.store.taskCreatorUserId(task.id);
    for (const selector of audience) {
      if (selector.startsWith('avatar:')) {
        const avatar = this.deps.store.getAvatar(selector.slice(7));
        if (!avatar || avatar.projectId !== task.projectId || !avatarEnabled(this.deps.store, avatar))
          throw new Error(`Avatar route ${selector} is not available in this project`);
        if (avatar.roles.length && !avatar.roles.includes('respond'))
          throw new Error(`Avatar "${avatar.name}" is not configured to respond to tasks`);
        if (!initiatingUserId || !avatarCallableBy(this.deps.store, avatar, initiatingUserId))
          throw new CapabilityError(`the task creator is not allowed to call Avatar "${avatar.name}"`);
        avatarRecipients.push(avatar);
        continue;
      }
      if (!this.deps.store.humanAudience(task.id, [selector]).length)
        throw new Error(`Human route ${selector} does not resolve to a human in this organization`);
    }
    const detail = String(args.message ?? '').trim();
    if (!detail) throw new Error('message is required');
    if ([...detail].length > 4_000) throw new Error('message must be at most 4000 characters');

    await this.stopTaskActivity(task, view, `Escalated to ${audience.join(', ')}`);
    const held = await this.startTransitionReplacement(task, view, view.stage, true, { audience, detail });
    const requestedBy = caller.taskId !== '*'
      ? `task-agent:${caller.taskId}:${caller.profileId}`
      : caller.principal;
    const event = {
      taskId,
      type: 'task.escalated',
      ts: Date.now(),
      payload: { audience, detail, requestedBy, originStage: view.stage,
        urgency: normalizeUrgency(args.urgency, DEFAULT_URGENCY.escalated) },
    };
    const seq = this.deps.store.appendEvent(event);
    this.deps.bus?.emit({ ...event, seq });
    for (const avatar of avatarRecipients) {
      try {
        await this.createTask(token, {
          projectId: task.projectId,
          workflow: 'just-do',
          title: `${avatar.name}: respond to task #${task.num ?? task.id}`,
          prompt: `The agent working on task #${task.num ?? task.id} (${task.title}) asked for your intervention:

${detail}

Act according to your Avatar instructions. When ready, call signal_task for task id ${task.id} with signal "followUp" and the concrete guidance or decision in text. Address role "${caller.role ?? 'do'}" when relevant. Then briefly report what you sent.`,
          params: {
            'agent:do': {
              avatarId: avatar.id,
              avatarPurpose: 'respond',
              provider: avatar.runtime.provider,
              ...(avatar.runtime.model ? { model: avatar.runtime.model } : {}),
              ...(avatar.runtime.effort ? { effort: avatar.runtime.effort } : {}),
            },
          },
        });
      } catch (error) {
        const failed = { taskId: task.id, type: 'avatar.response-dispatch-failed', ts: Date.now(),
          payload: { avatarId: avatar.id, error: error instanceof Error ? error.message : String(error) } };
        const failedSeq = this.deps.store.appendEvent(failed);
        this.deps.bus?.emit({ ...failed, seq: failedSeq });
      }
    }
    return held;
  }

  /** Ask selected people, teams, or owner-configured Avatars to add exact
   * capabilities and/or project scope to this task. The deciding principal must independently hold
   * every capability it grants. */
  async requestPermission(
    token: string,
    args: { capabilities: string[]; projectIds?: string[]; audience: string[]; reason: string; urgency?: Urgency },
  ): Promise<{ status: 'granted' | 'needs_approval'; requestId?: string; capabilities: string[]; projectIds?: string[]; audience?: string[] }> {
    const caller = this.require(token, 'request_permission');
    if (caller.taskId === '*') throw new Error('this endpoint requires a task-agent token');
    const task = this.deps.store.getTask(caller.taskId);
    this.require(token, 'request_permission', { projectId: task?.projectId, taskId: caller.taskId });
    if (!task) throw new Error(`no task ${caller.taskId}`);
    const project = this.deps.store.getProject(task.projectId);
    if (!project?.organizationId) throw new Error('task project has no organization');

    const capabilities = [...new Set((args.capabilities ?? []).map(exactCapability))];
    if (args.projectIds !== undefined && (!Array.isArray(args.projectIds)
      || args.projectIds.some((id) => typeof id !== 'string' || !id.trim())))
      throw new ValidationError('projectIds must be an array of nonempty project IDs');
    const requestedProjects = [...new Set((args.projectIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (requestedProjects.length > 32) throw new ValidationError('at most 32 projects may be requested');
    if (!capabilities.length && !requestedProjects.length) throw new Error('choose at least one capability or project');
    for (const id of requestedProjects) {
      if (this.deps.store.getProject(id)?.organizationId !== project.organizationId)
        throw new ValidationError('requested projects must exist in the task organization');
    }
    const projectIds = requestedProjects.filter((id) => caller.projectId ? caller.projectId !== id
      : caller.projectIds?.length ? !caller.projectIds.includes(id) : false);
    const baseAuthorization = projectIds.length ? previousTaskGrants(task).authorization : undefined;
    if (projectIds.length && (!baseAuthorization || baseAuthorization.scope !== 'projects'))
      throw new ValidationError('project expansion requires a task with selected-project authorization');
    if (projectIds.length && caller.principal.startsWith('avatar:'))
      throw new ValidationError('update the Avatar authorization before expanding its project access');
    if (capabilities.length > 32) throw new Error('at most 32 capabilities may be requested');
    const missing = capabilities.filter((capability) => !allows(caller.caps, capability));
    if (!missing.length && !projectIds.length) return { status: 'granted', capabilities };

    const audience = [...new Set((args.audience ?? []).map((selector) => String(selector).trim()).filter(Boolean))];
    if (!audience.length) throw new Error('choose at least one person, team, or Avatar');
    if (audience.length > 32) throw new Error('at most 32 audience selectors may be used');
    const recipients = new Set<string>();
    const avatarRecipients = new Set<string>();
    const initiatingUserId = this.deps.store.taskCreatorUserId(task.id);
    for (const selector of audience) {
      if (selector.startsWith('avatar:')) {
        const avatar = this.deps.store.getAvatar(selector.slice(7));
        if (!avatar || avatar.projectId !== task.projectId || !avatarEnabled(this.deps.store, avatar))
          throw new Error(`Avatar route ${selector} is not available in this project`);
        if (avatar.roles.length && !avatar.roles.includes('authorize'))
          throw new Error(`Avatar "${avatar.name}" is not configured to decide authorizations`);
        if (!initiatingUserId || !avatarCallableBy(this.deps.store, avatar, initiatingUserId))
          throw new CapabilityError(`the task creator is not allowed to call Avatar "${avatar.name}"`);
        avatarRecipients.add(avatar.id);
        continue;
      }
      const resolved = this.deps.store.humanAudience(task.id, [selector]);
      if (!resolved.length) throw new Error(`Human route ${selector} does not resolve to a human in this organization`);
      resolved.forEach((userId) => recipients.add(userId));
    }
    const service = new PermissionRequests(this.deps.store, project.organizationId);
    const role = caller.role
      ?? this.deps.store.getProfile(caller.profileId)?.role
      ?? caller.profileId.replace(/-default$/, '');
    const prior = new Set(service.requests({ taskId: task.id, status: 'pending' }).map((request) => request.id));
    const request = service.request({
      taskId: task.id,
      projectId: task.projectId,
      role,
      capabilities: projectIds.length ? capabilities : missing,
      ...(projectIds.length ? { projectIds, baseAuthorization } : {}),
      audience,
      recipients: [...recipients],
      avatarRecipients: [...avatarRecipients],
      reason: args.reason,
      requestedBy: `task-agent:${task.id}:${caller.profileId}`,
    });
    if (!prior.has(request.id)) {
      const event = {
        taskId: task.id,
        type: 'permission.approval-requested',
        ts: Date.now(),
        payload: {
          requestId: request.id,
          role: request.role,
          capabilities: request.capabilities,
          projectIds: request.projectIds,
          audience: request.audience,
          recipients: request.recipients,
          avatarRecipients: request.avatarRecipients,
          reason: request.reason,
          requestedBy: request.requestedBy,
          // An approval blocks the agent on a person, so it is high by default —
          // the agent may raise it further for something genuinely time-critical.
          urgency: normalizeUrgency(args.urgency, DEFAULT_URGENCY['approval-requested']),
        },
      };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
      // A scoped token is immutable. End the requesting turn and park the exact
      // workflow stage so an approval can wake this role in a fresh turn whose
      // normally minted token includes the durable extension.
      const view = await this.transitionSourceView(task);
      if (!['done', 'cancelled', 'failed'].includes(view.status)) {
        await this.stopTaskActivity(task, view, `Waiting for permission approval ${request.id}`);
        await this.startTransitionReplacement(task, view, view.stage, true, {
          audience: request.audience,
          detail: `Permission requested: ${request.capabilities.join(', ')}${request.projectIds?.length ? `; add projects: ${request.projectIds.join(', ')}` : ''} — ${request.reason}`,
        });
      }
      for (const avatarId of avatarRecipients) {
        const avatar = this.deps.store.getAvatar(avatarId)!;
        try {
          await this.createTask(token, {
            projectId: task.projectId,
            workflow: 'just-do',
            title: `${avatar.name}: decide permission request`,
            prompt: `Decide whether to approve or deny permission request ${request.id} for task #${task.num ?? task.id}.

Requested capabilities: ${request.capabilities.join(', ')}
${request.projectIds?.length ? `Add projects to the task's ${request.baseAuthorization?.level} authorization (existing permissions apply there too): ${request.projectIds.join(', ')}\n` : ''}Reason from the requesting agent: ${request.reason}

Act according to your Avatar instructions. Resolve the request exactly once by calling platform_request with POST /api/permission-requests/${request.id}/resolve?organizationId=${project.organizationId} and body {"action":"approve"} or {"action":"deny"}. Then briefly report the decision.`,
            params: {
              'agent:do': {
                avatarId: avatar.id,
                avatarPurpose: 'authorize',
                provider: avatar.runtime.provider,
                ...(avatar.runtime.model ? { model: avatar.runtime.model } : {}),
                ...(avatar.runtime.effort ? { effort: avatar.runtime.effort } : {}),
              },
            },
          });
        } catch (error) {
          const failed = { taskId: task.id, type: 'avatar.authorization-dispatch-failed', ts: Date.now(),
            payload: { requestId: request.id, avatarId, error: error instanceof Error ? error.message : String(error) } };
          const failedSeq = this.deps.store.appendEvent(failed);
          this.deps.bus?.emit({ ...failed, seq: failedSeq });
        }
      }
    }
    return {
      status: 'needs_approval',
      requestId: request.id,
      capabilities: request.capabilities,
      ...(request.projectIds?.length ? { projectIds: request.projectIds } : {}),
      audience: request.audience,
    };
  }

  authorizationEscalationTargets(
    token: string,
    input: { projectId: string; authorization: AuthorizationSelection },
  ): {
    projectId: string;
    authorization: AuthorizationSelection;
    requestedCapabilities: Capability[];
    missingCapabilities: Capability[];
    users: Array<{ id: string; selector: string }>;
    teams: Array<{ id: string; name: string; slug: string; selector: string; eligibleUserIds: string[] }>;
    special: Array<{ selector: '@all' | '@owners'; eligibleUserIds: string[] }>;
    avatars: Array<{ id: string; name: string; purpose?: string; selector: string }>;
  } {
    const caller = this.require(token, 'create_task', { projectId: input.projectId });
    const subject = requireHumanSubject(caller);
    const project = this.deps.store.getProject(input.projectId);
    if (!project?.organizationId) throw new NotFoundError('project organization not found');
    const authorization = this.deps.authorization;
    if (!authorization) throw new Error('authorization service is unavailable');
    const requestedCapabilities = authorization.requestedCapabilities(input.projectId, input.authorization);
    const missingCapabilities = caller.kind === 'human'
      ? authorization.missingCapabilities(caller.principal, input.projectId, input.authorization)
      : requestedCapabilities.filter((capability) => !allows(caller.caps, capability));
    const memberIds = this.deps.store.listOrganizationMemberships(project.organizationId).map((member) => member.userId);
    const eligibleUserIds = memberIds.filter((userId) =>
      allows(authorization.capabilities(`user:${userId}`, input.projectId, project.organizationId), 'task:create')
      && authorization.canGrantSelection(`user:${userId}`, input.projectId, input.authorization));
    const users = eligibleUserIds.map((id) => ({ id, selector: `user:${id}` }));
    const eligible = new Set(eligibleUserIds);
    const teams = this.deps.store.listTeams(project.organizationId, input.projectId)
      .map((team) => ({ ...team, eligibleUserIds: this.deps.store.listTeamMemberships(team.id)
        .map((member) => member.userId).filter((id) => eligible.has(id)) }))
      .filter((team) => team.eligibleUserIds.length)
      .map((team) => ({ id: team.id, name: team.name, slug: team.slug,
        selector: `@team:${team.slug}`, eligibleUserIds: team.eligibleUserIds }));
    const ownerIds = this.deps.store.listOrganizationMemberships(project.organizationId)
      .filter((member) => member.role === 'owner' && eligible.has(member.userId)).map((member) => member.userId);
    const initiatingUserId = subject.userId;
    const avatars = this.deps.store.listAvatars(input.projectId)
      .filter((avatar) => avatarEnabled(this.deps.store, avatar)
        && (!avatar.roles.length || avatar.roles.includes('authorize'))
        && avatarCallableBy(this.deps.store, avatar, initiatingUserId))
      .filter((avatar) => {
        const effective = avatarAuthorizationCapabilities(this.deps.store, authorization, avatar, input.projectId);
        return allows(effective, 'task:create')
          && requestedCapabilities.every((capability) => allows(effective, capability));
      })
      .map((avatar) => ({ id: avatar.id, name: avatar.name,
        ...(avatar.purpose ? { purpose: avatar.purpose } : {}), selector: `avatar:${avatar.id}` }));
    return {
      projectId: input.projectId, authorization: input.authorization,
      requestedCapabilities, missingCapabilities, users, teams,
      special: [
        ...(eligibleUserIds.length ? [{ selector: '@all' as const, eligibleUserIds }] : []),
        ...(ownerIds.length ? [{ selector: '@owners' as const, eligibleUserIds: ownerIds }] : []),
      ],
      avatars,
    };
  }

  async requestAuthorization(
    token: string,
    input: {
      projectId: string;
      target: { kind: 'task'; taskId: string; queueAfterApproval?: boolean }
        | { kind: 'avatar'; avatarId: string; enableAfterApproval?: boolean };
      authorization: AuthorizationSelection;
      audience: string[];
      reason?: string;
    },
  ): Promise<AuthorizationRequest> {
    const caller = this.require(token, 'create_task', { projectId: input.projectId });
    const subject = requireHumanSubject(caller);
    const project = this.deps.store.getProject(input.projectId);
    if (!project?.organizationId) throw new NotFoundError('project organization not found');
    const requesterId = subject.userId;
    if (input.target.kind === 'task') {
      const task = this.deps.store.getTask(input.target.taskId);
      if (!task || task.projectId !== input.projectId) throw new NotFoundError('task not found in this project');
      if (!task.params?.draft && task.params?.triggerState !== 'armed' && !task.params?.repeatable)
        throw new ValidationError('authorization must be approved before this task starts');
      if (this.deps.store.taskCreatorUserId(task.id) !== requesterId)
        throw new CapabilityError('only the task creator can route its initial authorization request');
    } else {
      const avatar = this.deps.store.getAvatar(input.target.avatarId);
      if (!avatar || avatar.projectId !== input.projectId) throw new NotFoundError('Avatar not found in this project');
      if (avatar.ownerUserId !== requesterId)
        throw new CapabilityError('only the Avatar owner can route its authorization request');
    }
    const targets = this.authorizationEscalationTargets(token, {
      projectId: input.projectId, authorization: input.authorization,
    });
    if (!targets.missingCapabilities.length)
      throw new ValidationError('you already have the requested authorization');
    const eligibleUsers = new Set(targets.users.map((user) => user.id));
    const eligibleAvatars = new Set(targets.avatars.map((avatar) => avatar.id));
    const audience = [...new Set((input.audience ?? []).map(String).map((value) => value.trim()).filter(Boolean))];
    if (!audience.length || audience.length > 32) throw new ValidationError('choose between 1 and 32 eligible recipients');
    const recipients = new Set<string>();
    const avatarRecipients = new Set<string>();
    for (const selector of audience) {
      if (selector.startsWith('user:')) {
        const id = selector.slice(5);
        if (!eligibleUsers.has(id)) throw new CapabilityError(`${selector} cannot grant the complete requested authorization`);
        recipients.add(id);
      } else if (selector.startsWith('avatar:')) {
        const id = selector.slice(7);
        if (input.target.kind === 'avatar' && input.target.avatarId === id)
          throw new CapabilityError('an Avatar cannot grant authorization to itself');
        if (!eligibleAvatars.has(id)) throw new CapabilityError(`${selector} cannot grant the complete requested authorization`);
        avatarRecipients.add(id);
      } else if (selector.startsWith('@team:')) {
        const team = targets.teams.find((candidate) => candidate.selector === selector);
        if (!team) throw new CapabilityError(`${selector} has no member who can grant the complete requested authorization`);
        team.eligibleUserIds.forEach((id) => recipients.add(id));
      } else {
        const special = targets.special.find((candidate) => candidate.selector === selector);
        if (!special) throw new CapabilityError(`${selector} has no member who can grant the complete requested authorization`);
        special.eligibleUserIds.forEach((id) => recipients.add(id));
      }
    }
    const service = new AuthorizationRequests(this.deps.store, project.organizationId);
    const existing = input.target.kind === 'task'
      ? service.requests({ status: 'pending', taskId: input.target.taskId })[0]
      : service.requests({ status: 'pending', avatarId: input.target.avatarId })[0];
    // A repeated click must not fan out duplicate Avatar decision tasks or route
    // a second audience that is not recorded on the durable request.
    if (existing) return existing;
    const request = service.request({
      projectId: input.projectId, target: input.target, authorization: input.authorization,
      capabilities: targets.requestedCapabilities, missingCapabilities: targets.missingCapabilities,
      audience, recipients: [...recipients], avatarRecipients: [...avatarRecipients],
      reason: String(input.reason ?? '').trim() || `Grant ${input.authorization.level} authorization to this ${input.target.kind}.`,
      requestedBy: caller.principal,
    });
    if (input.target.kind === 'task') {
      const event = { taskId: input.target.taskId, type: 'authorization.approval-requested', ts: Date.now(), payload: {
        requestId: request.id, recipients: request.recipients, audience: request.audience,
        authorization: request.authorization, missingCapabilities: request.missingCapabilities,
        urgency: normalizeUrgency(undefined, DEFAULT_URGENCY['approval-requested']),
      } };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
    } else {
      this.deps.store.addAuthorizationInbox(project.organizationId, request.recipients, {
        kind: 'avatar-authorization', avatarId: input.target.avatarId,
        projectId: input.projectId, requestId: request.id,
      }, request.createdAt);
      const event = { taskId: `avatar:${input.target.avatarId}`, type: 'authorization.approval-requested',
        ts: request.createdAt, payload: { requestId: request.id, recipients: request.recipients,
          audience: request.audience, authorization: request.authorization } };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
    }
    for (const avatarId of avatarRecipients) {
      const avatar = this.deps.store.getAvatar(avatarId)!;
      try {
        await this.createTask(token, {
          projectId: input.projectId, workflow: 'just-do',
          title: `${avatar.name}: decide authorization request`,
          prompt: `Decide whether to approve or deny authorization request ${request.id}.\n\nTarget: ${input.target.kind} ${input.target.kind === 'task' ? input.target.taskId : input.target.avatarId}\nRequested authorization: ${input.authorization.level} (${input.authorization.scope})\nMissing capabilities: ${request.missingCapabilities.join(', ')}\nReason: ${request.reason}\n\nAct according to your Avatar instructions. Resolve the request exactly once by calling platform_request with POST /api/authorization-requests/${request.id}/resolve?organizationId=${project.organizationId} and body {"action":"approve"} or {"action":"deny"}. Then briefly report the decision.`,
          params: { 'agent:do': { avatarId: avatar.id, avatarPurpose: 'authorize', provider: avatar.runtime.provider,
            ...(avatar.runtime.model ? { model: avatar.runtime.model } : {}),
            ...(avatar.runtime.effort ? { effort: avatar.runtime.effort } : {}) } },
        });
      } catch (error) {
        const failed = { taskId: input.target.kind === 'task' ? input.target.taskId : `avatar:${input.target.avatarId}`,
          type: 'avatar.authorization-dispatch-failed', ts: Date.now(),
          payload: { requestId: request.id, avatarId, error: error instanceof Error ? error.message : String(error) } };
        if (input.target.kind === 'task') {
          const seq = this.deps.store.appendEvent(failed);
          this.deps.bus?.emit({ ...failed, seq });
        }
      }
    }
    return request;
  }

  listAuthorizationRequests(
    token: string,
    input: { organizationId: string; status?: AuthorizationRequest['status']; taskId?: string; avatarId?: string },
  ): AuthorizationRequest[] {
    const projectId = input.taskId ? this.deps.store.getTask(input.taskId)?.projectId
      : input.avatarId ? this.deps.store.getAvatar(input.avatarId)?.projectId : undefined;
    if (!projectId) throw new ValidationError('taskId or avatarId is required');
    this.require(token, 'task:read', { projectId, organizationId: input.organizationId,
      ...(input.taskId ? { taskId: input.taskId } : {}) });
    return new AuthorizationRequests(this.deps.store, input.organizationId).requests(input);
  }

  async resolveAuthorizationRequest(
    token: string,
    input: { organizationId: string; requestId: string; action: 'approve' | 'deny' | 'dismiss' },
  ): Promise<AuthorizationRequest & { queued?: boolean }> {
    const service = new AuthorizationRequests(this.deps.store, input.organizationId);
    const request = service.requests().find((candidate) => candidate.id === input.requestId);
    if (!request) throw new NotFoundError(`no authorization request ${input.requestId}`);
    const caller = this.require(token, 'task:read', { projectId: request.projectId, organizationId: input.organizationId });
    const avatarId = caller.kind === 'agent' && caller.principal.startsWith('avatar:') ? caller.principal.slice(7) : undefined;
    const humanUserId = avatarId ? undefined : caller.humanSubject?.userId;
    if (!humanUserId && !avatarId) throw new CapabilityError('a routed human or Avatar is required to resolve this request');
    if (humanUserId && !request.recipients.includes(humanUserId)
      || avatarId && !(request.avatarRecipients ?? []).includes(avatarId))
      throw new CapabilityError('this authorization request was not routed to you');
    if (input.action === 'dismiss') {
      const dismissed = service.dismiss(request.id, caller.principal);
      this.deps.store.removeAuthorizationInbox(request.id);
      const event = { taskId: request.target.kind === 'task' ? request.target.taskId : `avatar:${request.target.avatarId}`,
        type: 'authorization.approval-dismissed', ts: Date.now(), payload: { requestId: request.id } };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
      return dismissed;
    }
    let queued = false;
    if (input.action === 'approve') {
      const grantorCaps = this.authorizationGrantorCaps(token, caller, request.authorization, input.organizationId);
      const authorization = this.deps.authorization?.taskGrant(caller.principal, request.projectId, request.authorization, grantorCaps);
      if (!authorization || authorization.attenuated)
        throw new CapabilityError('you can no longer grant the complete requested authorization');
      if (request.target.kind === 'task') {
        const group = this.deps.store.attemptGroup(request.target.taskId);
        const attempts = group?.attempts?.length ? group.attempts : [this.deps.store.getTask(request.target.taskId)!];
        for (const attempt of attempts) await this.setTaskAuthorization(
          token, attempt.id, request.authorization, undefined, undefined,
          { acceptAttenuation: false, preserveCredentialGrants: true });
        if (request.target.queueAfterApproval) {
          for (const attempt of attempts) if (this.deps.store.getTask(attempt.id)?.params?.draft)
            await this.queueTask(token, attempt.id);
          queued = true;
        }
      } else {
        const avatar = this.deps.store.getAvatar(request.target.avatarId);
        if (!avatar || avatar.projectId !== request.projectId) throw new NotFoundError('Avatar no longer exists');
        for (const capability of avatar.authorization.capabilities) {
          if (capability.startsWith('use-credential:') && !authorization.capabilities.includes(capability))
            authorization.capabilities.push(capability);
        }
        this.deps.store.upsertAvatar({ ...avatar, enabled: request.target.enableAfterApproval ? true : avatar.enabled,
          authorization: { ...authorization, principal: caller.principal }, updatedAt: Date.now() });
      }
    }
    const resolved = service.resolve(request.id, input.action, caller.principal);
    if (request.target.kind === 'task') {
      const event = { taskId: request.target.taskId, type: 'authorization.approval-resolved', ts: Date.now(), payload: {
        requestId: request.id, action: input.action, resolvedBy: caller.principal, queued,
      } };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
    } else {
      this.deps.store.removeAuthorizationInbox(request.id);
      const event = { taskId: `avatar:${request.target.avatarId}`, type: 'authorization.approval-resolved',
        ts: Date.now(), payload: { requestId: request.id, action: input.action, resolvedBy: caller.principal } };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
    }
    return { ...resolved, ...(queued ? { queued } : {}) };
  }

  listPermissionRequests(
    token: string,
    input: { organizationId: string; taskId: string; status?: PermissionRequest['status'] },
  ): PermissionRequest[] {
    const task = this.deps.store.getTask(input.taskId);
    const project = task && this.deps.store.getProject(task.projectId);
    this.require(token, 'task:read', {
      taskId: input.taskId,
      projectId: task?.projectId,
      organizationId: input.organizationId,
    });
    if (!task || project?.organizationId !== input.organizationId) return [];
    return new PermissionRequests(this.deps.store, input.organizationId)
      .requests({ taskId: input.taskId, status: input.status })
      .map((request) => ({
        ...request,
        task: {
          id: task.id,
          ...(task.num != null ? { num: task.num } : {}),
          title: task.title,
          projectId: task.projectId,
        },
      }));
  }

  async resolvePermissionRequest(
    token: string,
    input: { organizationId: string; requestId: string; action: 'approve' | 'deny' | 'dismiss' },
  ): Promise<PermissionRequest & { resume: Awaited<ReturnType<KarmaxApi['resumeAfterCredentialDecision']>> }> {
    const key = `${input.organizationId}:${input.requestId}`;
    if (this.resolvingPermissions.has(key)) throw new ValidationError('permission request decision is already in progress');
    this.resolvingPermissions.add(key);
    try {
      return await this.applyPermissionDecision(token, input);
    } finally {
      this.resolvingPermissions.delete(key);
    }
  }

  private async applyPermissionDecision(
    token: string,
    input: { organizationId: string; requestId: string; action: 'approve' | 'deny' | 'dismiss' },
  ): Promise<PermissionRequest & { resume: Awaited<ReturnType<KarmaxApi['resumeAfterCredentialDecision']>> }> {
    const service = new PermissionRequests(this.deps.store, input.organizationId);
    const request = service.requests().find((candidate) => candidate.id === input.requestId);
    if (!request) throw new NotFoundError(`no permission request ${input.requestId}`);
    const task = this.deps.store.getTask(request.taskId);
    const caller = this.require(token, 'task:read', {
      taskId: request.taskId,
      projectId: request.projectId,
      organizationId: input.organizationId,
    });
    const avatarId = caller.kind === 'agent' && caller.principal.startsWith('avatar:')
      ? caller.principal.slice(7) : undefined;
    const humanUserId = avatarId ? undefined : caller.humanSubject?.userId;
    if (!humanUserId && !avatarId)
      throw new CapabilityError('a routed human or Avatar principal is required to resolve a permission request');
    if (humanUserId && !request.recipients.includes(humanUserId)
      || avatarId && !(request.avatarRecipients ?? []).includes(avatarId))
      throw new CapabilityError('this permission request was not routed to you');
    if (request.status !== 'pending') throw new ValidationError(`request ${request.id} is already ${request.status}`);
    if (input.action === 'dismiss') {
      const dismissed = service.dismiss(request.id, caller.principal);
      const event = { taskId: request.taskId, type: 'permission.approval-dismissed',
        ts: Date.now(), payload: { requestId: request.id } };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
      return { ...dismissed, resume: { resumed: false, reason: 'Dismissed without notifying the agent' } };
    }
    if (input.action === 'approve' && !(task && this.permissionRequestSatisfied(task, request))) {
      let expanded: AuthorizationSelection | undefined;
      if (request.projectIds?.length) {
        if (!task || !this.deps.authorization) throw new ValidationError('task authorization is unavailable');
        const current = previousTaskGrants(task).authorization;
        if (!current || current.scope !== 'projects'
          || JSON.stringify(current) !== JSON.stringify(request.baseAuthorization))
          throw new ValidationError('task authorization changed; submit a new project access request');
        expanded = { ...current, projectIds: [...new Set([...(current.projectIds ?? []), ...request.projectIds])] };
        this.deps.authorization.requestedCapabilities(task.projectId, expanded);
        // Scope applies to every role, including earlier approved extensions.
        // Check durable human grants per project; delegated agents are limited
        // to their immediate bearer, never their backing human's authority.
        const existingCaps = [
          ...((task.params?._authorization as { capabilities?: string[] })?.capabilities ?? []),
          ...service.extensionCaps(task.id),
          ...new VaultItems(this.deps.store, this.deps.broker, undefined, input.organizationId).extensionCaps(task.id),
        ];
        for (const projectId of expanded.projectIds!) for (const capability of [...existingCaps, ...request.capabilities]) {
          const held = caller.kind === 'human'
            ? allows(this.deps.authorization.capabilities(caller.principal, projectId, input.organizationId), capability)
            : this.deps.tokens.check(token, capability, { projectId, organizationId: input.organizationId }).ok;
          if (!held) throw new CapabilityError(`you cannot grant ${capability} in project ${projectId}`);
        }
      }
      const selectedProjects = task && previousTaskGrants(task).authorization?.projectIds;
      for (const capability of expanded ? [] : request.capabilities) {
        for (const projectId of selectedProjects?.length ? selectedProjects : [request.projectId]) {
          // Later capability requests also apply throughout an expanded scope.
          const checked = caller.kind === 'human' && this.deps.authorization && selectedProjects && selectedProjects.length > 1
            ? { ok: allows(this.deps.authorization.capabilities(caller.principal, projectId, input.organizationId), capability), reason: 'permission denied' }
            : this.deps.tokens.check(token, capability, {
              taskId: request.taskId, projectId, organizationId: input.organizationId,
            });
          if (!checked.ok)
            throw new CapabilityError(`you cannot grant ${capability}: ${checked.reason ?? 'permission denied'} (project ${projectId})`);
        }
      }
      if (expanded) await this.setTaskAuthorization(token, request.taskId, expanded, undefined, undefined,
        { acceptAttenuation: false, preserveCredentialGrants: true });
    }
    return this.finishPermissionDecision(service, request, input.action, caller.principal,
      input.action === 'approve' && !!task && this.permissionRequestSatisfied(task, request));
  }

  /** Only reconcile from the persisted grant, never from the requested level. */
  private permissionRequestSatisfied(task: TaskRecord, request: PermissionRequest): boolean {
    const authorization = task.params?._authorization as { capabilities?: Capability[] } | undefined;
    if (!authorization?.capabilities) return false;
    const service = new PermissionRequests(this.deps.store,
      this.deps.store.getProject(task.projectId)?.organizationId ?? 'org_personal');
    const caps = [...authorization.capabilities, ...service.extensionCaps(task.id, request.role)];
    if (!request.capabilities.every((cap) => allows(caps, cap))) return false;
    if (!request.projectIds?.length) return true;
    const current = previousTaskGrants(task).authorization;
    if (!current || !this.deps.authorization || !request.baseAuthorization) return false;
    const projects = [...new Set([...(request.baseAuthorization.projectIds ?? [task.projectId]), ...request.projectIds])];
    if (current.scope === 'projects' && !projects.every((id) => current.projectIds?.includes(id))) return false;
    // Scope-only asks promise the original authorization across the added projects.
    try {
      const required = this.deps.authorization.requestedCapabilities(task.projectId,
        { ...request.baseAuthorization, scope: 'projects', projectIds: projects });
      return required.every((cap) => allows(authorization.capabilities!, cap));
    } catch {
      // An obsolete profile or deleted project must not block an unrelated edit.
      return false;
    }
  }

  private async finishPermissionDecision(
    service: PermissionRequests, request: PermissionRequest, action: 'approve' | 'deny',
    principal: string, alreadyAuthorized = false,
  ): Promise<PermissionRequest & { resume: Awaited<ReturnType<KarmaxApi['resumeAfterCredentialDecision']>> }> {
    const resolved = service.resolve(request.id, { action, by: principal, alreadyAuthorized });
    const message = action === 'approve'
      ? `[Krmax permission decision]\n\nApproved for this task's ${resolved.role} agent: ${resolved.capabilities.join(', ')}${resolved.projectIds?.length ? `; additional task projects: ${resolved.projectIds.join(', ')}` : ''}. Retry the blocked operation now; a newly scoped token will carry the grant.`
      : `[Krmax permission decision]\n\nDenied for this task's ${resolved.role} agent: ${resolved.capabilities.join(', ')}${resolved.projectIds?.length ? `; additional task projects: ${resolved.projectIds.join(', ')}` : ''}. Do not request these permissions again; continue without them or explain why the task cannot proceed.`;
    const resume = await this.resumeAfterCredentialDecision(request.taskId, message, request.role);
    const event = {
      taskId: request.taskId,
      type: 'permission.approval-resolved',
      ts: Date.now(),
      payload: {
        requestId: request.id,
        role: request.role,
        capabilities: request.capabilities,
        projectIds: request.projectIds,
        action,
        resolvedBy: principal,
        resumed: resume.resumed,
      },
    };
    const seq = this.deps.store.appendEvent(event);
    this.deps.bus?.emit({ ...event, seq });
    return { ...resolved, resume };
  }

  /** Discover only the people and teams that can receive an escalation for the
   * calling task. Kept behind the same narrow capability so Merge/Confirm and
   * custom roles do not need broad organization-directory access. */
  humanEscalationTargets(token: string): {
    taskId: string;
    users: Array<{ id: string; selector: string }>;
    teams: Array<{ id: string; name: string; slug: string; selector: string }>;
    special: Array<{ selector: string; description: string }>;
    avatars: Array<{ id: string; name: string; purpose?: string; selector: string; roles: string[] }>;
  } {
    const caller = this.require(token, 'escalate_to_human');
    if (caller.taskId === '*') throw new Error('this endpoint requires a task-agent token');
    const task = this.deps.store.getTask(caller.taskId);
    this.require(token, 'escalate_to_human', { projectId: task?.projectId, taskId: caller.taskId });
    if (!task) throw new Error(`no task ${caller.taskId}`);
    const project = this.deps.store.getProject(task.projectId);
    if (!project?.organizationId) throw new Error('task project has no organization');

    const projectUsers = this.deps.store.humanAudience(task.id, ['@project']);
    const users = projectUsers.map((id) => ({ id, selector: `user:${id}` }));
    const teams = this.deps.store.listTeams(project.organizationId, project.id)
      .filter((team) => this.deps.store.listTeamMemberships(team.id)
        .some((member) => projectUsers.includes(member.userId)))
      .map((team) => ({ id: team.id, name: team.name, slug: team.slug, selector: `@team:${team.slug}` }));
    const descriptions: Record<string, string> = {
      '@creator': 'The human who initiated this task (following its parent chain).',
      '@owners': 'Organization owners.',
      '@project': 'Everyone with access to this project.',
      '@all': 'Every member of this organization.',
    };
    const special = Object.entries(descriptions)
      .filter(([selector]) => this.deps.store.humanAudience(task.id, [selector]).length > 0)
      .map(([selector, description]) => ({ selector, description }));
    const creatorUserId = this.deps.store.taskCreatorUserId(task.id);
    const avatars = this.deps.store.listAvatars(task.projectId)
      .filter((avatar) => avatarEnabled(this.deps.store, avatar)
        && (!avatar.roles.length || avatar.roles.includes('authorize') || avatar.roles.includes('respond'))
        && Boolean(creatorUserId && avatarCallableBy(this.deps.store, avatar, creatorUserId)))
      .map((avatar) => ({ id: avatar.id, name: avatar.name, ...(avatar.purpose ? { purpose: avatar.purpose } : {}),
        selector: `avatar:${avatar.id}`, roles: avatar.roles }));
    return { taskId: task.id, users, teams, special, avatars };
  }

  /** Resolve the human-facing project-local number (#100) without guessing ids. */
  async findTask(token: string, projectId: string, num: number): Promise<TaskRecord | undefined> {
    this.require(token, 'find_task', { projectId });
    return this.deps.store.getTaskByNum(projectId, num);
  }

  /** Every durable agent conversation attached to a task, including sessions. */
  async listTaskAgents(token: string, taskId: string): Promise<Array<{ role: string; label: string; session?: string; provider?: string; messageCount: number }>> {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'list_agents', { projectId: task?.projectId, taskId });
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    const view = await this.getTaskView(token, taskId);
    const transcripts = view?.transcripts?.length
      ? view.transcripts
      : [{ role: 'do', label: 'Agent', messages: view?.messages ?? [] }];
    return transcripts.map((t) => {
      const session = this.deps.store.kvGet(`session:${taskId}:${t.role}`) || undefined;
      let provider: string | undefined;
      try { provider = JSON.parse(this.deps.store.kvGet(`sessionmeta:${taskId}:${t.role}`) ?? '{}').provider; } catch { /* legacy */ }
      return { role: t.role, label: t.label, session, provider, messageCount: t.messages.length };
    });
  }

  async taskConversation(token: string, taskId: string, role = 'do'): Promise<{ role: string; session?: string; messages: Message[] }> {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'get_conversation', { projectId: task?.projectId, taskId });
    const view = await this.getTaskView(token, taskId);
    if (!view) throw new Error(`task ${taskId} has no conversation yet`);
    const transcript = role === 'do' ? undefined : view.transcripts?.find((t) => t.role === role);
    return { role, session: this.deps.store.kvGet(`session:${taskId}:${role}`) || undefined, messages: (transcript?.messages ?? view.messages).map((m) => ({ ...m })) };
  }

  /** Branch a source agent into an independent task/session; the source is never mutated.
   *
   * `reauthorize` starts the fork from the grants the source task ended with —
   * its authorization level/scope (including any mid-task elevation a human
   * approved) plus its vault credential grants and policies — instead of the
   * project default. The forked conversation usually continues the same work,
   * so without it every credential the source was approved for is asked again.
   * The grants go through `createTask`'s ordinary checks: the caller cannot hand
   * the fork more than it could grant a fresh task, so an over-broad source
   * fails loudly rather than silently attenuating. */
  async forkTaskAgent(token: string, args: { taskId: string; role?: string; title?: string; message: string;
    base?: string; target?: string; authorizationProfile?: string; reauthorize?: boolean; provider?: Provider; model?: string;
    effort?: AgentSpec['effort'] }): Promise<TaskRecord> {
    const source = this.deps.store.getTask(args.taskId);
    this.require(token, 'fork_agent', { projectId: source?.projectId, taskId: args.taskId });
    if (!source) throw new NotFoundError(`no task ${args.taskId}`);
    const role = args.role ?? 'do';
    if (!this.deps.store.kvGet(`session:${args.taskId}:${role}`) && !(await this.getTaskView(token, args.taskId))?.messages?.length)
      throw new Error(`the ${role} agent has no conversation to fork`);
    const previous = args.reauthorize ? previousTaskGrants(source) : undefined;
    return this.createTask(token, {
      projectId: source.projectId,
      title: args.title ?? `Fork of #${source.num ?? source.id} ${role}`,
      workflow: 'software-dev',
      params: {
        prompt: args.message,
        ...(args.target ? { target: args.target } : {}),
        // Existing callers use target as a combined base/target override.
        // The new base field can override that legacy shorthand independently.
        ...(args.base || args.target ? { base: args.base ?? args.target } : {}),
        'agent:do': {
          ...(args.provider ? { provider: args.provider } : {}),
          ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          resumeFrom: { taskId: args.taskId, role },
        },
      },
      // An explicit profile is the caller's choice; the source's selection only
      // fills in when none was named.
      ...(args.authorizationProfile ? { authorizationProfile: args.authorizationProfile }
        : previous?.authorization ? { authorization: previous.authorization } : {}),
      ...(previous ? { credentialGrants: previous.credentialGrants, credentialPolicies: previous.credentialPolicies } : {}),
    });
  }

  async taskTiming(token: string, taskId: string) {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'list_events', { projectId: task?.projectId, taskId });
    if (!timingEnabled(this.deps.store)) throw new Error('Timing is disabled for this installation');
    return timingReport(this.deps.store.eventsOfType(taskId, 'timing').map(e => e.payload as unknown as import('../timing/index.js').TimingRow));
  }

  async taskEvents(token: string, taskId: string, since = 0, limit?: number) {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'list_events', { projectId: task?.projectId, taskId });
    return this.deps.store.eventsSince(taskId, since, limit, !timingEnabled(this.deps.store));
  }

  /** Resolve an Actions request through the calling task's project attachment.
   * Repository names supplied in prompts are never an authority source. */
  private githubActionsTask(token: string, tool: 'list_github_actions_workflows' | 'list_github_actions_runs' | 'inspect_github_actions_run'
    | 'manage_github_actions_run' | 'dispatch_github_actions_workflow', repositoryRef?: string) {
    const caller = this.require(token, tool);
    if (!caller.taskId || caller.taskId === '*') throw new CapabilityError(`${tool} requires a task-agent token`);
    const task = this.deps.store.getTask(caller.taskId);
    if (!task) throw new NotFoundError('calling task not found');
    this.require(token, tool, { projectId: task.projectId, taskId: task.id });
    if (!this.deps.githubApp) throw new Error('Connect GitHub in organization settings, then try again.');
    const linked = this.deps.store.listProjectRepositories(task.projectId).map((entry) => entry.repository)
      .filter((repository) => repository.provider === 'github' && repository.gitConnectionId);
    if (!linked.length) throw new Error('This project has no attached GitHub repository with an active App installation.');
    const selector = repositoryRef?.trim().toLowerCase();
    let matches = linked;
    if (selector) matches = linked.filter((repository) => repository.id.toLowerCase() === selector
      || repository.name.toLowerCase() === selector
      || `${repository.owner}/${repository.name}`.toLowerCase() === selector);
    if (!selector && linked.length > 1)
      throw new Error('repository is required because this project has more than one attached GitHub repository');
    if (!matches.length) throw new NotFoundError('repository is not attached to the calling task’s project');
    if (matches.length > 1) throw new Error('repository name is ambiguous; use owner/name or the repository id');
    const repository = matches[0]!;
    return { task, repository, api: this.deps.githubApp.actions(repository) };
  }

  private githubActionsEvent(taskId: string, type: string, payload: Record<string, unknown>): void {
    const event = { taskId, type, ts: Date.now(), payload };
    const seq = this.deps.store.appendEvent(event);
    this.deps.bus?.emit({ ...event, seq });
  }

  async listGithubActionsRuns(token: string, input: { repository?: string; branch?: string; event?: string;
    status?: GithubActionsStatus; workflow?: string | number; page?: number; perPage?: number }) {
    const { task, repository, api } = this.githubActionsTask(token, 'list_github_actions_runs', input.repository);
    const result = await api.listRuns(`${repository.owner}/${repository.name}`, input);
    this.githubActionsEvent(task.id, 'github.actions.runs-read', {
      repositoryId: repository.id, slug: `${repository.owner}/${repository.name}`,
      page: result.page, returned: result.runs.length,
      ...(input.branch ? { branch: input.branch } : {}), ...(input.workflow ? { workflow: input.workflow } : {}),
    });
    return result;
  }

  async listGithubActionsWorkflows(token: string, input: { repository?: string; page?: number; perPage?: number }) {
    const { task, repository, api } = this.githubActionsTask(token, 'list_github_actions_workflows', input.repository);
    const result = await api.listWorkflows(`${repository.owner}/${repository.name}`, input);
    this.githubActionsEvent(task.id, 'github.actions.workflows-read', {
      repositoryId: repository.id, page: result.page, returned: result.workflows.length,
    });
    return result;
  }

  async inspectGithubActionsRun(token: string, input: { repository?: string; runId: number } & GithubActionsInspectOptions) {
    const { task, repository, api } = this.githubActionsTask(token, 'inspect_github_actions_run', input.repository);
    const { repository: _repository, runId, ...options } = input;
    const result = await api.inspectRun(`${repository.owner}/${repository.name}`, runId, options);
    this.githubActionsEvent(task.id, 'github.actions.run-inspected', {
      repositoryId: repository.id, slug: `${repository.owner}/${repository.name}`, runId,
      view: input.view ?? 'failure', attempt: input.attempt, jobId: input.jobId, page: input.page,
    });
    return result;
  }

  async manageGithubActionsRun(token: string, input: {
    repository?: string; runId: number; action: 'rerun-failed' | 'rerun' | 'cancel';
  }) {
    if (!['rerun-failed', 'rerun', 'cancel'].includes(input.action))
      throw new Error('action must be rerun-failed, rerun, or cancel');
    const { task, repository, api } = this.githubActionsTask(token, 'manage_github_actions_run', input.repository);
    const slug = `${repository.owner}/${repository.name}`;
    const result = input.action === 'cancel'
      ? await api.cancel(slug, input.runId)
      : await api.rerun(slug, input.runId, input.action === 'rerun-failed');
    this.githubActionsEvent(task.id, 'github.actions.run-operated', {
      repositoryId: repository.id, slug, runId: input.runId, action: input.action,
    });
    return result;
  }

  async dispatchGithubActionsWorkflow(token: string, input: {
    repository?: string; workflow: string | number; ref: string;
    inputs?: Record<string, string | number | boolean>;
  }) {
    const { task, repository, api } = this.githubActionsTask(token, 'dispatch_github_actions_workflow', input.repository);
    const slug = `${repository.owner}/${repository.name}`;
    const result = await api.dispatch(slug, input.workflow, input.ref, input.inputs);
    this.githubActionsEvent(task.id, 'github.actions.workflow-dispatched', {
      repositoryId: repository.id, slug, workflow: input.workflow, ref: input.ref,
      inputNames: Object.keys(input.inputs ?? {}).sort(),
    });
    return result;
  }

  // ─── Search & organization (task search / views — PLAN-search-views) ─────────
  // A *view* is a saved *query*: every list surface (including the default one) is the
  // result of evaluating a `TaskQuery` — free text + structured filters + sort + group —
  // against the project's tasks. The evaluator is pure (src/domain/search.ts); it runs
  // in-memory over the store's `listTasks` (cheap at todo-list scale), whose records
  // already carry the cached `lastView` (status/stage/pr) and hydrated `tags`.

  /**
   * Evaluate a query against a project's tasks. `query` may be a raw query string
   * (the search box / a saved view's serialized form) or an already-structured
   * `TaskQuery`. Returns the filtered+sorted list, optional groups, and total.
   */
  async searchTasks(token: string, projectId: string, query: string | TaskQuery, now = Date.now()): Promise<EvalResult> {
    const caller = this.require(token, 'search_tasks', { projectId });
    const q: TaskQuery = typeof query === 'string' ? parseQuery(query) : query ?? {};
    // Conversation search is intentionally explicit. Every other query uses the
    // compact projection so routine list filtering never parses all transcripts.
    const needsConversation = q.filters?.some((clause) =>
      clause.field === 'conversation' || clause.field === 'says') ?? false;
    const tasks = needsConversation
      ? this.deps.store.listTasks(projectId)
      : this.deps.store.listTaskSummaries(projectId);
    const tags = this.deps.store.listTags(projectId);
    const principal = principalRefOf(caller.principal);
    return evaluateQuery(tasks, q, { now, tags, userId: principal?.kind === 'user' ? principal.userId : undefined });
  }

  /** The searchable-field registry the UI reads to build its filter/sort/group menus. */
  searchFields(token: string) {
    this.require(token, 'search_fields');
    return fieldCatalogue();
  }

  // ─── Tags ────────────────────────────────────────────────────────────────────
  async listTags(token: string, projectId: string): Promise<Tag[]> {
    this.require(token, 'list_tags', { projectId });
    return this.deps.store.listTags(projectId);
  }

  async createTag(token: string, input: { projectId: string; name: string; parentId?: string; color?: string; kind?: 'type' | 'topic' | 'flag'; description?: string }): Promise<Tag> {
    this.require(token, 'manage_tag', { projectId: input.projectId });
    return this.deps.store.createTag(input);
  }

  // `/api/tags/:id` and `/api/views/:id` carry no project in the path, so the
  // record has to be looked up BEFORE the check or the token's project/tenant
  // scope has nothing to compare against and the guard silently passes. Without
  // this, any token with `task:edit` could rename or delete a tag or a saved
  // view in any project of any organization.
  async updateTag(token: string, id: string, patch: { name?: string; parentId?: string | null; color?: string | null; kind?: 'type' | 'topic' | 'flag' | null; description?: string | null }): Promise<Tag | undefined> {
    const tag = this.deps.store.getTag(id);
    this.require(token, 'manage_tag', { projectId: tag?.projectId });
    return this.deps.store.updateTag(id, patch);
  }

  async deleteTag(token: string, id: string): Promise<void> {
    const tag = this.deps.store.getTag(id);
    this.require(token, 'manage_tag', { projectId: tag?.projectId });
    this.deps.store.deleteTag(id);
  }

  /** Replace the full tag set on a task (organization only — never reaches the agent). */
  async setTaskTags(token: string, taskId: string, tagIds: string[]): Promise<string[]> {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'set_task_tags', { projectId: task?.projectId, taskId });
    this.deps.store.setTaskTags(taskId, tagIds);
    return this.deps.store.tagsFor(taskId);
  }

  /**
   * Agent-friendly tagging: add/remove tags on a task **by name or `a/b` path** rather
   * than opaque ids. An `add` name that doesn't exist is created (slash paths build the
   * hierarchy); a `remove` name that isn't present is ignored. Returns the resulting tag
   * paths. This is what the platform MCP exposes so agents can label tasks they touch.
   */
  async tagTask(token: string, taskId: string, patch: { add?: string[]; remove?: string[] }): Promise<{ tags: string[] }> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError(`no such task ${taskId}`);
    this.require(token, 'set_task_tags', { projectId: task.projectId, taskId });
    return this.applyTagPatch(task.id, task.projectId, patch);
  }

  /**
   * Tag resolution and application, without the capability check.
   *
   * Split out so `createTask` can apply the tags that came WITH the creation
   * payload under its own `task:create` authorization. Applying them as a
   * follow-up `tagTask` call needed `task:edit`, which the bundled Do role does
   * not hold — so an agent creating a tagged sub-task got the task created and
   * *then* a permission error, with the tags silently missing and a half-built
   * task left behind. Creating a task with its metadata is one act of creation,
   * not a create plus an edit.
   */
  private applyTagPatch(taskId: string, projectId: string, patch: { add?: string[]; remove?: string[] }): { tags: string[] } {
    const task = { id: taskId, projectId };
    const resolve = () => {
      const tags = this.deps.store.listTags(task.projectId);
      const byId = new Map(tags.map((t) => [t.id, t]));
      const find = (s: string) => {
        const v = s.trim().toLowerCase();
        return tags.find((t) => t.name.toLowerCase() === v || tagPath(t, byId).toLowerCase() === v);
      };
      return { tags, byId, find };
    };
    const cur = new Set(this.deps.store.tagsFor(taskId));
    for (const name of patch.add ?? []) {
      if (!name.trim()) continue;
      const found = resolve().find(name);
      const id = found ? found.id : this.deps.store.createTag({ projectId: task.projectId, name }).id;
      cur.add(id);
    }
    for (const name of patch.remove ?? []) {
      const found = resolve().find(name);
      if (found) cur.delete(found.id);
    }
    this.deps.store.setTaskTags(taskId, [...cur]);
    const { byId } = resolve();
    return { tags: this.deps.store.tagsFor(taskId).map((id) => (byId.get(id) ? tagPath(byId.get(id)!, byId) : id)) };
  }

  /** Set the organizational priority (0–4) — editable at any lifecycle stage. */
  async setTaskPriority(token: string, taskId: string, priority: number): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    // Refuse a missing task explicitly. `task?.projectId` on a nonexistent id
    // passes `undefined` as the scope, and an omitted scope is not a partial
    // check but NO check — the tenant guard goes inert and the write silently
    // no-ops instead of reporting that the id was wrong.
    if (!task) throw new NotFoundError(`no such task ${taskId}`);
    this.require(token, 'set_task_priority', { projectId: task.projectId, taskId });
    this.deps.store.setTaskPriority(taskId, priority);
  }

  // ─── Saved views (a view is a saved query) ───────────────────────────────────
  async listViews(token: string, projectId: string): Promise<SavedView[]> {
    this.require(token, 'list_views', { projectId });
    return this.deps.store.listViews(projectId);
  }

  async createView(token: string, input: { projectId: string; name: string; query: TaskQuery; icon?: string }): Promise<SavedView> {
    this.require(token, 'manage_view', { projectId: input.projectId });
    return this.deps.store.createView(input);
  }

  // As with tags: `/api/views/:id` has no project in the path, so the view is
  // resolved first and its project supplied as the scope to check against.
  async updateView(token: string, id: string, patch: { name?: string; query?: TaskQuery; icon?: string | null }): Promise<SavedView | undefined> {
    const view = this.deps.store.getView(id);
    this.require(token, 'manage_view', { projectId: view?.projectId });
    return this.deps.store.updateView(id, patch);
  }

  async reorderView(token: string, id: string, ord: number): Promise<void> {
    const view = this.deps.store.getView(id);
    this.require(token, 'manage_view', { projectId: view?.projectId });
    this.deps.store.reorderView(id, ord);
  }

  async deleteView(token: string, id: string): Promise<void> {
    const view = this.deps.store.getView(id);
    this.require(token, 'manage_view', { projectId: view?.projectId });
    this.deps.store.deleteView(id);
  }

  /** Restart a terminally failed software-dev execution without running Setup.
   * Setup's createWorld deliberately replaces stale worktrees; doing that here
   * would erase the exact dirty work a recovery exists to preserve. */
  private async recoverFailedTask(taskId: string): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    const view = task?.lastView;
    if (!task || !view) throw new Error(`no failed task ${taskId}`);
    if (!RECOVERABLE_WORKFLOWS.has(task.workflow) || view.status !== 'failed')
      throw new Error(`only a failed ${[...RECOVERABLE_WORKFLOWS].join(' or ')} task can be recovered`);
    if (view.pointOfNoReturnPassed) throw new Error('cannot recover a task after its merge point of no return');

    // Recovery is an explicit migration boundary. Replaying a replacement with
    // the same obsolete implementation can reproduce the exact incompatibility
    // that made the old run terminal, so resume on the current bundled version
    // and persist that new pin only after Temporal accepts the replacement.
    const { startType, input, version } = await this.buildStart(task, true);
    const savedWorld = view.state?.recoveryWorld as any;
    let world = savedWorld?.root && savedWorld?.branch ? savedWorld : undefined;

    // Back-compat for failures recorded before recoveryWorld was added. The three
    // production incidents were single-repo worktrees and retain enough fields in
    // TaskView to rebuild their plain handle safely. Refuse ambiguous multi-repo or
    // container recovery rather than risking work loss.
    if (!world) {
      const repos = input.project.repos?.filter(Boolean) ?? [];
      if (!view.worldPath || !view.branch) throw new Error('failed task has no preserved world to recover');
      if (input.project.worldProvider === 'container') throw new Error('legacy container task has no recoverable container handle');
      if (repos.length > 1) throw new Error('legacy multi-repo task has no complete world checkpoint; recover its worktrees manually');
      const repo = repos[0];
      world = {
        kind: 'worktree',
        id: taskId,
        root: view.worldPath,
        branch: view.branch,
        base: view.base ?? input.base ?? 'main',
        target: view.targetBranch ?? input.target,
        ...(repo
          ? {
              repo,
              repos: [{ name: path.basename(repo), repo, root: view.worldPath, branch: view.branch, base: view.base ?? input.base ?? 'main' }],
            }
          : {}),
      };
    }
    if (world.kind === 'worktree' && !fs.existsSync(world.root)) throw new Error(`preserved worktree no longer exists: ${world.root}`);

    const messages = view.messages.map((m) => ({ ...m }));
    const seen = typeof view.state?.turnsSeen === 'number' ? view.state.turnsSeen : messages.length;
    messages.push({
      id: `recovery-${Date.now()}`,
      role: 'user',
      text: `Krmax recovered this task after its prior execution failed. Continue from the existing worktree and conversation; preserve and finish the work already present. Previous failure: ${view.error ?? 'unknown error'}`,
      ts: messages.length,
    });
    const session = this.deps.store.kvGet(`session:${taskId}:do`) || undefined;
    let sessionHome: string | undefined;
    try {
      const meta = JSON.parse(this.deps.store.kvGet(`sessionmeta:${taskId}:do`) ?? '{}');
      sessionHome = typeof meta.home === 'string' ? meta.home || '(profile)' : undefined;
    } catch {
      /* malformed legacy metadata: conversation still recovers without session resume */
    }
    input.recovery = {
      world,
      messages,
      transcripts: view.transcripts?.map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m })) })),
      reviewInfo: view.reviewInfo,
      session,
      sessionHome,
      seen,
      target: view.targetBranch,
    };

    const execution = await withTimeout(
      this.deps.client.workflow.start(startType, {
        taskQueue: this.deps.taskQueue,
        workflowId: taskId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        args: [input],
      }),
      START_TIMEOUT_MS,
    );
    this.deps.store.setTaskWorkflowVersion(taskId, version);
    this.deps.store.setTaskExecutionWorkflow(taskId, task.workflow);
    const runId = (execution as any)?.firstExecutionRunId ?? (execution as any)?.runId;
    if (typeof runId === 'string' && runId) {
      this.deps.store.patchTaskParams(taskId, { _workflowRunId: runId });
    }
    // A failed workflow recovery starts a new Temporal history, so replay cannot
    // reconstruct collaborationRequested signals from the old execution. Restore
    // the durable join set before the recovered Do turn can advance to Review.
    for (const request of this.deps.store.listCollaborationRequests({
      requesterTaskId: taskId,
      status: 'pending',
    })) {
      await this.workflowHandle(taskId)
        .signal(SIG.collaborationRequested, request.id)
        .catch(() => undefined);
    }
    const started = this.resolveStart(task.workflow, version,
      this.deps.store.getProject(task.projectId)?.organizationId);
    if (started) this.saveAgentSnapshot(taskId, started.manifest, input);
    // Close the short acceptance→first-publish window so the UI cannot offer a
    // second recovery while the replacement run is already starting.
    this.deps.store.saveView(taskId, {
      ...view,
      stage: 'do',
      status: 'active',
      messages,
      error: undefined,
      waitingFor: undefined,
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }],
      state: { ...view.state, recoveryWorld: world },
    });
  }

  async signalTask(token: string, taskId: string, signal: string, text?: string, role?: string, images?: ImageRef[], files?: FileRef[], attemptChoice?: { otherAttempts?: 'keep' | 'cancel'; saveOtherAttemptsDefault?: boolean }, receivedAt = timingEnabled(this.deps.store) ? { monoMs: performance.now(), wallMs: Date.now() } : undefined): Promise<Message | undefined> {
    const scopedTask = this.deps.store.getTask(taskId);
    const caller = this.require(token, 'signal_task', { projectId: scopedTask?.projectId, taskId });
    if (files?.length && scopedTask) this.validatePromptFiles(scopedTask.projectId, files);
    if (attemptChoice?.otherAttempts !== undefined && !['keep', 'cancel'].includes(attemptChoice.otherAttempts))
      throw new ValidationError('otherAttempts must be keep or cancel');
    if (attemptChoice?.saveOtherAttemptsDefault) {
      this.require(token, 'project:settings:write', { projectId: scopedTask?.projectId, taskId });
      if (!attemptChoice.otherAttempts) throw new ValidationError('choose keep or cancel before saving a default');
    }
    const heldView = scopedTask?.lastView;
    if (signal === SIG.retry && scopedTask && heldView?.stage === 'escalated'
      && heldView.status === 'blocked') {
      const credentialFailure = heldView.error?.match(/No usable\s+([^\s]+)\s+credential\b.*needs attention/i);
      if (credentialFailure) {
        // Retry explicitly permits another provider attempt, including credentials
        // with no usage endpoint. Await the quarantine update before signalling;
        // a failed update must not silently retry against the same denial.
        await this.deps.refreshCredentialHealth?.(scopedTask, credentialFailure[1]);
      }
    }
    const heldOrigin =
      heldView?.status === 'waiting'
      && heldView.waitingFor?.kind === 'human'
      && heldView.state?.humanPauseOrigin
        ? heldView.state.humanPauseOrigin as Stage
        : undefined;
    if (signal === SIG.confirm && heldOrigin && heldOrigin !== 'review')
      throw new Error(`this is a hold on ${stageName(heldOrigin)}, not a Review decision; resume it or send the relevant agent a follow-up`);
    // A Review confirmation is a reviewer's decision. A Confirm-role agent
    // records its verdict with `confirm_decision` in its own turn; any other
    // agent may send this signal only when its authorization carries
    // `review:approve` (maintainer and above — not the default developer
    // profile), because the workflow parks on the same `confirmed` flag
    // whichever layer is playing and the signal would pre-satisfy the human one.
    if (signal === SIG.confirm && caller.kind === 'agent' && !allows(caller.caps, 'review:approve'))
      throw new CapabilityError('confirming a Review gate needs review:approve (a maintainer-level authorization); an agent reviewing a task records its verdict with confirm_decision');
    if (signal === SIG.openPr && heldOrigin && heldOrigin !== 'do')
      throw new Error(`this is a hold on ${stageName(heldOrigin)}, not a proposal waiting to be opened`);
    const attemptGroup = scopedTask && this.deps.store.attemptGroup(taskId);
    const confirmsProposal = signal === SIG.confirm || (signal === SIG.openPr && !!caller.humanSubject);
    const needsAttemptChoice = confirmsProposal && scopedTask && this.attemptsReachMerge(scopedTask) && attemptGroup && !attemptGroup.committedAttemptId
      && attemptGroup.attempts.some((a) => a.id !== taskId && !['done', 'cancelled', 'failed'].includes(a.lastView?.status ?? ''));
    if (needsAttemptChoice && this.deps.store.otherAttemptsDefault(taskId) === 'ask' && !attemptChoice?.otherAttempts)
      throw new ValidationError('Choose whether to keep or cancel the other attempts when confirming this proposal.');
    if ((signal === SIG.confirm || signal === SIG.openPr || signal === SIG.approveCheckout)
      && scopedTask?.lastView?.waitingFor?.kind === 'human') {
      // Master's authorization parity: the human is the verified subject, not the
      // token's grantor principal. An agent authorized with `review:approve`
      // (maintainer and above) stands in for the human audience; a
      // developer-level agent does not.
      const userId = caller.humanSubject?.userId;
      const delegatedReviewer = !userId && caller.kind === 'agent' && allows(caller.caps, 'review:approve');
      if (!userId && !delegatedReviewer)
        throw new CapabilityError('only a human selected by this workflow step, or an agent authorized with review:approve, can confirm');
      if (userId && !this.deps.store.humanMayAct(taskId, userId))
        throw new CapabilityError('this workflow confirmation step is assigned to someone else');
      // Opening a proposal defers its confirmation until Review is ready.
      // Only a direct Confirm decision is journalled at this point.
      if (signal === SIG.confirm) {
        recordHumanConfirmation(this.deps.store, taskId, userId ?? caller.principal);
      }
    } else if (signal === SIG.confirm && scopedTask?.confirmationPolicy) {
      const userId = caller.humanSubject?.userId;
      if (!userId) throw new CapabilityError('only an explicitly targeted human can satisfy this confirmation policy');
      const vote = this.deps.store.voteConfirmation(taskId, userId);
      if (!vote.authorized) throw new CapabilityError('you are not a reviewer for this task');
      this.deps.store.appendEvent({ taskId, type: 'task.confirmation-voted', ts: Date.now(),
        payload: { userId, votes: vote.votes, required: vote.required, satisfied: vote.satisfied } });
      if (!vote.satisfied) return;
    }
    const chosenOtherAttempts = attemptChoice?.otherAttempts ?? (needsAttemptChoice ? this.deps.store.otherAttemptsDefault(taskId) : undefined);
    if (confirmsProposal && scopedTask && (chosenOtherAttempts === 'keep' || chosenOtherAttempts === 'cancel')) {
      this.deps.store.kvSet(`attempt-choice:${taskId}`, chosenOtherAttempts);
      if (attemptChoice?.saveOtherAttemptsDefault) {
        const defaults = this.deps.store.getSettings(scopedTask.projectId, '__common__') ?? {};
        this.deps.store.setSettings(scopedTask.projectId, '__common__', { ...defaults, otherAttempts: chosenOtherAttempts });
      }
    }
    // Setup is the one stage where the projected view has no WorldHandle yet.
    // A plain signal used to wait behind the five-minute createWorld activity,
    // leaving both the task and its runner slot visibly stuck. Give cooperative
    // cancellation a short chance, then terminate the old execution and reclaim
    // every capacity lease it acquired before publishing a handle. This also
    // repairs already-running pre-fix workflow versions after deployment.
    if (signal === SIG.cancel && scopedTask && heldView?.stage === 'setup'
      && !['done', 'cancelled', 'failed'].includes(heldView.status)) {
      await this.stopTaskActivity(scopedTask, heldView, 'Setup cancellation did not stop', 'cancel', 5_000);
      this.releaseTaskRunnerLeases(taskId);
      const latest = this.deps.store.getTask(taskId)?.lastView ?? heldView;
      if (!['done', 'cancelled', 'failed'].includes(latest.status)) {
        this.deps.store.saveView(taskId, {
          ...latest,
          stage: 'cancelled',
          status: 'cancelled',
          waitingFor: undefined,
          actions: [],
          state: { ...latest.state, cancelled: true, cancelledFrom: 'setup' },
        });
      }
      return;
    }

    const terminal = this.deps.store.getTask(taskId)?.lastView;
    if (terminal?.status === 'failed' && RECOVERABLE_WORKFLOWS.has(terminal.workflow) && !terminal.pointOfNoReturnPassed) {
      if (signal === SIG.retry) {
        await this.recoverFailedTask(taskId);
        return;
      }
      if (signal === SIG.followUp) {
        const now = Date.now();
        const msg: Message = { id: `u${randomUUID()}`, role: 'user', text: text ?? '', ts: now, ...(images?.length ? { images } : {}), ...(files?.length ? { files } : {}) };
        const messages = terminal.messages.map((m) => ({ ...m }));
        const transcripts = terminal.transcripts?.map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m })) }));
        const target = role && role !== 'do' ? transcripts?.find((t) => t.role === role)?.messages : messages;
        (target ?? messages).push(msg);
        this.deps.store.saveView(taskId, { ...terminal, messages, transcripts, actions: FAILED_RECOVERY_ACTIONS() });
        this.publishConversationMessage(taskId, role, msg);
        return msg;
      }
      if (signal === SIG.cancel) {
        this.deps.store.saveView(taskId, {
          ...terminal,
          stage: 'cancelled',
          status: 'cancelled',
          waitingFor: undefined,
          actions: [],
          state: { ...terminal.state, cancelled: true },
        });
        return;
      }
    }

    // Retry is also the explicit migration boundary for Landing failures parked
    // in a historical pre-1.21 execution. Retrying that pin would reproduce its
    // task-scalar landing model. Replace it with current participant admission
    // while retaining the world, PRs, task intent, and Do conversation.
    const retryMinor = Number(String(scopedTask?.workflowVersion ?? '').split('.')[1] ?? 0);
    if (signal === SIG.retry
      && scopedTask?.workflow === 'software-dev'
      && retryMinor >= 16
      && retryMinor < 21
      && heldView?.stage === 'escalated'
      && heldView.status === 'blocked'
      && !heldView.pointOfNoReturnPassed
      && heldView.landing?.authorization === 'authorized') {
      const now = Date.now();
      const message: Message = {
        id: `landing-upgrade-${now}`,
        role: 'user',
        text: `Karmax upgraded this attempt to the current fair Landing protocol after its prior automated landing step failed. Continue from the existing worktree and this same Do conversation. Preserve the task context, inspect the current proposal, make only necessary fixes, verify it, and call open_pr again. The repaired proposal owns no landing slot and will request landing again at the back; live repository policy decides whether fresh approval is required. Previous failure: ${heldView.error ?? 'unknown landing failure'}`,
        ts: now,
      };
      const nextView = this.withConversationMessage(heldView, 'do', message);
      await this.stopTaskActivity(scopedTask, heldView, 'Retrying authorized Landing failure on same-Do protocol');
      await this.startTransitionReplacement(scopedTask, nextView, 'do');
      this.publishConversationMessage(taskId, 'do', message);
      return message;
    }

    // A cross-cutting human hold is not a second decision gate. Supplying agent
    // input releases it immediately. Replacing from the persisted checkpoint
    // also repairs already-parked v1.5/v1.6 executions whose hold condition only
    // listened for Retry.
    if (signal === SIG.followUp && scopedTask && heldView && heldOrigin) {
      const holdRole = this.humanHoldRole(heldView);
      if (!holdRole)
        throw new Error(`the ${stageName(heldOrigin)} hold has no agent conversation to follow up; use Resume ${stageName(heldOrigin)}`);
      if (role && role !== holdRole)
        throw new Error(`this hold is waiting on the ${holdRole} agent, not ${role}; send the follow-up to ${holdRole} or resume ${stageName(heldOrigin)}`);
      const now = Date.now();
      const followUp: Message = {
        id: `u${randomUUID()}`,
        role: 'user',
        text: text ?? '',
        ts: now,
        ...(images?.length ? { images } : {}),
        ...(files?.length ? { files } : {}),
      };
      const nextView = this.withConversationMessage(heldView, holdRole, followUp);
      await this.stopTaskActivity(scopedTask, heldView, `Human supplied input for the ${stageName(heldOrigin)} hold`);
      // Review feedback has its normal meaning: return the task to Do. A Merge
      // hold can also deliberately fall back to Do when the current explicit-PR
      // workflow has no Merge agent; resume the conversation that actually
      // received the message, not a mechanical stage that cannot consume it.
      const resumeStage = heldOrigin === 'review' || (heldOrigin === 'merge' && holdRole === 'do')
        ? 'do'
        : heldOrigin;
      await this.startTransitionReplacement(scopedTask, nextView, resumeStage);
      this.publishConversationMessage(taskId, holdRole, followUp);
      return followUp;
    }

    // Confirming a Review-origin hold approves that preserved Review exactly
    // once. Current workflows already opened the PR before Review, so they resume
    // at Merge; historical post-Review-PR versions retain their recorded route.
    if (signal === SIG.confirm && scopedTask && heldView && heldOrigin === 'review') {
      await this.stopTaskActivity(scopedTask, heldView, 'Human confirmed the Review held for input');
      const minor = Number(String(scopedTask.workflowVersion ?? '').split('.')[1] ?? 0);
      // Current replacement workflows reopen/reconcile the proposal first and
      // apply this one approval only if every PR identity and head still match.
      await this.startTransitionReplacement(
        scopedTask,
        heldView,
        minor >= 12 ? 'review' : 'pr',
        false,
        undefined,
        true,
      );
      return;
    }

    // A pre-v1.21 execution may already be parked at an exceptional Landing
    // confirmation (provider permission, policy intervention, or the bounded
    // repair retry gate). Confirm is a safe replacement boundary here too: the
    // vote has been journalled above, and the checkpoint carries the exact PRs,
    // intent authorization, worktree, and Do session into participant Landing.
    // When the old wait exhausted its repair budget, this click explicitly
    // authorizes another batch, so consume that decision by resetting the count.
    const landingConfirmMinor = Number(String(scopedTask?.workflowVersion ?? '').split('.')[1] ?? 0);
    if (signal === SIG.confirm
      && scopedTask?.workflow === 'software-dev'
      && landingConfirmMinor >= 16
      && landingConfirmMinor < 21
      && heldView?.stage === 'merge'
      && heldView.status === 'waiting'
      && heldView.waitingFor?.kind === 'human'
      && heldView.landing?.authorization === 'authorized'
      && !heldOrigin) {
      const migratingView = (heldView.landing.repairAttempts ?? 0) >= 5
        ? { ...heldView, landing: { ...heldView.landing, repairAttempts: 0 } }
        : heldView;
      await this.stopTaskActivity(scopedTask, heldView, 'Landing confirmed; upgrading to per-participant provider/fallback Landing');
      await this.startTransitionReplacement(scopedTask, migratingView, 'merge');
      return;
    }

    // Executions on pre-v1.21 Landing protocols already parked at their
    // ordinary Review gate must not continue into a separate integration-agent
    // path. The
    // confirmation above has already been authorized and journalled, so replace
    // the old execution at the exact Review -> Landing boundary. This preserves
    // its PR/head checkpoint, consumes the one human decision exactly once, and
    // lets the latest workflow reconstruct intent authorization before requesting
    // provider-owned or fair fallback landing. Older versions did not journal durable
    // intent authorization, so they retain their historical semantics.
    const scopedMinor = Number(String(scopedTask?.workflowVersion ?? '').split('.')[1] ?? 0);
    if (signal === SIG.confirm
      && scopedTask?.workflow === 'software-dev'
      && scopedMinor >= 16
      && scopedMinor < 21
      && heldView?.stage === 'review'
      && heldView.status === 'waiting'
      && heldView.waitingFor?.kind === 'human'
      && !heldOrigin) {
      await this.stopTaskActivity(scopedTask, heldView, 'Review confirmed; upgrading to per-participant provider/fallback Landing');
      await this.startTransitionReplacement(scopedTask, heldView, 'merge');
      return;
    }

    const handle = this.workflowHandle(taskId);
    let followUp: Message | undefined;
    try {
      if (signal === SIG.followUp) {
        const now = Date.now();
        followUp = {
          id: `u${randomUUID()}`,
          role: 'user',
          text: text ?? '',
          ts: now,
          ...(images?.length ? { images } : {}),
          ...(files?.length ? { files } : {}),
        };
        // `role` (the addressed agent) is optional — single-agent workflows ignore it
        // and route every follow-up to their sole conversation.
        const trace = installationTiming(this.deps.store, { taskId, requestIds: [`${taskId}:${followUp.id}`] }, row => {
          this.deps.store.appendEvent({ taskId, type: 'timing', ts: row.wallMs, payload: { ...row } });
        });
        trace.mark('request.received', { requestId: `${taskId}:${followUp.id}` }, receivedAt);
        await trace.measure('workflow.dispatch', () => handle.signal(SIG.followUp, followUp, role));
        // A signal mutates workflow memory immediately, but workflows deliberately
        // publish their full cached view only at lifecycle boundaries. Journal the
        // accepted message separately so every open conversation can render it
        // mid-turn without changing replay-sensitive workflow command histories.
        this.publishConversationMessage(taskId, role, followUp);
      } else if (signal === SIG.openPr && caller.humanSubject) {
        // The same verified reviewer may defer confirmation whether acting
        // through a browser or a delegated agent. task:signal was checked above;
        // Review revalidates the selected reviewer before accepting this intent.
        await handle.signal(signal, { userId: caller.humanSubject.userId });
      } else if (signal === SIG.approveCheckout) {
        await handle.signal(signal, { name: text ?? '' });
      } else {
        await handle.signal(signal);
      }
    } catch (e) {
      // Cancellation is idempotent at the task API boundary. The drawer can be
      // acting on a view published immediately before the workflow closes, in
      // which case Temporal reports the closed execution as "not found". Settle
      // a stale non-terminal snapshot locally (the closed workflow can no longer
      // publish one), but preserve an already-terminal result such as `done`.
      // Other signals must still report stale/invalid actions.
      if (signal === SIG.cancel && e instanceof WorkflowNotFoundError) {
        const task = this.deps.store.getTask(taskId);
        if (!task) throw e;
        const view = task.lastView;
        if (view && !['done', 'cancelled', 'failed'].includes(view.status)) {
          this.deps.store.saveView(taskId, {
            ...view,
            stage: 'cancelled',
            status: 'cancelled',
            actions: [],
            state: { ...view.state, cancelled: true },
            waitingFor: undefined,
          });
        }
        return;
      }
      throw e;
    }
    return followUp;
  }

  private publishConversationMessage(taskId: string, role: string | undefined, message: Message): void {
    const event = {
      taskId,
      type: 'conversation.message',
      ts: message.ts,
      payload: { role: role ?? 'do', message },
    };
    const seq = this.deps.store.appendEvent(event);
    this.deps.bus?.emit({ ...event, seq });
  }

  private async routeCollaborationEvent(event: {
    taskId: string;
    type: string;
    ts: number;
    payload: unknown;
    seq?: number;
  }): Promise<void> {
    let settled: CollaborationRequest[] = [];
    if (event.type === 'push.branch') {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      settled = this.deps.store.settleCollaborationRequests(event.taskId, 'completed', {
        branch: payload.branch,
        repos: payload.repos,
        eventSeq: event.seq,
      }, event.seq);
    } else if (event.type === 'view.updated') {
      const current = this.deps.store.getTask(event.taskId)?.lastView;
      const issue = collaborationTargetIssueFromViewEvent(event.payload, current);
      if (issue) {
        settled = this.deps.store.settleCollaborationRequests(event.taskId, 'failed', {
          reason: issue.result,
          eventSeq: event.seq,
        }, event.seq);
      }
    }
    for (const request of settled) await this.notifyCollaborationRequest(request);
  }

  private async notifyCollaborationRequest(request: CollaborationRequest, attempt = 0): Promise<void> {
    if (request.status === 'pending' || request.notifiedAt) return;
    const target = this.deps.store.getTask(request.targetTaskId);
    const label = target?.num ? `#${target.num}` : request.targetTaskId;
    const result = request.result ?? {};
    const text = request.status === 'completed'
      ? [
          `[Collaboration request ${request.id} completed]`,
          `Task ${label} published branch ${String(result.branch ?? '(unknown)')}.`,
          `Call import_task_branch with source_task_id "${request.targetTaskId}" when you are ready to consume it.`,
        ].join('\n\n')
      : [
          `[Collaboration request ${request.id} failed]`,
          `Task ${label} did not publish its branch: ${String(result.reason ?? 'unknown failure')}.`,
          'Continue with another approach or send a new request after the target task is recoverable.',
        ].join('\n\n');
    const now = Date.now();
    const message: Message = { id: `collab-${request.id}`, role: 'user', text, ts: now };
    const handle = this.deps.client.workflow.getHandle(request.requesterTaskId);
    try {
      await handle.signal(SIG.collaborationSettled, request.id, message);
    } catch {
      this.scheduleCollaborationNotification(request.id, attempt + 1);
      return;
    }
    try {
      // Temporal accepts unknown signal names and buffers them, so success from
      // collaborationSettled alone does not prove an older workflow consumed it.
      // Also send the ordinary message signal; collaboration-aware workflows
      // deduplicate by message id, while older ones still receive the update.
      await handle.signal(SIG.followUp, message, 'do');
    } catch {
      this.scheduleCollaborationNotification(request.id, attempt + 1);
      return;
    }
    this.publishConversationMessage(request.requesterTaskId, 'do', message);
    this.deps.store.markCollaborationRequestNotified(request.id);
    this.collaborationNotificationRetries.delete(request.id);
  }

  private scheduleCollaborationNotification(requestId: string, attempt: number): void {
    if (this.collaborationNotificationRetries.has(requestId)) return;
    this.collaborationNotificationRetries.set(requestId, attempt);
    const timer = setTimeout(() => {
      this.collaborationNotificationRetries.delete(requestId);
      const request = this.deps.store.getCollaborationRequest(requestId);
      if (request && request.status !== 'pending' && !request.notifiedAt)
        void this.notifyCollaborationRequest(request, attempt);
    }, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
    timer.unref?.();
  }

  private async reconcileCollaborationRequests(): Promise<void> {
    for (const request of this.deps.store.listCollaborationRequests({ status: 'pending' })) {
      const relevant = this.deps.store.eventsSince(request.targetTaskId, request.afterSeq)
        .find((event) => event.type === 'push.branch'
          || (event.type === 'view.updated'
            && collaborationTargetIssueFromViewEvent(event.payload)));
      if (relevant) {
        await this.routeCollaborationEvent(relevant);
        continue;
      }
      const issue = collaborationTargetIssue(
        this.deps.store.getTask(request.targetTaskId)?.lastView,
        'pending',
      );
      if (issue) {
        const settled = this.deps.store.settleCollaborationRequests(request.targetTaskId, 'failed', {
          reason: issue.result,
        });
        for (const item of settled) await this.notifyCollaborationRequest(item);
      }
    }
    for (const status of ['completed', 'failed'] as const) {
      for (const request of this.deps.store.listCollaborationRequests({ status, unnotified: true }))
        await this.notifyCollaborationRequest(request);
    }
  }

  async setTarget(token: string, taskId: string, branch: string): Promise<boolean> {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'edit_task', { projectId: task?.projectId, taskId });
    this.assertBranchParams({ target: branch });
    let accepted: boolean;
    try {
      accepted = (await this.workflowHandle(taskId).executeUpdate('setTarget', { args: [branch] })) as boolean;
    } catch {
      return false;
    }
    if (accepted) this.persistAcceptedTarget(taskId, branch);
    return accepted;
  }

  /**
   * Apply an in-flight param edit (SPEC §4.5/§5.5) via the workflow's validated
   * `updateParams` update. Throws with the validator's reason if any field isn't
   * editable now (frozen after queue, or past the point of no return) — the
   * workflow validator is the single source of truth, so the gateway needn't
   * re-derive the window.
   */
  async updateParams(token: string, taskId: string, patch: Record<string, unknown>): Promise<{ applied: string[] }> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    const caller = this.require(token, 'edit_task', { projectId: task.projectId, taskId });
    this.assertBranchParams(patch);
    // An in-flight edit can introduce a `resumeFrom` pointer at another task —
    // the same source-side conversation check as createTask/updateArmedParams.
    this.validateAndAuthorizeResumeSources(token, patch);
    // Human routes are the fields whose validity the deterministic sandbox cannot
    // judge: "does @qa resolve to a human here?" is a store question. Assert them
    // up front so a re-route can never park a gate or input pause invisibly.
    // Who reviews a task, and who answers its questions, is a reviewer's
    // decision: the Do agent holds task:edit for its own parameters, and without
    // this it could patch `confirm.layers` to `[]` and skip its own Review gate.
    // An agent whose authorization carries `review:approve` (maintainer and
    // above) may re-route, like the human it stands in for.
    const mayRoute = caller.kind !== 'agent' || allows(caller.caps, 'review:approve');
    const confirmer = this.confirmerFieldOf(task);
    if (confirmer && patch[confirmer.field.name] !== undefined) {
      if (!mayRoute) throw new CapabilityError('changing who reviews a task needs review:approve (a maintainer-level authorization)');
      this.assertHumanRoutes(task, confirmer.manifest, { [confirmer.field.name]: patch[confirmer.field.name] } as ValueMap);
    }
    const responder = this.responderFieldOf(task);
    if (responder && patch[responder.field.name] !== undefined) {
      if (!mayRoute) throw new CapabilityError('changing who answers a task\'s questions needs review:approve (a maintainer-level authorization)');
      this.assertHumanRoutes(task, responder.manifest, { [responder.field.name]: patch[responder.field.name] } as ValueMap);
    }
    try {
      const result = (await this.workflowHandle(taskId).executeUpdate('updateParams', { args: [patch] })) as { applied: string[] };
      this.updateAgentSnapshot(taskId, patch, result.applied);
      if (result.applied.includes('target') && typeof patch.target === 'string')
        this.persistAcceptedTarget(taskId, patch.target);
      // Unlike target (published in the live view) and agents (kept in their
      // effective snapshot), the Responder has no separate projection. Persist an
      // accepted route so refreshes and later edits show the route actually in play.
      if (responder && result.applied.includes(responder.field.name)) {
        const current = this.deps.store.getTask(taskId);
        if (current) this.deps.store.updateTaskParams(taskId, {
          ...current.params,
          [responder.field.name]: patch[responder.field.name],
        });
      }
      if (confirmer && result.applied.includes(confirmer.field.name))
        await this.shareConfirmerAcrossAttempts(task!, confirmer.field.name, patch[confirmer.field.name]);
      return result;
    } catch (e) {
      throw new Error(unwrapCause(e));
    }
  }

  /** Keep the workflow's accepted destination, stored task snapshot, and durable
   * world handle coherent. The immutable base/baseSha deliberately do not move:
   * retargeting changes where work lands, not where its custody chain began. */
  private persistAcceptedTarget(taskId: string, target: string): void {
    const task = this.deps.store.getTask(taskId);
    if (task) this.deps.store.updateTaskParams(taskId, { ...task.params, target,
      [REPOSITORY_BRANCHES_RESOLVED_PARAM]: true });
    const world = this.deps.store.currentWorld(taskId);
    if (world) this.deps.store.updateCurrentWorldTarget(taskId, target);
  }

  /** The task's Review-route field (if its workflow has one) with the manifest it came from. */
  private confirmerFieldOf(task: TaskRecord): { field: FieldSpec; manifest: WorkflowManifest } | undefined {
    const organizationId = this.deps.store.getProject(task.projectId)?.organizationId;
    const start = this.resolveStart(task.workflow, task.workflowVersion, organizationId);
    const field = start?.manifest.params.find((f) => f.type === 'confirmer');
    return start && field ? { field, manifest: start.manifest } : undefined;
  }

  /** The task's ordinary-input route, resolved from its pinned workflow package. */
  private responderFieldOf(task: TaskRecord): { field: FieldSpec; manifest: WorkflowManifest } | undefined {
    const organizationId = this.deps.store.getProject(task.projectId)?.organizationId;
    const start = this.resolveStart(task.workflow, task.workflowVersion, organizationId);
    const field = start?.manifest.params.find((f) => f.type === 'responder');
    return start && field ? { field, manifest: start.manifest } : undefined;
  }

  /**
   * A confirmer belongs to the LOGICAL task, not one attempt (activities/core.ts) —
   * sibling attempts must never review against divergent routes. So an accepted
   * in-flight re-route is written through to the shared intent snapshot and pushed
   * into every other live attempt. A sibling that rejects it has already passed its
   * own gate (or its point of no return); it keeps the route it actually used.
   */
  private async shareConfirmerAcrossAttempts(task: TaskRecord, field: string, confirmer: unknown): Promise<void> {
    this.deps.store.setIntentConfirmer(task.intentId ?? task.id, field, confirmer, { inFlight: true });
    for (const sibling of this.deps.store.attemptGroup(task.intentId ?? task.id)?.attempts ?? []) {
      if (sibling.id === task.id || sibling.params?.draft) continue;
      try {
        await this.deps.client.workflow.getHandle(sibling.id).executeUpdate('updateParams', { args: [{ [field]: confirmer }] });
      } catch { /* already past its gate — it keeps the route it played */ }
    }
  }

  /**
   * Change the policy of a compatible running workflow without replacing its
   * Temporal execution. The workflow update is authoritative and validates the
   * lifecycle window; only after it accepts do we change the searchable record.
   */
  async changeWorkflow(
    token: string,
    taskId: string,
    workflow: string,
  ): Promise<{ workflow: 'software-dev' | 'goal'; task?: TaskRecord }> {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'edit_task', { projectId: task?.projectId, taskId });
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    if (workflow !== 'software-dev' && workflow !== 'goal') {
      throw new Error('only Software Dev and Goal are compatible in-flight');
    }
    // A draft has no Temporal execution yet, so its workflow is ordinary editable
    // task metadata. Re-pin it to the target definition in place: identity, notes,
    // tags, authorization and sparse parameters all survive the form change.
    if (task.params?.draft) {
      const project = this.deps.store.getProject(task.projectId);
      const start = this.resolveStart(workflow, this.workflowPinFor(task.projectId, workflow), project?.organizationId);
      if (!start) throw new Error(`workflow "${workflow}" is not available to this organization`);
      this.deps.store.setDraftWorkflow(taskId, workflow, start.manifest.version);
      return { workflow, task: this.deps.store.getTask(taskId)! };
    }
    const heldView = task.lastView;
    const heldOrigin =
      heldView?.status === 'waiting'
      && heldView.waitingFor?.kind === 'human'
      && heldView.state?.humanPauseOrigin
        ? heldView.state.humanPauseOrigin as Stage
        : undefined;
    try {
      const result = (await this.deps.client.workflow
        .getHandle(taskId)
        .executeUpdate('changeWorkflow', { args: [workflow] })) as { workflow: 'software-dev' | 'goal' };
      this.deps.store.setTaskWorkflow(taskId, result.workflow);
      // "Goal" is itself an instruction to continue autonomously. If the task
      // was held in Do/Review, release the hold and carry that instruction into a
      // fresh latest-version execution. This also repairs pre-1.7 held histories.
      if (result.workflow === 'goal' && heldView && (heldOrigin === 'do' || heldOrigin === 'review')) {
        const now = Date.now();
        const message: Message = { id: `mode-${now}`, role: 'user', text: GOAL_RESUME_MESSAGE, ts: now };
        const resumedView = this.withConversationMessage(heldView, 'do', message);
        await this.stopTaskActivity(task, heldView, 'Goal mode supplied autonomous direction for a human hold');
        const updatedTask = this.deps.store.getTask(taskId)!;
        await this.startTransitionReplacement(updatedTask, resumedView, 'do');
      }
      return result;
    } catch (e) {
      throw new Error(unwrapCause(e));
    }
  }

  async reorderQueue(token: string, domain: string, taskId: string): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    this.require(token, 'reorder_queue', { projectId: task.projectId, taskId });
    assertInMergeDomain(task, domain);
    await this.deps.client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
      workflowId: mergeQueueId(domain),
      taskQueue: this.deps.taskQueue,
      args: [{ domain }],
      signal: SIG_PRIORITIZE,
      signalArgs: [{ taskId }],
    });
  }

  /**
   * Reposition a queued task (drag-and-drop / move-to-bottom): place `taskId`
   * immediately before `beforeTaskId`, or at the end when no anchor is given.
   */
  async moveQueueItem(token: string, domain: string, taskId: string, beforeTaskId?: string): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    this.require(token, 'reorder_queue', { projectId: task.projectId, taskId });
    assertInMergeDomain(task, domain);
    if (beforeTaskId && this.deps.store.getTask(beforeTaskId)?.projectId !== task.projectId)
      throw new Error('cannot reorder across project authorization boundaries');
    await this.deps.client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
      workflowId: mergeQueueId(domain),
      taskQueue: this.deps.taskQueue,
      args: [{ domain }],
      signal: SIG_REORDER,
      signalArgs: [{ taskId, beforeTaskId }],
    });
  }

  async queueView(token: string, domain: string, projectId?: string): Promise<{ queue: string[]; current?: string }> {
    const caller = this.require(token, 'queue:read', projectId ? { projectId } : undefined);
    // A merge-queue domain spans whatever tasks were enqueued into it. With no
    // explicit project the raw view leaks other projects' task ids, so a
    // project-scoped token filters to its own project by default.
    const scopedTo = projectId ?? caller.projectId;
    try {
      const view = (await this.deps.client.workflow.getHandle(mergeQueueId(domain)).query('queue')) as { queue: string[]; current?: string };
      if (!scopedTo) return view;
      const belongs = (id: string | undefined) => !!id && this.deps.store.getTask(id)?.projectId === scopedTo;
      return { queue: view.queue.filter((id) => belongs(id)), ...(belongs(view.current) ? { current: view.current } : {}) };
    } catch {
      return { queue: [] };
    }
  }

  async agentQueueView(token: string, requestedOrganizationId?: string): Promise<{ capacity: number; queue: any[]; current: any[] }> {
    // The host agent-queue is a queue surface, not a task read: bind it to the
    // same `queue:read`/`queue:write` pair the gateway route uses, so a
    // maintainer (queue:*) is not refused by one layer and allowed by the other.
    const caller = this.require(token, 'queue:read', requestedOrganizationId
      ? { organizationId: requestedOrganizationId }
      : undefined);
    const organizationId = requestedOrganizationId
      ?? caller.organizationId
      ?? (caller.projectId ? this.deps.store.getProject(caller.projectId)?.organizationId : undefined);
    if (this.deps.store.hosted && !organizationId)
      throw new CapabilityError('hosted agent queues require an organization scope');
    if (organizationId && !requestedOrganizationId)
      this.require(token, 'queue:read', { organizationId });
    if (this.deps.store.hosted) {
      const entitlements = this.deps.store.organizationEntitlements(organizationId!);
      const fallback = entitlements.agentRunAdmissionAllowed
        ? entitlements.maxActiveAgentRuns ?? 0
        : 0;
      try {
        return (await this.deps.client.workflow.getHandle(agentQueueId(organizationId)).query(QRY_AGENT_QUEUE)) as any;
      } catch {
        return { capacity: fallback, queue: [], current: [] };
      }
    }
    const saved = Number(this.deps.store.getSettings('global', 'agent-queue')?.capacity);
    const fallback = Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 3;
    try {
      return (await this.deps.client.workflow.getHandle(agentQueueId()).query(QRY_AGENT_QUEUE)) as any;
    } catch {
      return { capacity: fallback, queue: [], current: [] };
    }
  }

  async moveAgentQueueItem(token: string, turnId: string, beforeTurnId?: string,
    requestedOrganizationId?: string): Promise<void> {
    const caller = this.require(token, 'reorder_queue', requestedOrganizationId
      ? { organizationId: requestedOrganizationId }
      : undefined);
    const organizationId = requestedOrganizationId
      ?? caller.organizationId
      ?? (caller.projectId ? this.deps.store.getProject(caller.projectId)?.organizationId : undefined);
    if (this.deps.store.hosted && !organizationId)
      throw new CapabilityError('hosted agent queues require an organization scope');
    if (organizationId && !requestedOrganizationId)
      this.require(token, 'reorder_queue', { organizationId });
    await this.deps.client.workflow.getHandle(agentQueueId(this.deps.store.hosted ? organizationId : undefined))
      .signal(SIG_REORDER, { turnId, beforeTurnId });
  }

  /** Host-wide concurrent agent turns. Installation configuration, so it takes
   *  the same `settings:write` the `/api/settings/global/agent-queue` route that
   *  drives it is bound to — this used to be the one queue mutation with no
   *  token and no check at all. */
  async setAgentCapacity(token: string, capacity: number): Promise<void> {
    this.require(token, 'set_settings');
    const value = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 3;
    await this.deps.client.workflow.signalWithStart(AGENT_QUEUE_WORKFLOW, {
      workflowId: agentQueueId(),
      taskQueue: this.deps.taskQueue,
      args: [{ capacity: value }],
      signal: SIG_SET_AGENT_CAPACITY,
      signalArgs: [{ capacity: value }],
    });
  }

  async saveSkill(token: string, args: { name: string; content: string }): Promise<{ path: string }> {
    const caller = this.require(token, 'save_skill');
    // Skills are tenant knowledge: an agent's saved resolution is indexed into
    // its own organization's Resolve prompts, never another tenant's.
    const organizationId = caller.organizationId
      ?? (caller.projectId ? this.deps.store.getProject(caller.projectId)?.organizationId : undefined)
      ?? 'org_personal';
    const skillsDir = organizationSkillsDir(this.deps.contentDir ?? paths().content, organizationId);
    // Preserve namespacing subdirs (e.g. "resolve/<slug>" → resolve/<slug>.md,
    // which listResolveSkills indexes for the self-healing loop, §3.4). Sanitize each
    // path segment and drop any traversal (`..`) so a name can't escape the directory.
    const rel = args.name.split('/').map((s) => s.replace(/[^a-z0-9_-]/gi, '-')).filter((s) => s && s !== '-' && s !== '..').join('/') || 'skill';
    const file = path.join(skillsDir, `${rel}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, args.content);
    return { path: file };
  }

  // ── Wiki (org/project skills, memories, prompts — SPEC §4.4 content) ──────
  // Reads need the scope's read capability; writes reuse `skill:write` because
  // authoring wiki content and saving a skill are the same authority, not
  // because they are the same store. They are NOT: `saveSkill` writes a flat
  // file under `<contentDir>/skills/` that is never inlined into a prompt,
  // while the wiki is the scoped, labelled store that is (SPEC §19.6).
  // All paths are traversal-checked inside src/wiki.

  /**
   * A `default`-labelled organization page is inlined into every task prompt in
   * the organization, and an `@builtin/*` page replaces the built-in working
   * instructions for all of them. Writing (or un-labelling, moving, deleting)
   * such a page is administering the organization, not saving a skill — so it
   * needs `organization:edit`, which every Do agent's `skill:write` is not.
   */
  private assertOrganizationWikiAuthority(token: string, organizationId: string,
    paths: Array<string | undefined>, entries: Array<{ labels?: string[] } | undefined>): void {
    const privileged = paths.some((p) => p?.startsWith(`${BUILTIN_WIKI_PREFIX}/`))
      || entries.some((entry) => entry && isDefaultDelivered(entry));
    if (privileged) this.require(token, 'organization:edit', { organizationId });
  }

  /** Resolve + authorize one wiki scope. Project wikis default to the caller
   * task's checkout; humans may explicitly select another task or branch. */
  private wikiScope(
    token: string,
    scope: string,
    id: string,
    write: boolean,
    selector: { taskId?: string; branch?: string } = {},
  ): { root: string; branch?: string; taskId?: string; writable: boolean; principal: string } {
    if (scope !== 'organization' && scope !== 'project') throw new Error('wiki scope must be organization or project');
    let caller;
    if (scope === 'project') {
      const project = this.deps.store.getProject(id);
      if (!project) throw new NotFoundError(`no project ${id}`);
      caller = this.require(token, write ? 'skill:write' : 'project:read', { projectId: id, organizationId: project.organizationId });
      const canonical = ensureProjectWikiRepository(this.deps.contentDir ?? paths().content, id);
      const requestedTask = selector.taskId ?? (caller.taskId && caller.taskId !== '*' ? caller.taskId : undefined);
      if (requestedTask) {
        const task = this.deps.store.getTask(requestedTask);
        if ((!task || task.projectId !== id) && selector.taskId) throw new Error('wiki task must belong to this project');
        const handle = task
          ? (this.deps.store.currentWorld(requestedTask) ?? task.lastView?.world) as WorldHandle | undefined
          : undefined;
        const repo = handle ? worldRepos(handle).find((candidate) => candidate.role === 'project-wiki') : undefined;
        if (repo && fs.existsSync(repo.root))
          return { root: repo.root, branch: repo.branch, taskId: requestedTask, writable: true, principal: caller.principal };
        const branch = handle?.branch;
        if (branch && projectWikiBranches(canonical).includes(branch))
          return { root: projectWikiBranchView(this.deps.contentDir ?? paths().content, id, branch),
            branch, taskId: requestedTask, writable: false, principal: caller.principal };
        if (selector.taskId) throw new Error('that task has no available project-wiki checkout');
      }
      if (selector.branch && selector.branch !== PROJECT_WIKI_BRANCH) {
        if (write) throw new Error('select a task world to edit a non-default wiki branch');
        return { root: projectWikiBranchView(this.deps.contentDir ?? paths().content, id, selector.branch),
          branch: selector.branch, writable: false, principal: caller.principal };
      }
      return { root: canonical, branch: PROJECT_WIKI_BRANCH, writable: true, principal: caller.principal };
    } else {
      caller = this.require(token, write ? 'skill:write' : 'organization:read', { organizationId: id });
      return { root: wikiRoot(this.deps.contentDir ?? paths().content, scope, id), writable: true, principal: caller.principal };
    }
  }

  /** One navigation call: a skill path returns the page; anything else lists
   *  the (sub)tree — the same call expands a TOC `[more…]` fold. The full tree
   *  also carries the `default`-labelled entries' bodies (inlined into every
   *  task) and `tocText`, the exact rendered table of contents agents receive
   *  (importance order, [more…] folds). The organization tree includes the
   *  built-ins, resolved through their on-disk overrides when edited. */
  readWiki(token: string, scope: WikiScope, id: string, rel = '', selector: { taskId?: string; branch?: string } = {}) {
    const view = this.wikiScope(token, scope, id, false, selector);
    const root = view.root;
    const entryOf = ({ content: _c, files: _f, ...entry }: (typeof BUILTIN_WIKI_ENTRIES)[number]) => entry;
    const builtins = scope === 'organization' ? resolveBuiltins(root) : [];
    const builtin = builtins.find((b) => b.path === safeWikiPath(rel));
    if (builtin) return { scope, id, path: builtin.path, page: builtin, view: { branch: view.branch, taskId: view.taskId, writable: view.writable } };
    const page = rel ? readWikiPage(root, rel) : undefined;
    if (page) return { scope, id, path: page.path, page, view: { branch: view.branch, taskId: view.taskId, writable: view.writable } };
    const toc = listWiki(root, rel);
    if (rel) return { scope, id, path: safeWikiPath(rel), toc, view: { branch: view.branch, taskId: view.taskId, writable: view.writable } };
    // `default` entries are inlined into every task's prompt (built-ins first).
    const unconditional = [
      ...builtins
        .filter(isDefaultDelivered)
        .map((b) => ({ ...entryOf(b), body: parseFrontmatter(b.content).body.trim() || b.content })),
      ...collectDefaultPages(root, toc).map(({ files: _files, content: _content, ...rest }) => rest),
    ];
    toc.children = [...builtins.map(entryOf), ...(toc.children ?? [])];
    // The TOC lists every entry except the `default` ones inlined above (shown
    // in full as their own cards) — the same rendering agents get.
    const exclude = new Set(unconditional.map((u) => u.path));
    const tocText = renderWikiToc(toc, { scope, id, exclude });
    return { scope, id, path: '', toc, unconditional, tocText, view: { branch: view.branch, taskId: view.taskId, writable: view.writable } };
  }

  /** Rank pages, labels, and folders of one scope against a typed query — what
   *  the task-form wiki-reference dropdown searches. */
  suggestWiki(token: string, scope: WikiScope, id: string, query: string, selector: { taskId?: string; branch?: string } = {}) {
    const root = this.wikiScope(token, scope, id, false, selector).root;
    return { scope, id, query, suggestions: suggestWiki(root, query) };
  }

  /** Create (`create` guards against overwriting), update, or — via `prevPath`
   *  — rename an entry. `kind` picks SKILL.md vs MEMORY.md; passing one that
   *  differs from an existing entry's converts it (skill ⇄ memory) in place. */
  saveWikiPage(
    token: string,
    scope: WikiScope,
    id: string,
    args: { path: string; content: string; kind?: 'skill' | 'memory'; create?: boolean; prevPath?: string },
    selector: { taskId?: string; branch?: string } = {},
  ) {
    const view = this.wikiScope(token, scope, id, true, selector);
    const root = view.root;
    const previousPath = args.prevPath ? safeWikiPath(args.prevPath) : undefined;
    const nextPath = safeWikiPath(args.path);
    if (scope === 'organization') {
      const baselinePath = previousPath ?? nextPath;
      const existing = readWikiPage(root, baselinePath)
        ?? resolveBuiltins(root).find((entry) => entry.path === baselinePath);
      this.assertOrganizationWikiAuthority(token, id, [nextPath, previousPath], [parseFrontmatter(args.content), existing]);
      if (existing && !(args.create && !previousPath))
        this.deps.store.recordOrganizationWikiVersion({
          organizationId: id,
          path: baselinePath,
          operation: 'baseline',
          kind: existing.kind,
          content: existing.content,
          principal: view.principal,
          ifEmpty: true,
        });
    }
    if (previousPath && previousPath !== nextPath) moveWikiPage(root, previousPath, nextPath);
    const page = writeWikiPage(root, args.path, args.content, args.kind, { create: args.create });
    // Scope the commit to the page(s) this edit touched. The canonical wiki root is
    // shared by every browser tab and every agent editing this project's wiki, so a
    // whole-tree `git add -A` attributed a concurrent editor's half-written page to
    // THIS commit (and left theirs empty, silently swallowed by the catch in
    // commitProjectWiki). A move also has to name the old path, or the removal of
    // the previous folder is left staged for whoever commits next.
    if (scope === 'project')
      commitProjectWiki(root, `wiki: update ${page.path}`,
        previousPath && previousPath !== nextPath ? [page.path, previousPath] : [page.path]);
    else this.deps.store.recordOrganizationWikiVersion({ organizationId: id, path: page.path,
      operation: previousPath && previousPath !== nextPath ? 'move' : 'write', kind: page.kind,
      content: page.content, principal: view.principal,
      previousPath: previousPath && previousPath !== nextPath ? previousPath : undefined });
    return page;
  }

  /**
   * Delete a wiki page, or (with `recursive`) a whole section.
   *
   * An organization wiki has no git history — `organization_wiki_versions` IS its
   * only undo. `readWikiPage` returns undefined for a *section*, so a section
   * delete used to record no baseline and a `delete` row with `content:
   * undefined`, while the filesystem removal is a recursive `rmSync`: one
   * `DELETE …/wiki/page?path=guides` destroyed the subtree unrecoverably.
   * Every page under the target is baselined and recorded before anything is
   * removed, and `recursive` is passed through deliberately so the wiki layer's
   * "this is a section, confirm" guard still stands for an unqualified call.
   */
  deleteWikiPage(token: string, scope: WikiScope, id: string, rel: string,
    selector: { taskId?: string; branch?: string; recursive?: boolean } = {}) {
    const view = this.wikiScope(token, scope, id, true, selector);
    const root = view.root;
    const safe = safeWikiPath(rel);
    const doomed = this.wikiPagesUnder(root, safe);
    if (scope === 'organization') {
      this.assertOrganizationWikiAuthority(token, id, [safe], doomed.map((page) => parseFrontmatter(page.content)));
      for (const page of doomed)
        this.deps.store.recordOrganizationWikiVersion({
          organizationId: id,
          path: page.path,
          operation: 'baseline',
          kind: page.kind,
          content: page.content,
          principal: view.principal,
          ifEmpty: true,
        });
    }
    const deleted = deleteWikiPage(root, rel, { recursive: selector.recursive });
    if (deleted && scope === 'project') commitProjectWiki(root, `wiki: delete ${safe}`, [safe]);
    if (deleted && scope === 'organization') {
      for (const page of doomed) this.deps.store.recordOrganizationWikiVersion({
        organizationId: id, path: page.path, operation: 'delete', kind: page.kind,
        content: page.content, principal: view.principal,
      });
    }
    return { deleted, removed: doomed.map((page) => page.path) };
  }

  /** Every readable page at `rel` or beneath it (a page returns just itself). */
  private wikiPagesUnder(root: string, rel: string): { path: string; kind: 'skill' | 'memory'; content: string }[] {
    const page = readWikiPage(root, rel);
    if (page) return [{ path: page.path, kind: page.kind, content: page.content }];
    const out: { path: string; kind: 'skill' | 'memory'; content: string }[] = [];
    const walk = (entry: { path: string; kind: string; children?: any[] }) => {
      if (entry.kind === 'section') { for (const child of entry.children ?? []) walk(child); return; }
      const child = readWikiPage(root, entry.path);
      if (child) out.push({ path: child.path, kind: child.kind, content: child.content });
    };
    walk(listWiki(root, rel) as any);
    return out;
  }

  searchWiki(token: string, scope: WikiScope, id: string, query: string, selector: { taskId?: string; branch?: string } = {}) {
    const root = this.wikiScope(token, scope, id, false, selector).root;
    return { scope, id, query, hits: searchWiki(root, query) };
  }

  wikiViews(token: string, projectId: string) {
    const view = this.wikiScope(token, 'project', projectId, false);
    const branches = projectWikiBranches(view.root);
    const tasks = this.deps.store.listTasks(projectId).flatMap((task) => {
      const handle = (this.deps.store.currentWorld(task.id) ?? task.lastView?.world) as WorldHandle | undefined;
      if (!handle || !worldRepos(handle).some((repo) => repo.role === 'project-wiki') && !branches.includes(handle.branch)) return [];
      return [{ id: task.id, num: task.num, title: task.title, branch: handle.branch,
        status: task.lastView?.status ?? (task.params.draft ? 'draft' : 'queued') }];
    });
    return { defaultBranch: PROJECT_WIKI_BRANCH, branches, tasks };
  }

  organizationWikiHistory(token: string, organizationId: string, rel?: string) {
    this.wikiScope(token, 'organization', organizationId, false);
    return { versions: this.deps.store.organizationWikiHistory(organizationId, rel ? safeWikiPath(rel) : undefined) };
  }

  /** Provider-aware variants used at the HTTP/MCP edge. Local worlds stay on
   * the fast synchronous path; remote worlds are snapshotted through the World
   * interface so the same wiki operations see their live branch. */
  async readWikiResolved(token: string, scope: WikiScope, id: string, rel = '',
    selector: { taskId?: string; branch?: string } = {}) {
    const remote = scope === 'project' ? await this.remoteWikiSnapshot(token, id, false, selector) : undefined;
    if (!remote) return this.readWiki(token, scope, id, rel, selector);
    try {
      return this.readWikiFromRoot(scope, id, rel, remote.root, {
        branch: remote.repo.branch, taskId: remote.taskId, writable: true,
      });
    } finally { await remote.release(); }
  }

  async searchWikiResolved(token: string, scope: WikiScope, id: string, query: string,
    selector: { taskId?: string; branch?: string } = {}) {
    const remote = scope === 'project' ? await this.remoteWikiSnapshot(token, id, false, selector) : undefined;
    if (!remote) return this.searchWiki(token, scope, id, query, selector);
    try { return { scope, id, query, hits: searchWiki(remote.root, query) }; }
    finally { await remote.release(); }
  }

  async suggestWikiResolved(token: string, scope: WikiScope, id: string, query: string,
    selector: { taskId?: string; branch?: string } = {}) {
    const remote = scope === 'project' ? await this.remoteWikiSnapshot(token, id, false, selector) : undefined;
    if (!remote) return this.suggestWiki(token, scope, id, query, selector);
    try { return { scope, id, query, suggestions: suggestWiki(remote.root, query) }; }
    finally { await remote.release(); }
  }

  async saveWikiPageResolved(token: string, scope: WikiScope, id: string,
    args: { path: string; content: string; kind?: 'skill' | 'memory'; create?: boolean; prevPath?: string },
    selector: { taskId?: string; branch?: string } = {}) {
    const remote = scope === 'project' ? await this.remoteWikiSnapshot(token, id, true, selector) : undefined;
    if (!remote) {
      if (scope !== 'project') return this.saveWikiPage(token, scope, id, args, selector);
      const view = this.wikiScope(token, scope, id, true, selector);
      // The default branch is the user-facing canonical wiki. Publish that
      // commit immediately when the project owns a GitHub remote. Live task
      // checkouts stay on their task branch and land through Review/Merge.
      if (view.branch === PROJECT_WIKI_BRANCH && !view.taskId)
        return mutateAndPublishProjectWiki(view.root,
          () => this.saveWikiPage(token, scope, id, args, selector),
          () => this.projectWikiPublishTarget(id));
      return this.saveWikiPage(token, scope, id, args, selector);
    }
    try {
      if (args.prevPath && safeWikiPath(args.prevPath) !== safeWikiPath(args.path))
        moveWikiPage(remote.root, args.prevPath, args.path);
      const page = writeWikiPage(remote.root, args.path, args.content, args.kind, { create: args.create });
      await remote.flush(`wiki: update ${page.path}`);
      return page;
    } finally { await remote.release(); }
  }

  async deleteWikiPageResolved(token: string, scope: WikiScope, id: string, rel: string,
    selector: { taskId?: string; branch?: string; recursive?: boolean } = {}) {
    const remote = scope === 'project' ? await this.remoteWikiSnapshot(token, id, true, selector) : undefined;
    if (!remote) {
      if (scope !== 'project') return this.deleteWikiPage(token, scope, id, rel, selector);
      const view = this.wikiScope(token, scope, id, true, selector);
      if (view.branch === PROJECT_WIKI_BRANCH && !view.taskId)
        return mutateAndPublishProjectWiki(view.root,
          () => this.deleteWikiPage(token, scope, id, rel, selector),
          () => this.projectWikiPublishTarget(id));
      return this.deleteWikiPage(token, scope, id, rel, selector);
    }
    try {
      const deleted = deleteWikiPage(remote.root, rel, { recursive: selector.recursive });
      if (deleted) await remote.flush(`wiki: delete ${safeWikiPath(rel)}`);
      return { deleted };
    } finally { await remote.release(); }
  }

  /** Resolve a fresh, repository-scoped App credential for one canonical wiki
   * publish. No linked remote means the local repository remains authoritative. */
  private async projectWikiPublishTarget(projectId: string) {
    const repository = this.deps.store.projectWiki(projectId)?.repository;
    if (!repository) return undefined;
    if (!this.deps.githubApp) throw new Error('the GitHub App is unavailable for this linked project wiki');
    return {
      remote: repository.sshUrl,
      credential: await this.deps.githubApp.brokerCredentials(repository),
    };
  }

  private readWikiFromRoot(scope: WikiScope, id: string, rel: string, root: string,
    view: { branch?: string; taskId?: string; writable: boolean }) {
    const entryOf = ({ content: _c, files: _f, ...entry }: (typeof BUILTIN_WIKI_ENTRIES)[number]) => entry;
    const builtins = scope === 'organization' ? resolveBuiltins(root) : [];
    const builtin = builtins.find((b) => b.path === safeWikiPath(rel));
    if (builtin) return { scope, id, path: builtin.path, page: builtin, view };
    const page = rel ? readWikiPage(root, rel) : undefined;
    if (page) return { scope, id, path: page.path, page, view };
    const toc = listWiki(root, rel);
    if (rel) return { scope, id, path: safeWikiPath(rel), toc, view };
    const unconditional = [
      ...builtins.filter(isDefaultDelivered)
        .map((b) => ({ ...entryOf(b), body: parseFrontmatter(b.content).body.trim() || b.content })),
      ...collectDefaultPages(root, toc).map(({ files: _files, content: _content, ...rest }) => rest),
    ];
    toc.children = [...builtins.map(entryOf), ...(toc.children ?? [])];
    const exclude = new Set(unconditional.map((u) => u.path));
    return { scope, id, path: '', toc, unconditional,
      tocText: renderWikiToc(toc, { scope, id, exclude }), view };
  }

  private async remoteWikiSnapshot(token: string, projectId: string, write: boolean,
    selector: { taskId?: string; branch?: string }) {
    const project = this.deps.store.getProject(projectId);
    if (!project) throw new NotFoundError(`no project ${projectId}`);
    const caller = this.require(token, write ? 'skill:write' : 'project:read',
      { projectId, organizationId: project.organizationId });
    const taskId = selector.taskId ?? (caller.taskId && caller.taskId !== '*' ? caller.taskId : undefined);
    if (!taskId || selector.branch) return undefined;
    const task = this.deps.store.getTask(taskId);
    if (!task || task.projectId !== projectId) {
      if (selector.taskId) throw new Error('wiki task must belong to this project');
      return undefined;
    }
    const handle = (this.deps.store.currentWorld(taskId) ?? task.lastView?.world) as WorldHandle | undefined;
    const repo = handle ? worldRepos(handle).find((candidate) => candidate.role === 'project-wiki') : undefined;
    if (!handle || !repo || fs.existsSync(repo.root)) return undefined;
    const access = await this.openCollaborationWorld(taskId, handle);
    const prefix = path.posix.relative(handle.root.replace(/\\/g, '/'), repo.root.replace(/\\/g, '/'));
    if (prefix.startsWith('..')) {
      await access.release();
      throw new Error('project wiki is outside the task world');
    }
    const contentDir = this.deps.contentDir ?? paths().content;
    fs.mkdirSync(contentDir, { recursive: true });
    const root = fs.mkdtempSync(path.join(contentDir, '.wiki-snapshot-'));
    try {
      const all = await access.world.listFiles();
      const inside = all.filter((file) => !prefix || file === prefix || file.startsWith(`${prefix}/`));
      const relative = (file: string) => prefix ? file.slice(prefix.length).replace(/^\/+/, '') : file;
      for (const file of inside) {
        const rel = relative(file);
        if (!rel || rel.startsWith('.git/')) continue;
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, await access.world.readFileBuffer(file));
      }
      const before = new Set(inside.map(relative).filter(Boolean));
      return {
        root, repo, taskId,
        flush: async (message: string) => {
          const after = wikiFiles(root);
          for (const old of before) if (!after.includes(old))
            await access.world.exec('rm', ['-rf', path.posix.join(repo.root, old)]);
          for (const rel of after) {
            const destination = prefix ? path.posix.join(prefix, rel) : rel;
            const value = fs.readFileSync(path.join(root, rel));
            if (access.world.writeFileBuffer) await access.world.writeFileBuffer(destination, value);
            else await access.world.writeFile(destination, value.toString('utf8'));
          }
          const added = await access.world.exec('git', ['add', '-A'], { cwd: repo.root });
          if (added.code !== 0) throw new Error(added.stderr || added.stdout);
          const committed = await access.world.exec('git', ['commit', '-q', '-m', message], { cwd: repo.root });
          if (committed.code !== 0 && !/nothing to commit/i.test(`${committed.stdout}${committed.stderr}`))
            throw new Error(committed.stderr || committed.stdout);
        },
        release: async () => {
          fs.rmSync(root, { recursive: true, force: true });
          await access.release();
        },
      };
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      await access.release();
      throw error;
    }
  }

  /** Propose a workflow-repo edit through the dogfooded merge-only PR gate (§4.4). */
  async proposeWorkflowEdit(
    token: string,
    args: { projectId: string; title: string; repo: string; branch: string; target: string },
  ): Promise<TaskRecord> {
    const caller = this.require(token, 'edit_workflow', { projectId: args.projectId });
    if (this.deps.hosted) throw new CapabilityError('Workflow code editing is disabled in hosted deployments; built-ins change only with a platform release');
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new NotFoundError(`no project ${args.projectId}`);
    const mergeOnly = MANIFESTS.find((m) => m.name === 'merge-only');
    if (!mergeOnly) throw new Error('bundled merge-only manifest is missing');
    const mergeOnlyVersion = mergeOnly.version;
    for (const [field, value] of Object.entries({ repo: args.repo, branch: args.branch, target: args.target }))
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
    // The merge lands with the project's git credentials: on a hosted cell the
    // repository must be one enrolled in this project, exactly as for a task.
    this.assertRepositoriesValid(mergeOnly, project, { repos: [args.repo] } as ValueMap);
    const authorization = this.deps.authorization
      ? this.deps.authorization.taskGrant(caller.principal, args.projectId, undefined, caller.caps)
      : { profileId: 'caller', capabilities: caller.caps, attenuated: false };
    let task = this.deps.store.createTask({
      projectId: args.projectId,
      title: args.title,
      workflow: 'merge-only',
      workflowVersion: mergeOnlyVersion,
      // Record the edit target for review. Activation requires a separate install.
      params: {
        prompt: args.title, branch: args.branch, target: args.target, repo: args.repo, workflowEdit: true,
        _authorization: { ...authorization, principal: caller.principal },
      },
      createdBy: principalRefOf(caller.principal),
    });
    const workflowDelegation = this.deps.tokens.delegateHuman(token, {
      taskId: task.id, projectId: task.projectId, organizationId: project.organizationId,
      externalIdentities: caller.externalIdentities,
    });
    if (workflowDelegation) {
      this.deps.store.updateTaskParams(task.id, { ...task.params,
        _authorization: { ...(task.params._authorization as object), delegationId: workflowDelegation.id },
        ...(workflowDelegation.externalIdentities?.githubAccountId
          ? { _githubAccountId: workflowDelegation.externalIdentities.githubAccountId } : {}) });
      task = this.deps.store.getTask(task.id)!;
    }
    const input = {
      taskId: task.id,
      projectId: args.projectId,
      title: args.title,
      createdAt: task.createdAt,
      prompt: args.title,
      branch: args.branch,
      target: args.target,
      project: { ...this.deps.store.effectiveProjectConfig(project), repos: [args.repo] },
      workflowEdit: true,
      grant: authorization.capabilities,
      grantPrincipal: caller.principal,
      delegationId: workflowDelegation?.id,
      authorizationProfile: authorization.profileId,
    } as TaskInput;
    try {
      await withTimeout(
        this.deps.client.workflow.start(pinnedType(WORKFLOW_TYPE['merge-only']!, mergeOnlyVersion), {
          taskQueue: this.deps.taskQueue,
          workflowId: task.id,
          args: [input],
        }),
        START_TIMEOUT_MS,
      );
    } catch (e) {
      this.deps.store.deleteTask(task.id);
      throw new Error(
        `Could not start the workflow-edit task: the durable engine didn't accept it (${e instanceof Error ? e.message : String(e)}). ` +
        `Nothing was queued — check that Temporal is healthy and try again.`,
      );
    }
    const started = this.resolveStart(task.workflow, task.workflowVersion,
      this.deps.store.getProject(task.projectId)?.organizationId);
    if (started) this.saveAgentSnapshot(task.id, started.manifest, input);
    return task;
  }

  /** Installed + built-in workflows, with versions (§21d). */
  listWorkflows(token: string, organizationId = 'org_personal'): WorkflowSummary[] {
    this.require(token, 'list_workflows', { organizationId });
    return this.deps.workflows?.list(organizationId) ?? [];
  }

  /**
   * Task-form parameter schemas for selectable workflows (§10.4). Includes
   * installed workflows when a manager is configured, else the built-ins — so
   * the New Task form can offer any registered workflow. Read-only, session-gated
   * by the gateway, so it takes no capability (matches the prior inline handler).
   */
  workflowSchemas(organizationId = 'org_personal'): { name: string; description: string; params: unknown; stages: unknown }[] {
    const taskSchemas = this.deps.workflows
      ? this.deps.workflows.schemas(organizationId)
      : MANIFESTS.filter((m) => m.kind !== 'coordinator').map((m) => ({ name: m.name, description: m.description, params: m.params, stages: m.stages }));
    const settingsOnly = MANIFESTS
      .filter((m) => m.kind === 'coordinator' && m.params.length)
      .map((m) => ({ name: m.name, description: m.description, params: m.params, stages: m.stages }));
    const schemas = [...taskSchemas, ...settingsOnly];
    if (!this.deps.hosted) return schemas;
    return schemas.map((schema) => ({
      ...schema,
      params: Array.isArray(schema.params) ? schema.params.map((raw) => {
        const field = raw as FieldSpec;
        if (field.name !== 'remote' || field.type !== 'select') return field;
        return {
          ...field,
          options: ['pr', 'push'],
          default: 'pr',
          help: 'How completed hosted repository work lands: pr — open the exact GitHub proposal before Review and land it under a confirming human’s GitHub authorization; push — advanced direct push without a pull request.',
        } satisfies FieldSpec;
      }) : schema.params,
    }));
  }

  /**
   * The event catalog for the event-trigger picker (SPEC §5): every workflow's
   * declared events + the core platform events, each with payload fields a filter
   * can match. Read-only, session-gated by the gateway (like workflowSchemas).
   */
  eventCatalog(): { type: string; description: string; fields: Record<string, string>; source: string }[] {
    return eventCatalog();
  }

  /**
   * Install a workflow from a git repo and roll the worker to serve it (§21d/§21e).
   * Requires a configured workflow manager; refuses to shadow a built-in name.
   */
  async installWorkflow(token: string, args: { url: string; ref?: string; name?: string }, organizationId = 'org_personal'): Promise<{ name: string; version: string }> {
    this.require(token, 'install_workflow', { organizationId });
    if (this.deps.hosted) throw new CapabilityError('External workflow code is disabled in hosted deployments');
    if (!this.deps.workflows) throw new Error('workflow installation is not enabled on this server');
    return this.deps.workflows.install(args, organizationId);
  }
}

/** The grants a task ended with, in the shape a new task is created with: the
 * stored `_authorization` selection (level/scope/projects — the elevated one if
 * a human approved a mid-task authorization request), its per-task vault
 * credential caps and the policies chosen for them. A legacy record that only
 * carries a `profileId` still maps to a level. */
export function previousTaskGrants(task: TaskRecord): {
  authorization?: AuthorizationSelection;
  credentialGrants: string[];
  credentialPolicies: VaultTaskPolicyOverrides;
} {
  const stored = task.params?._authorization as {
    level?: string; profileId?: string; scope?: AuthorizationSelection['scope']; projectIds?: string[];
    capabilities?: string[]; credentialPolicies?: VaultTaskPolicyOverrides;
  } | undefined;
  const level = stored?.level ?? stored?.profileId;
  return {
    ...(level ? { authorization: {
      level,
      scope: stored?.scope ?? 'projects',
      ...(stored?.scope === 'organization' || stored?.scope === 'global' ? {}
        : { projectIds: stored?.projectIds?.length ? stored.projectIds : [task.projectId] }),
    } } : {}),
    credentialGrants: (stored?.capabilities ?? []).filter((capability) => capability.startsWith('use-credential:')),
    credentialPolicies: stored?.credentialPolicies ?? {},
  };
}

function uniqueFileRefs(files: FileRef[]): FileRef[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file?.id ?? ''}\0${file?.name ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const EXECUTION_POLICY_KEYS = ['worldProvider', 'runnerPoolId', 'resources', 'network', 'monthlyBudgetMicros', 'hibernateAfterMs'] as const;
function executionConfigOf(config: import('../domain/types.js').ProjectConfig): Partial<OrganizationExecutionPolicy> {
  return Object.fromEntries(EXECUTION_POLICY_KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
}
function applyExecutionConfig(config: import('../domain/types.js').ProjectConfig, patch: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...config };
  for (const key of EXECUTION_POLICY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (patch[key] == null) delete next[key];
    else next[key] = patch[key];
  }
  return next as import('../domain/types.js').ProjectConfig;
}
