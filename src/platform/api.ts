import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError, type Client } from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { Store, type CollaborationRequest } from '../store/db.js';
import { TokenAuthority, type ScopedToken } from './tokens.js';
import { TOOL_CAPABILITY, Capability, allows } from './capabilities.js';
import { WORKFLOW_TYPE, SIG, pinnedType } from '../workflows/names.js';
import { bundledStart, StartResolution } from './resolve-start.js';
import { MANIFESTS, WorkflowManifest, eventCatalog } from '../contrib/manifests.js';
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
  MERGE_QUEUE_WORKFLOW,
  AGENT_QUEUE_WORKFLOW,
} from '../coordinators/names.js';
import { TaskRecord, TaskView, Message, Project, TaskInput, ImageRef, Tag, SavedView, TaskQuery, AgentRole, AgentSpec, FieldSpec, Provider, PrincipalRef, ConfirmationPolicy, OrganizationExecutionPolicy, Stage, StageTransition, TaskRecoveryCheckpoint, AuthorizationSelection, mergeQueueDomains, Urgency, DEFAULT_URGENCY, normalizeUrgency, remotePolicyOf, ResourceAccess, ResourceTarget } from '../domain/types.js';
import { hasActiveTriggers, cloneParamsWithoutTriggers, normalizeTriggers, validateTriggers, forcesRepeatable } from '../domain/triggers.js';
import { evaluateQuery, fieldCatalogue, tagPath, EvalResult } from '../domain/search.js';
import { parseQuery } from '../domain/query-language.js';
import { resolveParamsLayers, assembleTaskInput, projectSettingsFor, globalSettingsFor, quickProjectSettingsFor, quickGlobalSettingsFor, effectiveRepos, ValueMap } from './params.js';
import { defaultBranch } from '../world/git.js';
import { expandPath } from '../util/expand.js';
import { withTimeout } from '../util/timeout.js';
import path from 'node:path';
import fs from 'node:fs';
import { paths } from '../config/paths.js';
import { defaultProvider } from '../agent/adapters.js';
import { WikiScope, wikiRoot, listWiki, readWikiPage, writeWikiPage, deleteWikiPage, moveWikiPage, collectDefaultPages, isDefaultDelivered, searchWiki, suggestWiki, safeWikiPath, parseFrontmatter, renderWikiToc, resolveBuiltins, BUILTIN_WIKI_ENTRIES } from '../wiki/wiki.js';
import { commitProjectWiki, ensureProjectWikiRepository, projectWikiBranches, projectWikiBranchView, PROJECT_WIKI_BRANCH } from '../wiki/repository.js';
import { applyAgentSpec, defaultModel, defaultEffort, ProfileResolver, roleDefaultProfile } from '../agent/profiles.js';
import type { AuthorizationService } from './authorization.js';
import { PermissionRequests, exactCapability, type PermissionRequest } from './permission-requests.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';
import { confirmLayersOf } from '../domain/confirm.js';
import type { KarmaxBus } from '../contrib/bus.js';
import type { WorldRegistry } from '../world/registry.js';
import type { WorldHandle } from '../world/types.js';
import { worldRepos, worldRepoSource } from '../world/types.js';
import { brokerImportTaskBranch, brokerPublishBranch, brokerRefreshUpstream, describePublishFailures, type GitBrokerAuth } from '../world/git-broker.js';
import { sameRepository } from '../world/repository-identity.js';
import type { WorldAccessService } from '../world/access.js';
import { VaultItems, type VaultItemPolicy, type VaultTaskPolicyOverrides } from '../autonomy/vault-items.js';
import { itemHandle } from '../autonomy/vault-items.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { ProjectResourceService } from '../world/resources.js';

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
const stageName = (stage: string) => stage === 'human'
  ? 'Waiting for human input'
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
const FAILED_RECOVERY_ACTIONS = (): TaskView['actions'] => [
  { name: 'retry', kind: 'signal', label: 'Retry', enabled: true },
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
  /** Organization-scoped cloud provider credentials. Kept optional for the
   * small unit-test API harnesses; production always supplies it. */
  providerConnections?: import('../world/connections.js').WorldProviderConnectionService;
  /** World access for permission-checked collaboration tools. */
  worlds?: WorldRegistry;
  worldAccess?: WorldAccessService;
  resources?: ProjectResourceService;
  broker?: CredentialBroker;
  githubApp?: import('../integrations/github-app.js').GitHubAppService;
  /** Wake live gateway subscribers when platform-side actions append events. The
   * durable event table remains the source of truth when this is absent. */
  bus?: KarmaxBus;
}

/**
 * The single service layer agents and humans act through. Both the gateway
 * (HTTP, for users) and the platform MCP server (for agents) translate into
 * these calls; every call is capability-checked against a scoped token (§8.3),
 * so authz lives in exactly one place.
 */
