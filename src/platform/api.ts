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
import { TaskRecord, TaskView, Message, Project, TaskInput, ImageRef, Tag, SavedView, TaskQuery, AgentSpec, Provider } from '../domain/types.js';
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
import { defaultModel, defaultEffort } from '../agent/profiles.js';

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

  private require(token: string, tool: string) {
    const cap = TOOL_CAPABILITY[tool] ?? tool;
    const r = this.deps.tokens.check(token, cap);
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
      /** Total mutually-exclusive attempts to create and queue up front. */
      attempts?: number;
    },
  ): Promise<TaskRecord> {
    this.require(token, 'create_task');
    const workflow = args.workflow ?? 'software-dev';
    // Honor a per-project version pin (§21d) so a project can hold on a specific
    // version while others take the latest; unpinned → latest.
    const start = this.resolveStart(workflow, this.workflowPinFor(args.projectId, workflow));
    if (!start) throw new Error(`unknown workflow "${workflow}"`);
    const { manifest, startType } = start;
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new Error(`no project ${args.projectId}`);

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
      params: { ...taskOverrides, prompt: String(taskOverrides.prompt ?? resolved.prompt ?? ''), profiles: args.profiles, draft: !!args.draft, ...(repeatable ? { repeatable: true } : {}) },
      confirmer: (() => {
        const field = manifest.params.find((f) => f.type === 'confirmer');
        return field ? resolved[field.name] : undefined;
      })(),
    });
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
          parentTaskId: task.parentTaskId, intentId: task.intentId });
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
      project: project.config,
    });
    input.workflow = workflow;
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
    const globalVals = globalSettingsFor(getSettings, manifest.name);
    // Quick tasks layer the quick-task defaults (project-quick → global-quick) above
    // the general defaults; a full-form task skips them entirely (SPEC §10.4).
    const layers: (ValueMap | undefined)[] = quick
      ? [taskOverrides, quickProjectSettingsFor(getSettings, project.id, manifest.name), quickGlobalSettingsFor(getSettings, manifest.name), projectVals, globalVals]
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

  /** Turn the compact Agent setting into concrete per-role input. Profile defaults
   * live outside parameter settings, so this final materialization must happen
   * after the parameter overlays have selected the child scope's form shape. */
  private materializeUnifiedAgents(resolved: ValueMap, projectId: string): void {
    if (resolved.separateAgents !== false) return;
    let spec = resolved['agent:do'] as AgentSpec | undefined;
    if (!spec?.provider) {
      const profile = this.deps.store.getProfile(`${projectId}::do-default`) ?? this.deps.store.getProfile('do-default');
      const provider = (profile?.provider ?? defaultProvider().provider) as Provider;
      const model = profile?.model ?? defaultModel(provider);
      const effort = profile?.effort ?? defaultEffort(provider);
      spec = { provider, ...(model ? { model } : {}), ...(effort ? { effort: effort as AgentSpec['effort'] } : {}) };
    }
    resolved['agent:do'] = spec;
    const { resumeFrom: _resumeFrom, ...shared } = spec;
    resolved['agent:merge'] = shared;
    resolved['agent:resolve'] = shared;
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
    const { profiles, draft: _d, archived: _a, triggers: _t, triggerState: _ts, images, ...overrides } = task.params as Record<string, unknown>;
    const resolved = await this.resolveTaskParams(manifest, project, overrides as ValueMap);
    // The confirmer belongs to the logical task, not an attempt. Snapshotting it
    // once prevents attempts queued days apart from inheriting different reviewers.
    const group = this.deps.store.attemptGroup(task.id);
    const confirmerField = manifest.params.find((f) => f.type === 'confirmer');
    if (confirmerField && group?.confirmer !== undefined) resolved[confirmerField.name] = group.confirmer;
    // Same guard as createTask, on the resolved effective repos, before we clear the draft.
    this.assertRepoConfigured(manifest, project, resolved);
    const input = assembleTaskInput(manifest, resolved, {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      project: project.config,
    });
    input.workflow = task.workflow;
    input.intentId = task.intentId ?? task.id;
    if (profiles) input.profiles = profiles as Record<string, string>;
    if ((images as ImageRef[] | undefined)?.length) input.images = images as ImageRef[];
    return { startType, input, version: manifest.version };
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
    this.require(token, 'create_task');
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
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
    return this.deps.store.getTask(taskId)!;
  }

  /**
   * Spawn a **run** from a series (repeatable template) and start it — a fresh
   * task record linked to the series via `runOf`, with trigger/series metadata
   * stripped so it's a plain one-off execution with its own history. Used on
   * each trigger fire of a repeatable series, and by "Run again".
   */
  async spawnRun(token: string, seriesId: string): Promise<TaskRecord> {
    this.require(token, 'create_task');
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
    const confirmerField = this.resolveStart(task.workflow, task.workflowVersion)?.manifest.params.find((f) => f.type === 'confirmer');
    if (confirmerField && Object.prototype.hasOwnProperty.call(params, confirmerField.name)) {
      this.deps.store.setIntentConfirmer(task.intentId ?? task.id, confirmerField.name, params[confirmerField.name]);
    }
    const { profiles } = task.params;
    const meta = profiles !== undefined ? { profiles } : {};
    const base: Record<string, unknown> = opts.replace ? { ...meta, ...params } : { ...task.params, ...params };
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
    this.require(token, 'get_task');
    const snapshot = () => this.deps.store.getTask(taskId)?.lastView;
    // Cosmetic human notes live on the record (never on the workflow), so mirror
    // them onto whichever view we return — the UI shows/edits them at any stage.
    const withNotes = (view: TaskView | undefined): TaskView | undefined =>
      view
        ? {
            ...view,
            notes: this.deps.store.getTask(taskId)?.notes,
            ...(view.status === 'failed' && view.workflow === 'software-dev' && !view.pointOfNoReturnPassed
              ? { actions: FAILED_RECOVERY_ACTIONS() }
              : {}),
          }
        : view;
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
    if (snap && !opts?.live && !legacyAccountWait) return withNotes(snap);
    // Live path — bound it: a wedged workflow (e.g. stuck in a workflow-task-failure
    // loop) makes a query hang without rejecting, which would otherwise freeze the
    // caller. Fall back fast to whatever snapshot we have.
    try {
      const q = this.deps.client.workflow.getHandle(taskId).query('view') as Promise<TaskView>;
      q.catch(() => undefined); // swallow the late rejection if we time out first
      const view = await withTimeout(q, QUERY_TIMEOUT_MS);
      return withNotes((view as TaskView) ?? snapshot());
    } catch {
      return withNotes(snapshot());
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
    this.require(token, 'list_tasks');
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
    });
    if (source.notes) this.deps.store.setTaskNotes(attempt.id, source.notes);
    if (source.tags?.length) this.deps.store.setTaskTags(attempt.id, source.tags);
    // If the former principal is cancelled/failed, the new draft naturally takes over.
    this.deps.store.electPrincipal(group.intentId);
    return this.deps.store.getTask(attempt.id)!;
  }

  attemptGroup(token: string, taskId: string) {
    this.require(token, 'get_task');
    return this.deps.store.attemptGroup(taskId);
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
    this.require(token, 'search_tasks');
    const q: TaskQuery = typeof query === 'string' ? parseQuery(query) : query ?? {};
    const tasks = this.deps.store.listPrincipalTasks(projectId);
    const tags = this.deps.store.listTags(projectId);
    return evaluateQuery(tasks, q, { now, tags });
  }

  /** The searchable-field registry the UI reads to build its filter/sort/group menus. */
  searchFields(token: string) {
    this.require(token, 'search_fields');
    return fieldCatalogue();
  }

  // ─── Tags ────────────────────────────────────────────────────────────────────
  async listTags(token: string, projectId: string): Promise<Tag[]> {
    this.require(token, 'list_tags');
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
    this.require(token, 'set_task_tags');
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`no such task ${taskId}`);
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
    this.require(token, 'set_task_priority');
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

  async signalTask(token: string, taskId: string, signal: string, text?: string, role?: string, images?: ImageRef[]): Promise<void> {
    this.require(token, 'signal_task');
    const terminal = this.deps.store.getTask(taskId)?.lastView;
    if (terminal?.status === 'failed' && terminal.workflow === 'software-dev' && !terminal.pointOfNoReturnPassed) {
      if (signal === SIG.retry) return await this.recoverFailedTask(taskId);
      if (signal === SIG.followUp) {
        const msg: Message = { id: `u${Date.now()}`, role: 'user', text: text ?? '', ts: 0, ...(images?.length ? { images } : {}) };
        const messages = terminal.messages.map((m) => ({ ...m }));
        const transcripts = terminal.transcripts?.map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m })) }));
        const target = role && role !== 'do' ? transcripts?.find((t) => t.role === role)?.messages : messages;
        (target ?? messages).push({ ...msg, ts: (target ?? messages).length });
        this.deps.store.saveView(taskId, { ...terminal, messages, transcripts, actions: FAILED_RECOVERY_ACTIONS() });
        return;
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
    try {
      if (signal === SIG.followUp) {
        const msg: Message = {
          id: `u${Date.now()}`,
          role: 'user',
          text: text ?? '',
          ts: 0,
          ...(images?.length ? { images } : {}),
        };
        // `role` (the addressed agent) is optional — single-agent workflows ignore it
        // and route every follow-up to their sole conversation.
        await handle.signal(SIG.followUp, msg, role);
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
  }

  async setTarget(token: string, taskId: string, branch: string): Promise<boolean> {
    this.require(token, 'edit_task');
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
    this.require(token, 'edit_task');
    try {
      return (await this.deps.client.workflow.getHandle(taskId).executeUpdate('updateParams', { args: [patch] })) as { applied: string[] };
    } catch (e) {
      throw new Error(unwrapCause(e));
    }
  }

  async reorderQueue(token: string, domain: string, taskId: string): Promise<void> {
    this.require(token, 'reorder_queue');
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
    this.require(token, 'reorder_queue');
    await this.deps.client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
      workflowId: mergeQueueId(domain),
      taskQueue: this.deps.taskQueue,
      args: [{ domain }],
      signal: SIG_REORDER,
      signalArgs: [{ taskId, beforeTaskId }],
    });
  }

  async queueView(token: string, domain: string): Promise<{ queue: string[]; current?: string }> {
    this.require(token, 'get_task');
    try {
      return (await this.deps.client.workflow.getHandle(mergeQueueId(domain)).query('queue')) as { queue: string[]; current?: string };
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

  /** Propose a workflow-repo edit through the dogfooded merge-only PR gate (§4.4). */
  async proposeWorkflowEdit(
    token: string,
    args: { projectId: string; title: string; repo: string; branch: string; target: string },
  ): Promise<TaskRecord> {
    this.require(token, 'edit_workflow');
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new Error(`no project ${args.projectId}`);
    const mergeOnlyVersion = MANIFESTS.find((m) => m.name === 'merge-only')?.version;
    if (!mergeOnlyVersion) throw new Error('bundled merge-only manifest is missing');
    const task = this.deps.store.createTask({
      projectId: args.projectId,
      title: args.title,
      workflow: 'merge-only',
      workflowVersion: mergeOnlyVersion,
      // Record the edit target so the self-healing loop can reload the workflow
      // from `repo@target` once this merge completes (§4.4).
      params: { prompt: args.title, branch: args.branch, target: args.target, repo: args.repo, workflowEdit: true },
    });
    try {
      await withTimeout(
        this.deps.client.workflow.start(pinnedType(WORKFLOW_TYPE['merge-only']!, mergeOnlyVersion), {
          taskQueue: this.deps.taskQueue,
          workflowId: task.id,
          args: [
            {
              taskId: task.id,
              projectId: args.projectId,
              title: args.title,
              prompt: args.title,
              branch: args.branch,
              target: args.target,
              project: { ...project.config, repos: [args.repo] },
              workflowEdit: true,
            },
          ],
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
