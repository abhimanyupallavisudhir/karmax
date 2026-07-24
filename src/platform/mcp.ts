import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KarmaxApi, CapabilityError } from './api.js';
import { taskStatus } from '../domain/search.js';
import { PLATFORM_API_CATALOG } from './catalog.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';

/**
 * The platform MCP server (SPEC §3.4) — the single API agents use to act on the
 * system. One server given to every agent; integration is written once because
 * both Claude and Codex speak MCP. Every call is permission-checked (the agent's
 * scoped token gates it) and routed through the same `PlatformOps` whether the
 * server runs in-process (worker) or as a stdio subprocess that forwards to the
 * gateway over HTTP (a CLI agent reading its config home's mcpServers).
 */
export interface PlatformOps {
  createTask(a: { projectId: string; title: string; prompt: string; workflow?: string; wikiContext?: string[] }): Promise<{ id: string }>;
  getTask(taskId: string): Promise<unknown>;
  listTasks(projectId: string): Promise<{ id: string; title: string; workflow: string }[]>;
  searchTasks(projectId: string, query: string): Promise<{ total: number; tasks: CompactTask[] }>;
  listTags(projectId: string): Promise<{ path: string; kind?: string }[]>;
  tagTask(taskId: string, add?: string[], remove?: string[]): Promise<{ tags: string[] }>;
  setTaskPriority(taskId: string, priority: number): Promise<void>;
  signalTask(taskId: string, signal: string, text?: string, role?: string): Promise<void>;
  reorderQueue(domain: string, taskId: string): Promise<void>;
  saveSkill(a: { name: string; content: string }): Promise<unknown>;
  readWiki(scope: 'organization' | 'project', id: string, path?: string): Promise<unknown>;
  searchWiki(scope: 'organization' | 'project', id: string, query: string): Promise<unknown>;
  proposeWorkflowEdit(a: { projectId: string; title: string; repo: string; branch: string; target: string }): Promise<{ id: string }>;
  findTask(projectId: string, num: number): Promise<unknown>;
  listAgents(taskId: string): Promise<unknown>;
  getConversation(taskId: string, role?: string): Promise<unknown>;
  forkAgent(a: { taskId: string; role?: string; title?: string; message: string; authorizationProfile?: string }): Promise<{ id: string }>;
  listEvents(taskId: string, since?: number): Promise<unknown>;
  publishTaskBranch(): Promise<unknown>;
  importTaskBranch(sourceTaskId: string): Promise<unknown>;
  refreshUpstream(branch?: string): Promise<unknown>;
  listWorldProviders(organizationId: string): Promise<unknown>;
  connectWorldProvider(a: { organizationId: string; provider: 'e2b' | 'daytona'; apiKey?: string;
    name?: string; template?: string; snapshot?: string; image?: string; desktopTemplate?: string;
    desktopSnapshot?: string; desktopImage?: string; apiUrl?: string; target?: string }): Promise<unknown>;
  testWorldProvider(organizationId: string, provider: 'e2b' | 'daytona'): Promise<unknown>;
  disconnectWorldProvider(organizationId: string, provider: 'e2b' | 'daytona'): Promise<unknown>;
  getExecutionPolicy(organizationId: string, projectId?: string): Promise<unknown>;
  setExecutionPolicy(a: { organizationId: string; projectId?: string; policy: Record<string, unknown> }): Promise<unknown>;
  /** Complete escape hatch for the documented gateway API; still authz checked. */
  platformRequest(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown>;
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
    status: t.lastView?.status ?? (t.params?.draft ? 'draft' : taskStatus(t)),
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
    signalTask: async (id, sig, text, role) => void (await api.signalTask(getToken(), id, sig as any, text, role)),
    reorderQueue: (domain, id) => api.reorderQueue(getToken(), domain, id),
    saveSkill: (a) => api.saveSkill(getToken(), a) as Promise<unknown>,
    readWiki: async (scope, id, path) => api.readWikiResolved(getToken(), scope, id, path ?? ''),
    searchWiki: async (scope, id, query) => api.searchWikiResolved(getToken(), scope, id, query),
    proposeWorkflowEdit: (a) => api.proposeWorkflowEdit(getToken(), a),
    findTask: (pid, num) => api.findTask(getToken(), pid, num),
    listAgents: (id) => api.listTaskAgents(getToken(), id),
    getConversation: (id, role) => api.taskConversation(getToken(), id, role),
    forkAgent: (a) => api.forkTaskAgent(getToken(), a),
    listEvents: (id, since) => api.taskEvents(getToken(), id, since),
    publishTaskBranch: () => api.publishTaskBranch(getToken()),
    importTaskBranch: (sourceTaskId) => api.importTaskBranch(getToken(), sourceTaskId),
    refreshUpstream: (branch) => api.refreshUpstream(getToken(), branch),
    listWorldProviders: (organizationId) => Promise.resolve(api.listWorldProviderConnections(getToken(), organizationId)),
    connectWorldProvider: (a) => Promise.resolve(api.saveWorldProviderConnection(getToken(), {
      organizationId: a.organizationId, provider: a.provider, apiKey: a.apiKey, name: a.name,
      config: { template: a.template, snapshot: a.snapshot, image: a.image,
        desktopTemplate: a.desktopTemplate, desktopSnapshot: a.desktopSnapshot, desktopImage: a.desktopImage,
        apiUrl: a.apiUrl, target: a.target },
    })),
    testWorldProvider: (organizationId, provider) => api.testWorldProviderConnection(getToken(), organizationId, provider),
    disconnectWorldProvider: (organizationId, provider) => Promise.resolve(api.deleteWorldProviderConnection(getToken(), organizationId, provider)),
    getExecutionPolicy: (organizationId, projectId) => Promise.resolve(api.getExecutionPolicy(getToken(), { organizationId, projectId })),
    setExecutionPolicy: (a) => Promise.resolve(api.setExecutionPolicy(getToken(), a)),
    platformRequest: async () => { throw new Error('generic administration requires the gateway-backed platform MCP'); },
  };
}

