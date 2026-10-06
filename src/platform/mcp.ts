import type { GithubActionsInspectOptions } from '../integrations/github-actions.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KarmaxApi, CapabilityError } from './api.js';
import { PLATFORM_API_CATALOG } from './catalog.js';
import { URGENCY_LEVELS, type AgentSpec, type Provider, type Urgency } from '../domain/types.js';
import {
  AGENT_ROLE_NAMES, PLATFORM_REQUEST_BODY_SCHEMA, PLATFORM_REQUEST_EXCLUDED_PATHS,
  PRIORITY_NAMES, compactSearch, compactOrganizationSearch, compactTags, normalizePlatformPath, normalizeRequestBody,
  platformRequestPathError,
  type CompactTask,
} from './platform-request.js';
import { BRAND } from '../domain/brand.js';

// Re-exported so the platform MCP module stays the one place a reader looks for
// the agent-facing contract; `src/agent/tools.ts` imports the same definitions
// from the leaf module (see platform-request.ts for why it cannot import here).
export {
  AGENT_ROLE_NAMES, PLATFORM_REQUEST_BODY_SCHEMA, PLATFORM_REQUEST_EXCLUDED_PATHS,
  PRIORITY_NAMES, compactSearch, compactTags, normalizePlatformPath, normalizeRequestBody,
  platformRequestPathError,
  type CompactTask,
};

/**
 * The platform MCP server (SPEC §3.4) — the single API agents use to act on the
 * system. One server given to every agent; integration is written once because
 * both Claude and Codex speak MCP. Every call is permission-checked (the agent's
 * scoped token gates it) and routed through the same `PlatformOps` whether the
 * server runs in-process (worker) or as a stdio subprocess that forwards to the
 * gateway over HTTP (a CLI agent reading its config home's mcpServers).
 */
export interface PlatformOps {
  createTask(a: { projectId: string; title: string; prompt: string; workflow?: string; wikiContext?: string[];
    /** Save on the list without starting it (SPEC §10.4 drafts). */
    draft?: boolean;
    /** Ordinal priority, index into PRIORITY_NAMES. */
    priority?: number;
    /** Tag names or `a/b` paths, created on demand (same rules as tag_task). */
    tags?: string[];
    /** Full task-form field values, including trigger definitions. */
    params?: Record<string, unknown> }): Promise<{ id: string }>;
  getTask(taskId: string): Promise<unknown>;
  listTasks(projectId: string): Promise<{ id: string; title: string; workflow: string }[]>;
  searchTasks(projectId: string, query: string): Promise<{ total: number; tasks: CompactTask[] }>;
  /** The organization task list: every project of it the caller can read. */
  searchOrganizationTasks(organizationId: string, query: string): Promise<{ total: number; tasks: CompactTask[] }>;
  listTags(projectId: string): Promise<{ path: string; kind?: string; description?: string }[]>;
  tagTask(taskId: string, add?: string[], remove?: string[]): Promise<{ tags: string[] }>;
  setTaskPriority(taskId: string, priority: number): Promise<void>;
  signalTask(taskId: string, signal: string, text?: string, role?: string, otherAttempts?: 'keep' | 'cancel', saveOtherAttemptsDefault?: boolean): Promise<void>;
  messageAgent(taskId: string, text: string, role?: string): Promise<void>;
  escalateToHuman(a: { audience: string[]; message: string; urgency?: Urgency }): Promise<unknown>;
  requestPermission(a: { capabilities: string[]; audience: string[]; reason: string; urgency?: Urgency }): Promise<unknown>;
  requestAgentAction(a: { taskId: string; role?: string; action: 'publish_branch'; message?: string }): Promise<unknown>;
  cancelAgentAction(requestId: string): Promise<unknown>;
  reorderQueue(domain: string, taskId: string): Promise<void>;
  saveSkill(a: { name: string; content: string }): Promise<unknown>;
  readWiki(scope: 'organization' | 'project', id: string, path?: string): Promise<unknown>;
  searchWiki(scope: 'organization' | 'project', id: string, query: string): Promise<unknown>;
  proposeWorkflowEdit(a: { projectId: string; title: string; repo: string; branch: string; target: string }): Promise<{ id: string }>;
  findTask(projectId: string, num: number): Promise<unknown>;
  listAgents(taskId: string): Promise<unknown>;
  getConversation(taskId: string, role?: string): Promise<unknown>;
  forkAgent(a: { taskId: string; role?: string; title?: string; message: string; base?: string; authorizationProfile?: string;
    reauthorize?: boolean; target?: string; provider?: Provider; model?: string; effort?: AgentSpec['effort'] }): Promise<{ id: string }>;
  listEvents(taskId: string, since?: number): Promise<unknown>;
  listGithubActionsRuns(a: { repository?: string; branch?: string; event?: string; status?: string;
    workflow?: string | number; page?: number; perPage?: number }): Promise<unknown>;
  listGithubActionsWorkflows(a: { repository?: string; page?: number; perPage?: number }): Promise<unknown>;
  inspectGithubActionsRun(a: { repository?: string; runId: number } & GithubActionsInspectOptions): Promise<unknown>;
  manageGithubActionsRun(a: { repository?: string; runId: number; action: 'rerun-failed' | 'rerun' | 'cancel' }): Promise<unknown>;
  dispatchGithubActionsWorkflow(a: { repository?: string; workflow: string | number; ref: string;
    inputs?: Record<string, string | number | boolean> }): Promise<unknown>;
  publishTaskBranch(): Promise<unknown>;
  importTaskBranch(sourceTaskId: string): Promise<unknown>;
  refreshUpstream(branch?: string): Promise<unknown>;
  proposeProjectResource(a: { source: { kind: 'path'; path: string } | { kind: 'vault-item'; itemId: string; field?: string };
    name: string; driver?: 'volume@1' | 'object-tree@1' | 'secret@1' | 'service@1' | 'database@1';
    target: { kind: 'path'; path: string } | { kind: 'environment' | 'service'; name: string };
    access?: 'read' | 'write'; publish?: 'discard' | 'review' }): Promise<unknown>;
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

/**
 * A gateway response that was not 2xx, carrying the status so the agent-facing
 * error can say *why* (403 escalate, 404 retry with another id, 5xx back off).
 */
export class PlatformHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'PlatformHttpError';
  }
}

