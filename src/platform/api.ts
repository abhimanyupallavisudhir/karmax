import type { Client } from '@temporalio/client';
import { Store } from '../store/db.js';
import { TokenAuthority } from './tokens.js';
import { TOOL_CAPABILITY } from './capabilities.js';
import { WORKFLOW_TYPE, SIG, pinnedType } from '../workflows/names.js';
import { bundledStart, StartResolution } from './resolve-start.js';
import { MANIFESTS, WorkflowManifest } from '../contrib/manifests.js';
import type { WorkflowManager, WorkflowSummary } from '../packages/manager.js';
import { mergeQueueId, SIG_PRIORITIZE, MERGE_QUEUE_WORKFLOW } from '../coordinators/names.js';
import { TaskRecord, TaskView, Message, Project } from '../domain/types.js';
import { resolveParams, assembleTaskInput, projectSettingsFor, globalSettingsFor, ValueMap } from './params.js';
import { defaultBranch } from '../world/git.js';
import { expandPath } from '../util/expand.js';
import { withTimeout } from '../util/timeout.js';
import path from 'node:path';
import fs from 'node:fs';
import { paths } from '../config/paths.js';

export class CapabilityError extends Error {
  code = 'capability_denied';
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
  constructor(private deps: KarmaxApiDeps) {}

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
  private assertRepoConfigured(manifest: WorkflowManifest, project: Project) {
    const needsRepo = (manifest.params ?? []).some((p) => p.name === 'repos');
    if (!needsRepo) return; // scratch-only workflow (declares no repo) — fine.
    const configured = (project.config.repos ?? []).some((r) => !!r && r.trim().length > 0);
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
      workflow?: string;
      base?: string;
      target?: string;
      command?: string;
      branch?: string;
      profiles?: Record<string, string>;
      /** Full task-form field values (SPEC §10.4); takes precedence over the flat fields. */
      params?: ValueMap;
      /** Save without starting the workflow (SPEC §10.4 drafts). */
      draft?: boolean;
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
    // Refuse to *run* a repo-oriented workflow with no repository configured
    // (drafts may still be saved without one, then checked again at queueTask).
    if (!args.draft) this.assertRepoConfigured(manifest, project);

    // Task-scope overrides: the form's `params` plus the legacy flat fields.
    const taskOverrides: ValueMap = { ...(args.params ?? {}) };
    for (const [k, v] of Object.entries({ prompt: args.prompt, base: args.base, target: args.target, command: args.command, branch: args.branch })) {
      if (v !== undefined && taskOverrides[k] === undefined) taskOverrides[k] = v;
    }
    const resolved = await this.resolveTaskParams(manifest, project, taskOverrides);

    const title = args.title ?? firstLine(String(resolved.prompt ?? resolved.command ?? 'Task'));
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
      params: { ...taskOverrides, prompt: String(taskOverrides.prompt ?? resolved.prompt ?? ''), profiles: args.profiles, draft: !!args.draft },
    });
    if (args.draft) return task; // stored but not queued

    const input = assembleTaskInput(manifest, resolved, {
      taskId: task.id,
      projectId: args.projectId,
      title,
      project: project.config,
    });
    input.workflow = workflow;
    if (args.profiles) input.profiles = args.profiles;

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
      this.deps.store.deleteTask(task.id);
      throw new Error(
        `Could not start "${title}": the durable engine didn't accept the task (${e instanceof Error ? e.message : String(e)}). ` +
          `Nothing was queued — check that Temporal is healthy and try again.`,
      );
    }
    return task;
  }

  /**
   * Resolve a task's effective field values from its own overrides layered over
   * the CURRENT project + global defaults (SPEC §10.4 overlay). Shared by task
   * creation and draft queueing so both pick up the live defaults, and so an
   * unqueued task inherits any default change made after it was saved.
   */
  private async resolveTaskParams(manifest: WorkflowManifest, project: Project, taskOverrides: ValueMap): Promise<ValueMap> {
    const getSettings = (s: string, w: string) => this.deps.store.getSettings(s, w);
    const projectVals = projectSettingsFor(getSettings, project, manifest.name);
    const globalVals = globalSettingsFor(getSettings, manifest.name);
    const resolved = resolveParams(manifest, { task: taskOverrides, project: projectVals, global: globalVals });

    // Auto-detect the repo's default branch when base/target weren't set anywhere,
    // instead of guessing "main" (which would create a phantom target branch).
    const explicitBase = taskOverrides.base ?? projectVals.base ?? globalVals.base;
    const explicitTarget = taskOverrides.target ?? projectVals.target ?? globalVals.target;
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

  /** Start a previously-saved draft (SPEC §10.4). */
  async queueTask(token: string, taskId: string): Promise<TaskRecord> {
    this.require(token, 'create_task');
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    const project = this.deps.store.getProject(task.projectId);
    // Pin to the version stamped when the draft was created, not whatever is
    // current now — queueing a draft after an upgrade must not silently swap code.
    const start = this.resolveStart(task.workflow, task.workflowVersion);
    if (!project || !start) throw new Error(`cannot queue task ${taskId}`);
    const { manifest, startType } = start;
    this.assertRepoConfigured(manifest, project); // same guard as createTask, before we clear the draft
    // Re-resolve against the CURRENT project/global defaults. The task stored only
    // its own overrides, so a draft queued after a default change picks up the new
    // default (SPEC §10.4). Meta fields (profiles/draft/archived) aren't overrides.
    const { profiles, draft: _d, archived: _a, ...overrides } = task.params as Record<string, unknown>;
    const resolved = await this.resolveTaskParams(manifest, project, overrides as ValueMap);
    const input = assembleTaskInput(manifest, resolved, {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      project: project.config,
    });
    input.workflow = task.workflow;
    if (profiles) input.profiles = profiles as Record<string, string>;
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

  async getTaskView(token: string, taskId: string): Promise<TaskView | undefined> {
    this.require(token, 'get_task');
    const snapshot = () => this.deps.store.getTask(taskId)?.lastView;
    // Prefer the live workflow view, but bound it: a wedged workflow (e.g. stuck
    // in a workflow-task-failure loop) makes a query hang without rejecting, which
    // would otherwise freeze the whole task list / dashboard. Fall back fast.
    try {
      const q = this.deps.client.workflow.getHandle(taskId).query('view') as Promise<TaskView>;
      q.catch(() => undefined); // swallow the late rejection if we time out first
      const view = await withTimeout(q, QUERY_TIMEOUT_MS);
      return (view as TaskView) ?? snapshot();
    } catch {
      return snapshot();
    }
  }

  async listTasks(token: string, projectId: string): Promise<TaskRecord[]> {
    this.require(token, 'list_tasks');
    return this.deps.store.listTasks(projectId);
  }

  async signalTask(token: string, taskId: string, signal: string, text?: string): Promise<void> {
    this.require(token, 'signal_task');
    const handle = this.deps.client.workflow.getHandle(taskId);
    if (signal === SIG.followUp) {
      const msg: Message = { id: `u${Date.now()}`, role: 'user', text: text ?? '', ts: 0 };
      await handle.signal(SIG.followUp, msg);
    } else {
      await handle.signal(signal);
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

  async queueView(token: string, domain: string): Promise<{ queue: string[]; current?: string }> {
    this.require(token, 'get_task');
    try {
      return (await this.deps.client.workflow.getHandle(mergeQueueId(domain)).query('queue')) as { queue: string[]; current?: string };
    } catch {
      return { queue: [] };
    }
  }

  async saveSkill(token: string, args: { name: string; content: string }): Promise<{ path: string }> {
    this.require(token, 'save_skill');
    const dir = this.deps.contentDir ?? paths().content;
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const file = path.join(skillsDir, `${args.name.replace(/[^a-z0-9_-]/gi, '-')}.md`);
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
    const task = this.deps.store.createTask({
      projectId: args.projectId,
      title: args.title,
      workflow: 'merge-only',
      workflowVersion: '1.0.0',
      // Record the edit target so the self-healing loop can reload the workflow
      // from `repo@target` once this merge completes (§4.4).
      params: { prompt: args.title, branch: args.branch, target: args.target, repo: args.repo, workflowEdit: true },
    });
    try {
      await withTimeout(
        this.deps.client.workflow.start(pinnedType(WORKFLOW_TYPE['merge-only']!, '1.0.0'), {
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
    if (this.deps.workflows) return this.deps.workflows.schemas();
    return MANIFESTS.filter((m) => m.kind !== 'coordinator').map((m) => ({ name: m.name, description: m.description, params: m.params, stages: m.stages }));
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