/**
 * HTTP ops that forward to the gateway with a bearer token (stdio subprocess).
 *
 * `token` may be a fixed string or a resolver. A resolver lets a CLI-launched
 * bridge acquire a gateway session lazily (see `src/mcp/stdio.ts`) and, on a 401,
 * re-acquire one — the gateway holds sessions in memory, so a gateway restart
 * would otherwise 401 every subsequent call for the life of the agent.
 */
export function httpOps(baseUrl: string, token: string | (() => Promise<string | undefined>)): PlatformOps {
  const resolve = typeof token === 'string' ? async () => token : token;
  let cached: string | undefined = typeof token === 'string' ? token : undefined;
  const req = async (path: string, init: RequestInit = {}, reauth = true): Promise<unknown> => {
    if (!path.startsWith('/api/') || path.startsWith('/api/login') || path.startsWith('/api/setup') || path.startsWith('/api/signup') || path.startsWith('/api/session'))
      throw new Error('platform path must be an authenticated /api/* endpoint');
    if (cached === undefined) cached = await resolve();
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cached ? { authorization: `Bearer ${cached}` } : {}), ...(init.headers ?? {}) },
    });
    // Session expired or the gateway restarted since we last authed — drop the
    // stale token, re-acquire once, and retry before surfacing an error.
    if (res.status === 401 && reauth && typeof token !== 'string') {
      cached = await resolve();
      if (cached) return req(path, init, false);
    }
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
    readWiki: (scope, id, path) => req(`/api/${scope === 'project' ? 'projects' : 'organizations'}/${encodeURIComponent(id)}/wiki?path=${encodeURIComponent(path ?? '')}`),
    searchWiki: (scope, id, query) => req(`/api/${scope === 'project' ? 'projects' : 'organizations'}/${encodeURIComponent(id)}/wiki/search?q=${encodeURIComponent(query)}`),
    proposeWorkflowEdit: (a) => req(`/api/projects/${a.projectId}/propose-workflow-edit`, { method: 'POST', body: JSON.stringify(a) }) as Promise<{ id: string }>,
    findTask: (pid, num) => req(`/api/projects/${pid}/tasks/by-num/${num}`),
    listAgents: (id) => req(`/api/tasks/${id}/agents`),
    getConversation: (id, role) => req(`/api/tasks/${id}/conversation${role ? `?role=${encodeURIComponent(role)}` : ''}`),
    forkAgent: (a) => req(`/api/tasks/${a.taskId}/fork-agent`, { method: 'POST', body: JSON.stringify(a) }) as Promise<{ id: string }>,
    listEvents: (id, since = 0) => req(`/api/tasks/${id}/events?since=${since}`),
    publishTaskBranch: () => req('/api/agent/git/publish', { method: 'POST', body: '{}' }),
    importTaskBranch: (sourceTaskId) => req('/api/agent/git/import', { method: 'POST', body: JSON.stringify({ sourceTaskId }) }),
    refreshUpstream: (branch) => req('/api/agent/git/refresh-upstream', { method: 'POST', body: JSON.stringify({ branch }) }),
    listWorldProviders: (organizationId) => req(`/api/organizations/${organizationId}/world-providers`),
    connectWorldProvider: (a) => req(`/api/organizations/${a.organizationId}/world-providers/${a.provider}`, {
      method: 'PUT', body: JSON.stringify({ apiKey: a.apiKey, name: a.name,
        config: { template: a.template, snapshot: a.snapshot, image: a.image,
          desktopTemplate: a.desktopTemplate, desktopSnapshot: a.desktopSnapshot, desktopImage: a.desktopImage,
          apiUrl: a.apiUrl, target: a.target } }),
    }),
    testWorldProvider: (organizationId, provider) => req(`/api/organizations/${organizationId}/world-providers/${provider}/test`, { method: 'POST', body: '{}' }),
    disconnectWorldProvider: (organizationId, provider) => req(`/api/organizations/${organizationId}/world-providers/${provider}`, { method: 'DELETE' }),
    getExecutionPolicy: (organizationId, projectId) => req(projectId
      ? `/api/projects/${encodeURIComponent(projectId)}/execution-policy`
      : `/api/organizations/${encodeURIComponent(organizationId)}/execution-policy`),
    setExecutionPolicy: (a) => req(a.projectId
      ? `/api/projects/${encodeURIComponent(a.projectId)}/execution-policy`
      : `/api/organizations/${encodeURIComponent(a.organizationId)}/execution-policy`, {
      method: 'PUT', body: JSON.stringify(a.projectId ? { override: a.policy } : { policy: a.policy }),
    }),
    platformRequest: (method, path, body) => req(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
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
    {
      description:
        'Create a new task on a project task list. To inline wiki context into the new task, pass wikiContext: an array of `@proj:…`/`@org:…` tokens — a page (@proj:guides/deploy), a whole label (@proj:tag:security), or a folder (@proj:runbooks/*). Omit it to inherit the default `default`-labelled pages; pass [] to inline none.',
      inputSchema: { projectId: z.string(), title: z.string(), prompt: z.string(), workflow: z.string().optional(), wikiContext: z.array(z.string()).optional() },
    },
    async (a) => wrap(async () => (await ops.createTask(a)).id),
  );
  server.registerTool(
    'list_world_providers',
    { description: 'List the cloud sandbox providers connected to an organization. Credentials are write-only and are never returned.', inputSchema: { organizationId: z.string() } },
    async (a) => wrap(() => ops.listWorldProviders(a.organizationId)),
  );
  server.registerTool(
    'connect_world_provider',
    {
      description: 'Connect or rotate an organization cloud sandbox provider. Requires organization:edit. The API key is stored in the encrypted Karmax vault and never returned.',
      inputSchema: {
        organizationId: z.string(), provider: z.enum(['e2b', 'daytona']), apiKey: z.string().optional(), name: z.string().optional(),
        template: z.string().optional(), snapshot: z.string().optional(), image: z.string().optional(),
        desktopTemplate: z.string().optional(), desktopSnapshot: z.string().optional(), desktopImage: z.string().optional(),
        apiUrl: z.string().url().optional(), target: z.string().optional(),
      },
    },
    async (a) => wrap(() => ops.connectWorldProvider(a)),
  );
  server.registerTool(
    'test_world_provider',
    { description: 'Verify an organization cloud provider credential without creating a billable task world.', inputSchema: { organizationId: z.string(), provider: z.enum(['e2b', 'daytona']) } },
    async (a) => wrap(() => ops.testWorldProvider(a.organizationId, a.provider)),
  );
  server.registerTool(
    'disconnect_world_provider',
    { description: 'Remove an organization cloud provider credential after all worlds using it are gone.', inputSchema: { organizationId: z.string(), provider: z.enum(['e2b', 'daytona']) } },
    async (a) => wrap(() => ops.disconnectWorldProvider(a.organizationId, a.provider)),
  );
  server.registerTool(
    'get_execution_policy',
    { description: 'Read an organization execution policy, or a project override plus its effective inherited policy.', inputSchema: {
      organizationId: z.string(), projectId: z.string().optional(),
    } },
    async (a) => wrap(() => ops.getExecutionPolicy(a.organizationId, a.projectId)),
  );
  server.registerTool(
    'set_execution_policy',
    { description: 'Set organization execution defaults or sparse project overrides. Null project values restore organization inheritance.', inputSchema: {
      organizationId: z.string(), projectId: z.string().optional(),
      worldProvider: z.string().nullish(), runnerPoolId: z.string().nullish(),
      environmentFlavor: z.enum(['headless', 'desktop']).optional(),
      cpu: z.number().positive().optional(), memoryMb: z.number().int().min(128).optional(), gpu: z.number().nonnegative().optional(),
      unrestrictedInternet: z.boolean().optional(), allowDomains: z.array(z.string()).optional(), allowCidrs: z.array(z.string()).optional(),
      monthlyBudgetUsd: z.number().nonnegative().nullish(), hibernateAfterDays: z.number().nonnegative().nullish(),
    } },
    async (a) => wrap(() => {
      const policy: Record<string, unknown> = {};
      if (a.worldProvider !== undefined) policy.worldProvider = a.worldProvider;
      if (a.runnerPoolId !== undefined) policy.runnerPoolId = a.runnerPoolId;
      if (a.environmentFlavor !== undefined) policy.environment = { flavor: a.environmentFlavor };
      if (a.cpu !== undefined || a.memoryMb !== undefined || a.gpu !== undefined)
        policy.resources = { cpu: a.cpu, memoryMb: a.memoryMb, gpu: a.gpu };
      if (a.unrestrictedInternet !== undefined || a.allowDomains !== undefined || a.allowCidrs !== undefined)
        policy.network = { unrestricted: a.unrestrictedInternet ?? false, allowDomains: a.allowDomains, allowCidrs: a.allowCidrs };
      if (a.monthlyBudgetUsd !== undefined) policy.monthlyBudgetMicros = a.monthlyBudgetUsd == null ? null : Math.round(a.monthlyBudgetUsd * 1e6);
      if (a.hibernateAfterDays !== undefined) policy.hibernateAfterMs = a.hibernateAfterDays == null ? null : Math.round(a.hibernateAfterDays * 86_400_000);
      return ops.setExecutionPolicy({ organizationId: a.organizationId, projectId: a.projectId, policy });
    }),
  );
  server.registerTool(
    'find_task',
    { description: 'Find a task by its project and human-facing project-local number (for example projectId + #100).', inputSchema: { projectId: z.string(), number: z.number().int().positive() } },
    async (a) => wrap(() => ops.findTask(a.projectId, a.number)),
  );
  server.registerTool('list_agents', { description: 'Discover every agent role/session attached to a task and its conversation size.', inputSchema: { taskId: z.string() } }, async (a) => wrap(() => ops.listAgents(a.taskId)));
  server.registerTool(
    'get_conversation',
    { description: 'Read the durable message history for one agent attached to a task (do, merge, resolve, or confirm).', inputSchema: { taskId: z.string(), role: z.string().default('do') } },
    async (a) => wrap(() => ops.getConversation(a.taskId, a.role)),
  );
  server.registerTool(
    'fork_agent',
    {
      description: 'Branch an attached agent into a new independent task and native provider session, preserving the source. Use message_agent for later back-and-forth with the fork.',
      inputSchema: { taskId: z.string(), role: z.string().default('do'), message: z.string(), title: z.string().optional(), authorizationProfile: z.string().optional() },
    },
    async (a) => wrap(async () => (await ops.forkAgent(a)).id),
  );
  server.registerTool(
    'message_agent',
    { description: 'Send a follow-up into an attached agent conversation. This works for original or forked tasks and is delivered live when that agent is running.', inputSchema: { taskId: z.string(), role: z.string().default('do'), message: z.string() } },
    async (a) => wrap(async () => { await ops.signalTask(a.taskId, 'followUp', a.message, a.role); return 'message delivered'; }),
  );
  server.registerTool('list_events', { description: 'Read durable karmax events for a task after an optional sequence number.', inputSchema: { taskId: z.string(), since: z.number().int().nonnegative().default(0) } }, async (a) => wrap(() => ops.listEvents(a.taskId, a.since)));
  server.registerTool('publish_task_branch', {
    description: 'Publish this task’s clean, committed branch through Karmax’s trusted Git broker so another agent can import it.', inputSchema: {},
  }, async () => wrap(() => ops.publishTaskBranch()));
  server.registerTool('import_task_branch', {
    description: 'Fetch another task’s published branch into namespaced refs in this world. Inspect/test/cherry-pick or merge it locally afterward.',
    inputSchema: { sourceTaskId: z.string() },
  }, async (a) => wrap(() => ops.importTaskBranch(a.sourceTaskId)));
  server.registerTool('refresh_upstream', {
    description: 'Fetch the latest upstream base/target branch into refs/remotes/origin without placing Git credentials in this world.',
    inputSchema: { branch: z.string().optional() },
  }, async (a) => wrap(() => ops.refreshUpstream(a.branch)));
  server.registerTool(
    'describe_platform',
    { description: 'Describe the complete administrative API available through platform_request.', inputSchema: {} },
    async () => wrap(async () => PLATFORM_API_CATALOG),
  );
  server.registerTool(
    'platform_request',
    {
      description: 'Call any authenticated karmax gateway API operation, including project/account/payment/settings/user/safe-mode/review administration. Call describe_platform first when unsure. This never bypasses authorization.',
      inputSchema: { method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().startsWith('/api/'), body: z.unknown().optional() },
    },
    async (a) => wrap(() => ops.platformRequest(a.method, a.path, a.body)),
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
        'Fields: status (incl. `armed` for trigger-gated tasks), stage, priority, tag (a/b path matches descendants), ' +
        'workflow, created, updated, num, is:<facet> (open/draft/archived/pr/untagged/armed/scheduled/recurring/blocked-on-deps/series/run/…), ' +
        'trigger (dependency|schedule|event|none, groupable), schedule (cron text), nextRun (sortable date), ' +
        'dependsOn:#N / blocks:#N (the dependency graph), and any workflow param via `param.<key>` / `agent_<role>.model`. ' +
        'Add `sort:priority-desc` and `group:tag` to order/bucket. Empty query returns all tasks (runs of a series included — ' +
        'add `-is:run` to hide them). E.g. `is:scheduled sort:nextRun-asc`, `dependsOn:#42`, `is:blocked-on-deps`.',
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
    {
      description: `Send a signal to a task (confirm, cancel, retry, or followUp with text). For a followUp, \`role\` optionally addresses the ${RESOLVE_AGENT_ENABLED ? 'Do, Merge, or Resolve' : 'Do or Merge'} agent; it defaults to the Do agent.`,
      inputSchema: {
        taskId: z.string(),
        signal: z.enum(['confirm', 'cancel', 'retry', 'followUp']),
        text: z.string().optional(),
        role: z.enum(RESOLVE_AGENT_ENABLED ? ['do', 'merge', 'resolve'] : ['do', 'merge']).optional(),
      },
    },
    async (a) => wrap(async () => { await ops.signalTask(a.taskId, a.signal, a.text, a.role); return 'signalled'; }),
  );
  server.registerTool('reorder_queue', { description: 'Prioritize a task in a merge queue domain.', inputSchema: { domain: z.string(), taskId: z.string() } }, async (a) => wrap(async () => { await ops.reorderQueue(a.domain, a.taskId); return 'reordered'; }));
  server.registerTool('save_skill', { description: 'Save a reusable skill (markdown) for future tasks.', inputSchema: { name: z.string(), content: z.string() } }, async (a) => wrap(() => ops.saveSkill(a)));
  server.registerTool(
    'read_wiki',
    {
      description:
        'Navigate an organization or project wiki (skills, memories, prompts). No path → the full table of contents (this also expands any [more…] fold); a section path → that section listed in full; a skill/memory path → its complete markdown plus attached files. Your prompt names the scope ids that apply to your task.',
      inputSchema: { scope: z.enum(['organization', 'project']), id: z.string(), path: z.string().optional() },
    },
    async (a) => wrap(() => ops.readWiki(a.scope, a.id, a.path)),
  );
  server.registerTool(
    'search_wiki',
    {
      description: 'Grep every page of an organization or project wiki with a case-insensitive regular expression; returns file:line matches. Works from any world, including cloud sandboxes.',
      inputSchema: { scope: z.enum(['organization', 'project']), id: z.string(), query: z.string() },
    },
    async (a) => wrap(() => ops.searchWiki(a.scope, a.id, a.query)),
  );
  server.registerTool(
    'propose_workflow_edit',
    { description: 'Propose an edit to a workflow repo through the reviewed merge-only PR gate.', inputSchema: { projectId: z.string(), title: z.string(), repo: z.string(), branch: z.string(), target: z.string() } },
    async (a) => wrap(async () => (await ops.proposeWorkflowEdit(a)).id),
  );
  return server;
}
