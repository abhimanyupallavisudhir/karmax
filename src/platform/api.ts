import type { Client } from '@temporalio/client';
import { Store } from '../store/db.js';
import { TokenAuthority } from './tokens.js';
import { TOOL_CAPABILITY } from './capabilities.js';
import { WORKFLOW_TYPE, SIG, pinnedType } from '../workflows/names.js';
import { bundledStart, StartResolution } from './resolve-start.js';
import { MANIFESTS } from '../contrib/manifests.js';
import type { WorkflowManager, WorkflowSummary } from '../packages/manager.js';
import { mergeQueueId, SIG_PRIORITIZE, MERGE_QUEUE_WORKFLOW } from '../coordinators/names.js';
import { TaskRecord, TaskView, Message } from '../domain/types.js';
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

/** How long to wait on a live workflow query before falling back to the snapshot. */
const QUERY_TIMEOUT_MS = 3000;

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
    const start = this.resolveStart(workflow);
    if (!start) throw new Error(`unknown workflow "${workflow}"`);
    const { manifest, startType } = start;
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new Error(`no project ${args.projectId}`);

    // Task-scope overrides: the form's `params` plus the legacy flat fields.
    const taskOverrides: ValueMap = { ...(args.params ?? {}) };
    for (const [k, v] of Object.entries({ prompt: args.prompt, base: args.base, target: args.target, command: args.command, branch: args.branch })) {
      if (v !== undefined && taskOverrides[k] === undefined) taskOverrides[k] = v;
    }
    const getSettings = (s: string, w: string) => this.deps.store.getSettings(s, w);
    const projectVals = projectSettingsFor(getSettings, project, workflow);
    const globalVals = globalSettingsFor(getSettings, workflow);
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

    const title = args.title ?? firstLine(String(resolved.prompt ?? resolved.command ?? 'Task'));
    const task = this.deps.store.createTask({
      projectId: args.projectId,
      title,
      workflow,
      workflowVersion: manifest.version,
      params: { ...resolved, prompt: String(resolved.prompt ?? ''), profiles: args.profiles, draft: !!args.draft },
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
    await this.deps.client.workflow.start(startType, { taskQueue: this.deps.taskQueue, workflowId: task.id, args: [input] });
    return task;
  }

  /** Resolve a workflow's start type + manifest via the manager (installed) or built-ins. */
  private resolveStart(workflow: string, version?: string): StartResolution | undefined {
    return this.deps.workflows?.resolveStart(workflow, version) ?? bundledStart(workflow, version);
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
    const resolved: ValueMap = { ...task.params };
    const input = assembleTaskInput(manifest, resolved, {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      project: project.config,
    });
    input.workflow = task.workflow;
    if (task.params.profiles) input.profiles = task.params.profiles as Record<string, string>;
    this.deps.store.clearDraft(taskId);
    await this.deps.client.workflow.start(startType, { taskQueue: this.deps.taskQueue, workflowId: task.id, args: [input] });
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
      params: { prompt: args.title, branch: args.branch, target: args.target },
    });
    await this.deps.client.workflow.start(pinnedType(WORKFLOW_TYPE['merge-only']!, '1.0.0'), {
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
    });
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
