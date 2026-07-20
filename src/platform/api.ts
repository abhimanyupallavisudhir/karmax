import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { WorkflowIdReusePolicy } from '@temporalio/common';
import { Store } from '../store/db.js';
import { TokenAuthority } from './tokens.js';
import { TOOL_CAPABILITY } from './capabilities.js';
import { WORKFLOW_TYPE, SIG, pinnedType } from '../workflows/names.js';
import { bundledStart, StartResolution } from './resolve-start.js';
import { MANIFESTS, WorkflowManifest, eventCatalog } from '../contrib/manifests.js';
import type { WorkflowManager, WorkflowSummary } from '../packages/manager.js';
import {
  mergeQueueId,
  agentQueueId,
  SIG_PRIORITIZE,
  SIG_REORDER,
  SIG_SET_AGENT_CAPACITY,
  QRY_AGENT_QUEUE,
  MERGE_QUEUE_WORKFLOW,
  AGENT_QUEUE_WORKFLOW,
} from '../coordinators/names.js';
import { TaskRecord, TaskView, Message, Project, TaskInput, ImageRef, Tag, SavedView, TaskQuery, AgentRole, AgentSpec, Provider, PrincipalRef, ConfirmationPolicy, OrganizationExecutionPolicy } from '../domain/types.js';
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
import { WikiScope, wikiRoot, listWiki, readWikiPage, writeWikiPage, deleteWikiPage, moveWikiPage, collectUnconditional, searchWiki, safeWikiPath, parseFrontmatter, renderWikiToc, resolveBuiltins, BUILTIN_WIKI_ENTRIES } from '../wiki/wiki.js';
import { applyAgentSpec, defaultModel, defaultEffort, ProfileResolver } from '../agent/profiles.js';
import type { AuthorizationService } from './authorization.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';
import { confirmLayersOf } from '../domain/confirm.js';
import type { KarmaxBus } from '../contrib/bus.js';
import type { WorldRegistry } from '../world/registry.js';
import type { WorldHandle } from '../world/types.js';
import { worldRepos } from '../world/types.js';
import { brokerImportTaskBranch, brokerPublishBranch, brokerRefreshUpstream, type GitBrokerAuth } from '../world/git-broker.js';
import type { WorldAccessService } from '../world/access.js';

export class CapabilityError extends Error {
  code = 'capability_denied';
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
}

const firstLine = (s: string) => (s.split('\n')[0] ?? 'Task').slice(0, 80) || 'Task';
const agentSnapshotKey = (taskId: string) => `task-agents:${taskId}`;

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

