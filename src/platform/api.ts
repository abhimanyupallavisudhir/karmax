import type { Client } from '@temporalio/client';
import { Store } from '../store/db.js';
import { TokenAuthority } from './tokens.js';
import { TOOL_CAPABILITY } from './capabilities.js';
import { WORKFLOW_TYPE, SIG } from '../workflows/names.js';
import { mergeQueueId, SIG_PRIORITIZE, MERGE_QUEUE_WORKFLOW } from '../coordinators/names.js';
import { TaskInput, TaskRecord, TaskView, Message } from '../domain/types.js';
import path from 'node:path';
import fs from 'node:fs';
import { paths } from '../config/paths.js';

export class CapabilityError extends Error {
  code = 'capability_denied';
}

export interface KarmaxApiDeps {
  store: Store;
  client: Client;
  taskQueue: string;
  tokens: TokenAuthority;
  contentDir?: string;
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
    args: { projectId: string; title: string; prompt: string; workflow?: string; base?: string; target?: string; command?: string; profiles?: Record<string, string> },
  ): Promise<TaskRecord> {
    this.require(token, 'create_task');
    const workflow = args.workflow ?? 'software-dev';
    const type = WORKFLOW_TYPE[workflow];
    if (!type) throw new Error(`unknown workflow "${workflow}"`);
    const project = this.deps.store.getProject(args.projectId);
    if (!project) throw new Error(`no project ${args.projectId}`);

    const task = this.deps.store.createTask({
      projectId: args.projectId,
      title: args.title,
      workflow,
      workflowVersion: '1.0.0',
      params: { prompt: args.prompt, base: args.base, target: args.target, command: args.command, profiles: args.profiles },
    });

    const input: TaskInput = {
      taskId: task.id,
      projectId: args.projectId,
      title: args.title,
      prompt: args.prompt,
      base: args.base ?? project.config.defaultBase,
      target: args.target ?? project.config.defaultTarget,
      command: args.command,
      profiles: args.profiles,
      project: project.config,
    };
    await this.deps.client.workflow.start(type, {
      taskQueue: this.deps.taskQueue,
      workflowId: task.id,
      args: [input],
    });
    return task;
  }

  async getTaskView(token: string, taskId: string): Promise<TaskView | undefined> {
    this.require(token, 'get_task');
    // Prefer the live workflow view; fall back to the persisted snapshot.
    try {
      return (await this.deps.client.workflow.getHandle(taskId).query('view')) as TaskView;
    } catch {
      return this.deps.store.getTask(taskId)?.lastView;
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
    await this.deps.client.workflow.start(WORKFLOW_TYPE['merge-only']!, {
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
}
