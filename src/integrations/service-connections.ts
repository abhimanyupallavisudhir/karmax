import * as __asyncCollections from '../util/async-collections.js';
import { currentTiming, timed, toolFailed } from '../timing/index.js';
import crypto from 'node:crypto';
import Composio from '@composio/client';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE, organizationScope } from '../autonomy/vault-keys.js';
import { newId } from '../util/id.js';
import { beginOAuth, finishOAuth, connectionHeaders, type OAuthVault, type OAuthTarget } from '../mcp/connections/oauth.js';
import { openRemoteMcp, remoteMcpAuth, type RemoteMcpTransport } from '../mcp/connections/remote.js';
import { registryServer } from '../mcp/connections/registry.js';
import { validateTransport } from '../mcp/connections/store.js';

const PREFIX = 'service-connection:';
const MCP_CREDENTIALS = 'service-connection-mcp:';
const KEY = 'service-connections:composio:api-key';
const TTL = 30 * 60_000;
export interface ServiceConnection {
  id: string;
  organizationId: string;
  ownerId?: string;
  toolkit: string;
  label: string;
  projectIds: string[];
  taskId?: string;
  role?: string;
  why?: string;
  status: 'requested' | 'connecting' | 'active' | 'expired' | 'denied' | 'disconnected';
  createdAt: number;
  updatedAt: number;
  accountId?: string;
  sessionId?: string;
  /** Set on a task grant: the owner's existing connection it uses. A grant
   * holds no provider account; revoking it never touches the account. */
  grantedConnectionId?: string;
  /** A native MCP server account (instead of a Composio toolkit). Its OAuth
   * credentials stay in the vault; the gateway calls the server for the task. */
  mcp?: McpServer;
  /** Changes on every sign-in, so a stale OAuth exchange cannot overwrite it. */
  revision?: string;
  notifiedAt?: number;
}
export interface McpServer extends RemoteMcpTransport { auth: 'oauth' | 'none'; registry?: { name: string; version: string } }
type OpenMcp = typeof openRemoteMcp;
export interface ServiceTool { slug: string; name: string; description?: string; inputParameters?: unknown }
export interface ConnectionBackend {
  catalog(search: string): Promise<Array<{ slug: string; name: string }>>;
  authorize(userId: string, toolkit: string): Promise<{ id: string; url: string }>;
  active(accountId: string, toolkit: string): Promise<boolean>;
  session(userId: string, toolkit: string, accountId: string): Promise<string>;
  tools(toolkit: string, search: string): Promise<ServiceTool[]>;
  execute(sessionId: string, slug: string, args: Record<string, unknown>): Promise<unknown>;
  disconnect(accountId: string): Promise<void>;
}

/** The SDK runs only in the gateway. No provider key, session/MCP URL, account
 * credentials, or automatic host-file upload is exposed to an agent. */
export class ComposioBackend implements ConnectionBackend {
  private client: Composio;
  constructor(key: string) {
    // Never automatically retry external writes or upload gateway files.
    this.client = new Composio({ apiKey: key, maxRetries: 0, timeout: 30_000 });
  }
  async catalog(search: string) {
    const page = await this.client.toolkits.list({ search, limit: 50 });
    return page.items.map(({ slug, name }) => ({ slug, name }));
  }
  async authorize(userId: string, toolkit: string) {
    const session = await this.client.toolRouter.session.create({ user_id: userId, toolkits: { enable: [toolkit] }, multi_account: { enable: true }, workbench: { enable: false } });
    const request = await this.client.toolRouter.session.link(session.session_id, { toolkit });
    return { id: request.connected_account_id, url: request.redirect_url };
  }
  async active(accountId: string, toolkit: string) {
    const account = await this.client.connectedAccounts.retrieve(accountId);
    if (account.id !== accountId || account.toolkit.slug !== toolkit) throw new Error('Account identity mismatch');
    return account.status === 'ACTIVE' && !account.is_disabled;
  }
  async session(userId: string, toolkit: string, accountId: string) {
    const session = await this.client.toolRouter.session.create({ user_id: userId, toolkits: { enable: [toolkit] },
      connected_accounts: { [toolkit]: [accountId] }, multi_account: { enable: false }, manage_connections: { enable: false }, workbench: { enable: false } });
    return session.session_id;
  }
  async tools(toolkit: string, search: string) {
    const page = await this.client.tools.list({ toolkit_slug: toolkit, search, limit: 20 });
    return page.items.map(({ slug, name, description, input_parameters }) => ({ slug, name, description, inputParameters: input_parameters }));
  }
  async execute(sessionId: string, slug: string, args: Record<string, unknown>) {
    return this.client.toolRouter.session.execute(sessionId, { tool_slug: slug, arguments: args });
  }
  async disconnect(accountId: string) {
    try { await this.client.connectedAccounts.delete(accountId, { revoke_on_delete: true }); }
    catch (error) { if (!(error instanceof Composio.APIError && error.status === 404)) throw error; }
  }
}

