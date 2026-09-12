import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { KarmaxApi } from '../src/platform/api.js';
import { createPlatformMcpServer, apiOps, httpOps, normalizeRequestBody } from '../src/platform/mcp.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { WorldProviderConnectionService } from '../src/world/connections.js';
import { WorldRegistry } from '../src/world/registry.js';
import { platformToolHandlers } from '../src/agent/tools.js';

describe('platform MCP server (capability-checked tool calls)', () => {
  let store: Store;
  let tokens: TokenAuthority;
  let api: KarmaxApi;
  let contentDir: string;
  let currentToken: string;
  let client: Client;
  let worlds: WorldRegistry;

  beforeEach(async () => {
    store = new Store(':memory:');
    tokens = new TokenAuthority();
    contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-content-'));
    const providerConnections = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(path.join(contentDir, 'vault'))));
    worlds = new WorldRegistry();
    api = new KarmaxApi({ store, client: {} as any, taskQueue: 'karmax', tokens, contentDir, providerConnections, worlds });
    const server = createPlatformMcpServer(apiOps(api, () => currentToken));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientT);
  });
  afterEach(() => {
    fs.rmSync(contentDir, { recursive: true, force: true });
  });

  it('exposes the platform tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'create_task', 'save_skill', 'signal_task', 'reorder_queue', 'propose_workflow_edit',
        'search_tasks', 'list_tags', 'tag_task', 'set_task_priority',
        'find_task', 'list_agents', 'get_conversation', 'fork_agent', 'message_agent', 'request_agent_action', 'cancel_agent_action',
        'escalate_to_human', 'request_permission',
        'list_events', 'publish_task_branch', 'import_task_branch', 'refresh_upstream', 'propose_project_resource', 'describe_platform', 'platform_request', 'list_world_providers',
        'list_github_actions_runs', 'inspect_github_actions_run', 'manage_github_actions_run', 'dispatch_github_actions_workflow',
        'connect_world_provider', 'test_world_provider', 'disconnect_world_provider',
        'get_execution_policy', 'set_execution_policy',
      ]),
    );
    const described: any = await client.callTool({ name: 'describe_platform', arguments: {} });
    const catalog = JSON.parse(described.content[0].text);
    expect(catalog.administration).toContain('GET|POST /api/users');
    expect(catalog.payments).toContain('GET|POST /api/cards');
    expect(catalog.cloud).toContain('GET /api/organizations/:organizationId/world-providers');
    expect(catalog.cloud).toContain('GET|PUT /api/organizations/:organizationId/execution-policy');
    expect(catalog.sourceControl).toContain('GET|PUT /api/projects/:projectId/repository-sources');
    expect(catalog.sourceControl).toContain('GET|POST /api/projects/:projectId/repositories');
    expect(catalog.projects).toContain('GET|POST /api/projects/:projectId/secrets');
    expect(catalog.projects).toContain('GET|POST|DELETE /api/projects/:projectId/services');
    expect(catalog.projects).toContain('GET|PUT /api/projects/:projectId/environment');
    const fork = tools.find((tool) => tool.name === 'fork_agent') as any;
    expect(fork.inputSchema.properties).toMatchObject({
      provider: { enum: expect.arrayContaining(['claude', 'codex', 'opencode']) },
      model: { type: 'string' },
      effort: { enum: expect.arrayContaining(['low', 'high', 'xhigh']) },
    });
  });

  it('forwards a task resource proposal without adopting it', async () => {
    const seen: unknown[] = [];
    const stub = { proposeProjectResource: async (args: unknown) => { seen.push(args); return { candidate: { id: 'candidate-1' } }; } } as any;
    const server = createPlatformMcpServer(stub);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair(); await server.connect(serverT);
    const c = new Client({ name: 'resource-test', version: '1.0.0' }); await c.connect(clientT);
    const result: any = await c.callTool({ name: 'propose_project_resource', arguments: {
      path: 'downloads/model', name: 'Model', driver: 'volume@1', targetPath: 'models/main', access: 'read',
    } });
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([{ source: { kind: 'path', path: 'downloads/model' }, name: 'Model', driver: 'volume@1',
      target: { kind: 'path', path: 'models/main' }, access: 'read', publish: undefined }]);
  });

  it('forwards brokered GitHub Actions reads and separately-declared mutations', async () => {
    const seen: unknown[] = [];
    const stub = {
      listGithubActionsWorkflows: async (args: unknown) => { seen.push(['workflows', args]); return { workflows: [] }; },
      listGithubActionsRuns: async (args: unknown) => { seen.push(['list', args]); return { runs: [] }; },
      inspectGithubActionsRun: async (args: unknown) => { seen.push(['inspect', args]); return { failedJobs: [] }; },
      manageGithubActionsRun: async (args: unknown) => { seen.push(['manage', args]); return { accepted: true }; },
      dispatchGithubActionsWorkflow: async (args: unknown) => { seen.push(['dispatch', args]); return { accepted: true }; },
    } as any;
    const server = createPlatformMcpServer(stub);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair(); await server.connect(serverT);
    const c = new Client({ name: 'github-actions-test', version: '1.0.0' }); await c.connect(clientT);
    for (const [name, args] of [
      ['list_github_actions_workflows', { repository: 'acme/app', page: 2 }],
      ['list_github_actions_runs', { repository: 'acme/app', branch: 'main', status: 'failure', perPage: 10 }],
      ['inspect_github_actions_run', { repository: 'acme/app', runId: 42, view: 'log', attempt: 1, jobId: 99, tailLines: 20, offsetLines: 3, maxChars: 1000 }],
      ['manage_github_actions_run', { repository: 'acme/app', runId: 42, action: 'rerun-failed' }],
      ['dispatch_github_actions_workflow', { repository: 'acme/app', workflow: 'deploy.yml', ref: 'main', inputs: { dry_run: false } }],
    ] as const) {
      const result: any = await c.callTool({ name, arguments: args as any });
      expect(result.isError, result.content?.[0]?.text).toBeFalsy();
    }
    expect(seen).toEqual([
      ['workflows', { repository: 'acme/app', page: 2 }],
      ['list', { repository: 'acme/app', branch: 'main', status: 'failure', perPage: 10 }],
      ['inspect', { repository: 'acme/app', runId: 42, view: 'log', attempt: 1, jobId: 99, tailLines: 20, offsetLines: 3, maxChars: 1000 }],
      ['manage', { repository: 'acme/app', runId: 42, action: 'rerun-failed' }],
      ['dispatch', { repository: 'acme/app', workflow: 'deploy.yml', ref: 'main', inputs: { dry_run: false } }],
    ]);
  });

  it('forwards a dedicated human escalation with its chosen audience and reason', async () => {
    const seen: unknown[] = [];
    const stub = {
      escalateToHuman: async (args: unknown) => {
        seen.push(args);
        return { status: 'waiting' };
      },
    } as any;
    const server = createPlatformMcpServer(stub);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const c = new Client({ name: 'escalation-test', version: '1.0.0' });
    await c.connect(clientT);

    const result: any = await c.callTool({
      name: 'escalate_to_human',
      arguments: {
        audience: ['user:designer', '@team:leaders'],
        message: 'Which launch option should I use?',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([{
      audience: ['user:designer', '@team:leaders'],
      message: 'Which launch option should I use?',
    }]);
  });

  /** Urgency is how loudly the agent is allowed to ask. It has to survive the MCP
   *  boundary, and a level nobody defined has to be refused at it. */
  it('carries the agent\'s chosen urgency across the boundary, and only a real level', async () => {
    const seen: any[] = [];
    const stub = { escalateToHuman: async (args: unknown) => { seen.push(args); return { status: 'waiting' }; } } as any;
    const server = createPlatformMcpServer(stub);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const c = new Client({ name: 'urgency-test', version: '1.0.0' });
    await c.connect(clientT);

    await c.callTool({ name: 'escalate_to_human',
      arguments: { audience: ['@owners'], message: 'The card was declined.', urgency: 'critical' } });
    expect(seen[0]).toMatchObject({ urgency: 'critical' });

    // Silence stays silent here: the default belongs to the API, not the tool call.
    await c.callTool({ name: 'escalate_to_human', arguments: { audience: ['@owners'], message: 'Which font?' } });
    expect(seen[1]).not.toHaveProperty('urgency');

    const invalid: any = await c.callTool({ name: 'escalate_to_human',
      arguments: { audience: ['@owners'], message: 'Now!', urgency: 'EXTREMELY' } });
    expect(invalid.isError).toBeTruthy();
    expect(seen).toHaveLength(2);
  });

  it('forwards an exact permission request with its chosen audience and reason', async () => {
    const seen: unknown[] = [];
    const stub = {
      requestPermission: async (args: unknown) => {
        seen.push(args);
        return { status: 'needs_approval', requestId: 'preq_1' };
      },
    } as any;
    const server = createPlatformMcpServer(stub);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const c = new Client({ name: 'permission-test', version: '1.0.0' });
    await c.connect(clientT);

    const result: any = await c.callTool({
      name: 'request_permission',
      arguments: {
        capabilities: [],
        projectIds: ['proj_second'],
        audience: ['@creator', '@team:operators'],
        reason: 'Inspect the outbound email configuration.',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([{
      capabilities: [],
      projectIds: ['proj_second'],
      audience: ['@creator', '@team:operators'],
      reason: 'Inspect the outbound email configuration.',
    }]);
  });

  /**
   * Regression: `platform_request.body` was declared `z.unknown()`, which serializes to
   * an *empty* JSON Schema (`{}`). Clients dropped the argument before it left the
   * caller, so every write reached the gateway with an empty body and silently became a
   * no-op — a POST arrived at createTag as `{}` and threw on `name.trim()`. The advertised
   * schema must describe a concrete shape.
   */
  it('advertises a concrete body schema for platform_request so writes carry a payload', async () => {
    const { tools } = await client.listTools();
    const body = (tools.find((t) => t.name === 'platform_request')!.inputSchema as any).properties.body;
    expect(body).toBeDefined();
    expect(Object.keys(body)).not.toHaveLength(0);
    // An object payload must be expressible (that is the overwhelmingly common case).
    expect(JSON.stringify(body)).toMatch(/"type":"object"/);
  });

  /**
   * Pins the server half of the contract: a body survives client → server → ops.
   *
   * Worth being precise about what the empty schema did and did not break. A
   * well-behaved MCP client (this one) always forwarded an object body, even under
   * `z.unknown()` — so the *server* was never the fault. The breakage was client-side:
   * a caller that will not marshal an argument whose advertised schema is empty drops
   * it, and the gateway then sees `{}`. Declaring a concrete shape is what makes the
   * argument survive those clients; the JSON-string arm below is new capability.
   */
  it('delivers a platform_request body across the MCP boundary to the ops layer', async () => {
    const seen: { method?: string; path?: string; body?: unknown } = {};
    const stub = {
      platformRequest: async (method: string, path: string, body?: unknown) => {
        Object.assign(seen, { method, path, body });
        return { ok: true };
      },
    } as any;
    const server = createPlatformMcpServer(stub);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const c = new Client({ name: 'body-test', version: '1.0.0' });
    await c.connect(clientT);

    await c.callTool({
      name: 'platform_request',
      arguments: { method: 'POST', path: '/api/projects/p1/tags', body: { name: 'bug', kind: 'type' } },
    });
    expect(seen).toMatchObject({ method: 'POST', path: '/api/projects/p1/tags' });
    expect(seen.body).toEqual({ name: 'bug', kind: 'type' });

    // The JSON-string escape hatch arrives structured, not as a string.
    await c.callTool({
      name: 'platform_request',
      arguments: { method: 'PATCH', path: '/api/tags/t1', body: '{"kind":"flag"}' },
    });
    expect(seen.body).toEqual({ kind: 'flag' });
  });

  it('accepts a platform_request body as a structured value or a JSON string', () => {
    expect(normalizeRequestBody({ name: 'bug' })).toEqual({ name: 'bug' });
    expect(normalizeRequestBody('{"name":"bug"}')).toEqual({ name: 'bug' });
    expect(normalizeRequestBody([1, 2])).toEqual([1, 2]);
    expect(normalizeRequestBody(undefined)).toBeUndefined();
    // A string that is not JSON is forwarded verbatim rather than mangled.
    expect(normalizeRequestBody('plain text')).toBe('plain text');
  });

  it('does not expose direct cross-world filesystem inspection', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('list_world_files');
    expect(names).not.toContain('read_world_file');
  });

  it('lets an authorized agent connect and disconnect a provider without reading its secret', async () => {
    const organization = store.createOrganization({ name: 'Automation', ownerUserId: 'a' });
    currentToken = tokens.mintPrincipal('user:a', ['organization:read', 'organization:edit'], undefined, 60_000, organization.id).token;
    const connected: any = await client.callTool({ name: 'connect_world_provider', arguments: {
      organizationId: organization.id, provider: 'e2b', apiKey: 'write-only-secret', template: 'node-22',
    } });
    expect(connected.isError).toBeFalsy();
    expect(connected.content[0].text).not.toContain('write-only-secret');
    const listed: any = await client.callTool({ name: 'list_world_providers', arguments: { organizationId: organization.id } });
    expect(JSON.parse(listed.content[0].text)[0]).toMatchObject({ provider: 'e2b', credentialConfigured: true });
    expect(listed.content[0].text).not.toContain('write-only-secret');
    const configured: any = await client.callTool({ name: 'set_execution_policy', arguments: {
      organizationId: organization.id, worldProvider: 'e2b', unrestrictedInternet: true,
      cpu: 4, memoryMb: 8192, hibernateAfterDays: 2,
    } });
    expect(configured.isError).toBeFalsy();
    expect(JSON.parse(configured.content[0].text).organization).toMatchObject({
      worldProvider: 'e2b', resources: { cpu: 4, memoryMb: 8192 }, network: { unrestricted: true },
      hibernateAfterMs: 2 * 86_400_000,
    });
    const removed: any = await client.callTool({ name: 'disconnect_world_provider', arguments: { organizationId: organization.id, provider: 'e2b' } });
    expect(JSON.parse(removed.content[0].text)).toEqual({ deleted: true });
  });

  /**
   * `set_execution_policy` advertises "sparse project overrides", but it built a
   * FULL `network`/`resources` object whenever any member field was supplied —
   * and the store replaces `network` wholesale while `resources` merges by
   * spread (so an explicit `undefined` erases the stored value). So
   * `{allowDomains}` alone silently set `unrestricted:false` and dropped
   * `allowCidrs`, and `{memoryMb}` alone erased `cpu` and `gpu`. Disabling
   * unrestricted internet behind the caller's back is a live-config hazard, not
   * a cosmetic one.
   */
  it('applies set_execution_policy sparsely instead of erasing unrelated fields', async () => {
    const organization = store.createOrganization({ name: 'Sparse', ownerUserId: 'a' });
    currentToken = tokens.mintPrincipal('user:a', ['organization:read', 'organization:edit'], undefined, 60_000, organization.id).token;
    const call = async (args: any) => {
      const res: any = await client.callTool({ name: 'set_execution_policy', arguments: { organizationId: organization.id, ...args } });
      expect(res.isError, res.content?.[0]?.text).toBeFalsy();
      return JSON.parse(res.content[0].text).organization;
    };

    await call({ cpu: 4, memoryMb: 8192, gpu: 1, unrestrictedInternet: true,
      allowDomains: ['pypi.org'], allowCidrs: ['10.0.0.0/8'] });

    // Adding one allowed domain must not revoke unrestricted internet or drop the CIDRs.
    const afterDomains = await call({ allowDomains: ['pypi.org', 'npmjs.com'] });
    expect(afterDomains.network).toMatchObject({
      unrestricted: true, allowDomains: ['pypi.org', 'npmjs.com'], allowCidrs: ['10.0.0.0/8'],
    });
    expect(afterDomains.resources).toMatchObject({ cpu: 4, memoryMb: 8192, gpu: 1 });

    // Resizing memory must not erase cpu/gpu, nor touch the network policy.
    const afterMemory = await call({ memoryMb: 4096 });
    expect(afterMemory.resources).toMatchObject({ cpu: 4, memoryMb: 4096, gpu: 1 });
    expect(afterMemory.network).toMatchObject({ unrestricted: true, allowCidrs: ['10.0.0.0/8'] });

    // An explicit value is still honoured — sparseness is not stickiness.
    expect((await call({ unrestrictedInternet: false })).network).toMatchObject({
      unrestricted: false, allowCidrs: ['10.0.0.0/8'],
    });
  });

  /**
   * An agent has to tell a denial (escalate) from a bad identifier (retry with
   * another id) from a server fault (back off). `wrap` only recognized
   * CapabilityError, so an in-process NotFoundError read as a generic `error:`.
   */
  it('distinguishes denied from not-found in the agent-visible error text', async () => {
    currentToken = tokens.mint({ taskId: 't1', profileId: 'do', principal: 'user:a',
      ceiling: ['task:*'], grantorCaps: ['task:*'] }).token;
    const missing: any = await client.callTool({ name: 'tag_task', arguments: { taskId: 'task_missing', add: ['bug'] } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/HTTP 404/);
    expect(missing.content[0].text).not.toMatch(/permission denied/);

    const pid = store.createProject('Errors').id;
    const task = store.createTask({ projectId: pid, title: 'Real', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    currentToken = tokens.mint({ taskId: 't1', profileId: 'do', principal: 'user:a',
      ceiling: ['signal-completion'], grantorCaps: ['signal-completion'] }).token;
    const refused: any = await client.callTool({ name: 'tag_task', arguments: { taskId: task.id, add: ['bug'] } });
    expect(refused.content[0].text).toMatch(/permission denied/);
  });

  it('lets an agent tag, prioritize, and search tasks by attribute', async () => {
    // Seed a project + two tasks directly in the store (createTask via MCP would start a
    // workflow, which this harness's mock client can't do).
    const pid = store.createProject('Acme').id;
    const a = store.createTask({ projectId: pid, title: 'Fix web login', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x', base: 'main' } as any });
    const b = store.createTask({ projectId: pid, title: 'Write docs', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'y', base: 'develop' } as any });
    currentToken = tokens.mint({
      taskId: 't1', profileId: 'do', principal: 'user:a',
      ceiling: ['read-task', 'edit-task'], grantorCaps: ['read-task', 'edit-task'],
    }).token;

    const raw = async (name: string, args: any) => {
      const res: any = await client.callTool({ name, arguments: args });
      expect(res.isError, res.content?.[0]?.text).toBeFalsy();
      return res.content[0].text as string;
    };
    const call = async (name: string, args: any) => JSON.parse(await raw(name, args));

    // tag_task creates a slash hierarchy on the fly and returns the resulting paths.
    const tagged = await call('tag_task', { taskId: a.id, add: ['bug', 'frontend/web'] });
    expect(tagged.tags.sort()).toEqual(['bug', 'frontend/web']);
    expect(await raw('set_task_priority', { taskId: a.id, priority: 'high' })).toMatch(/high/);

    // list_tags shows the hierarchy as paths.
    const tags = await call('list_tags', { projectId: pid });
    expect(tags.map((t: any) => t.path).sort()).toEqual(['bug', 'frontend', 'frontend/web']);

    // search by a parent tag matches the child-tagged task; compact projection carries paths + priority.
    const byParent = await call('search_tasks', { projectId: pid, query: 'tag:frontend priority:>=2' });
    expect(byParent.total).toBe(1);
    expect(byParent.tasks[0].id).toBe(a.id);
    expect(byParent.tasks[0].tags).toContain('frontend/web');
    expect(byParent.tasks[0].priority).toBe(3);

    // search by a workflow param (param.<key>) finds the other task.
    const byParam = await call('search_tasks', { projectId: pid, query: 'param.base:develop' });
    expect(byParam.tasks.map((t: any) => t.id)).toEqual([b.id]);

    // tag_task can remove by name too.
    const untagged = await call('tag_task', { taskId: a.id, remove: ['bug'] });
    expect(untagged.tags).toEqual(['frontend/web']);
  });

  it('lets an agent find scheduled / dependency-blocked tasks via search_tasks', async () => {
    const pid = store.createProject('Ops').id;
    // A nightly cron series (armed) and a task blocked on a dependency.
    const nightly = store.createTask({ projectId: pid, title: 'Nightly backup', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x', triggers: [{ kind: 'schedule', cron: '0 3 * * *' }], triggerState: 'armed', repeatable: true } as any });
    const build = store.createTask({ projectId: pid, title: 'Build', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'y' } as any });
    const deploy = store.createTask({ projectId: pid, title: 'Deploy', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'z', triggers: [{ kind: 'dependency', tasks: [build.id] }], triggerState: 'armed' } as any });
    currentToken = tokens.mint({ taskId: 't1', profileId: 'do', principal: 'user:a', ceiling: ['read-task'], grantorCaps: ['read-task'] }).token;
    const call = async (query: string) => {
      const res: any = await client.callTool({ name: 'search_tasks', arguments: { projectId: pid, query } });
      expect(res.isError, res.content?.[0]?.text).toBeFalsy();
      return JSON.parse(res.content[0].text);
    };
    expect((await call('is:scheduled')).tasks.map((t: any) => t.id)).toEqual([nightly.id]);
    // armed tasks project as status "armed" in the compact result
    expect((await call('is:scheduled')).tasks[0].status).toBe('armed');
    expect((await call('is:blocked-on-deps')).tasks.map((t: any) => t.id)).toEqual([deploy.id]);
    expect((await call(`dependsOn:#${build.num}`)).tasks.map((t: any) => t.id)).toEqual([deploy.id]);
    expect((await call('is:series')).tasks.map((t: any) => t.id)).toEqual([nightly.id]);
  });

  it('denies search_tasks when the token lacks read-task', async () => {
    currentToken = tokens.mint({
      taskId: 't1', profileId: 'do', principal: 'user:a',
      ceiling: ['signal-completion'], grantorCaps: ['signal-completion'],
    }).token;
    const res: any = await client.callTool({ name: 'search_tasks', arguments: { projectId: 'p', query: '' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/permission denied/i);
  });

  it('permits a tool call when the token carries the capability', async () => {
    currentToken = tokens.mint({
      taskId: 't1',
      profileId: 'do',
      principal: 'user:a',
      ceiling: ['save-skill'],
      grantorCaps: ['save-skill'],
    }).token;
    const res: any = await client.callTool({ name: 'save_skill', arguments: { name: 'greet', content: '# hi' } });
    expect(res.isError).toBeFalsy();
    // Saved under the calling tenant's directory, never the installation-wide one.
    expect(fs.existsSync(path.join(contentDir, 'skills', 'organizations', 'org_personal', 'greet.md'))).toBe(true);
  });

  it('denies a tool call when the token lacks the capability', async () => {
    currentToken = tokens.mint({
      taskId: 't1',
      profileId: 'do',
      principal: 'user:a',
      ceiling: ['signal-completion'], // no save-skill
      grantorCaps: ['signal-completion'],
    }).token;
    const res: any = await client.callTool({ name: 'save_skill', arguments: { name: 'x', content: 'y' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/permission denied/i);
  });
});

// The stdio bridge (src/mcp/stdio.ts) hands httpOps a lazy resolver instead of a
// baked token so a CLI-launched agent can acquire a gateway session itself. This
// is the path that used to fail as `Failed to reconnect to karmax: -32000` when
// no KARMAX_TOKEN was present (the bridge process exited before the handshake).
describe('httpOps token resolution (CLI bridge)', () => {
  const jsonRes = (status: number, body: unknown) =>
    ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) }) as any;

  it('sends the resolved token as a Bearer and re-acquires on a 401', async () => {
    const seen: (string | null)[] = [];
    let issued = 0;
    const fetchMock = async (_url: string, init: any = {}) => {
      const auth = (init.headers?.authorization as string) ?? null;
      seen.push(auth);
      // First call carries the stale token → 401; after re-resolve it succeeds.
      return auth === 'Bearer s_fresh' ? jsonRes(200, []) : jsonRes(401, { error: 'unauthorized' });
    };
    const orig = globalThis.fetch;
    (globalThis as any).fetch = fetchMock;
    try {
      const ops = httpOps('http://gw', async () => (issued++ === 0 ? 's_stale' : 's_fresh'));
      const list = await ops.listTasks('p1');
      expect(list).toEqual([]);
      expect(seen).toEqual(['Bearer s_stale', 'Bearer s_fresh']); // retried once with a fresh session
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  it('routes the dedicated escalation tool through the calling-task API', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      seen.push({ url, init });
      return jsonRes(200, { status: 'waiting' });
    };
    try {
      const ops = httpOps('http://gw', 'agent-token');
      await ops.escalateToHuman({ audience: ['@team:design'], message: 'Choose a direction.' });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe('http://gw/api/agent/escalate');
      expect(seen[0]!.init.method).toBe('POST');
      expect(JSON.parse(seen[0]!.init.body)).toEqual({
        audience: ['@team:design'],
        message: 'Choose a direction.',
      });
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  it('still issues the request (unauthenticated) when no token can be resolved', async () => {
    let auth: string | null | undefined;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string, init: any = {}) => {
      auth = (init.headers?.authorization as string) ?? null;
      return jsonRes(200, []);
    };
    try {
      const ops = httpOps('http://gw', async () => undefined);
      await expect(ops.listTasks('p1')).resolves.toEqual([]);
      expect(auth).toBeNull(); // no Authorization header, but the call is still made
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
});

/**
 * `set_execution_policy`'s sparse merge read its base as `current.organization`.
 * That key exists on the in-process `apiOps` (`api.getExecutionPolicy` wraps the
 * org policy as `{organization}`) and on the gateway's PROJECT route
 * (`{override, organization, effective}`) — but the gateway's ORGANIZATION route
 * returns the **bare** policy object (`src/gateway/server.ts`, GET
 * /api/organizations/:id/execution-policy). `httpOps` is the only production
 * wiring (`src/mcp/stdio.ts`; `apiOps` is used solely by these tests), so on the
 * shipped path the org-scoped base was always `{}` and the "merge" discarded the
 * policy in force: because the store replaces `network` wholesale, an update of
 * just `{allowDomains}` cleared `unrestricted` and dropped `allowCidrs`. The
 * apiOps-backed test above cannot see this — it never exercises the route shape.
 */
describe('set_execution_policy merge base (httpOps — the shipped gateway shape)', () => {
  const jsonRes = (status: number, body: unknown) =>
    ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) }) as any;

  /** The policy currently in force, as the store would report it. */
  const STORED = {
    worldProvider: 'e2b',
    resources: { cpu: 4, memoryMb: 8192, gpu: 1 },
    network: { unrestricted: true, allowDomains: ['pypi.org'], allowCidrs: ['10.0.0.0/8'] },
  };

  /** Fake gateway: the org route answers BARE, the project route answers wrapped. */
  const fakeGateway = (puts: any[]) => async (url: string, init: any = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'PUT') { puts.push(JSON.parse(init.body)); return jsonRes(200, { saved: true }); }
    if (/\/api\/organizations\/[^/]+\/execution-policy$/.test(url)) return jsonRes(200, STORED);
    if (/\/api\/projects\/[^/]+\/execution-policy$/.test(url))
      return jsonRes(200, { override: STORED, organization: {}, effective: STORED });
    return jsonRes(404, { error: `unexpected ${method} ${url}` });
  };

  /** Drive the real MCP tool over httpOps; return the bodies it PUT. */
  const putBodies = async (args: Record<string, unknown>): Promise<any[]> => {
    const puts: any[] = [];
    const orig = globalThis.fetch;
    (globalThis as any).fetch = fakeGateway(puts);
    try {
      const server = createPlatformMcpServer(httpOps('http://gw', 'tok'));
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const c = new Client({ name: 'test', version: '1.0.0' });
      await c.connect(clientT);
      const res: any = await c.callTool({ name: 'set_execution_policy', arguments: args });
      expect(res.isError, res.content?.[0]?.text).toBeFalsy();
    } finally {
      (globalThis as any).fetch = orig;
    }
    return puts;
  };

  it('keeps unrestricted internet and the CIDRs on an org-scoped allowDomains update', async () => {
    const [body] = await putBodies({ organizationId: 'org_1', allowDomains: ['pypi.org', 'npmjs.com'] });
    expect(body.policy.network).toEqual({
      unrestricted: true, allowDomains: ['pypi.org', 'npmjs.com'], allowCidrs: ['10.0.0.0/8'],
    });
  });

  it('keeps cpu/gpu on an org-scoped memoryMb update', async () => {
    const [body] = await putBodies({ organizationId: 'org_1', memoryMb: 4096 });
    expect(body.policy.resources).toEqual({ cpu: 4, memoryMb: 4096, gpu: 1 });
  });

  it('still merges a project override from the wrapped {override} shape', async () => {
    const [body] = await putBodies({ organizationId: 'org_1', projectId: 'p1', memoryMb: 4096 });
    expect(body.override.resources).toEqual({ cpu: 4, memoryMb: 4096, gpu: 1 });
    expect(body.override.network).toBeUndefined(); // untouched keys are not resent
  });

  // `src/agent/tools.ts` carries a second copy of this handler for the
  // tool-calling (non-MCP) rail, with the identical defect.
  it('applies the same merge in the agent tool-handler rail', async () => {
    const puts: { method: string; path: string; body: any }[] = [];
    const handlers = platformToolHandlers({} as any, {
      emit: () => {},
      platformRequest: async (method: string, path: string, body?: unknown) => {
        if (method === 'GET') return STORED; // bare, as the org route answers
        puts.push({ method, path, body: body as any });
        return { saved: true };
      },
    } as any);
    await handlers.set_execution_policy!({ organization_id: 'org_1', allow_domains: ['pypi.org', 'npmjs.com'] });
    expect(puts[0]!.body.policy.network).toEqual({
      unrestricted: true, allowDomains: ['pypi.org', 'npmjs.com'], allowCidrs: ['10.0.0.0/8'],
    });
  });
});
