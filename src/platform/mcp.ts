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
  searchTasks(projectId: string, query: string): Promise<{ total: number; tasks: CompactTask[] }>;
  listTags(projectId: string): Promise<{ path: string; kind?: string }[]>;
  tagTask(taskId: string, add?: string[], remove?: string[]): Promise<{ tags: string[] }>;
  setTaskPriority(taskId: string, priority: number): Promise<void>;
  signalTask(taskId: string, signal: string, text?: string, role?: string): Promise<void>;
  reorderQueue(domain: string, taskId: string): Promise<void>;
  saveSkill(a: { name: string; content: string }): Promise<unknown>;
  proposeWorkflowEdit(a: { projectId: string; title: string; repo: string; branch: string; target: string }): Promise<{ id: string }>;
}

/** The compact task projection agents get back from search (ids + the human-facing bits). */
export interface CompactTask {
  num?: number;
  id: string;
  title: string;
  workflow: string;
  status: string;
  stage?: string;
  priority: number;
  draft: boolean;
  tags: string[];
}

/** Ordinal priority names (index = stored value); shared so agents can pass a level name. */
export const PRIORITY_NAMES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

// ─── shared projections (tag id → `a/b/c` path; full record → compact) ─────────
function tagPathOf(id: string, byId: Map<string, any>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); parts.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
  return parts.join('/') || id;
}
function tagsById(tags: any[]): Map<string, any> {
  return new Map((tags ?? []).map((t) => [t.id, t]));
}
function compactSearch(result: any, tags: any[]): { total: number; tasks: CompactTask[] } {
  const byId = tagsById(tags);
  const one = (t: any): CompactTask => ({
    num: t.num,
    id: t.id,
    title: t.title,
    workflow: t.workflow,
    status: t.lastView?.status ?? (t.params?.draft ? 'draft' : 'unknown'),
    stage: t.lastView?.stage,
    priority: Number(t.params?.priority ?? 0),
    draft: !!t.params?.draft,
    tags: (t.tags ?? []).map((id: string) => tagPathOf(id, byId)),
  });
  return { total: result?.total ?? 0, tasks: (result?.tasks ?? []).map(one) };
}
function compactTags(tags: any[]): { path: string; kind?: string }[] {
  const byId = tagsById(tags);
  return (tags ?? [])
    .map((t) => ({ path: tagPathOf(t.id, byId), kind: t.kind }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** In-process ops backed by KarmaxApi + the agent's scoped token (worker side). */
export function apiOps(api: KarmaxApi, getToken: () => string): PlatformOps {
  return {
    createTask: (a) => api.createTask(getToken(), a),
    getTask: (id) => api.getTaskView(getToken(), id) as Promise<unknown>,
    listTasks: async (pid) => (await api.listTasks(getToken(), pid)).map((t) => ({ id: t.id, title: t.title, workflow: t.workflow })),
    searchTasks: async (pid, query) => {
      const [result, tags] = await Promise.all([api.searchTasks(getToken(), pid, query), api.listTags(getToken(), pid)]);
      return compactSearch(result, tags);
    },
    listTags: async (pid) => compactTags(await api.listTags(getToken(), pid)),
    tagTask: (id, add, remove) => api.tagTask(getToken(), id, { add, remove }),
    setTaskPriority: (id, priority) => api.setTaskPriority(getToken(), id, priority),
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
    searchTasks: async (pid, query) => {
      const [result, tags] = await Promise.all([req(`/api/projects/${pid}/search?q=${encodeURIComponent(query)}`), req(`/api/projects/${pid}/tags`)]);
      return compactSearch(result, tags as any[]);
    },
    listTags: async (pid) => compactTags((await req(`/api/projects/${pid}/tags`)) as any[]),
    tagTask: (id, add, remove) => req(`/api/tasks/${id}/tag`, { method: 'POST', body: JSON.stringify({ add, remove }) }) as Promise<{ tags: string[] }>,
    setTaskPriority: async (id, priority) => void (await req(`/api/tasks/${id}/priority`, { method: 'PUT', body: JSON.stringify({ priority }) })),
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
    'search_tasks',
    {
      description:
        'Search/organize a project\'s tasks with a Linear-style query and get back a compact list (num, title, status, priority, tags). ' +
        'Query grammar: `field:value` clauses AND together, commas = OR (`status:active,waiting`), `-` negates (`-tag:bug`), ' +
        'comparisons on numbers/dates (`priority:>=2`, `created:<7d`), quoted phrases, and bare words = full text. ' +
        'Fields: status, stage, priority, tag (a/b path matches descendants), workflow, created, updated, num, is:<facet> ' +
        '(open/draft/archived/pr/untagged/…), and any workflow param via `param.<key>` (e.g. `param.base:main`). ' +
        'Add `sort:priority-desc` and `group:tag` to order/bucket. Empty query returns all tasks.',
      inputSchema: { projectId: z.string(), query: z.string().default('') },
    },
    async (a) => wrap(() => ops.searchTasks(a.projectId, a.query ?? '')),
  );
  server.registerTool('list_tags', { description: 'List a project\'s tag catalogue as `a/b/c` paths (with kind: type|topic).', inputSchema: { projectId: z.string() } }, async (a) => wrap(() => ops.listTags(a.projectId)));
  server.registerTool(
    'tag_task',
    {
      description:
        'Add and/or remove tags on a task, by name or `a/b` path. Tags are purely organizational (labels like bug/feature and ' +
        'topics like frontend/auth) — never sent to any agent. A name in `add` that does not exist is created (a slash path builds ' +
        'the hierarchy, reusing existing parents); a `remove` name that is not present is ignored. Returns the resulting tag paths.',
      inputSchema: { taskId: z.string(), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() },
    },
    async (a) => wrap(() => ops.tagTask(a.taskId, a.add, a.remove)),
  );
  server.registerTool(
    'set_task_priority',
    { description: 'Set a task\'s organizational priority (none/low/medium/high/urgent) — for search/sorting only, never sent to any agent.', inputSchema: { taskId: z.string(), priority: z.enum(PRIORITY_NAMES) } },
    async (a) => wrap(async () => { await ops.setTaskPriority(a.taskId, PRIORITY_NAMES.indexOf(a.priority)); return `priority set to ${a.priority}`; }),
  );
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