/** A failed execution is terminal, but software-dev can start a replacement run
 * from its persisted world/conversation checkpoint. These mirror escalation's
 * controls; signalTask gives them terminal-aware semantics. */
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
  constructor(private deps: KarmaxApiDeps) {}

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
    if (!this.deps.githubApp) throw new Error('Git collaboration requires a connected GitHub App');
    const linked = this.deps.store.listProjectRepositories(projectId);
    return async (repo) => {
      const repository = linked.find((candidate) => candidate.repository.sshUrl === repo.repo)?.repository;
      if (!repository) throw new Error(`repository is not enrolled in this project: ${repo.repo}`);
      return this.deps.githubApp!.brokerCredentials(repository);
    };
  }

  private async openCollaborationWorld(taskId: string, handle: WorldHandle) {
    if (this.deps.worldAccess) return this.deps.worldAccess.open(taskId, handle);
    if (!this.deps.worlds) throw new Error('world access is unavailable');
    return { world: await this.deps.worlds.open(handle), handle, release: async () => {} };
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
        throw new Error(`could not publish ${result.skipped.length ? result.skipped.join(', ') : 'task branch'}`);
      const event = { taskId: task.id, type: 'push.branch', ts: Date.now(), payload: {
        branch: access.handle.branch, repos: result.pushed, reason: 'agent-collaboration' } };
      const seq = this.deps.store.appendEvent(event);
      this.deps.bus?.emit({ ...event, seq });
      return { branch: access.handle.branch, pushed: result.pushed };
    } finally { await access.release(); }
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
      return { refs: await brokerRefreshUpstream(access.world, this.gitBrokerAuth(task.projectId), branch) };
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
        throw new Error(
          `Workflow "${manifest.name}" works on a repository, but hosted project "${project.name}" has no attached ` +
            `GitHub repository. Connect the organization GitHub App and attach a repository to this project before running the task.`,
        );
      }
      const enrolled = new Set(linked.map((candidate) => candidate.repository.sshUrl));
      const outside = effectiveRepos(resolved, project.config).filter((repository) => !enrolled.has(repository));
      if (outside.length) throw new Error(`Hosted project "${project.name}" references a repository that is not attached to it: ${outside[0]}`);
    }
    // Guard on the EFFECTIVE repo list the world will be built from (the resolved
    // settings overlay, falling back to project config) — the same value that
    // reaches createWorld — not project.config alone. Those two can diverge (an
    // empty settings-overlay repos list resolving to nothing while config still
    // holds a repo), and checking config-only let that case slip through into a
    // silent scratch sandbox — the very footgun this guard exists to prevent.
    const configured = effectiveRepos(resolved, project.config).length > 0;
    if (!configured) {
      throw new Error(
        `Workflow "${manifest.name}" works on a repository, but project "${project.name}" has no repository ` +
          `configured — it would run against an empty throwaway sandbox, not your code. Set the repository ` +
          `directory in the project's Settings (an absolute path, or one starting with ~) before running this task.`,
      );
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
      /** Total mutually-exclusive attempts to create and queue up front. */
      attempts?: number;
      assignee?: PrincipalRef;
      delegate?: PrincipalRef;
      confirmationPolicy?: ConfirmationPolicy;
    },
  ): Promise<TaskRecord> {
    const caller = this.require(token, 'create_task', { projectId: args.projectId });
    const workflow = args.workflow ?? 'software-dev';
    // Honor a per-project version pin (§21d) so a project can hold on a specific
    // version while others take the latest; unpinned → latest.
    const start = this.resolveStart(workflow, this.workflowPinFor(args.projectId, workflow));
    if (!start) throw new Error(`unknown workflow "${workflow}"`);
    const { manifest, startType } = start;
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new Error(`no project ${args.projectId}`);
    const authorization = this.deps.authorization
      ? this.deps.authorization.taskGrant(caller.principal, args.projectId, args.authorizationProfile, caller.caps)
      : { profileId: args.authorizationProfile ?? 'caller', capabilities: caller.caps, attenuated: false };

    // Task-scope overrides: the form's `params` plus the legacy flat fields.
    const taskOverrides: ValueMap = { ...(args.params ?? {}) };
    for (const [k, v] of Object.entries({ prompt: args.prompt, base: args.base, target: args.target, command: args.command, branch: args.branch })) {
      if (v !== undefined && taskOverrides[k] === undefined) taskOverrides[k] = v;
    }
    // Image attachments ride alongside the prompt but aren't a manifest param, so
    // carry them explicitly (references only — bytes live in the attachment store).
    if (args.images?.length && taskOverrides.images === undefined) taskOverrides.images = args.images;
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
        _authorization: { ...authorization, principal: caller.principal },
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
      const profile = this.deps.store.getProfile(`${projectId}::do-default`) ?? this.deps.store.getProfile('do-default');
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
  private resolveStart(workflow: string, version?: string): StartResolution | undefined {
    return this.deps.workflows?.resolveStart(workflow, version) ?? bundledStart(workflow, version);
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
    this.require(token, 'edit_workflow');
    const v = args.version && args.version !== 'latest' ? args.version : '';
    this.deps.store.kvSet(this.pinKey(args.projectId, args.workflow), v);
    return { workflow: args.workflow, version: v || 'latest' };
  }

  /** The version each installed/built-in workflow is pinned to for a project (else 'latest'). */
  workflowPins(token: string, projectId: string): Record<string, string> {
    this.require(token, 'list_workflows');
    const out: Record<string, string> = {};
    for (const w of this.deps.workflows?.list() ?? []) out[w.name] = this.workflowPinFor(projectId, w.name) ?? 'latest';
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
    const start = this.resolveStart(task.workflow, migrateToLatest ? undefined : task.workflowVersion);
    if (!project || !start) throw new Error(`cannot start task ${task.id}`);
    const { manifest, startType } = start;
    // Re-resolve against the CURRENT project/global defaults. The task stored only
    // its own overrides, so a draft queued after a default change picks up the new
    // default (SPEC §10.4). Meta fields (profiles/draft/archived/triggers) aren't overrides.
    const { profiles, draft: _d, archived: _a, triggers: _t, triggerState: _ts, images, _authorization, ...overrides } = task.params as Record<string, unknown>;
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
    const errs = validateTriggers(normalizeTriggers(task.params));
    if (errs.length) throw new Error(`invalid trigger(s): ${errs.join('; ')}`);
    this.deps.store.updateTaskParams(taskId, { ...task.params, draft: false, triggerState: 'armed' });
    const armed = this.deps.store.getTask(taskId)!;
    this.armer?.arm(armed);
    return armed;
  }

  /** Start a previously-saved draft (SPEC §10.4). */
  async queueTask(token: string, taskId: string): Promise<TaskRecord> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
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
    this.deps.store.clearDraft(taskId);
    // Bounded + compensated: on a wedged engine, restore the draft flag so a
    // failed queue attempt leaves the task saved (not stranded, non-draft, with
    // no workflow) and report a real error rather than hanging.
    try {
      await withTimeout(
        this.deps.client.workflow.start(startType, { taskQueue: this.deps.taskQueue, workflowId: task.id, args: [input] }),
        START_TIMEOUT_MS,
      );
    } catch (e) {
      this.deps.store.updateTaskParams(taskId, { ...task.params, draft: true });
      throw new Error(
        `Could not queue task: the durable engine didn't accept it (${e instanceof Error ? e.message : String(e)}). ` +
          `It's still saved as a draft — check that Temporal is healthy and try again.`,
      );
    }
    const started = this.resolveStart(task.workflow, task.workflowVersion);
    if (started) this.saveAgentSnapshot(task.id, started.manifest, input);
    return this.deps.store.getTask(taskId)!;
  }

  /** Change the job-shaped grant on work that has not started yet. The selected
   * profile is always re-attenuated against the immediate bearer, so an agent
   * cannot use a human principal recorded on the draft as a confused deputy. */
  setTaskAuthorization(token: string, taskId: string, profileId: string): TaskRecord {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    if (!task.params?.draft && task.params?.triggerState !== 'armed' && !task.params?.repeatable)
      throw new Error('authorization is frozen after a task starts');
    const caller = this.require(token, 'create_task', { projectId: task.projectId, taskId });
    const authorization = this.deps.authorization
      ? this.deps.authorization.taskGrant(caller.principal, task.projectId, profileId, caller.caps)
      : { profileId, capabilities: caller.caps, attenuated: false };
    this.deps.store.updateTaskParams(taskId, {
      ...task.params,
      _authorization: { ...authorization, principal: caller.principal },
    });
    return this.deps.store.getTask(taskId)!;
  }

  /**
   * Spawn a **run** from a series (repeatable template) and start it — a fresh
   * task record linked to the series via `runOf`, with trigger/series metadata
   * stripped so it's a plain one-off execution with its own history. Used on
   * each trigger fire of a repeatable series, and by "Run again".
   */
  async spawnRun(token: string, seriesId: string): Promise<TaskRecord> {
    const caller = this.require(token, 'create_task');
    const series = this.deps.store.getTask(seriesId);
    if (!series) throw new Error(`no task ${seriesId}`);
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
    const started = this.resolveStart(run.workflow, run.workflowVersion);
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
    this.require(token, 'create_task');
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);

    if (mode === 'clone') return { startedTaskId: (await this.spawnRun(token, taskId)).id };

    const fired = { ...(task.params as Record<string, unknown>), triggerState: 'fired' };
    this.deps.store.updateTaskParams(taskId, fired as any);
    try {
      const { startType, input } = await this.buildStart({ ...task, params: fired as any });
      await withTimeout(
        this.deps.client.workflow.start(startType, { taskQueue: this.deps.taskQueue, workflowId: task.id, args: [input] }),
        START_TIMEOUT_MS,
      );
      const started = this.resolveStart(task.workflow, task.workflowVersion);
      if (started) this.saveAgentSnapshot(task.id, started.manifest, input);
    } catch (e) {
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
    this.require(token, 'edit_task');
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    this.armer?.disarm(taskId);
    const { triggerState: _s, ...rest } = task.params as Record<string, unknown>;
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
    this.require(token, 'edit_task');
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    const { archived, profiles, priority, _authorization } = task.params;
    const meta = {
      ...(archived !== undefined ? { archived } : {}),
      ...(profiles !== undefined ? { profiles } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(_authorization !== undefined ? { _authorization } : {}),
    };
    const start = this.resolveStart(task.workflow, task.workflowVersion);
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
      return {
        ...view,
        notes: this.deps.store.getTask(taskId)?.notes,
        ...(agents ? { agents } : {}),
        ...(view.status === 'failed' && view.workflow === 'software-dev' && !view.pointOfNoReturnPassed
          ? { actions: FAILED_RECOVERY_ACTIONS() }
          : {}),
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
  getDraftView(token: string, taskId: string): TaskView | undefined {
    this.require(token, 'get_task');
    const record = this.deps.store.getTask(taskId);
    if (!record?.params?.draft) return undefined;
    return {
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
  }

  async listTasks(token: string, projectId: string): Promise<TaskRecord[]> {
    this.require(token, 'list_tasks', { projectId });
    return this.deps.store.listPrincipalTasks(projectId);
  }

  /** Create an editable, unqueued alternate by cloning an existing attempt. */
  async addAttempt(token: string, sourceTaskId: string): Promise<TaskRecord> {
    this.require(token, 'create_task');
    const source = this.deps.store.getTask(sourceTaskId);
    if (!source) throw new Error(`no task ${sourceTaskId}`);
    const group = this.deps.store.attemptGroup(sourceTaskId);
    if (!group) throw new Error('task has no attempt group');
    if (group.committedAttemptId) throw new Error('no more attempts can be added after an attempt enters Merge');
    const { archived: _archived, draft: _draft, triggers: _triggers, triggerState: _triggerState,
      repeatable: _repeatable, runOf: _runOf, ...workflowParams } = source.params;
    const start = this.resolveStart(source.workflow, source.workflowVersion);
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
    if (source.notes) this.deps.store.setTaskNotes(attempt.id, source.notes);
    if (source.tags?.length) this.deps.store.setTaskTags(attempt.id, source.tags);
    // If the former principal is cancelled/failed, the new draft naturally takes over.
    this.deps.store.electPrincipal(group.intentId);
    return this.deps.store.getTask(attempt.id)!;
  }

  attemptGroup(token: string, taskId: string) {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'get_task', { projectId: task?.projectId, taskId });
    return this.deps.store.attemptGroup(taskId);
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
    if (!task) throw new Error(`no task ${taskId}`);
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
    if (!source) throw new Error(`no task ${args.taskId}`);
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

  async taskEvents(token: string, taskId: string, since = 0) {
    const task = this.deps.store.getTask(taskId);
    this.require(token, 'list_events', { projectId: task?.projectId, taskId });
    return this.deps.store.eventsSince(taskId, since);
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
    const tasks = this.deps.store.listPrincipalTasks(projectId);
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

  async createTag(token: string, input: { projectId: string; name: string; parentId?: string; color?: string; kind?: 'type' | 'topic' }): Promise<Tag> {
    this.require(token, 'manage_tag');
    return this.deps.store.createTag(input);
  }

  async updateTag(token: string, id: string, patch: { name?: string; parentId?: string | null; color?: string | null; kind?: 'type' | 'topic' | null }): Promise<Tag | undefined> {
    this.require(token, 'manage_tag');
    return this.deps.store.updateTag(id, patch);
  }

  async deleteTag(token: string, id: string): Promise<void> {
    this.require(token, 'manage_tag');
    this.deps.store.deleteTag(id);
  }

  /** Replace the full tag set on a task (organization only — never reaches the agent). */
  async setTaskTags(token: string, taskId: string, tagIds: string[]): Promise<string[]> {
    this.require(token, 'set_task_tags');
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
    if (!task) throw new Error(`no such task ${taskId}`);
    this.require(token, 'set_task_tags', { projectId: task.projectId, taskId });
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
    this.require(token, 'set_task_priority', { projectId: task?.projectId, taskId });
    this.deps.store.setTaskPriority(taskId, priority);
  }

  // ─── Saved views (a view is a saved query) ───────────────────────────────────
  async listViews(token: string, projectId: string): Promise<SavedView[]> {
    this.require(token, 'list_views');
    return this.deps.store.listViews(projectId);
  }

  async createView(token: string, input: { projectId: string; name: string; query: TaskQuery; icon?: string }): Promise<SavedView> {
    this.require(token, 'manage_view');
    return this.deps.store.createView(input);
  }

  async updateView(token: string, id: string, patch: { name?: string; query?: TaskQuery; icon?: string | null }): Promise<SavedView | undefined> {
    this.require(token, 'manage_view');
    return this.deps.store.updateView(id, patch);
  }

  async reorderView(token: string, id: string, ord: number): Promise<void> {
    this.require(token, 'manage_view');
    this.deps.store.reorderView(id, ord);
  }

  async deleteView(token: string, id: string): Promise<void> {
    this.require(token, 'manage_view');
    this.deps.store.deleteView(id);
  }

  /** Restart a terminally failed software-dev execution without running Setup.
   * Setup's createWorld deliberately replaces stale worktrees; doing that here
   * would erase the exact dirty work a recovery exists to preserve. */
  private async recoverFailedTask(taskId: string): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    const view = task?.lastView;
    if (!task || !view) throw new Error(`no failed task ${taskId}`);
    if (task.workflow !== 'software-dev' || view.status !== 'failed') throw new Error('only failed software-dev tasks can be recovered');
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
      text: `Karmax recovered this task after its prior execution failed. Continue from the existing worktree and conversation; preserve and finish the work already present. Previous failure: ${view.error ?? 'unknown error'}`,
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
    const started = this.resolveStart(task.workflow, version);
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
    if (signal === SIG.confirm && scopedTask?.lastView?.waitingFor?.kind === 'human') {
      const userId = caller.principal.startsWith('user:') ? caller.principal.slice(5) : undefined;
      if (!userId) throw new CapabilityError('only a human selected by this workflow step can confirm');
      if (!this.deps.store.humanMayAct(taskId, userId))
        throw new CapabilityError('this workflow confirmation step is assigned to someone else');
      this.deps.store.appendEvent({ taskId, type: 'task.confirmation-voted', ts: Date.now(),
        payload: { userId, audience: scopedTask.lastView.waitingFor.audience ?? ['@creator'], satisfied: true } });
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
    if (terminal?.status === 'failed' && terminal.workflow === 'software-dev' && !terminal.pointOfNoReturnPassed) {
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
    try {
      const result = (await this.deps.client.workflow.getHandle(taskId).executeUpdate('updateParams', { args: [patch] })) as { applied: string[] };
      this.updateAgentSnapshot(taskId, patch, result.applied);
      return result;
    } catch (e) {
      throw new Error(unwrapCause(e));
    }
  }

  async reorderQueue(token: string, domain: string, taskId: string): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    this.require(token, 'reorder_queue', { projectId: task.projectId, taskId });
    if (task.lastView?.state?.mergeDomain && task.lastView.state.mergeDomain !== domain) throw new Error('task is not in that merge queue domain');
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
    if (!task) throw new Error(`no task ${taskId}`);
    this.require(token, 'reorder_queue', { projectId: task.projectId, taskId });
    if (task.lastView?.state?.mergeDomain && task.lastView.state.mergeDomain !== domain) throw new Error('task is not in that merge queue domain');
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
    this.require(token, 'get_task', projectId ? { projectId } : undefined);
    try {
      const view = (await this.deps.client.workflow.getHandle(mergeQueueId(domain)).query('queue')) as { queue: string[]; current?: string };
      if (!projectId) return view;
      const belongs = (id: string | undefined) => !!id && this.deps.store.getTask(id)?.projectId === projectId;
      return { queue: view.queue.filter((id) => belongs(id)), ...(belongs(view.current) ? { current: view.current } : {}) };
    } catch {
      return { queue: [] };
    }
  }

  async agentQueueView(token: string): Promise<{ capacity: number; queue: any[]; current: any[] }> {
    this.require(token, 'get_task');
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

  async setAgentCapacity(capacity: number): Promise<void> {
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
  // Reads need the scope's read capability; writes reuse skill:write (the wiki
  // IS the skills store). All paths are traversal-checked inside src/wiki.

  /** Resolve + authorize one wiki scope; returns its on-disk root. */
  private wikiScope(token: string, scope: string, id: string, write: boolean): string {
    if (scope !== 'organization' && scope !== 'project') throw new Error('wiki scope must be organization or project');
    if (scope === 'project') {
      const project = this.deps.store.getProject(id);
      if (!project) throw new Error(`no project ${id}`);
      this.require(token, write ? 'skill:write' : 'project:read', { projectId: id, organizationId: project.organizationId });
    } else {
      this.require(token, write ? 'skill:write' : 'organization:read', { organizationId: id });
    }
    return wikiRoot(this.deps.contentDir ?? paths().content, scope, id);
  }

  /** One navigation call: a skill path returns the page; anything else lists
   *  the (sub)tree — the same call expands a TOC `[more…]` fold. The full tree
   *  also carries the unconditional entries' bodies and `tocText`, the exact
   *  rendered table of contents agents receive (importance order, [more…]
   *  folds). The organization tree includes the built-ins, resolved through
   *  their on-disk overrides when edited. */
  readWiki(token: string, scope: WikiScope, id: string, rel = '') {
    const root = this.wikiScope(token, scope, id, false);
    const entryOf = ({ content: _c, files: _f, ...entry }: (typeof BUILTIN_WIKI_ENTRIES)[number]) => entry;
    const builtins = scope === 'organization' ? resolveBuiltins(root) : [];
    const builtin = builtins.find((b) => b.path === safeWikiPath(rel));
    if (builtin) return { scope, id, path: builtin.path, page: builtin };
    const page = rel ? readWikiPage(root, rel) : undefined;
    if (page) return { scope, id, path: page.path, page };
    const toc = listWiki(root, rel);
    if (rel) return { scope, id, path: safeWikiPath(rel), toc };
    const unconditional = [
      ...builtins
        .filter((b) => b.delivery === 'unconditional')
        .map((b) => ({ ...entryOf(b), body: parseFrontmatter(b.content).body.trim() || b.content })),
      ...collectUnconditional(root, toc).map(({ files: _files, content: _content, ...rest }) => rest),
    ];
    toc.children = [...builtins.map(entryOf), ...(toc.children ?? [])];
    // renderWikiToc skips unconditional entries itself, so the full tree gives
    // exactly the agent-visible TOC (indexed built-ins included).
    const tocText = renderWikiToc(toc, { scope, id });
    return { scope, id, path: '', toc, unconditional, tocText };
  }

  /** Create (`create` guards against overwriting), update, or — via `prevPath`
   *  — rename an entry. `kind` picks SKILL.md vs MEMORY.md at creation only. */
  saveWikiPage(
    token: string,
    scope: WikiScope,
    id: string,
    args: { path: string; content: string; kind?: 'skill' | 'memory'; create?: boolean; prevPath?: string },
  ) {
    const root = this.wikiScope(token, scope, id, true);
    if (args.prevPath && safeWikiPath(args.prevPath) !== safeWikiPath(args.path)) moveWikiPage(root, args.prevPath, args.path);
    return writeWikiPage(root, args.path, args.content, args.kind === 'memory' ? 'memory' : 'skill', { create: args.create });
  }

  deleteWikiPage(token: string, scope: WikiScope, id: string, rel: string) {
    const root = this.wikiScope(token, scope, id, true);
    return { deleted: deleteWikiPage(root, rel) };
  }

  searchWiki(token: string, scope: WikiScope, id: string, query: string) {
    const root = this.wikiScope(token, scope, id, false);
    return { scope, id, query, hits: searchWiki(root, query) };
  }

  /** Propose a workflow-repo edit through the dogfooded merge-only PR gate (§4.4). */
  async proposeWorkflowEdit(
    token: string,
    args: { projectId: string; title: string; repo: string; branch: string; target: string },
  ): Promise<TaskRecord> {
    const caller = this.require(token, 'edit_workflow', { projectId: args.projectId });
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new Error(`no project ${args.projectId}`);
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
    const started = this.resolveStart(task.workflow, task.workflowVersion);
    if (started) this.saveAgentSnapshot(task.id, started.manifest, input);
    return task;
  }

  /** Installed + built-in workflows, with versions (§21d). */
  listWorkflows(token: string): WorkflowSummary[] {
    this.require(token, 'list_workflows');
    return this.deps.workflows?.list() ?? [];
  }

  /**
   * Task-form parameter schemas for selectable workflows (§10.4). Includes
   * installed workflows when a manager is configured, else the built-ins — so
   * the New Task form can offer any registered workflow. Read-only, session-gated
   * by the gateway, so it takes no capability (matches the prior inline handler).
   */
  workflowSchemas(): { name: string; description: string; params: unknown; stages: unknown }[] {
    const taskSchemas = this.deps.workflows
      ? this.deps.workflows.schemas()
      : MANIFESTS.filter((m) => m.kind !== 'coordinator').map((m) => ({ name: m.name, description: m.description, params: m.params, stages: m.stages }));
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
  async installWorkflow(token: string, args: { url: string; ref?: string; name?: string }): Promise<{ name: string; version: string }> {
    this.require(token, 'install_workflow');
    if (!this.deps.workflows) throw new Error('workflow installation is not enabled on this server');
    return this.deps.workflows.install(args);
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