export class KarmaxApi {
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
    if (['done', 'cancelled', 'failed'].includes(target.lastView?.status ?? ''))
      throw new Error(`target task is already ${target.lastView?.status}`);
    if (target.lastView?.pointOfNoReturnPassed || ['pr', 'merge'].includes(target.lastView?.stage ?? ''))
      throw new Error('target task has passed its agent-work stage and can no longer publish on request');

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
    return this.deps.store.getCollaborationRequest(request.id) ?? request;
  }

  private async deliverWorkflowMessage(taskId: string, text: string, role = 'do'): Promise<Message> {
    const now = Date.now();
    const message: Message = { id: `u${now}`, role: 'user', text, ts: now };
    await this.deps.client.workflow.getHandle(taskId).signal(SIG.followUp, message, role);
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
      for (const repo of worldRepos(access.world.handle)) {
        const dirty = await access.world.exec('git', ['status', '--porcelain'], { cwd: repo.root });
        if (dirty.code !== 0) throw new Error(`could not inspect ${repo.name}: ${dirty.stderr || dirty.stdout}`);
        if (dirty.stdout.trim()) throw new Error(`repo "${repo.name}" has uncommitted changes; commit them before publishing`);
      }
      const result = await brokerPublishBranch(access.world, this.gitBrokerAuth(task.projectId));
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
    // default. Existing-item attachment remains a human settings operation.
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
    if (caller.kind !== 'human') throw new CapabilityError('project resource adoption requires a human review token');
    if (!this.deps.resources) throw new Error('project resources are unavailable');
    const result = this.deps.resources.adoptCandidate(taskId, candidateId, caller.principal);
    // The durable store transition is authoritative. The signal only wakes a
    // Review workflow that is currently parked on this decision; if the workflow
    // has already closed, the adopted resource must remain adopted.
    try { await this.deps.client.workflow.getHandle(taskId).signal(SIG.resourceResolved); }
    catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
    return result;
  }

  async discardProjectResource(token: string, taskId: string, candidateId: string) {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError('task not found');
    const project = this.deps.store.getProject(task.projectId);
    const caller = this.require(token, 'discard_project_resource', { taskId, projectId: task.projectId,
      organizationId: project?.organizationId });
    if (caller.kind !== 'human') throw new CapabilityError('project resource discard requires a human review token');
    if (!this.deps.resources) throw new Error('project resources are unavailable');
    const result = await this.deps.resources.discardCandidate(taskId, candidateId, caller.principal);
    try { await this.deps.client.workflow.getHandle(taskId).signal(SIG.resourceResolved); }
    catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
    return result;
  }

  async importTaskBranch(token: string, sourceTaskId: string) {
    const { task, handle } = this.collaborationTask(token, 'import_task_branch');
    const source = this.deps.store.getTask(sourceTaskId);
    if (!source || source.projectId !== task.projectId) throw new Error('source task must belong to the same project');
    const sourceHandle = (this.deps.store.currentWorld(sourceTaskId) ?? source.lastView?.world) as WorldHandle | undefined;
    if (!sourceHandle) throw new Error('source task has no published world branch');
    const published = this.deps.store.eventsSince(sourceTaskId, 0).some((event) => event.type === 'push.branch'
      && (event.payload as { branch?: string } | undefined)?.branch === sourceHandle.branch);
    if (!published) throw new Error('source branch is not published yet; message its agent and ask it to commit and call publish_task_branch');
    const access = await this.openCollaborationWorld(task.id, handle);
    try {
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
   * Authorize every `agent:<role>.resumeFrom.taskId` in a task's params against
   * the **source** task, not just the task being created/edited.
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
  private authorizeResumeSources(token: string, params: Record<string, unknown> | undefined): void {
    for (const [key, value] of Object.entries(params ?? {})) {
      if (!key.startsWith('agent:') || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const resumeFrom = (value as Record<string, unknown>).resumeFrom;
      if (!resumeFrom || typeof resumeFrom !== 'object' || Array.isArray(resumeFrom)) continue;
      const sourceId = (resumeFrom as Record<string, unknown>).taskId;
      if (typeof sourceId !== 'string' || !sourceId) continue;
      const source = this.deps.store.getTask(sourceId);
      if (!source) throw new NotFoundError(`no task ${sourceId} to resume from`);
      this.require(token, 'get_conversation', { projectId: source.projectId, taskId: sourceId });
    }
  }

  /**
   * A repo-oriented workflow — one whose manifest declares a `repos` param — run
   * against a project with no repository configured would silently get a
   * throwaway scratch repo from the world provider (worktree.ts): the agent ends
   * up in an empty README-only sandbox instead of the user's code, with no signal
   * (the empty-repo footgun). Refuse the *run* early, with an actionable message,
   * rather than let a whole attempt burn against the wrong world.
   */
  private assertRepoConfigured(manifest: WorkflowManifest, project: Project, resolved: ValueMap) {
    const needsRepo = (manifest.params ?? []).some((p) => p.name === 'repos');
    if (!needsRepo) return; // scratch-only workflow (declares no repo) — fine.
    if (this.deps.hosted) {
      const linked = this.deps.store.listProjectRepositories(project.id);
      if (!linked.length) {
        throw new Error('Please connect GitHub in organization settings, then add a git repo in project settings.');
      }
      const enrolled = linked.map((candidate) => candidate.repository.sshUrl);
      const outside = effectiveRepos(resolved, project.config)
        .filter((repository) => !enrolled.some((candidate) => sameRepository(candidate, repository)));
      if (outside.length) throw new Error('Please choose a GitHub repo attached to this project in project settings.');
    }
    // Guard on the EFFECTIVE repo list the world will be built from (the resolved
    // settings overlay, falling back to project config) — the same value that
    // reaches createWorld — not project.config alone. Those two can diverge (an
    // empty settings-overlay repos list resolving to nothing while config still
    // holds a repo), and checking config-only let that case slip through into a
    // silent scratch sandbox — the very footgun this guard exists to prevent.
    const configured = effectiveRepos(resolved, project.config).length > 0;
    if (!configured) {
      throw new Error('Please add a git repo in project settings.');
    }
  }

  async createTask(
    token: string,
    args: {
      projectId: string;
      title?: string;
      prompt?: string;
      /** Images attached to the initial prompt (references, never inline bytes). */
      images?: ImageRef[];
      /** Wiki context to inline, as `@proj:…`/`@org:…` tokens (see TaskParams.wikiContext). */
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
    if (args.authorization && authorization.attenuated)
      throw new CapabilityError('you cannot grant an authorization level you do not hold for the selected scope');
    this.applyCredentialGrants(authorization, args.credentialGrants, caller.caps);
    const credentialPolicies = this.credentialPolicyOverrides(
      project.organizationId ?? 'org_personal', args.credentialPolicies, caller.caps, authorization,
    );

    // Task-scope overrides: the form's `params` plus the legacy flat fields.
    const taskOverrides: ValueMap = { ...(args.params ?? {}) };
    for (const [k, v] of Object.entries({ prompt: args.prompt, base: args.base, target: args.target, command: args.command, branch: args.branch })) {
      if (v !== undefined && taskOverrides[k] === undefined) taskOverrides[k] = v;
    }
    // Image attachments ride alongside the prompt but aren't a manifest param, so
    // carry them explicitly (references only — bytes live in the attachment store).
    if (args.images?.length && taskOverrides.images === undefined) taskOverrides.images = args.images;
    // Wiki context (which pages to inline) isn't a manifest param either; a
    // top-level arg (MCP/API) is folded in like the form sends it via `params`.
    if (args.wikiContext && taskOverrides.wikiContext === undefined) taskOverrides.wikiContext = args.wikiContext;
    // A `resumeFrom` pointer reads another task's conversation — authorize it
    // against that task's project before anything is created.
    this.authorizeResumeSources(token, taskOverrides);
    const resolved = await this.resolveTaskParams(manifest, project, taskOverrides, !!args.quick);
    // Refuse to *run* a repo-oriented workflow whose effective repo list is empty
    // (drafts may still be saved without one, then checked again at queueTask).
    // Checked after resolution so the guard sees the same repos the world will.
    if (!args.draft) this.assertRepoConfigured(manifest, project, resolved);

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
    const githubAccountId = createdBy?.kind === 'user'
      ? this.deps.githubApp?.activeUserAccountId(createdBy.userId)
      : undefined;
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
    const task = this.deps.store.createTask({
      projectId: args.projectId,
      title,
      workflow,
      workflowVersion: manifest.version,
      params: {
        ...taskOverrides,
        prompt: String(taskOverrides.prompt ?? resolved.prompt ?? ''),
        profiles: args.profiles,
        draft: !!args.draft,
        _authorization: { ...authorization, principal: caller.principal, credentialPolicies },
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
        const alt = this.deps.store.createTask({ projectId: task.projectId, listId: task.listId, title: task.title,
          workflow: task.workflow, workflowVersion: task.workflowVersion, params: { ...copied, draft: true, archived: false },
          parentTaskId: task.parentTaskId, intentId: task.intentId, createdBy: task.createdBy,
          assignee: task.assignee, delegate: task.delegate, confirmationPolicy: task.confirmationPolicy });
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
    input.authorizationProfile = authorization.profileId;
    input.resolveAgentEnabled = RESOLVE_AGENT_ENABLED;
    input.intentId = task.intentId ?? task.id;
    if (args.profiles) input.profiles = args.profiles;
    const initialImages = taskOverrides.images as ImageRef[] | undefined;
    if (initialImages?.length) input.images = initialImages;

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
    this.materializeUnifiedAgents(resolved, project.id);

    // Auto-detect the repo's default branch when base/target weren't set anywhere,
    // instead of guessing "main" (which would create a phantom target branch).
    const firstSet = (name: string) => layers.map((l) => l?.[name]).find((v) => v !== undefined && v !== null && v !== '');
    const explicitBase = firstSet('base');
    const explicitTarget = firstSet('target');
    const repo0 = project.config.repos?.[0] ? expandPath(project.config.repos[0]) : undefined;
    if (repo0 && (!explicitBase || !explicitTarget)) {
      const db = await defaultBranch(repo0).catch(() => undefined);
      if (db) {
        if (!explicitBase) resolved.base = db;
        if (!explicitTarget) resolved.target = db;
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
      const profile = roleDefaultProfile(this.deps.store, 'do', projectId);
      const provider = (profile?.provider ?? this.deps.defaultAgentProvider ?? defaultProvider().provider) as Provider;
      const model = profile?.model ?? defaultModel(provider);
      const effort = profile?.effort ?? defaultEffort(provider);
      spec = { provider, ...(model ? { model } : {}), ...(effort ? { effort: effort as AgentSpec['effort'] } : {}) };
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
      const profile = applyAgentSpec(base, selected);
      out[role] = {
        provider: profile.provider,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
        ...(selected?.resumeFrom ? { resumeFrom: selected.resumeFrom } : {}),
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
  private async buildStart(task: TaskRecord, migrateToLatest = false): Promise<{ startType: string; input: TaskInput; version: string }> {
    const project = this.deps.store.getProject(task.projectId);
    const start = this.resolveStart(task.workflow, migrateToLatest ? undefined : task.workflowVersion, project?.organizationId);
    if (!project || !start) throw new Error(`cannot start task ${task.id}`);
    const { manifest, startType } = start;
    // Re-resolve against the CURRENT project/global defaults. The task stored only
    // its own overrides, so a draft queued after a default change picks up the new
    // default (SPEC §10.4). Meta fields (profiles/draft/archived/triggers) aren't overrides.
    const { profiles, draft: _d, archived: _a, triggers: _t, triggerState: _ts, images, _authorization,
      _discardProgress, ...overrides } = task.params as Record<string, unknown>;
    const resolved = await this.resolveTaskParams(manifest, project, overrides as ValueMap);
    // The confirmer belongs to the logical task, not an attempt. Snapshotting it
    // once prevents attempts queued days apart from inheriting different reviewers.
    const group = this.deps.store.attemptGroup(task.id);
    const confirmerField = manifest.params.find((f) => f.type === 'confirmer');
    if (confirmerField && group?.confirmer !== undefined) resolved[confirmerField.name] = group.confirmer;
    this.assertHumanRoutes(task, manifest, resolved);
    // Same guard as createTask, on the resolved effective repos, before we clear the draft.
    this.assertRepoConfigured(manifest, project, resolved);
    const input = assembleTaskInput(manifest, resolved, {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      project: this.deps.store.effectiveProjectConfig(project),
    });
    input.createdAt = task.createdAt;
    input.workflow = task.workflow;
    const auth = _authorization as { capabilities?: string[]; principal?: string; profileId?: string } | undefined;
    input.grant = auth?.capabilities ?? ['task:signal'];
    input.grantPrincipal = auth?.principal ?? 'system:legacy-task';
    input.authorizationProfile = auth?.profileId ?? 'legacy';
    input.resolveAgentEnabled = RESOLVE_AGENT_ENABLED;
    input.intentId = task.intentId ?? task.id;
    if (profiles) input.profiles = profiles as Record<string, string>;
    if ((images as ImageRef[] | undefined)?.length) input.images = images as ImageRef[];
    if (_discardProgress === true) input.discardProgress = true;
    return { startType, input, version: manifest.version };
  }

  private assertHumanRoutes(task: TaskRecord, manifest: WorkflowManifest, resolved: ValueMap): void {
    const field = manifest.params.find((candidate) => candidate.type === 'confirmer');
    if (!field) return;
    const value = resolved[field.name];
    if (!value || typeof value !== 'object') return;
    for (const layer of confirmLayersOf(value as import('../domain/types.js').ConfirmConfig)) {
      if (layer.kind !== 'human') continue;
      const audience = layer.audience?.length ? layer.audience : ['@creator'];
      if (!this.deps.store.humanAudience(task.id, audience).length) {
        const project = this.deps.store.getProject(task.projectId);
        // A pre-collaboration/local database can contain historical tasks before
        // its personal organization is claimed. Do not make those tasks
        // unrecoverable; once an organization has people, every route must
        // resolve before new work can run.
        if (project?.organizationId
          && this.deps.store.listOrganizationMemberships(project.organizationId).length === 0) continue;
        throw new Error(`Review route ${audience.join(', ')} does not resolve to a human in this organization`);
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

  /** Start a previously-saved draft (SPEC §10.4). */
  async queueTask(token: string, taskId: string): Promise<TaskRecord> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new NotFoundError(`no task ${taskId}`);
    this.require(token, 'create_task', { projectId: task.projectId, taskId });
    const group = this.deps.store.attemptGroup(taskId);
    if (group?.committedAttemptId && group.committedAttemptId !== taskId) {
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
    const { startType, input } = await this.buildStart(task);
    const hadNumber = task.num != null;
    this.deps.store.clearDraft(taskId);
    // Bounded + compensated: on a wedged engine, restore the draft and release a
    // number minted by this failed transition. Previously established permalinks
    // remain stable when already-numbered work is queued again.
    try {
      await withTimeout(
        this.deps.client.workflow.start(startType, {
          taskQueue: this.deps.taskQueue,
          workflowId: task.id,
          // Queueing is idempotent. In particular, never create a second run if
          // the first one finished before a lost start acknowledgement is retried.
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          args: [input],
        }),
        START_TIMEOUT_MS,
      );
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
    if (typeof requested !== 'string' && authorization.attenuated)
      throw new CapabilityError('you cannot grant an authorization level you do not hold for the selected scope');
    this.applyCredentialGrants(authorization, credentialGrants, caller.caps);
    const priorPolicies = (task.params?._authorization as { credentialPolicies?: VaultTaskPolicyOverrides } | undefined)
      ?.credentialPolicies;
    const policies = credentialPolicies === undefined
      ? (priorPolicies ?? {})
      : this.credentialPolicyOverrides(
        this.deps.store.getProject(task.projectId)?.organizationId ?? 'org_personal',
        credentialPolicies,
        caller.caps,
        authorization,
      );
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
    this.deps.store.updateTaskParams(taskId, {
      ...task.params,
      _authorization: { ...authorization, principal: caller.principal, credentialPolicies: policies },
    });
    const updated = this.deps.store.getTask(taskId)!;
    this.persistTaskCredentialPolicies(updated);
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
    const run = this.deps.store.createTask({
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
    // Editing params can introduce a `resumeFrom` pointer at another task, so
    // the same source-side conversation check as createTask applies here.
    this.authorizeResumeSources(token, params);
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
    const enrich = (view: TaskView | undefined): TaskView | undefined => {
      if (!view) return view;
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
      const q = this.deps.client.workflow.getHandle(taskId).query('view') as Promise<TaskView>;
      q.catch(() => undefined); // swallow the late rejection if we time out first
      const view = await withTimeout(q, QUERY_TIMEOUT_MS);
      return enrich((view as TaskView) ?? snapshot());
    } catch {
      return enrich(snapshot());
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
    this.require(token, 'create_task', { projectId: source?.projectId, taskId: sourceTaskId });
    if (!source) throw new NotFoundError(`no task ${sourceTaskId}`);
    const group = this.deps.store.attemptGroup(sourceTaskId);
    if (!group) throw new Error('task has no attempt group');
    if (group.committedAttemptId) throw new Error('no more attempts can be added after an attempt enters Merge');
    const { archived: _archived, draft: _draft, triggers: _triggers, triggerState: _triggerState,
      repeatable: _repeatable, runOf: _runOf, ...workflowParams } = source.params;
    const start = this.resolveStart(source.workflow, source.workflowVersion,
      this.deps.store.getProject(source.projectId)?.organizationId);
    const confirmerField = start?.manifest.params.find((f) => f.type === 'confirmer');
    if (confirmerField && group.confirmer !== undefined) workflowParams[confirmerField.name] = group.confirmer;
    const attempt = this.deps.store.createTask({
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
    this.persistTaskCredentialPolicies(attempt);
    if (source.notes) this.deps.store.setTaskNotes(attempt.id, source.notes);
    if (source.tags?.length) this.deps.store.setTaskTags(attempt.id, source.tags);
    // If the former principal is cancelled/failed, the new draft naturally takes over.
    this.deps.store.electPrincipal(group.intentId);
    return this.deps.store.getTask(attempt.id)!;
  }

  attemptGroup(token: string, taskId: string) {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'get_task', { projectId: task?.projectId, taskId });
    const group = this.deps.store.attemptGroup(taskId);
    if (!group) return group;
    return {
      ...group,
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
    const origin = view.state?.humanPauseOrigin as Stage | undefined;
    if (view.status !== 'waiting' || view.waitingFor?.kind !== 'human' || !origin)
      return view.actions;
    const role = this.humanHoldRole(view);
    const actions = view.actions
      .filter((action) => action.name !== 'followUp' && (action.name !== 'confirm' || origin === 'review'));
    if (role) actions.splice(origin === 'review' ? 1 : 0, 0, FOLLOW_UP_ACTION(role));
    return actions;
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
      add({ target: 'do', label: 'Queue', description: 'Start this draft.' });
      add({ target: 'done', label: 'Done', description: 'Mark this draft done without running it.' });
      return result;
    }
    if (view.status === 'done') {
      if (manuallyDoneFrom) {
        add({
          target: manuallyDoneFrom,
          label: manuallyDoneFrom === 'draft' ? 'Back to Draft' : `Restore ${stageName(manuallyDoneFrom)}`,
          description: 'Undo the manual completion and restore its prior stage.',
        });
      }
      return result; // natural completion is immutable
    }
    if (view.status === 'cancelled') {
      if (resumable && cancelledFrom && cancelledFrom !== 'cancelled') {
        add({ target: cancelledFrom, label: `Restore ${stageName(cancelledFrom)}`, description: 'Resume from the stage active when this attempt was cancelled.' });
      }
      if (!jayadratha) add({ target: 'draft', label: 'Draft', description: 'Discard progress and make this attempt editable again.', danger: true });
      add({ target: 'done', label: 'Done', description: 'Mark this cancelled attempt done manually.' });
      return result;
    }
    if (view.status === 'failed') {
      if (resumable && !view.pointOfNoReturnPassed)
        add({ target: 'do', label: 'Retry Do', description: 'Recover the preserved work and retry the task.' });
      if (!jayadratha && !view.pointOfNoReturnPassed)
        add({ target: 'draft', label: 'Draft', description: 'Discard failed progress and start over later.', danger: true });
      add({ target: 'done', label: 'Done', description: 'Stop treating this failure as active work.' });
      return result;
    }

    if (origin) {
      add({ target: origin, label: `Resume ${stageName(origin)}`, description: 'Leave the human hold and resume the originating stage.' });
    // Resolve is an internal recovery frame rather than a resumable public
    // pipeline position: restarting merely at "resolve" loses the failed
    // operation it was repairing. Do not advertise a transition we cannot
    // restore faithfully.
    } else if (resumable && view.stage !== 'escalated' && view.stage !== 'resolve' && view.waitingFor?.kind !== 'human') {
      add({ target: 'human', label: 'Waiting for human input', description: 'Stop current activity and hold this attempt for a person.' });
    }
    if (resumable && (view.stage === 'review' || view.stage === 'merge') && !origin)
      add({
        target: 'do',
        label: 'Do',
        description: view.stage === 'merge'
          ? 'Return the pending pull request to Do for repair; preserved intent authorization is revalidated automatically unless the repair changes scope.'
          : 'Return the reviewed work to the Do agent.',
      });
    if (!jayadratha && !view.pointOfNoReturnPassed)
      add({ target: 'draft', label: 'Draft', description: 'Discard all execution progress and make the attempt editable.', danger: true });
    add({ target: 'done', label: 'Done', description: 'Stop all activity and mark this attempt done manually.' });
    return result;
  }

  private transitionCheckpoint(view: TaskView, resumeStage: Stage, pausedForHuman = false): TaskRecoveryCheckpoint {
    const saved = view.state?.transitionCheckpoint as TaskRecoveryCheckpoint | undefined;
    const source = saved ?? {
      world: view.status === 'cancelled'
        ? undefined
        : (view.world ?? view.state?.recoveryWorld) as WorldHandle | undefined,
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
      ...source,
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
        label: role === 'do' ? 'Do agent' : role === 'merge' ? 'Merge agent' : role === 'resolve' ? 'Resolve agent' : 'Confirm agent',
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
  private async stopTaskActivity(task: TaskRecord, view: TaskView, reason: string): Promise<void> {
    const handle = this.deps.client.workflow.getHandle(task.id);
    await handle.terminate(reason).catch((error) => {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    });

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

  private async startTransitionReplacement(
    task: TaskRecord,
    view: TaskView,
    resumeStage: Stage,
    pausedForHuman = false,
    humanWait?: { audience: string[]; detail: string },
  ): Promise<TaskView> {
    const { startType, input, version } = await this.buildStart(task, true);
    input.recovery = this.transitionCheckpoint(view, resumeStage, pausedForHuman);
    await withTimeout(this.deps.client.workflow.start(startType, {
      taskQueue: this.deps.taskQueue,
      workflowId: task.id,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      args: [input],
    }), START_TIMEOUT_MS);
    this.deps.store.setTaskWorkflowVersion(task.id, version);
    this.deps.store.setTaskExecutionWorkflow(task.id, task.workflow);
    this.deps.store.updateTaskParams(task.id, { ...task.params, archived: false, draft: false });
    const {
      manuallyDoneFrom: _manuallyDoneFrom,
      manuallyDoneView: _manuallyDoneView,
      transitionCheckpoint: _transitionCheckpoint,
      humanPauseOrigin: _humanPauseOrigin,
      cancelledFrom: _cancelledFrom,
      ...priorState
    } = view.state;
    const starting: TaskView = {
      ...view,
      stage: resumeStage,
      status: pausedForHuman ? 'waiting' : 'active',
      actions: pausedForHuman ? this.lifecycleActions(view) : this.resumedActions(view.actions, resumeStage),
      waitingFor: pausedForHuman
        ? {
            kind: 'human',
            audience: humanWait?.audience ?? ['@creator'],
            detail: humanWait?.detail ?? `Paused during ${resumeStage}`,
          }
        : undefined,
      agentTurn: undefined,
      error: undefined,
      state: {
        ...priorState,
        cancelled: false,
        ...(pausedForHuman ? { humanPauseOrigin: resumeStage } : {}),
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
    const view = task.params.draft ? this.getDraftView(token, taskId) : task.lastView;
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
        await this.stopTaskActivity(task, view, 'Task marked done manually');
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
        await this.stopTaskActivity(task, view, 'Task moved back to Draft');
      const world = (view.world ?? view.state?.recoveryWorld) as WorldHandle | undefined;
      if (world && this.deps.worlds) {
        const opened = await this.deps.worlds.open(world).catch(() => undefined);
        await opened?.destroy().catch(() => undefined);
      }
      this.deps.store.updateTaskParams(taskId, {
        ...task.params,
        draft: true,
        archived: false,
        _discardProgress: true,
      });
      this.deps.store.electPrincipal(task.intentId ?? task.id);
      return this.getDraftView(token, taskId)!;
    }

    if (view.state?.humanPauseOrigin === target) {
      await this.deps.client.workflow.getHandle(taskId).signal(SIG.retry);
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
    const view = task.lastView;
    if (!view) throw new Error('task has no lifecycle state yet');
    if (!this.availableStageTransitions(task, view).some((move) => move.target === 'human'))
      throw new Error(`cannot request human input from ${stageName(view.stage)}`);

    const audience = [...new Set((args.audience ?? []).map((selector) => String(selector).trim()).filter(Boolean))];
    if (!audience.length) throw new Error('choose at least one human or team');
    if (audience.length > 32) throw new Error('at most 32 human audience selectors may be used');
    for (const selector of audience) {
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
    return held;
  }

  /**
   * Ask selected humans to add exact capabilities to this task. This is a
   * request primitive, not an elevation primitive: only a selected human who
   * independently holds every requested capability can approve it.
   */
  async requestPermission(
    token: string,
    args: { capabilities: string[]; audience: string[]; reason: string; urgency?: Urgency },
  ): Promise<{ status: 'granted' | 'needs_approval'; requestId?: string; capabilities: string[]; audience?: string[] }> {
    const caller = this.require(token, 'request_permission');
    if (caller.taskId === '*') throw new Error('this endpoint requires a task-agent token');
    const task = this.deps.store.getTask(caller.taskId);
    this.require(token, 'request_permission', { projectId: task?.projectId, taskId: caller.taskId });
    if (!task) throw new Error(`no task ${caller.taskId}`);
    const project = this.deps.store.getProject(task.projectId);
    if (!project?.organizationId) throw new Error('task project has no organization');

    const capabilities = [...new Set((args.capabilities ?? []).map(exactCapability))];
    if (!capabilities.length) throw new Error('choose at least one capability');
    if (capabilities.length > 32) throw new Error('at most 32 capabilities may be requested');
    const missing = capabilities.filter((capability) => !allows(caller.caps, capability));
    if (!missing.length) return { status: 'granted', capabilities };

    const audience = [...new Set((args.audience ?? []).map((selector) => String(selector).trim()).filter(Boolean))];
    if (!audience.length) throw new Error('choose at least one human or team');
    if (audience.length > 32) throw new Error('at most 32 human audience selectors may be used');
    const recipients = new Set<string>();
    for (const selector of audience) {
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
      capabilities: missing,
      audience,
      recipients: [...recipients],
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
          audience: request.audience,
          recipients: request.recipients,
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
      const view = task.lastView;
      if (view && !['done', 'cancelled', 'failed'].includes(view.status)) {
        await this.stopTaskActivity(task, view, `Waiting for permission approval ${request.id}`);
        await this.startTransitionReplacement(task, view, view.stage, true, {
          audience: request.audience,
          detail: `Permission requested: ${request.capabilities.join(', ')} — ${request.reason}`,
        });
      }
    }
    return {
      status: 'needs_approval',
      requestId: request.id,
      capabilities: request.capabilities,
      audience: request.audience,
    };
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
    input: { organizationId: string; requestId: string; action: 'approve' | 'deny' },
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
    if (caller.kind !== 'human' || !caller.principal.startsWith('user:'))
      throw new CapabilityError('a human account is required to resolve a permission request');
    const userId = caller.principal.slice(5);
    if (!request.recipients.includes(userId))
      throw new CapabilityError('this permission request was not routed to you');
    if (input.action === 'approve') {
      for (const capability of request.capabilities) {
        const checked = this.deps.tokens.check(token, capability, {
          taskId: request.taskId,
          projectId: request.projectId,
          organizationId: input.organizationId,
        });
        if (!checked.ok)
          throw new CapabilityError(`you cannot grant ${capability}: ${checked.reason ?? 'permission denied'}`);
      }
    }
    const resolved = service.resolve(request.id, { action: input.action, by: caller.principal });
    const message = input.action === 'approve'
      ? `[Krmax permission decision]\n\nApproved for this task's ${resolved.role} agent: ${resolved.capabilities.join(', ')}. Retry the blocked operation now; a newly scoped token will carry the grant.`
      : `[Krmax permission decision]\n\nDenied for this task's ${resolved.role} agent: ${resolved.capabilities.join(', ')}. Do not request these permissions again; continue without them or explain why the task cannot proceed.`;
    const resume = await this.resumeAfterCredentialDecision(request.taskId, message, request.role);
    const event = {
      taskId: request.taskId,
      type: 'permission.approval-resolved',
      ts: Date.now(),
      payload: {
        requestId: request.id,
        role: request.role,
        capabilities: request.capabilities,
        action: input.action,
        resolvedBy: caller.principal,
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
    return { taskId: task.id, users, teams, special };
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
      : [{ role: 'do', label: 'Do', messages: view?.messages ?? [] }];
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

  /** Branch a source agent into an independent task/session; the source is never mutated. */
  async forkTaskAgent(token: string, args: { taskId: string; role?: string; title?: string; message: string; authorizationProfile?: string }): Promise<TaskRecord> {
    const source = this.deps.store.getTask(args.taskId);
    this.require(token, 'fork_agent', { projectId: source?.projectId, taskId: args.taskId });
    if (!source) throw new NotFoundError(`no task ${args.taskId}`);
    const role = args.role ?? 'do';
    if (!this.deps.store.kvGet(`session:${args.taskId}:${role}`) && !(await this.getTaskView(token, args.taskId))?.messages?.length)
      throw new Error(`the ${role} agent has no conversation to fork`);
    return this.createTask(token, {
      projectId: source.projectId,
      title: args.title ?? `Fork of #${source.num ?? source.id} ${role}`,
      workflow: 'software-dev',
      params: { prompt: args.message, 'agent:do': { resumeFrom: { taskId: args.taskId, role } } },
      authorizationProfile: args.authorizationProfile,
    });
  }

  async taskEvents(token: string, taskId: string, since = 0, limit?: number) {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'list_events', { projectId: task?.projectId, taskId });
    return this.deps.store.eventsSince(taskId, since, limit);
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

    await withTimeout(
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
    // A failed workflow recovery starts a new Temporal history, so replay cannot
    // reconstruct collaborationRequested signals from the old execution. Restore
    // the durable join set before the recovered Do turn can advance to Review.
    for (const request of this.deps.store.listCollaborationRequests({
      requesterTaskId: taskId,
      status: 'pending',
    })) {
      await this.deps.client.workflow.getHandle(taskId)
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

  async signalTask(token: string, taskId: string, signal: string, text?: string, role?: string, images?: ImageRef[]): Promise<Message | undefined> {
    const scopedTask = this.deps.store.getTask(taskId);
    const caller = this.require(token, 'signal_task', { projectId: scopedTask?.projectId, taskId });
    const heldView = scopedTask?.lastView;
    const heldOrigin =
      heldView?.status === 'waiting'
      && heldView.waitingFor?.kind === 'human'
      && heldView.state?.humanPauseOrigin
        ? heldView.state.humanPauseOrigin as Stage
        : undefined;
    if (signal === SIG.confirm && heldOrigin && heldOrigin !== 'review')
      throw new Error(`this is a hold on ${stageName(heldOrigin)}, not a Review decision; resume it or send the relevant agent a follow-up`);
    if (signal === SIG.openPr && heldOrigin && heldOrigin !== 'do')
      throw new Error(`this is a hold on ${stageName(heldOrigin)}, not a proposal waiting to be opened`);
    if ((signal === SIG.confirm || signal === SIG.openPr || signal === SIG.approveCheckout)
      && scopedTask?.lastView?.waitingFor?.kind === 'human') {
      const userId = caller.principal.startsWith('user:') ? caller.principal.slice(5) : undefined;
      if (!userId) throw new CapabilityError('only a human selected by this workflow step can confirm');
      if (!this.deps.store.humanMayAct(taskId, userId))
        throw new CapabilityError('this workflow confirmation step is assigned to someone else');
      // Approving one branch and opening the proposal are not Review confirmation
      // decisions — only `confirm`
      // passes the gate, so only `confirm` is journalled as the decision.
      if (signal === SIG.confirm) {
        this.deps.store.appendEvent({ taskId, type: 'task.confirmation-voted', ts: Date.now(),
          payload: {
            userId, audience: scopedTask.lastView.waitingFor.audience ?? ['@creator'], satisfied: true,
            githubMergeAuthorized: Boolean(scopedTask.lastView.prs?.length
              && (scopedTask.lastView.stage === 'review' || scopedTask.lastView.stage === 'merge')),
            // Current software-dev treats a Review confirmation as durable
            // authorization of the task intent, including bounded automated
            // integration repairs. An exceptional Landing confirmation still
            // records the exact current heads below for strict GitHub policy.
            githubMergeIntentAuthorized: Boolean(scopedTask.lastView.prs?.length
              && Number(String(scopedTask.workflowVersion ?? '').split('.')[1] ?? 0) >= 16
              && scopedTask.lastView.stage === 'review'),
            githubPrHeads: (scopedTask.lastView.prs ?? []).map((ref) => ({
              slug: ref.slug, number: ref.number, headSha: ref.headSha,
            })),
          } });
      }
    } else if (signal === SIG.confirm && scopedTask?.confirmationPolicy) {
      const userId = caller.principal.startsWith('user:') ? caller.principal.slice(5) : undefined;
      if (!userId) throw new CapabilityError('only an explicitly targeted human can satisfy this confirmation policy');
      const vote = this.deps.store.voteConfirmation(taskId, userId);
      if (!vote.authorized) throw new CapabilityError('you are not a reviewer for this task');
      this.deps.store.appendEvent({ taskId, type: 'task.confirmation-voted', ts: Date.now(),
        payload: { userId, votes: vote.votes, required: vote.required, satisfied: vote.satisfied } });
      if (!vote.satisfied) return;
    }
    const terminal = this.deps.store.getTask(taskId)?.lastView;
    if (terminal?.status === 'failed' && RECOVERABLE_WORKFLOWS.has(terminal.workflow) && !terminal.pointOfNoReturnPassed) {
      if (signal === SIG.retry) {
        await this.recoverFailedTask(taskId);
        return;
      }
      if (signal === SIG.followUp) {
        const now = Date.now();
        const msg: Message = { id: `u${now}`, role: 'user', text: text ?? '', ts: now, ...(images?.length ? { images } : {}) };
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

    // Retry is also the explicit migration boundary for Landing failures that
    // are parked in a still-running historical execution. Retrying that same
    // pin would reproduce either the separate Confirm credential selection or
    // the unguarded task-branch push. Replace it with the current workflow while
    // retaining the world, PRs, intent authorization, and Do conversation.
    const retryMinor = Number(String(scopedTask?.workflowVersion ?? '').split('.')[1] ?? 0);
    if (signal === SIG.retry
      && scopedTask?.workflow === 'software-dev'
      && retryMinor >= 16
      && retryMinor < 18
      && heldView?.stage === 'escalated'
      && heldView.status === 'blocked'
      && !heldView.pointOfNoReturnPassed
      && heldView.landing?.authorization === 'authorized') {
      const now = Date.now();
      const message: Message = {
        id: `landing-upgrade-${now}`,
        role: 'user',
        text: `Karmax upgraded this attempt to the current Landing protocol after its prior automated landing step failed. Continue from the existing worktree and this same Do conversation. Preserve the already-authorized intent, inspect the current repaired proposal, make only necessary fixes, verify it, and call open_pr again. Previous failure: ${heldView.error ?? 'unknown landing failure'}`,
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
        id: `u${now}`,
        role: 'user',
        text: text ?? '',
        ts: now,
        ...(images?.length ? { images } : {}),
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
      await this.startTransitionReplacement(scopedTask, heldView, minor >= 12 ? 'merge' : 'pr');
      return;
    }

    // Executions on the pre-v1.18 Landing protocols already parked at their
    // ordinary Review gate must not continue into a separate integration-agent
    // path. The
    // confirmation above has already been authorized and journalled, so replace
    // the old execution at the exact Review -> Landing boundary. This preserves
    // its PR/head checkpoint, consumes the one human decision exactly once, and
    // lets the latest workflow reconstruct intent authorization before entering
    // the front-held exact-candidate queue. Older versions did not journal durable
    // intent authorization, so they retain their historical semantics.
    const scopedMinor = Number(String(scopedTask?.workflowVersion ?? '').split('.')[1] ?? 0);
    if (signal === SIG.confirm
      && scopedTask?.workflow === 'software-dev'
      && scopedMinor >= 16
      && scopedMinor < 18
      && heldView?.stage === 'review'
      && heldView.status === 'waiting'
      && heldView.waitingFor?.kind === 'human'
      && !heldOrigin) {
      await this.stopTaskActivity(scopedTask, heldView, 'Review confirmed; upgrading to same-Do Landing verification');
      await this.startTransitionReplacement(scopedTask, heldView, 'merge');
      return;
    }

    const handle = this.deps.client.workflow.getHandle(taskId);
    let followUp: Message | undefined;
    try {
      if (signal === SIG.followUp) {
        const now = Date.now();
        followUp = {
          id: `u${now}`,
          role: 'user',
          text: text ?? '',
          ts: now,
          ...(images?.length ? { images } : {}),
        };
        // `role` (the addressed agent) is optional — single-agent workflows ignore it
        // and route every follow-up to their sole conversation.
        await handle.signal(SIG.followUp, followUp, role);
        // A signal mutates workflow memory immediately, but workflows deliberately
        // publish their full cached view only at lifecycle boundaries. Journal the
        // accepted message separately so every open conversation can render it
        // mid-turn without changing replay-sensitive workflow command histories.
        this.publishConversationMessage(taskId, role, followUp);
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
      const status = String((event.payload as { status?: unknown } | undefined)?.status ?? '');
      if (status === 'failed' || status === 'cancelled' || status === 'done') {
        settled = this.deps.store.settleCollaborationRequests(event.taskId, 'failed', {
          reason: status === 'done'
            ? 'target task completed without publishing its branch'
            : `target task became ${status}`,
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
            && ['done', 'cancelled', 'failed'].includes(String((event.payload as any)?.status ?? ''))));
      if (relevant) {
        await this.routeCollaborationEvent(relevant);
        continue;
      }
      const status = this.deps.store.getTask(request.targetTaskId)?.lastView?.status;
      if (status && ['done', 'cancelled', 'failed'].includes(status)) {
        const settled = this.deps.store.settleCollaborationRequests(request.targetTaskId, 'failed', {
          reason: status === 'done'
            ? 'target task completed without publishing its branch'
            : `target task became ${status}`,
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
    try {
      return (await this.deps.client.workflow.getHandle(taskId).executeUpdate('setTarget', { args: [branch] })) as boolean;
    } catch {
      return false;
    }
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
    this.require(token, 'edit_task', { projectId: task?.projectId, taskId });
    // A Review-route edit is the one field whose validity the deterministic sandbox
    // cannot judge: "does @qa resolve to a human here?" is a store question. Assert it
    // up front so a re-route can never park the gate on an audience nobody can see.
    const confirmer = task && this.confirmerFieldOf(task);
    if (confirmer && patch[confirmer.field.name] !== undefined)
      this.assertHumanRoutes(task!, confirmer.manifest, { [confirmer.field.name]: patch[confirmer.field.name] } as ValueMap);
    try {
      const result = (await this.deps.client.workflow.getHandle(taskId).executeUpdate('updateParams', { args: [patch] })) as { applied: string[] };
      this.updateAgentSnapshot(taskId, patch, result.applied);
      if (confirmer && result.applied.includes(confirmer.field.name))
        await this.shareConfirmerAcrossAttempts(task!, confirmer.field.name, patch[confirmer.field.name]);
      return result;
    } catch (e) {
      throw new Error(unwrapCause(e));
    }
  }

  /** The task's Review-route field (if its workflow has one) with the manifest it came from. */
  private confirmerFieldOf(task: TaskRecord): { field: FieldSpec; manifest: WorkflowManifest } | undefined {
    const organizationId = this.deps.store.getProject(task.projectId)?.organizationId;
    const start = this.resolveStart(task.workflow, task.workflowVersion, organizationId);
    const field = start?.manifest.params.find((f) => f.type === 'confirmer');
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

  async agentQueueView(token: string): Promise<{ capacity: number; queue: any[]; current: any[] }> {
    // The host agent-queue is a queue surface, not a task read: bind it to the
    // same `queue:read`/`queue:write` pair the gateway route uses, so a
    // maintainer (queue:*) is not refused by one layer and allowed by the other.
    this.require(token, 'queue:read');
    const saved = Number(this.deps.store.getSettings('global', 'agent-queue')?.capacity);
    const fallback = Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 3;
    try {
      return (await this.deps.client.workflow.getHandle(agentQueueId()).query(QRY_AGENT_QUEUE)) as any;
    } catch {
      return { capacity: fallback, queue: [], current: [] };
    }
  }

  async moveAgentQueueItem(token: string, turnId: string, beforeTurnId?: string): Promise<void> {
    this.require(token, 'reorder_queue');
    await this.deps.client.workflow.getHandle(agentQueueId()).signal(SIG_REORDER, { turnId, beforeTurnId });
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
    this.require(token, 'save_skill');
    const dir = this.deps.contentDir ?? paths().content;
    const skillsDir = path.join(dir, 'skills');
    // Preserve namespacing subdirs (e.g. "resolve/<slug>" → skills/resolve/<slug>.md,
    // which listResolveSkills indexes for the self-healing loop, §3.4). Sanitize each
    // path segment and drop any traversal (`..`) so a name can't escape skills/.
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
   *  the task-form `@proj:…`/`@org:…` mention dropdown searches. */
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
    if (!remote) return this.saveWikiPage(token, scope, id, args, selector);
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
    if (!remote) return this.deleteWikiPage(token, scope, id, rel, selector);
    try {
      const deleted = deleteWikiPage(remote.root, rel, { recursive: selector.recursive });
      if (deleted) await remote.flush(`wiki: delete ${safeWikiPath(rel)}`);
      return { deleted };
    } finally { await remote.release(); }
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
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new NotFoundError(`no project ${args.projectId}`);
    const authorization = this.deps.authorization
      ? this.deps.authorization.taskGrant(caller.principal, args.projectId, undefined, caller.caps)
      : { profileId: 'caller', capabilities: caller.caps, attenuated: false };
    const mergeOnlyVersion = MANIFESTS.find((m) => m.name === 'merge-only')?.version;
    if (!mergeOnlyVersion) throw new Error('bundled merge-only manifest is missing');
    const task = this.deps.store.createTask({
      projectId: args.projectId,
      title: args.title,
      workflow: 'merge-only',
      workflowVersion: mergeOnlyVersion,
      // Record the edit target so the self-healing loop can reload the workflow
      // from `repo@target` once this merge completes (§4.4).
      params: {
        prompt: args.title, branch: args.branch, target: args.target, repo: args.repo, workflowEdit: true,
        _authorization: { ...authorization, principal: caller.principal },
      },
      createdBy: principalRefOf(caller.principal),
    });
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
      : MANIFESTS.filter((m) => m.kind !== 'coordinator' && m.selectable !== false).map((m) => ({ name: m.name, description: m.description, params: m.params, stages: m.stages }));
    const settingsOnly = MANIFESTS
      .filter((m) => m.kind === 'coordinator' && m.params.length)
      .map((m) => ({ name: m.name, description: m.description, params: m.params, stages: m.stages }));
    return [...taskSchemas, ...settingsOnly];
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
    if (!this.deps.workflows) throw new Error('workflow installation is not enabled on this server');
    return this.deps.workflows.install(args, organizationId);
  }
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