/** In-process ops backed by KarmaxApi + the agent's scoped token (worker side). */
export function apiOps(api: KarmaxApi, getToken: () => string): PlatformOps {
  return {
    // `priority`/`tags` go through `createTask` itself rather than as follow-up
    // edits: the follow-ups needed `task:edit`, which the bundled Do role does
    // not hold, so a tagged create half-succeeded and then reported a permission
    // error for a task that already existed.
    createTask: (a) => api.createTask(getToken(), a),
    getTask: (id) => api.getTaskView(getToken(), id) as Promise<unknown>,
    listTasks: async (pid) => (await api.listTaskSummaries(getToken(), pid)).map((t) => ({ id: t.id, title: t.title, workflow: t.workflow })),
    searchTasks: async (pid, query) => {
      const [result, tags] = await Promise.all([api.searchTasks(getToken(), pid, query), api.listTags(getToken(), pid)]);
      return compactSearch(result, tags);
    },
    searchOrganizationTasks: async (organizationId, query) => {
      return compactOrganizationSearch(await api.searchOrganizationTasks(getToken(), organizationId, query));
    },
    listTags: async (pid) => compactTags(await api.listTags(getToken(), pid)),
    tagTask: (id, add, remove) => api.tagTask(getToken(), id, { add, remove }),
    setTaskPriority: (id, priority) => api.setTaskPriority(getToken(), id, priority),
    signalTask: async (id, sig, text, role, otherAttempts, saveOtherAttemptsDefault) => void (await api.signalTask(getToken(), id, sig as any, text, role, undefined, undefined, { otherAttempts, saveOtherAttemptsDefault })),
    messageAgent: async (id, text, role) => void (await api.messageAgent(getToken(), id, text, role)),
    escalateToHuman: (a) => api.escalateToHuman(getToken(), a),
    requestPermission: (a) => api.requestPermission(getToken(), a),
    requestAgentAction: (a) => api.requestAgentAction(getToken(), a),
    cancelAgentAction: (requestId) => api.cancelAgentAction(getToken(), requestId),
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
    listGithubActionsRuns: (a) => api.listGithubActionsRuns(getToken(), a as any),
    listGithubActionsWorkflows: (a) => api.listGithubActionsWorkflows(getToken(), a),
    inspectGithubActionsRun: (a) => api.inspectGithubActionsRun(getToken(), a),
    manageGithubActionsRun: (a) => api.manageGithubActionsRun(getToken(), a),
    dispatchGithubActionsWorkflow: (a) => api.dispatchGithubActionsWorkflow(getToken(), a),
    publishTaskBranch: () => api.publishTaskBranch(getToken()),
    importTaskBranch: (sourceTaskId) => api.importTaskBranch(getToken(), sourceTaskId),
    refreshUpstream: (branch) => api.refreshUpstream(getToken(), branch),
    proposeProjectResource: (a) => api.proposeProjectResource(getToken(), a),
    listWorldProviders: async (organizationId) => Promise.resolve((await api.listWorldProviderConnections(getToken(), organizationId))),
    connectWorldProvider: async (a) => Promise.resolve((await api.saveWorldProviderConnection(getToken(), {
      organizationId: a.organizationId, provider: a.provider, apiKey: a.apiKey, name: a.name,
      config: { template: a.template, snapshot: a.snapshot, image: a.image,
        desktopTemplate: a.desktopTemplate, desktopSnapshot: a.desktopSnapshot, desktopImage: a.desktopImage,
        apiUrl: a.apiUrl, target: a.target },
    }))),
    testWorldProvider: (organizationId, provider) => api.testWorldProviderConnection(getToken(), organizationId, provider),
    disconnectWorldProvider: async (organizationId, provider) => Promise.resolve((await api.deleteWorldProviderConnection(getToken(), organizationId, provider))),
    getExecutionPolicy: async (organizationId, projectId) => Promise.resolve((await api.getExecutionPolicy(getToken(), { organizationId, projectId }))),
    setExecutionPolicy: async (a) => Promise.resolve((await api.setExecutionPolicy(getToken(), a))),
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
  const req = async (rawPath: string, init: RequestInit = {}, reauth = true): Promise<unknown> => {
    const rejected = platformRequestPathError(rawPath);
    if (rejected) throw new Error(rejected);
    // Dispatch exactly what was screened, never the raw string — see
    // `normalizePlatformPath` for the traversal this closes.
    const path = normalizePlatformPath(rawPath);
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
    // Keep the HTTP status: an agent needs to tell 403 (escalate / ask for a
    // capability) from 404 (wrong id — retry with a different one) from 5xx
    // (transient — back off). Flattening everything to the message alone made
    // every failure look the same.
    if (!res.ok) throw new PlatformHttpError(res.status, (body as any)?.error || `HTTP ${res.status}`);
    return body;
  };
  return {
    createTask: async (a) => {
      const { priority, tags, ...create } = a;
      const task = await req(`/api/projects/${a.projectId}/tasks`, { method: 'POST', body: JSON.stringify(create) }) as { id: string };
      if (priority) await req(`/api/tasks/${task.id}/priority`, { method: 'PUT', body: JSON.stringify({ priority }) });
      if (tags?.length) await req(`/api/tasks/${task.id}/tag`, { method: 'POST', body: JSON.stringify({ add: tags }) });
      return task;
    },
    getTask: (id) => req(`/api/tasks/${id}`),
    listTasks: (pid) => req(`/api/projects/${pid}/tasks`) as Promise<{ id: string; title: string; workflow: string }[]>,
    searchTasks: async (pid, query) => {
      const [result, tags] = await Promise.all([req(`/api/projects/${pid}/search?q=${encodeURIComponent(query)}`), req(`/api/projects/${pid}/tags`)]);
      return compactSearch(result, tags as any[]);
    },
    searchOrganizationTasks: async (organizationId, query) => {
      return compactOrganizationSearch(await req(`/api/organizations/${encodeURIComponent(organizationId)}/search?q=${encodeURIComponent(query)}`) as { tags?: unknown[] });
    },
    listTags: async (pid) => compactTags((await req(`/api/projects/${pid}/tags`)) as any[]),
    tagTask: (id, add, remove) => req(`/api/tasks/${id}/tag`, { method: 'POST', body: JSON.stringify({ add, remove }) }) as Promise<{ tags: string[] }>,
    setTaskPriority: async (id, priority) => void (await req(`/api/tasks/${id}/priority`, { method: 'PUT', body: JSON.stringify({ priority }) })),
    signalTask: async (id, signal, text, role, otherAttempts, saveOtherAttemptsDefault) => void (await req(`/api/tasks/${id}/signal`, { method: 'POST', body: JSON.stringify({ signal, text, role, otherAttempts, saveOtherAttemptsDefault }) })),
    messageAgent: async (id, text, role) => void (await req(`/api/tasks/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, role }) })),
    escalateToHuman: (a) => req('/api/agent/escalate', { method: 'POST', body: JSON.stringify(a) }),
    requestPermission: (a) => req('/api/agent/permission-requests', { method: 'POST', body: JSON.stringify(a) }),
    requestAgentAction: (a) => req('/api/agent/collaboration/request', { method: 'POST', body: JSON.stringify(a) }),
    cancelAgentAction: (requestId) => req(`/api/agent/collaboration/${encodeURIComponent(requestId)}/cancel`, {
      method: 'POST', body: '{}',
    }),
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
    listGithubActionsRuns: (a) => {
      const query = new URLSearchParams();
      if (a.repository) query.set('repository', a.repository);
      if (a.branch) query.set('branch', a.branch);
      if (a.event) query.set('event', a.event);
      if (a.status) query.set('status', a.status);
      if (a.workflow !== undefined) query.set('workflow', String(a.workflow));
      if (a.page !== undefined) query.set('page', String(a.page));
      if (a.perPage !== undefined) query.set('perPage', String(a.perPage));
      return req(`/api/agent/github/actions/runs?${query}`);
    },
    listGithubActionsWorkflows: (a) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(a)) if (value !== undefined) query.set(key, String(value));
      return req(`/api/agent/github/actions/workflows?${query}`);
    },
    inspectGithubActionsRun: (a) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(a)) if (key !== 'runId' && value !== undefined) query.set(key, String(value));
      return req(`/api/agent/github/actions/runs/${a.runId}?${query}`);
    },
    manageGithubActionsRun: (a) => req(`/api/agent/github/actions/runs/${a.runId}`, {
      method: 'POST', body: JSON.stringify({ repository: a.repository, action: a.action }),
    }),
    dispatchGithubActionsWorkflow: (a) => req('/api/agent/github/actions/dispatch', {
      method: 'POST', body: JSON.stringify(a),
    }),
    publishTaskBranch: () => req('/api/agent/git/publish', { method: 'POST', body: '{}' }),
    importTaskBranch: (sourceTaskId) => req('/api/agent/git/import', { method: 'POST', body: JSON.stringify({ sourceTaskId }) }),
    refreshUpstream: (branch) => req('/api/agent/git/refresh-upstream', { method: 'POST', body: JSON.stringify({ branch }) }),
    proposeProjectResource: (a) => req('/api/agent/resource-candidates', { method: 'POST', body: JSON.stringify(a) }),
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
      // Preserve the distinction the agent has to act on: denied (fix the
      // authorization), not found (fix the identifier), or a server fault (retry).
      // The status may come from the gateway (PlatformHttpError) or from an
      // in-process platform error that declares its own (CapabilityError,
      // NotFoundError, ValidationError) — both surfaces must read alike.
      const status = e instanceof PlatformHttpError ? e.status
        : typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined;
      const msg = e instanceof CapabilityError || status === 403
        ? `permission denied: ${(e as Error).message}`
        : `error${status ? ` (HTTP ${status})` : ''}: ${String((e as Error).message ?? e)}`;
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
  };

  server.registerTool(
    'create_task',
    {
      description:
        'Create a new task on a project task list. It is queued and started immediately unless `draft` is true. '
        + '`params` carries the full task-form field values for the chosen workflow (including `triggers`, so a draft can be armed on a schedule/dependency/event); '
        + '`tags` accepts names or `a/b` paths and creates missing ones. '
        + 'To inline wiki context into the new task, pass wikiContext: an array of `[[proj:…]]`/`[[org:…]]` references — a page ([[proj:guides/deploy]]), a whole label ([[proj:tag:security]]), or a folder ([[proj:runbooks/*]]). Omit it to inherit the default `default`-labelled pages; pass [] to inline none.',
      inputSchema: {
        projectId: z.string(), title: z.string(), prompt: z.string(), workflow: z.string().optional(),
        wikiContext: z.array(z.string()).optional(),
        draft: z.boolean().optional(),
        priority: z.enum(PRIORITY_NAMES).optional(),
        tags: z.array(z.string()).optional(),
        params: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (a) => wrap(async () => (await ops.createTask({
      ...a, priority: a.priority ? PRIORITY_NAMES.indexOf(a.priority) : undefined,
    })).id),
  );
  server.registerTool(
    'list_world_providers',
    { description: 'List the cloud sandbox providers connected to an organization. Credentials are write-only and are never returned.', inputSchema: { organizationId: z.string() } },
    async (a) => wrap(async () => (await ops.listWorldProviders(a.organizationId))),
  );
  server.registerTool(
    'connect_world_provider',
    {
      description: `Connect or rotate an organization cloud sandbox provider. Requires organization:edit. The API key is stored in the encrypted ${BRAND} vault and never returned.`,
      inputSchema: {
        organizationId: z.string(), provider: z.enum(['e2b', 'daytona']), apiKey: z.string().optional(), name: z.string().optional(),
        template: z.string().optional(), snapshot: z.string().optional(), image: z.string().optional(),
        desktopTemplate: z.string().optional(), desktopSnapshot: z.string().optional(), desktopImage: z.string().optional(),
        apiUrl: z.string().url().optional(), target: z.string().optional(),
      },
    },
    async (a) => wrap(async () => (await ops.connectWorldProvider(a))),
  );
  server.registerTool(
    'test_world_provider',
    { description: 'Verify an organization cloud provider credential without creating a billable task world.', inputSchema: { organizationId: z.string(), provider: z.enum(['e2b', 'daytona']) } },
    async (a) => wrap(async () => (await ops.testWorldProvider(a.organizationId, a.provider))),
  );
  server.registerTool(
    'disconnect_world_provider',
    { description: 'Remove an organization cloud provider credential after all worlds using it are gone.', inputSchema: { organizationId: z.string(), provider: z.enum(['e2b', 'daytona']) } },
    async (a) => wrap(async () => (await ops.disconnectWorldProvider(a.organizationId, a.provider))),
  );
  server.registerTool(
    'get_execution_policy',
    { description: 'Read an organization execution policy, or a project override plus its effective inherited policy.', inputSchema: {
      organizationId: z.string(), projectId: z.string().optional(),
    } },
    async (a) => wrap(async () => (await ops.getExecutionPolicy(a.organizationId, a.projectId))),
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
    async (a) => wrap(async () => {
      const policy: Record<string, unknown> = {};
      if (a.worldProvider !== undefined) policy.worldProvider = a.worldProvider;
      if (a.runnerPoolId !== undefined) policy.runnerPoolId = a.runnerPoolId;
      if (a.environmentFlavor !== undefined) policy.environment = { flavor: a.environmentFlavor };
      if (a.monthlyBudgetUsd !== undefined) policy.monthlyBudgetMicros = a.monthlyBudgetUsd == null ? null : Math.round(a.monthlyBudgetUsd * 1e6);
      if (a.hibernateAfterDays !== undefined) policy.hibernateAfterMs = a.hibernateAfterDays == null ? null : Math.round(a.hibernateAfterDays * 86_400_000);

      // `network` is REPLACED wholesale by the store and `resources` is merged by
      // spread (so an explicit `undefined` erases the stored value). This tool
      // advertises *sparse* updates, so a partial change has to be merged against
      // the policy currently in force: otherwise `{allowDomains}` alone silently
      // set `unrestricted:false` and dropped `allowCidrs`, and `{memoryMb}` alone
      // erased `cpu`/`gpu`. Only keys the caller actually supplied are assigned.
      const wantsResources = a.cpu !== undefined || a.memoryMb !== undefined || a.gpu !== undefined;
      const wantsNetwork = a.unrestrictedInternet !== undefined || a.allowDomains !== undefined || a.allowCidrs !== undefined;
      if (wantsResources || wantsNetwork) {
        // Either `{organization, override?, effective?}` or a bare policy — see below.
        const current = await ops.getExecutionPolicy(a.organizationId, a.projectId).catch(() => undefined) as
          Record<string, any> | undefined;
        // A project call edits its own sparse override, never the org defaults.
        // The org read comes back in one of TWO shapes and both must work:
        // `apiOps` (and the gateway's project route) wrap it as `{organization}`,
        // but the gateway's org route — GET /api/organizations/:id/execution-policy
        // in src/gateway/server.ts — returns the BARE policy object. Reading only
        // `.organization` made the base `{}` on `httpOps`, which is the only
        // production wiring (src/mcp/stdio.ts): the merge then silently discarded
        // the policy in force, so an org-scoped `{allowDomains}` cleared
        // `unrestricted` and dropped `allowCidrs` (the store replaces `network`
        // wholesale) — exactly what the sparse merge exists to prevent.
        const base = (a.projectId ? current?.override : (current?.organization ?? current)) ?? {};
        if (wantsResources) {
          const resources: Record<string, unknown> = { ...(base.resources ?? {}) };
          if (a.cpu !== undefined) resources.cpu = a.cpu;
          if (a.memoryMb !== undefined) resources.memoryMb = a.memoryMb;
          if (a.gpu !== undefined) resources.gpu = a.gpu;
          policy.resources = resources;
        }
        if (wantsNetwork) {
          const network: Record<string, unknown> = { ...(base.network ?? {}) };
          if (a.unrestrictedInternet !== undefined) network.unrestricted = a.unrestrictedInternet;
          if (a.allowDomains !== undefined) network.allowDomains = a.allowDomains;
          if (a.allowCidrs !== undefined) network.allowCidrs = a.allowCidrs;
          policy.network = network;
        }
      }
      return (await ops.setExecutionPolicy({ organizationId: a.organizationId, projectId: a.projectId, policy }));
    }),
  );
  server.registerTool(
    'find_task',
    { description: 'Resolve a human-facing project-local task number (for example projectId + #100) to its canonical id. Returns a pointer `{id, num, projectId}` — pass that id to get_task for the task itself.', inputSchema: { projectId: z.string(), number: z.number().int().positive() } },
    async (a) => wrap(async () => (await ops.findTask(a.projectId, a.number))),
  );
  server.registerTool('list_agents', { description: 'Discover every agent role/session attached to a task and its conversation size.', inputSchema: { taskId: z.string() } }, async (a) => wrap(async () => (await ops.listAgents(a.taskId))));
  server.registerTool(
    'get_conversation',
    { description: `Read the durable message history for one agent attached to a task (${AGENT_ROLE_NAMES.join(', ')}). Call list_agents first to see which roles this task actually has.`, inputSchema: { taskId: z.string(), role: z.enum(AGENT_ROLE_NAMES).default('do') } },
    async (a) => wrap(async () => (await ops.getConversation(a.taskId, a.role))),
  );
  server.registerTool(
    'fork_agent',
    {
      description: 'Branch an attached agent into a new independent task, optionally with a different provider/model. Defaults to the source task branch and unpublished checkpoint, or its merge target after landing. Set base to another branch for normal project initialization. The source remains untouched. Use message_agent for later back-and-forth with the fork. reauthorize=true starts the fork with the grants the source task ended with (its authorization level/scope and approved vault credentials) instead of the project default; the grant is checked against your own authority like any new task.',
      inputSchema: {
        taskId: z.string(), role: z.string().default('do'), message: z.string(), title: z.string().optional(),
        base: z.string().optional(), target: z.string().optional(), authorizationProfile: z.string().optional(), reauthorize: z.boolean().optional(),
        provider: z.enum(['claude', 'codex', 'opencode', 'kimi', 'grok', 'mock']).optional(),
        model: z.string().optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      },
    },
    async (a) => wrap(async () => (await ops.forkAgent(a)).id),
  );
  server.registerTool(
    'message_agent',
    { description: `Send a follow-up into an attached agent conversation (${AGENT_ROLE_NAMES.join(', ')}). This works for original or forked tasks and is delivered live when that agent is running.`, inputSchema: { taskId: z.string(), role: z.enum(AGENT_ROLE_NAMES).default('do'), message: z.string() } },
    async (a) => wrap(async () => { await ops.messageAgent(a.taskId, a.message, a.role); return 'message delivered'; }),
  );
  server.registerTool(
    'escalate_to_human',
    {
      description:
        'Pause your current task at its exact stage and request input from selected people, teams, or Avatars. ' +
        'Audience selectors: avatar:<id>, user:<id>, @team:<slug>, @creator, @owners, @project, or @all. ' +
        'Discover valid choices with platform_request GET /api/agent/escalation-targets. ' +
        'Calling this stops the current turn; the task resumes when a selected principal responds. ' +
        'urgency orders the human\'s inbox and decides whether their device alerts them: use high only when the ' +
        'person is genuinely blocking progress, and critical only for something that goes wrong if it waits.',
      inputSchema: {
        audience: z.array(z.string()).min(1).max(32),
        message: z.string().trim().min(1).max(4_000),
        urgency: z.enum(URGENCY_LEVELS as [Urgency, ...Urgency[]]).optional(),
      },
    },
    async (a) => wrap(async () => (await ops.escalateToHuman(a))),
  );
  server.registerTool(
    'request_permission',
    {
      description:
        'Request exact capabilities and/or additional projectIds for this task. Project expansion retains existing projects and applies the task authorization in added projects. The request appears in the task Approval Requests tab ' +
        'and is routed to selected people, teams, or Avatars. Audience selectors: avatar:<id>, user:<id>, @team:<slug>, @creator, @owners, ' +
        '@project, or @all. Discover valid choices with platform_request GET /api/agent/escalation-targets. ' +
        'Only a selected principal that already holds the requested capabilities and can grant the full task authorization across the expanded scope can approve; approval resumes the task ' +
        'with a newly scoped token. Do not request wildcards. Approval requests are high urgency by default; ' +
        'pass urgency to raise or lower how loudly the human is alerted.',
      inputSchema: {
        capabilities: z.array(z.string().trim().min(1)).max(32),
        projectIds: z.array(z.string().trim().min(1)).max(32).optional(),
        audience: z.array(z.string().trim().min(1)).min(1).max(32),
        reason: z.string().trim().min(1).max(4_000),
        urgency: z.enum(URGENCY_LEVELS as [Urgency, ...Urgency[]]).optional(),
      },
    },
    async (a) => wrap(async () => (await ops.requestPermission(a))),
  );
  server.registerTool(
    'request_agent_action',
    {
      description: `Ask another task agent to publish its branch in the background. Returns immediately with a durable request id; ${BRAND} injects completion or failure into this agent automatically. Continue other work and do not poll.`,
      inputSchema: {
        taskId: z.string(), role: z.string().default('do'),
        action: z.literal('publish_branch'), message: z.string().optional(),
      },
    },
    async (a) => wrap(async () => (await ops.requestAgentAction(a))),
  );
  server.registerTool(
    'cancel_agent_action',
    {
      description: 'Withdraw one pending background collaboration requested by this task. Use this when the target is blocked or its result is no longer needed; the target task itself is not cancelled.',
      inputSchema: { requestId: z.string() },
    },
    async (a) => wrap(async () => (await ops.cancelAgentAction(a.requestId))),
  );
  server.registerTool('list_events', { description: `Read durable ${BRAND} events for a task after an optional sequence number.`, inputSchema: { taskId: z.string(), since: z.number().int().nonnegative().default(0) } }, async (a) => wrap(async () => (await ops.listEvents(a.taskId, a.since))));
  server.registerTool('list_github_actions_runs', {
    description: 'List GitHub Actions workflow runs for a repository attached to the calling task’s project. The GitHub credential remains in the control plane.',
    inputSchema: {
      repository: z.string().optional(), branch: z.string().optional(), event: z.string().optional(),
      status: z.enum(['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale',
        'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending']).optional(),
      workflow: z.union([z.string(), z.number().int().positive()]).optional(),
      page: z.number().int().min(1).max(1000).optional(), perPage: z.number().int().min(1).max(100).optional(),
    },
  }, async (a) => wrap(async () => (await ops.listGithubActionsRuns(a))));
  server.registerTool('list_github_actions_workflows', {
    description: 'Discover workflow ids, paths and enabled states for an attached repository. Requires github:actions:read.',
    inputSchema: { repository: z.string().optional(), page: z.number().int().min(1).max(1000).optional(),
      perPage: z.number().int().min(1).max(100).optional() },
  }, async (a) => wrap(async () => (await ops.listGithubActionsWorkflows(a))));
  server.registerTool('inspect_github_actions_run', {
    description: 'Inspect Actions evidence with read authority. Default failure diagnostics; jobs/artifacts are paginated. log selects any job conclusion by jobId and attempt, returning bounded tail output; annotations selects job check diagnostics; pending-deployments shows current approval waits. Check tailComplete/truncation flags. Run headSha or success/skipped does not prove deployment; correlate explicit target, readiness, completion and rollback evidence. Tokens and signed URLs never returned.',
    inputSchema: { repository: z.string().optional(), runId: z.number().int().positive(),
      view: z.enum(['failure', 'jobs', 'log', 'artifacts', 'annotations', 'pending-deployments']).optional(),
      attempt: z.number().int().positive().optional(), jobId: z.number().int().positive().optional(),
      page: z.number().int().min(1).max(1000).optional(), perPage: z.number().int().min(1).max(100).optional(),
      offsetLines: z.number().int().min(0).max(1000000).optional(),
      tailLines: z.number().int().min(1).max(500).optional(), maxChars: z.number().int().min(256).max(32000).optional(),
    },
  }, async (a) => wrap(async () => (await ops.inspectGithubActionsRun(a))));
  server.registerTool('manage_github_actions_run', {
    description: 'Rerun failed jobs, rerun an entire run, or cancel a run in a repository attached to this task’s project. Requires separately approved GitHub Actions write authority.',
    inputSchema: { repository: z.string().optional(), runId: z.number().int().positive(), action: z.enum(['rerun-failed', 'rerun', 'cancel']) },
  }, async (a) => wrap(async () => (await ops.manageGithubActionsRun(a))));
  server.registerTool('dispatch_github_actions_workflow', {
    description: 'Dispatch a workflow on a ref in a repository attached to this task’s project. Requires separately approved GitHub Actions write authority.',
    inputSchema: { repository: z.string().optional(), workflow: z.union([z.string(), z.number().int().positive()]),
      ref: z.string(), inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() },
  }, async (a) => wrap(async () => (await ops.dispatchGithubActionsWorkflow(a))));
  server.registerTool('publish_task_branch', {
    description: `Publish this task’s clean, committed branch through ${BRAND}’s trusted Git broker so another agent can import it.`, inputSchema: {},
  }, async () => wrap(async () => (await ops.publishTaskBranch())));
  server.registerTool('import_task_branch', {
    description: 'Fetch another task’s published branch into namespaced refs in this world. Inspect/test/cherry-pick or merge it locally afterward.',
    inputSchema: { sourceTaskId: z.string() },
  }, async (a) => wrap(async () => (await ops.importTaskBranch(a.sourceTaskId))));
  server.registerTool('refresh_upstream', {
    description: 'Fetch the latest upstream base/target branch into refs/remotes/origin without placing Git credentials in this world. Returns refreshed refs plus per-repository skipped/errors diagnostics for any partial failure.',
    inputSchema: { branch: z.string().optional() },
  }, async (a) => wrap(async () => (await ops.refreshUpstream(a.branch))));
  server.registerTool('verify_resource_revision', {
    description: 'Read and decrypt an exact historical project resource snapshot on the server. Requires project:settings:read for projectId. Returns validated root digest/totals and bounded per-file SHA256/byte evidence; no keys, object refs or plaintext. Reads at most 1000 files and 256 MiB per page (default 100 files). Follow nextOffset on the same revision; status complete means the entire tree was byte-verified in this call, partial covers only returned files, failed means unreadable/corrupt storage or invalid offset. A byte-limit with no progress requires another verification facility for that oversized file. Does not change the resource head or leases.',
    inputSchema: { projectId: z.string(), resourceId: z.string(), revisionId: z.string(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional() },
  }, async (a) => wrap(async () => (await ops.platformRequest('GET',
    `/api/projects/${encodeURIComponent(a.projectId)}/resources/${encodeURIComponent(a.resourceId)}/revisions/${encodeURIComponent(a.revisionId)}/verify?offset=${a.offset ?? 0}&limit=${a.limit ?? 100}`))));
  server.registerTool('propose_project_resource', {
    description: 'Stage newly-created non-Git task output as an encrypted, task/world-generation-bound candidate for Review. A path is checked now and snapshotted when the task reaches Review, however large (refreshed if it changes before Confirm); keep it in place (Review shows whether it was saved). Confirmation adopts it as a project default unless a reviewer excludes it using PUT /api/tasks/:taskId/resources/:resourceId/selection {excluded:true} through platform_request. Use path for declared non-secret files/directories, or vaultItemId for a credential this task just stored. Agents with project:settings:write may instead administer resources directly through platform_request, including storageLocationId and other authorized projects.',
    inputSchema: {
      path: z.string().optional(), vaultItemId: z.string().optional(), field: z.string().optional(), name: z.string(),
      driver: z.enum(['volume@1', 'object-tree@1', 'secret@1', 'service@1', 'database@1']).optional(),
      targetPath: z.string().describe('Path relative to the task working directory (the sole development checkout, or the workspace for multiple development repositories).').optional(),
      targetEnvironment: z.string().optional(), targetService: z.string().optional(),
      access: z.enum(['read', 'write']).optional(), publish: z.enum(['discard', 'review']).optional(),
    },
  }, async (a) => wrap(async () => {
    const sources = Number(Boolean(a.path)) + Number(Boolean(a.vaultItemId));
    const targets = Number(Boolean(a.targetPath)) + Number(Boolean(a.targetEnvironment)) + Number(Boolean(a.targetService));
    if (sources !== 1) throw new Error('provide exactly one of path or vaultItemId');
    if (targets !== 1) throw new Error('provide exactly one targetPath, targetEnvironment, or targetService');
    return (await ops.proposeProjectResource({
      source: a.path ? { kind: 'path', path: a.path } : { kind: 'vault-item', itemId: a.vaultItemId!, field: a.field },
      name: a.name, driver: a.driver, access: a.access, publish: a.publish,
      target: a.targetPath ? { kind: 'path', path: a.targetPath }
        : a.targetService ? { kind: 'service', name: a.targetService }
          : { kind: 'environment', name: a.targetEnvironment! },
    }));
  }));
  // Vault credentials (wiki plans/PLAN-passwords) — thin wrappers over the gateway's
  // /api/vault surface so the pull model is first-class, not buried behind
  // platform_request. Available on the gateway-backed bridge; the in-process
  // apiOps embedding reports the same platform_request limitation.
  server.registerTool('list_connections', {
    description: 'List app accounts explicitly shared with this task or project. Prefer these connections to requesting passwords. Tokens stay server-side.', inputSchema: {},
  }, async () => wrap(async () => (await ops.platformRequest('GET', '/api/connections'))));
  server.registerTool('request_connection', {
    description: 'Request access to an app for this task. Prefer a native MCP server: pass mcp as its MCP Registry name (e.g. com.example/gmail, find one with GET /api/mcp/registry?search=) or its public HTTPS URL. Use toolkit (a Composio slug such as gmail or googlecalendar) only as the fallback when no suitable remote MCP server exists. The user allows an account they already connected or signs in; a Connect button appears in this task and it resumes automatically. Continue independent work, but do not finish while the connection is pending. Reuse accounts from list_connections.',
    inputSchema: { mcp: z.string().optional(), toolkit: z.string().optional(), why: z.string() },
  }, async a => wrap(async () => (await ops.platformRequest('POST', '/api/connections/request', a))));
  server.registerTool('search_connection_tools', {
    description: 'Search the tools and input schemas available for a connected account. Use the exact returned tool slug and schema with execute_connection_tool.',
    inputSchema: { connectionId: z.string(), search: z.string() },
  }, async a => wrap(async () => (await ops.platformRequest('GET', `/api/connections/${encodeURIComponent(a.connectionId)}/tools?search=${encodeURIComponent(a.search)}`))));
  server.registerTool('execute_connection_tool', {
    description: 'Execute one app tool on the exact connected account, within the user’s task instructions. Search its schema first. Read/write actions take effect immediately; authorization to connect an account does not authorize unrelated actions. Do not blindly retry a failed write: check whether it succeeded first.',
    inputSchema: { connectionId: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) },
  }, async a => wrap(async () => (await ops.platformRequest('POST', `/api/connections/${encodeURIComponent(a.connectionId)}/execute`, { tool: a.tool, arguments: a.arguments }))));
  server.registerTool(
    'list_credentials',
    {
      description:
        'List the accounts and other vault credentials this task is authorized to use. Returns non-secret metadata including each item id, label, type, domains, username when present, stored field names, and effective use/reveal policy. Call this before guessing a domain or requesting new access.',
      inputSchema: {},
    },
    async () => wrap(async () => (await ops.platformRequest('GET', '/api/vault/available'))),
  );
  server.registerTool(
    'request_credential',
    {
      description:
        `Ask for access to a credential in the user's vault (site login, API key, SSH key, .env bag) that list_credentials does not show, by itemId or site domain. granted → proceed (fill_credential/get_credential); needs_approval or not_in_vault → a request is parked for the human and this turn may stop — ${BRAND} automatically resumes the task with the decision; denied → do not re-ask. If a stored credential turns out to be WRONG (the site rejects it) and you cannot self-reset (recovery goes to the human's own inbox, not the agent mailbox), report it with kind: "reset" — the human fixes the item or sends the reset code, then ${BRAND} resumes the task. Prefer an app connection (request_connection) when the service offers one, and ask for reveal only when use cannot work: a revealed secret is sent to your model provider.`,
      inputSchema: { itemId: z.string().optional(), domain: z.string().optional(), mode: z.enum(['use', 'reveal']).optional(), kind: z.enum(['access', 'reset']).optional(), why: z.string(), urgency: z.enum(URGENCY_LEVELS as [Urgency, ...Urgency[]]).optional() },
    },
    async (a) => wrap(async () => (await ops.platformRequest('POST', '/api/vault/requests', a))),
  );
  server.registerTool(
    'fill_credential',
    {
      description:
        `Type a vault credential into the page open in your browser WITHOUT the secret entering your context — ${BRAND} resolves and types it over CDP after verifying the page origin matches the credential's domains. Call once per field (username, password, then totp for a one-time code). The ${BRAND} browser MCP already runs a Chrome that exposes this DevTools endpoint, so just drive the page normally — no manual Chrome launch needed. A needs_approval response already parks the approval request for the human (its requestId is returned) — do NOT also call request_credential; just wait for the decision, which resumes the task.`,
      inputSchema: { itemId: z.string().optional(), domain: z.string().optional(), field: z.enum(['username', 'password', 'totp']).optional(), selector: z.string() },
    },
    async (a) => wrap(async () => (await ops.platformRequest('POST', '/api/vault/fill', a))),
  );
  server.registerTool(
    'get_credential',
    {
      description:
        'Reveal a vault secret in plaintext (API key, password, SSH key, .env contents). Default login reveal includes notes; field note retrieves notes alone — the audited last resort; prefer fill_credential for logins. Returns granted with the value, or needs_approval/denied per the item\'s reveal policy, or not_in_vault. A needs_approval response already parks the approval request for the human (its requestId is returned) — do NOT also call request_credential; just wait for the decision, which resumes the task.',
      inputSchema: { itemId: z.string().optional(), domain: z.string().optional(), field: z.string().optional() },
    },
    async (a) => wrap(async () => (await ops.platformRequest('POST', '/api/vault/resolve', a))),
  );
  server.registerTool(
    'store_credential',
    {
      description:
        'Save a credential into the user\'s vault so it outlives this task. Two uses: (1) a credential you just created (registered account, generated password, captured TOTP seed, minted API/SSH key); (2) ROTATION — after you change a password on a site, immediately update the granted item\'s secrets here (pass its id; metadata is ignored), or everyone is locked out with the stale value. Secrets are write-only: login → {password, totp}, api-key → {secret}, ssh-key → {privateKey}, env → {env}, note → {note}. Rotation is allowed for any item this task may use; full edits only for items this task created.',
      inputSchema: {
        id: z.string().optional(), type: z.enum(['login', 'api-key', 'ssh-key', 'env', 'note']), label: z.string(),
        domains: z.array(z.string()).optional(), username: z.string().optional(), envVar: z.string().optional(),
        secrets: z.record(z.string(), z.string()).optional(),
      },
    },
    async (a) => wrap(async () => (await ops.platformRequest('POST', '/api/vault/store', a))),
  );
  server.registerTool(
    'check_agent_mail',
    {
      description:
        'Read your organization\'s agent mailbox — the dedicated inbox for accounts YOU register (never the user\'s personal email). Completes "check your email for a code / link" steps: returns the address to register with plus recent messages with any verification code and link already extracted. Mailboxes are per organization; you can only read your own.',
      inputSchema: { organizationId: z.string(), match: z.string().optional(),
        since: z.number().optional(), limit: z.number().int().positive().optional() },
    },
    async (a) => wrap(async () => {
      // `since` and `limit` are compared against undefined, not truthiness:
      // `since: 0` ("everything since the epoch") is a legitimate value that a
      // truthiness test silently dropped.
      const q = new URLSearchParams();
      if (a.match !== undefined) q.set('match', a.match);
      if (a.since !== undefined) q.set('since', String(a.since));
      if (a.limit !== undefined) q.set('limit', String(a.limit));
      return (await ops.platformRequest('GET', `/api/organizations/${encodeURIComponent(a.organizationId)}/agent-mail${q.toString() ? `?${q}` : ''}`));
    }),
  );
  server.registerTool(
    'enroll_passkey',
    {
      description:
        'Enroll a NEW passkey belonging to tavya on the account open in your browser (the user\'s own passkeys are unusable — the OS biometric is theirs). tavya preps a virtual authenticator (origin-verified); you trigger the site\'s "create a passkey" button; then call save_passkey with the returned authenticatorId. Afterwards use_passkey logs in with no 2FA prompt.',
      inputSchema: { domain: z.string() },
    },
    async (a) => wrap(async () => (await ops.platformRequest('POST', '/api/vault/passkey/enroll', a))),
  );
  server.registerTool(
    'save_passkey',
    {
      description: 'After triggering the site\'s passkey-create button (see enroll_passkey), store the newly created credential in the vault as a passkey item.',
      inputSchema: { authenticatorId: z.string(), label: z.string().optional(), domains: z.array(z.string()).optional(), username: z.string().optional() },
    },
    async (a) => wrap(async () => (await ops.platformRequest('POST', '/api/vault/passkey/save', a))),
  );
  server.registerTool(
    'use_passkey',
    {
      description:
        `Log in with a ${BRAND}-enrolled passkey: ${BRAND} loads the stored credential into a virtual authenticator on the page; you trigger the site's "sign in with a passkey" button. The secret never enters your context. Returns granted with an authenticatorId (release it when done via platform_request POST /api/vault/passkey/release), or needs_approval/not_in_vault.`,
      inputSchema: { itemId: z.string().optional(), domain: z.string().optional() },
    },
    async (a) => wrap(async () => (await ops.platformRequest('POST', '/api/vault/passkey/login', a))),
  );
  server.registerTool(
    'save_session',
    {
      description:
        `Save the signed-in session of the site open in your browser (its cookies and storage) as a vault item, so later tasks start signed in with use_session. Works however the site was signed into, including "Sign in with Google/GitHub": sign in first (with fill_credential, a passkey, or ask a human to sign in through this task's desktop), then call this on the signed-in page. Values never enter your context. The vault copy is then refreshed from your browser after each turn. Pass itemId to replace a session with a new sign-in.`,
      inputSchema: { domain: z.string().optional(), itemId: z.string().optional(), label: z.string().optional(), username: z.string().optional(), exclusive: z.boolean().optional() },
    },
    async (a) => wrap(async () => (await ops.platformRequest('POST', '/api/vault/session/save', a))),
  );
  server.registerTool(
    'use_session',
    {
      description:
        `Sign your browser into a site with a saved session (see save_session). Navigate to the site first; ${BRAND} restores its cookies and storage and reloads the page signed in, without the values entering your context. Returns granted; needs_approval (a request was raised; you are resumed when it is decided); busy (the session works in one task at a time and another task has it: pause, then retry); expired or not_in_vault. When it no longer works, the result names the site's saved password or passkey to sign in with; then call save_session with the itemId.`,
      inputSchema: { itemId: z.string().optional(), domain: z.string().optional(), why: z.string().optional() },
    },
    async (a) => wrap(async () => (await ops.platformRequest('POST', '/api/vault/session/use', a))),
  );
  server.registerTool(
    'describe_platform',
    { description: 'Describe the complete administrative API available through platform_request.', inputSchema: {} },
    async () => wrap(async () => PLATFORM_API_CATALOG),
  );
  server.registerTool(
    'platform_request',
    {
      description: `Call any authenticated ${BRAND} gateway API operation, including project/account/payment/settings/user/review administration. Call describe_platform first when unsure. This never bypasses authorization, and routes the gateway answers before its session gate (sign-in/sign-up, webhooks, OAuth callbacks) are refused.`,
      // See PLATFORM_REQUEST_BODY_SCHEMA for why `body` must declare a concrete
      // shape; the zod union below is its zod twin (both are asserted equivalent
      // in tests/platform-surface.test.ts).
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().startsWith('/api/'),
        body: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]).optional(),
      },
    },
    async (a) => wrap(async () => {
      // Enforced at the tool boundary as well as inside httpOps, so the refusal
      // is identical whichever ops implementation is wired underneath.
      const rejected = platformRequestPathError(a.path);
      if (rejected) throw new Error(rejected);
      return (await ops.platformRequest(a.method, a.path, normalizeRequestBody(a.body)));
    }),
  );
  server.registerTool('get_task', { description: "Get a task's current view-model.", inputSchema: { taskId: z.string() } }, async (a) => wrap(async () => (await ops.getTask(a.taskId))));
  // Kept for compatibility, but strictly dominated by search_tasks (which returns
  // status/stage/priority/tags and accepts a query). Point callers there.
  server.registerTool('list_tasks', { description: 'List every task in a project as bare {id, title, workflow}. Prefer search_tasks — it takes a query, and its result carries num/status/stage/priority/tags. Pass an empty query for the same "everything" listing.', inputSchema: { projectId: z.string() } }, async (a) => wrap(() => ops.listTasks(a.projectId)));
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
        '`for:me` / `for:<name|email|user:id>` = tasks waiting on that person (review, input, approval, assignment, unread mention) plus their drafts; ' +
        '`project:<id|slug|name>`. Add `sort:priority-desc` and `group:tag` to order/bucket. Empty query returns all tasks (runs of a series included — ' +
        'add `-is:run` to hide them). E.g. `is:scheduled sort:nextRun-asc`, `dependsOn:#42`, `is:blocked-on-deps`. ' +
        'Pass `organizationId` instead of `projectId` to search every project of the organization you can read (results carry projectId).',
      inputSchema: { projectId: z.string().optional(), organizationId: z.string().optional(), query: z.string().default('') },
    },
    async (a) => wrap(() => {
      if (!a.projectId === !a.organizationId) throw new Error('pass exactly one of projectId or organizationId');
      return a.organizationId ? ops.searchOrganizationTasks(a.organizationId, a.query ?? '') : ops.searchTasks(a.projectId!, a.query ?? '');
    }),
  );
  server.registerTool('list_tags', { description: 'List a project\'s tag catalogue as `a/b/c` paths, with kind and optional section description.', inputSchema: { projectId: z.string() } }, async (a) => wrap(() => ops.listTags(a.projectId)));
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
      description: `Send a signal to a task (confirm, cancel, retry, or followUp with text). For a followUp, \`role\` optionally addresses one of the task's attached agents (${AGENT_ROLE_NAMES.join(', ')}); it defaults to the Do agent.`,
      inputSchema: {
        taskId: z.string(),
        signal: z.enum(['confirm', 'cancel', 'retry', 'followUp']),
        otherAttempts: z.enum(['keep', 'cancel']).optional(),
        saveOtherAttemptsDefault: z.boolean().optional().describe('Save as project default; requires project:settings:write.'),
        text: z.string().optional(),
        role: z.enum(AGENT_ROLE_NAMES).optional(),
      },
    },
    async (a) => wrap(async () => { await ops.signalTask(a.taskId, a.signal, a.text, a.role, a.otherAttempts, a.saveOtherAttemptsDefault); return 'signalled'; }),
  );
  server.registerTool('reorder_queue', { description: 'Prioritize a task in a merge queue domain.', inputSchema: { domain: z.string(), taskId: z.string() } }, async (a) => wrap(async () => { await ops.reorderQueue(a.domain, a.taskId); return 'reordered'; }));
  server.registerTool('save_skill', {
    description: 'Save a reusable skill (markdown) for future tasks; saving the same name overwrites it. It is saved to your task\'s project, or for your whole organization if your task has organization-wide authority (organization:wiki:write); the result says which. For content that task prompts should include, write a wiki page instead (platform_request PUT /api/{organizations|projects}/:id/wiki/page).',
    inputSchema: { name: z.string(), content: z.string() },
  }, async (a) => wrap(async () => (await ops.saveSkill(a))));
  server.registerTool(
    'read_wiki',
    {
      description:
        'Navigate an organization or project wiki (skills, memories, prompts). No path → the full table of contents (this also expands any [more…] fold); a section path → that section listed in full; a skill/memory path → its complete markdown plus attached files. Your prompt names the scope ids that apply to your task.',
      inputSchema: { scope: z.enum(['organization', 'project']), id: z.string(), path: z.string().optional() },
    },
    async (a) => wrap(async () => (await ops.readWiki(a.scope, a.id, a.path))),
  );
  server.registerTool(
    'search_wiki',
    {
      description: 'Grep every page of an organization or project wiki with a case-insensitive regular expression; returns file:line matches. Works from any world, including cloud sandboxes.',
      inputSchema: { scope: z.enum(['organization', 'project']), id: z.string(), query: z.string() },
    },
    async (a) => wrap(async () => (await ops.searchWiki(a.scope, a.id, a.query))),
  );
  server.registerTool(
    'propose_workflow_edit',
    { description: 'Self-hosted only: propose an edit to an external workflow repo through the reviewed merge-only PR gate. Activation requires a separate install. Built-ins change only with platform releases.', inputSchema: { projectId: z.string(), title: z.string(), repo: z.string(), branch: z.string(), target: z.string() } },
    async (a) => wrap(async () => (await ops.proposeWorkflowEdit(a)).id),
  );
  return server;
}