export class ConnectionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export class ServiceConnections {
  private client?: ConnectionBackend;
  private locks = new Map<string, Promise<unknown>>();
  constructor(private store: Store, private broker: CredentialBroker,
    private factory: (key: string) => ConnectionBackend = key => new ComposioBackend(key),
    private openMcp: OpenMcp = openRemoteMcp) {}
  private vault: OAuthVault = {
    secret: (c) => {
      const handle = MCP_CREDENTIALS + c.id;
      return this.broker.hasHandle(handle) ? JSON.parse(this.broker.resolve(handle, { caps: [`use-credential:${handle}`] })) : {};
    },
    setSecret: async (c, value) => {
      if ((await this.get(c.organizationId, c.id)).revision !== c.revision) throw new Error('Connection changed during authorization. Connect again.');
      (await this.broker.registerHandle(MCP_CREDENTIALS + c.id, JSON.stringify(value), organizationScope(c.organizationId)));
    },
  };
  private target(c: ServiceConnection): OAuthTarget {
    return { id: c.id, organizationId: c.organizationId, label: c.label, auth: c.mcp!.auth,
      transport: { type: c.mcp!.type, url: c.mcp!.url }, revision: c.revision ?? '' };
  }

  configured() { return this.broker.hasHandle(KEY); }
  async configure(key: string) {
    if (!key.trim()) throw new ConnectionError('Composio project API key is required');
    // Verify before rotating a working key. Raw provider errors can contain secrets.
    const candidate = this.factory(key.trim());
    await this.remote(() => candidate.catalog('gmail'));
    // A rotated key must still address the same project’s existing accounts.
    // Changing projects would orphan their grants and sessions.
    for (const c of (await this.all()).filter(c => c.accountId))
      await this.remote(() => candidate.active(c.accountId!, c.toolkit));
    (await this.broker.registerHandle(KEY, key.trim(), INSTALLATION_SCOPE));
    this.client = candidate;
  }
  private backend() {
    if (!this.configured()) throw new ConnectionError('Connections need a Composio project API key configured by the installation administrator', 503);
    return this.client ??= this.factory(this.broker.resolve(KEY, { caps: [`use-credential:${KEY}`] }));
  }
  private async remote<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      if (e instanceof ConnectionError) throw e;
      throw new ConnectionError('The connection provider could not complete this request. Retry or check the account in Connections.', 502);
    }
  }
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    // Publish the lock before yielding for diagnostic settings; otherwise two
    // callers can both observe the same predecessor and run concurrently.
    const waitEnd = currentTiming().then(trace => trace?.start('service.lock.wait'));
    const work = previous.catch(() => {}).then(async () => { await (await waitEnd)?.(); return fn(); });
    this.locks.set(key, work);
    try { return await work; } finally { if (this.locks.get(key) === work) this.locks.delete(key); }
  }
  async all(): Promise<ServiceConnection[]> { return (await this.store.kvEntries(PREFIX)).map(row => JSON.parse(row.value)); }
  async get(org: string, id: string) {
    const raw = (await this.store.kvGet(PREFIX + id));
    const c: ServiceConnection | undefined = raw ? JSON.parse(raw) : undefined;
    if (!c || c.organizationId !== org) throw new ConnectionError('Connection not found', 404);
    return c;
  }
  private async save(c: ServiceConnection) { c.updatedAt = Date.now(); (await this.store.kvSet(PREFIX + c.id, JSON.stringify(c))); return c; }
  view(c: ServiceConnection) {
    const { accountId, sessionId, notifiedAt, ...view } = c;
    return { ...view, ...(c.status === 'disconnected' && accountId ? { disconnectPending: true } : {}) };
  }
  private async user(c: ServiceConnection) {
    return this.store.transaction(async () => {
    if (!c.ownerId) throw new ConnectionError('Connection has no owner');
    (await this.store.lock('kv:service-connections:installation'));
    let installation = (await this.store.kvGet('service-connections:installation'));
    if (!installation) { installation = crypto.randomUUID(); (await this.store.kvSet('service-connections:installation', installation)); }
    return 'karmax_' + crypto.createHash('sha256').update(JSON.stringify([installation, c.organizationId, c.ownerId])).digest('hex');
      });
  }
  canUse(c: ServiceConnection, taskId: string, projectId: string) {
    return c.taskId === taskId || c.projectIds.includes(projectId);
  }
  async list(org: string, ctx: { ownerId?: string; taskId?: string; projectId?: string }) {
    return (await this.all()).filter(c => c.organizationId === org && (ctx.taskId
      ? this.canUse(c, ctx.taskId, ctx.projectId!) : c.ownerId === ctx.ownerId || (!!ctx.projectId && c.projectIds.includes(ctx.projectId)))).map(c => this.view(c));
  }
  async pending(taskId: string) { return (await this.all()).filter(c => c.taskId === taskId && ['requested', 'connecting'].includes(c.status)); }
  async catalog(search = '') { return this.remote(() => this.backend().catalog(search.slice(0, 200))); }
  async request(org: string, toolkit: string, taskId: string, role: string, why: string) {
    return this.store.transaction(async () => {
    this.slug(toolkit);
    // One open request per task and app.
    (await this.store.lock(`service-connections:${org}:${taskId}`));
    const existing = (await this.all()).find(c => c.organizationId === org && c.toolkit === toolkit && c.taskId === taskId && !['disconnected', 'expired'].includes(c.status));
    if (existing) return existing;
    return (await this.save({ id: newId('conn'), organizationId: org, toolkit, label: toolkit,
      taskId, role, why: why.slice(0, 2000), projectIds: [], status: 'requested', createdAt: Date.now(), updatedAt: Date.now() }));
      });
  }
  /** Resolves an agent's MCP request: an MCP Registry name or a public HTTPS URL. */
  async resolveMcp(target: string): Promise<{ transport: RemoteMcpTransport; label: string; registry?: McpServer['registry'] }> {
    target = target.trim();
    if (target.startsWith('https://')) {
      try { const transport = validateTransport({ type: 'http', url: target }) as RemoteMcpTransport; return { transport, label: new URL(transport.url).hostname }; }
      catch (e) { throw new ConnectionError(e instanceof Error ? e.message : 'Invalid MCP server URL'); }
    }
    let entry;
    try { entry = await registryServer(target); } catch (e) { throw new ConnectionError(e instanceof Error ? e.message : 'MCP Registry is unavailable', 502); }
    if (!entry) throw new ConnectionError(`No MCP Registry server is named ${target}`, 404);
    const remote = entry.options.find((o: any) => o.transport.type !== 'stdio');
    if (!remote) throw new ConnectionError('This MCP server runs as a local process. Ask the user to add it in Tools settings.');
    if (remote.fields.some((f: any) => f.isRequired || f.isSecret))
      throw new ConnectionError('This MCP server needs an API key. Ask the user to add it in Tools settings.');
    return { transport: remote.transport as RemoteMcpTransport, label: entry.title && entry.title !== entry.name ? entry.title : entry.name,
      registry: { name: entry.name, version: entry.version } };
  }
  async requestMcp(org: string, server: Awaited<ReturnType<ServiceConnections['resolveMcp']>>, taskId: string, role: string, why: string) {
    const open = async () => (await this.all()).find(c => c.organizationId === org && c.mcp?.url === server.transport.url && c.taskId === taskId && !['disconnected', 'expired'].includes(c.status));
    const prior = (await open());
    if (prior) return prior;
    let auth: McpServer['auth'];
    try { auth = await remoteMcpAuth(server.transport); } catch { throw new ConnectionError('Could not reach that MCP server. Check its URL.', 502); }
    return this.store.transaction(async () => (await this.store.lock(`service-connections:${org}:${taskId}`), await open()) ?? (await this.save({ id: newId('conn'), organizationId: org,
      toolkit: `mcp:${server.registry?.name ?? new URL(server.transport.url).hostname}`.slice(0, 120), label: server.label.slice(0, 120),
      mcp: { ...server.transport, auth, ...(server.registry ? { registry: server.registry } : {}) },
      taskId, role, why: why.slice(0, 2000), projectIds: [], status: 'requested', createdAt: Date.now(), updatedAt: Date.now() })));
  }
  private slug(value: string) { if (!/^[a-z][a-z0-9_]{0,79}$/.test(value)) throw new ConnectionError('Invalid app identifier'); }
  private sameApp(a: ServiceConnection, b: ServiceConnection) { return a.mcp ? a.mcp.url === b.mcp?.url : !b.mcp && a.toolkit === b.toolkit; }
  /** An account the person connected themselves, rather than a grant of one. */
  private isAccount(c: ServiceConnection) { return !c.grantedConnectionId && c.status === 'active' && (c.mcp ? true : !!c.accountId); }
  /** The person's own connected accounts that a task request can use without another sign-in, newest first. */
  async reusable(org: string, ownerId: string, app: string | ServiceConnection) {
    const wanted = typeof app === 'string' ? { toolkit: app } as ServiceConnection : app;
    return (await this.all()).filter(c => c.organizationId === org && c.ownerId === ownerId && this.sameApp(wanted, c) && this.isAccount(c))
      .sort((a, b) => b.createdAt - a.createdAt).map(c => this.view(c));
  }
  async connect(org: string, ownerId: string, input: { id?: string; toolkit?: string; label?: string; restart?: boolean; useConnectionId?: string; redirect?: string }) {
    return this.locked(input.id ?? `${org}:${ownerId}:${input.toolkit}`, async () => {
      let c = input.id ? (await this.get(org, input.id)) : undefined;
      if (c?.ownerId && c.ownerId !== ownerId) throw new ConnectionError('This connection belongs to another person', 403);
      if (c?.status === 'active') return { connection: this.view(c) };
      if (input.useConnectionId) {
        if (!c?.taskId) throw new ConnectionError('Only a task request can use an existing account');
        const account = (await this.get(org, input.useConnectionId));
        if (account.ownerId !== ownerId) throw new ConnectionError('This connection belongs to another person', 403);
        if (!this.sameApp(c, account) || !this.isAccount(account)) throw new ConnectionError('That account is not connected for this app');
        // An unfinished sign-in for this request is no longer needed.
        if (c.accountId) await this.remote(() => this.backend().disconnect(c!.accountId!));
        if (c.mcp) (await this.broker.deleteHandle(MCP_CREDENTIALS + c.id));
        Object.assign(c, { ownerId, label: account.label, grantedConnectionId: account.id, status: 'active',
          accountId: undefined, sessionId: undefined, notifiedAt: undefined });
        (await this.broker.deleteHandle(PREFIX + c.id)); (await this.save(c));
        (await this.audit(c, ownerId, 'granted'));
        return { connection: this.view(c) };
      }
      if (c?.mcp) return this.connectMcp(c, ownerId, input.redirect);
      const toolkit = c?.toolkit ?? input.toolkit ?? '';
      this.slug(toolkit);
      if (input.restart && c?.status === 'connecting' && c.accountId && await this.remote(() => this.backend().active(c!.accountId!, toolkit))) {
        c.sessionId = await this.remote(async () => this.backend().session((await this.user(c!)), toolkit, c!.accountId!));
        c.status = 'active'; c.notifiedAt = undefined;
        (await this.broker.deleteHandle(PREFIX + c.id)); (await this.save(c));
        return { connection: this.view(c) };
      }
      if (!input.restart && c?.status === 'connecting' && Date.now() - c.updatedAt < TTL && this.broker.hasHandle(PREFIX + c.id))
        return { connection: this.view(c), url: this.broker.resolve(PREFIX + c.id, { caps: [`use-credential:${PREFIX + c.id}`] }) };
      c ??= { id: newId('conn'), organizationId: org, toolkit, label: (input.label || toolkit).slice(0, 120),
        projectIds: [], status: 'requested', createdAt: Date.now(), updatedAt: Date.now() };
      c.ownerId = ownerId; c.grantedConnectionId = undefined;
      // Retire the previous provider account before replacing its only local
      // reference, so failed/abandoned sign-ins cannot leave orphaned accounts.
      if (c.accountId) {
        await this.remote(() => this.backend().disconnect(c!.accountId!));
        c.accountId = undefined; c.sessionId = undefined; c.status = 'expired'; c.notifiedAt = undefined;
        (await this.broker.deleteHandle(PREFIX + c.id)); (await this.save(c));
      }
      const auth = await this.remote(async () => this.backend().authorize((await this.user(c!)), toolkit));
      const url = new URL(auth.url);
      if (url.protocol !== 'https:' || url.hostname !== 'connect.composio.dev' || url.username || url.password)
        throw new ConnectionError('The provider returned an invalid connection URL', 502);
      // A returned account id is trusted only because it came from our own
      // server-side authorize call; a browser callback never supplies it.
      c.accountId = auth.id; c.sessionId = undefined; c.notifiedAt = undefined; c.status = 'connecting';
      (await this.broker.registerHandle(PREFIX + c.id, auth.url, organizationScope(c.organizationId)));
      (await this.save(c));
      return { connection: this.view(c), url: auth.url };
    });
  }
  /** Signs the owner in to a native MCP server. Each sign-in stores fresh credentials. */
  private async connectMcp(c: ServiceConnection, ownerId: string, redirect?: string) {
    Object.assign(c, { ownerId, grantedConnectionId: undefined, revision: crypto.randomUUID(), notifiedAt: undefined });
    (await this.broker.deleteHandle(MCP_CREDENTIALS + c.id));
    if (c.mcp!.auth === 'none') { c.status = 'active'; (await this.save(c)); (await this.audit(c, ownerId, 'connected')); return { connection: this.view(c) }; }
    if (!redirect) throw new ConnectionError('Configure the public Tavya URL before signing in to MCP servers', 503);
    c.status = 'connecting'; (await this.save(c));
    try {
      const { authorizationUrl } = await beginOAuth(this.vault, this.target(c), `user:${ownerId}`, redirect);
      return { connection: this.view(c), url: authorizationUrl, callback: 'mcp' as const };
    } catch (e) { throw new ConnectionError(e instanceof Error ? e.message : 'MCP authorization failed', 502); }
  }
  /** Completes the owner's MCP sign-in from the browser callback's state and code. */
  async finishMcp(org: string, id: string, ownerId: string, state: unknown, code: unknown) {
    return this.locked(id, async () => {
      const c = (await this.get(org, id));
      if (!c.mcp || c.ownerId !== ownerId) throw new ConnectionError('Only the connection owner can finish this sign-in', 403);
      if (c.status !== 'connecting') throw new ConnectionError('This sign-in is no longer pending. Connect again.', 409);
      try { await finishOAuth(this.vault, this.target(c), `user:${ownerId}`, state as string, code as string); }
      catch (e) { throw new ConnectionError(e instanceof Error ? e.message : 'MCP authorization failed'); }
      c.status = 'active'; c.notifiedAt = undefined;
      (await this.save(c)); (await this.audit(c, ownerId, 'connected'));
      return this.view(c);
    });
  }
  async refresh(org: string, id: string) {
    return this.locked(id, async () => {
      const c = (await this.get(org, id));
      if (c.mcp) {
        // MCP sign-in completes only through its callback; abandoned sign-ins expire.
        if (c.status === 'connecting' && Date.now() - c.updatedAt > TTL) { c.status = 'expired'; c.notifiedAt = undefined; (await this.save(c)); }
        return c;
      }
      if (!['connecting', 'active'].includes(c.status) || !c.accountId) return c;
      const active = await this.remote(() => this.backend().active(c.accountId!, c.toolkit));
      if (active && c.status === 'connecting') {
        c.sessionId = await this.remote(async () => this.backend().session((await this.user(c)), c.toolkit, c.accountId!));
        c.status = 'active'; c.notifiedAt = undefined;
        (await this.broker.deleteHandle(PREFIX + c.id));
        (await this.save(c));
      } else if (!active && (c.status === 'active' || Date.now() - c.updatedAt > TTL)) {
        c.status = 'expired'; c.sessionId = undefined; c.notifiedAt = undefined;
        (await this.broker.deleteHandle(PREFIX + c.id)); (await this.save(c));
      }
      return c;
    });
  }
  async share(org: string, id: string, ownerId: string, projectIds: string[]) {
    return this.locked(id, async () => {
    const c = (await this.get(org, id));
    if (c.ownerId !== ownerId) throw new ConnectionError('Only the connection owner can change access', 403);
    if (projectIds.length > 100 || (await __asyncCollections.some(projectIds, async id => (await this.store.getProject(id))?.organizationId !== org)))
      throw new ConnectionError('Projects must belong to this organization');
    c.projectIds = [...new Set(projectIds)];
    (await this.audit(c, ownerId, 'access-changed'));
    return this.view((await this.save(c)));
    });
  }
  async disconnect(org: string, id: string, ownerId: string) {
    return this.locked(id, async () => {
      const c = (await this.get(org, id));
      if (c.ownerId && c.ownerId !== ownerId) throw new ConnectionError('Only the connection owner can disconnect', 403);
      // Revoke local access first, even if upstream deletion is unavailable.
      if (!['disconnected', 'denied'].includes(c.status)) c.notifiedAt = undefined;
      c.status = c.ownerId ? 'disconnected' : 'denied'; c.projectIds = []; c.sessionId = undefined;
      (await this.save(c)); (await this.broker.deleteHandle(PREFIX + id)); (await this.broker.deleteHandle(MCP_CREDENTIALS + id));
      for (const grant of (await this.all()).filter(g => g.grantedConnectionId === c.id && g.status !== 'disconnected'))
        (await this.save({ ...grant, status: 'disconnected', notifiedAt: undefined }));
      if (c.accountId) { await this.remote(() => this.backend().disconnect(c.accountId!)); c.accountId = undefined; (await this.save(c)); }
      (await this.audit(c, ownerId, 'disconnected'));
      return this.view(c);
    });
  }
  private async authorized(org: string, id: string, taskId: string, projectId: string) {
    const c = (await this.get(org, id));
    if (!c.ownerId || !(await this.store.organizationMembership(org, c.ownerId))) throw new ConnectionError('The account owner is no longer a member of this organization', 403);
    if (!this.canUse(c, taskId, projectId)) throw new ConnectionError('This account has not been shared with this task or project', 403);
    const account = c.grantedConnectionId && c.status === 'active' ? (await this.get(org, c.grantedConnectionId)) : c;
    if (c.status !== 'active' || account.ownerId !== c.ownerId || account.status !== 'active' || !(account.mcp || account.sessionId))
      throw new ConnectionError('Reconnect this account in Connections before using it', 409);
    return account;
  }
  async tools(org: string, id: string, taskId: string, projectId: string, search: string) {
    const c = (await this.authorized(org, id, taskId, projectId));
    if (c.mcp) return timed('service.catalog.remote', () => this.mcpCall(c, taskId, async client => {
      const tools = [];
      for (let cursor: string | undefined, page = 0; page < 10 && (page === 0 || cursor); page++) {
        const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
        tools.push(...result.tools); cursor = result.nextCursor;
      }
      const words = search.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
      const matches = tools.filter(t => words.some(w => `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase().includes(w)));
      return (matches.length ? matches : tools).slice(0, 30).map(t => ({ slug: t.name, name: t.title ?? t.name, description: t.description, inputParameters: t.inputSchema }));
    }));
    return timed('service.catalog.remote', () => this.remote(() => this.backend().tools(c.toolkit, search.slice(0, 200))));
  }
  async execute(org: string, id: string, taskId: string, projectId: string, slug: string, args: Record<string, unknown>) {
    return this.locked(id, async () => {
      const c = (await this.authorized(org, id, taskId, projectId));
      if (c.mcp) {
        if (!/^[A-Za-z0-9_.\-/]{1,128}$/.test(slug)) throw new ConnectionError('Invalid tool name');
        (await this.audit(c, `task:${taskId}`, 'execute', slug));
        return timed('service.action.remote', () => this.mcpCall(c, taskId, client => client.callTool({ name: slug, arguments: args }, undefined, { timeout: 60_000 })), undefined, toolFailed);
      }
      // The session is pinned to exactly one toolkit and connected account.
      // Reject meta-tools, including proxy, remote bash and connection managers.
      if (!/^[A-Z][A-Z0-9_]{1,199}$/.test(slug) || !slug.startsWith(c.toolkit.toUpperCase() + '_') || slug.startsWith('COMPOSIO_'))
        throw new ConnectionError('Tool does not belong to this connection', 403);
      if (!await timed('service.account-check.remote', () => this.remote(() => this.backend().active(c.accountId!, c.toolkit)))) {
        c.status = 'expired'; c.sessionId = undefined; (await this.save(c));
        throw new ConnectionError('Account access expired; reconnect it in Connections', 409);
      }
      // Membership may have changed while checking the provider account.
      (await this.authorized(org, id, taskId, projectId));
      (await this.audit(c, `task:${taskId}`, 'execute', slug));
      return timed('service.action.remote', () => this.remote(async () => (await this.backend().execute(c.sessionId!, slug, args))), undefined, toolFailed);
    });
  }
  /** One bounded MCP session with the account's current credentials. Never retried. */
  private async mcpCall<T>(c: ServiceConnection, taskId: string, run: (client: Awaited<ReturnType<OpenMcp>>) => Promise<T>): Promise<T> {
    let headers: Record<string, string>;
    try { headers = await connectionHeaders(this.vault, this.target(c), taskId); }
    catch { throw new ConnectionError('Account access expired; reconnect it in Connections', 409); }
    let client: Awaited<ReturnType<OpenMcp>> | undefined;
    try {
      client = await this.openMcp({ type: c.mcp!.type, url: c.mcp!.url }, headers);
      return await run(client);
    } catch (e) {
      if (e instanceof ConnectionError) throw e;
      throw new ConnectionError('The MCP server could not complete this request. Retry or reconnect the account.', 502);
    } finally { await client?.close().catch(() => {}); }
  }
  private async audit(c: ServiceConnection, principalId: string, action: string, tool?: string) {
    (await this.store.appendAudit({ principalId, action: `connection.${action}`, scopeKey: c.organizationId,
      detail: { connectionId: c.id, toolkit: c.toolkit, ...(tool ? { tool } : {}) } }));
  }
  /** Durable polling/outbox: a restart retries unfinished auth and undelivered
   * task notifications. Provider callbacks and browser query strings are not proof. */
  async reconcile(resume: (c: ServiceConnection) => Promise<boolean>) {
    for (const c of (await this.all())) {
      try {
        let current = c.status === 'connecting' ? await this.refresh(c.organizationId, c.id) : c;
        if (c.status === 'disconnected' && c.accountId && c.ownerId) {
          try { await this.disconnect(c.organizationId, c.id, c.ownerId); } catch { /* local revocation already succeeded; retry cleanup next sweep */ }
          current = (await this.get(c.organizationId, c.id));
        }
        if (current.taskId && !current.notifiedAt && ['active', 'expired', 'disconnected', 'denied'].includes(current.status)) {
          if (await resume(current)) { const latest = (await this.get(current.organizationId, current.id));
            if (latest.status === current.status) { latest.notifiedAt = Date.now(); (await this.save(latest)); } }
        }
      } catch { /* retry transient provider/delivery failures on the next sweep */ }
    }
  }
}
