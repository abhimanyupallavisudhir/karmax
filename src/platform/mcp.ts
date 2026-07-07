import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KarmaxApi, CapabilityError } from './api.js';

/**
 * The platform MCP server (SPEC §3.4) — the single API agents use to act on the
 * system. One server given to every agent; integration is written once because
 * both Claude and Codex speak MCP. Every call is permission-checked (the agent's
 * scoped token gates it) and routed through the same `PlatformOps` whether the
 * server runs in-process (worker) or as a stdio subprocess that forwards to the
 * gateway over HTTP (a CLI agent reading its config home's mcpServers).
 */
export interface PlatformOps {
  createTask(a: { projectId: string; title: string; prompt: string; workflow?: string }): Promise<{ id: string }>;
  getTask(taskId: string): Promise<unknown>;
  listTasks(projectId: string): Promise<{ id: string; title: string; workflow: string }[]>;
  signalTask(taskId: string, signal: string, text?: string, role?: string): Promise<void>;
  reorderQueue(domain: string, taskId: string): Promise<void>;
  saveSkill(a: { name: string; content: string }): Promise<unknown>;
  proposeWorkflowEdit(a: { projectId: string; title: string; repo: string; branch: string; target: string }): Promise<{ id: string }>;
}

/** In-process ops backed by KarmaxApi + the agent's scoped token (worker side). */
export function apiOps(api: KarmaxApi, getToken: () => string): PlatformOps {
  return {
    createTask: (a) => api.createTask(getToken(), a),
    getTask: (id) => api.getTaskView(getToken(), id) as Promise<unknown>,
    listTasks: async (pid) => (await api.listTasks(getToken(), pid)).map((t) => ({ id: t.id, title: t.title, workflow: t.workflow })),
    signalTask: (id, sig, text, role) => api.signalTask(getToken(), id, sig as any, text, role),
    reorderQueue: (domain, id) => api.reorderQueue(getToken(), domain, id),
    saveSkill: (a) => api.saveSkill(getToken(), a) as Promise<unknown>,
    proposeWorkflowEdit: (a) => api.proposeWorkflowEdit(getToken(), a),
  };
}

/** HTTP ops that forward to the gateway with a bearer token (stdio subprocess). */
export function httpOps(baseUrl: string, token: string): PlatformOps {
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((body as any)?.error || `HTTP ${res.status}`);
    return body;
  };
  return {
    createTask: (a) => req(`/api/projects/${a.projectId}/tasks`, { method: 'POST', body: JSON.stringify(a) }) as Promise<{ id: string }>,
    getTask: (id) => req(`/api/tasks/${id}`),
    listTasks: (pid) => req(`/api/projects/${pid}/tasks`) as Promise<{ id: string; title: string; workflow: string }[]>,
    signalTask: async (id, signal, text, role) => void (await req(`/api/tasks/${id}/signal`, { method: 'POST', body: JSON.stringify({ signal, text, role }) })),
    reorderQueue: async (domain, taskId) => void (await req(`/api/queue/prioritize`, { method: 'POST', body: JSON.stringify({ domain, taskId }) })),
    saveSkill: (a) => req(`/api/skills`, { method: 'POST', body: JSON.stringify(a) }),
    proposeWorkflowEdit: (a) => req(`/api/projects/${a.projectId}/propose-workflow-edit`, { method: 'POST', body: JSON.stringify(a) }) as Promise<{ id: string }>,
  };
}

export function createPlatformMcpServer(ops: PlatformOps): McpServer {
  const server = new McpServer({ name: 'karmax-platform', version: '1.0.0' });
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const wrap = async (fn: () => Promise<any>) => {
    try {
      const r = await fn();
      return ok(typeof r === 'string' ? r : JSON.stringify(r));
    } catch (e) {
      const msg = e instanceof CapabilityError ? `permission denied: ${e.message}` : `error: ${String((e as Error).message ?? e)}`;
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
  };

  server.registerTool(
    'create_task',
    { description: 'Create a new task on a project task list.', inputSchema: { projectId: z.string(), title: z.string(), prompt: z.string(), workflow: z.string().optional() } },
    async (a) => wrap(async () => (await ops.createTask(a)).id),
  );
  server.registerTool('get_task', { description: "Get a task's current view-model.", inputSchema: { taskId: z.string() } }, async (a) => wrap(() => ops.getTask(a.taskId)));
  server.registerTool('list_tasks', { description: 'List tasks in a project.', inputSchema: { projectId: z.string() } }, async (a) => wrap(() => ops.listTasks(a.projectId)));
  server.registerTool(
    'signal_task',
    { description: 'Send a signal to a task (confirm, cancel, retry, or followUp with text). For a followUp, `role` optionally addresses a specific agent (do/merge/resolve); it defaults to the Do agent.', inputSchema: { taskId: z.string(), signal: z.enum(['confirm', 'cancel', 'retry', 'followUp']), text: z.string().optional(), role: z.enum(['do', 'merge', 'resolve']).optional() } },
    async (a) => wrap(async () => { await ops.signalTask(a.taskId, a.signal, a.text, a.role); return 'signalled'; }),
  );
  server.registerTool('reorder_queue', { description: 'Prioritize a task in a merge queue domain.', inputSchema: { domain: z.string(), taskId: z.string() } }, async (a) => wrap(async () => { await ops.reorderQueue(a.domain, a.taskId); return 'reordered'; }));
  server.registerTool('save_skill', { description: 'Save a reusable skill (markdown) for future tasks.', inputSchema: { name: z.string(), content: z.string() } }, async (a) => wrap(() => ops.saveSkill(a)));
  server.registerTool(
    'propose_workflow_edit',
    { description: 'Propose an edit to a workflow repo through the reviewed merge-only PR gate.', inputSchema: { projectId: z.string(), title: z.string(), repo: z.string(), branch: z.string(), target: z.string() } },
    async (a) => wrap(async () => (await ops.proposeWorkflowEdit(a)).id),
  );
  return server;
}
