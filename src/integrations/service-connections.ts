import crypto from 'node:crypto';
import Composio from '@composio/client';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import { newId } from '../util/id.js';

const PREFIX = 'service-connection:';
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
  notifiedAt?: number;
}
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
    private factory: (key: string) => ConnectionBackend = key => new ComposioBackend(key)) {}

  configured() { return this.broker.hasHandle(KEY); }
  async configure(key: string) {
    if (!key.trim()) throw new ConnectionError('Composio project API key is required');
    // Verify before rotating a working key. Raw provider errors can contain secrets.
    const candidate = this.factory(key.trim());
    await this.remote(() => candidate.catalog('gmail'));
    // A rotated key must still address the same project’s existing accounts.
    // Changing projects would orphan their grants and sessions.
    for (const c of this.all().filter(c => c.accountId))
      await this.remote(() => candidate.active(c.accountId!, c.toolkit));
    this.broker.registerHandle(KEY, key.trim());
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
    const work = previous.catch(() => {}).then(fn);
    this.locks.set(key, work);
    try { return await work; } finally { if (this.locks.get(key) === work) this.locks.delete(key); }
  }
  all(): ServiceConnection[] { return this.store.kvEntries(PREFIX).map(row => JSON.parse(row.value)); }
  get(org: string, id: string) {
    const raw = this.store.kvGet(PREFIX + id);
    const c: ServiceConnection | undefined = raw ? JSON.parse(raw) : undefined;
    if (!c || c.organizationId !== org) throw new ConnectionError('Connection not found', 404);
    return c;
  }
  private save(c: ServiceConnection) { c.updatedAt = Date.now(); this.store.kvSet(PREFIX + c.id, JSON.stringify(c)); return c; }
  view(c: ServiceConnection) {
    const { accountId, sessionId, notifiedAt, ...view } = c;
    return { ...view, ...(c.status === 'disconnected' && accountId ? { disconnectPending: true } : {}) };
  }
  private user(c: ServiceConnection) {
    if (!c.ownerId) throw new ConnectionError('Connection has no owner');
    let installation = this.store.kvGet('service-connections:installation');
    if (!installation) { installation = crypto.randomUUID(); this.store.kvSet('service-connections:installation', installation); }
    return 'karmax_' + crypto.createHash('sha256').update(JSON.stringify([installation, c.organizationId, c.ownerId])).digest('hex');
  }
  canUse(c: ServiceConnection, taskId: string, projectId: string) {
    return c.taskId === taskId || c.projectIds.includes(projectId);
  }
  list(org: string, ctx: { ownerId?: string; taskId?: string; projectId?: string }) {
    return this.all().filter(c => c.organizationId === org && (ctx.taskId
      ? this.canUse(c, ctx.taskId, ctx.projectId!) : c.ownerId === ctx.ownerId)).map(c => this.view(c));
  }
  pending(taskId: string) { return this.all().filter(c => c.taskId === taskId && ['requested', 'connecting'].includes(c.status)); }
  async catalog(search = '') { return this.remote(() => this.backend().catalog(search.slice(0, 200))); }
  request(org: string, toolkit: string, taskId: string, role: string, why: string) {
    this.slug(toolkit);
    const existing = this.all().find(c => c.organizationId === org && c.toolkit === toolkit && c.taskId === taskId && !['disconnected', 'expired'].includes(c.status));
    if (existing) return existing;
    return this.save({ id: newId('conn'), organizationId: org, toolkit, label: toolkit,
      taskId, role, why: why.slice(0, 2000), projectIds: [], status: 'requested', createdAt: Date.now(), updatedAt: Date.now() });
  }
  private slug(value: string) { if (!/^[a-z][a-z0-9_]{0,79}$/.test(value)) throw new ConnectionError('Invalid app identifier'); }
  async connect(org: string, ownerId: string, input: { id?: string; toolkit?: string; label?: string }) {
    return this.locked(input.id ?? `${org}:${ownerId}:${input.toolkit}`, async () => {
      let c = input.id ? this.get(org, input.id) : undefined;
      if (c?.ownerId && c.ownerId !== ownerId) throw new ConnectionError('This connection belongs to another person', 403);
      if (c?.status === 'active') return { connection: this.view(c) };
      const toolkit = c?.toolkit ?? input.toolkit ?? '';
      this.slug(toolkit);
      if (c?.status === 'connecting' && Date.now() - c.updatedAt < TTL && this.broker.hasHandle(PREFIX + c.id))
        return { connection: this.view(c), url: this.broker.resolve(PREFIX + c.id, { caps: [`use-credential:${PREFIX + c.id}`] }) };
      c ??= { id: newId('conn'), organizationId: org, toolkit, label: (input.label || toolkit).slice(0, 120),
        projectIds: [], status: 'requested', createdAt: Date.now(), updatedAt: Date.now() };
      c.ownerId = ownerId;
      // Retire the previous provider account before replacing its only local
      // reference, so failed/abandoned sign-ins cannot leave orphaned accounts.
      if (c.accountId) {
        await this.remote(() => this.backend().disconnect(c!.accountId!));
        c.accountId = undefined; c.sessionId = undefined; c.status = 'expired'; c.notifiedAt = undefined;
        this.broker.deleteHandle(PREFIX + c.id); this.save(c);
      }
      const auth = await this.remote(() => this.backend().authorize(this.user(c!), toolkit));
      const url = new URL(auth.url);
      if (url.protocol !== 'https:' || url.hostname !== 'connect.composio.dev' || url.username || url.password)
        throw new ConnectionError('The provider returned an invalid connection URL', 502);
      // A returned account id is trusted only because it came from our own
      // server-side authorize call; a browser callback never supplies it.
      c.accountId = auth.id; c.sessionId = undefined; c.notifiedAt = undefined; c.status = 'connecting';
      this.broker.registerHandle(PREFIX + c.id, auth.url);
      this.save(c);
      return { connection: this.view(c), url: auth.url };
    });
  }
  async refresh(org: string, id: string) {
    return this.locked(id, async () => {
      const c = this.get(org, id);
      if (!['connecting', 'active'].includes(c.status) || !c.accountId) return c;
      const active = await this.remote(() => this.backend().active(c.accountId!, c.toolkit));
      if (active && c.status === 'connecting') {
        c.sessionId = await this.remote(() => this.backend().session(this.user(c), c.toolkit, c.accountId!));
        c.status = 'active'; c.notifiedAt = undefined;
        this.broker.deleteHandle(PREFIX + c.id);
        this.save(c);
      } else if (!active && (c.status === 'active' || Date.now() - c.updatedAt > TTL)) {
        c.status = 'expired'; c.sessionId = undefined; c.notifiedAt = undefined;
        this.broker.deleteHandle(PREFIX + c.id); this.save(c);
      }
      return c;
    });
  }
  async share(org: string, id: string, ownerId: string, projectIds: string[]) {
    return this.locked(id, async () => {
    const c = this.get(org, id);
    if (c.ownerId !== ownerId) throw new ConnectionError('Only the connection owner can change access', 403);
    if (projectIds.length > 100 || projectIds.some(id => this.store.getProject(id)?.organizationId !== org))
      throw new ConnectionError('Projects must belong to this organization');
    c.projectIds = [...new Set(projectIds)];
    this.audit(c, ownerId, 'access-changed');
    return this.view(this.save(c));
    });
  }
  async disconnect(org: string, id: string, ownerId: string) {
    return this.locked(id, async () => {
      const c = this.get(org, id);
      if (c.ownerId && c.ownerId !== ownerId) throw new ConnectionError('Only the connection owner can disconnect', 403);
      // Revoke local access first, even if upstream deletion is unavailable.
      if (!['disconnected', 'denied'].includes(c.status)) c.notifiedAt = undefined;
      c.status = c.ownerId ? 'disconnected' : 'denied'; c.projectIds = []; c.sessionId = undefined;
      this.save(c); this.broker.deleteHandle(PREFIX + id);
      if (c.accountId) { await this.remote(() => this.backend().disconnect(c.accountId!)); c.accountId = undefined; this.save(c); }
      this.audit(c, ownerId, 'disconnected');
      return this.view(c);
    });
  }
  private authorized(org: string, id: string, taskId: string, projectId: string) {
    const c = this.get(org, id);
    if (!c.ownerId || !this.store.organizationMembership(org, c.ownerId)) throw new ConnectionError('The account owner is no longer a member of this organization', 403);
    if (!this.canUse(c, taskId, projectId)) throw new ConnectionError('This account has not been shared with this task or project', 403);
    if (c.status !== 'active' || !c.sessionId) throw new ConnectionError('Reconnect this account in Connections before using it', 409);
    return c;
  }
  async tools(org: string, id: string, taskId: string, projectId: string, search: string) {
    const c = this.authorized(org, id, taskId, projectId);
    return this.remote(() => this.backend().tools(c.toolkit, search.slice(0, 200)));
  }
  async execute(org: string, id: string, taskId: string, projectId: string, slug: string, args: Record<string, unknown>) {
    return this.locked(id, async () => {
      const c = this.authorized(org, id, taskId, projectId);
      // The session is pinned to exactly one toolkit and connected account.
      // Reject meta-tools, including proxy, remote bash and connection managers.
      if (!/^[A-Z][A-Z0-9_]{1,199}$/.test(slug) || !slug.startsWith(c.toolkit.toUpperCase() + '_') || slug.startsWith('COMPOSIO_'))
        throw new ConnectionError('Tool does not belong to this connection', 403);
      if (!await this.remote(() => this.backend().active(c.accountId!, c.toolkit))) {
        c.status = 'expired'; c.sessionId = undefined; this.save(c);
        throw new ConnectionError('Account access expired; reconnect it in Connections', 409);
      }
      // Membership may have changed while checking the provider account.
      this.authorized(org, id, taskId, projectId);
      this.audit(c, `task:${taskId}`, 'execute', slug);
      return this.remote(() => this.backend().execute(c.sessionId!, slug, args));
    });
  }
  private audit(c: ServiceConnection, principalId: string, action: string, tool?: string) {
    this.store.appendAudit({ principalId, action: `connection.${action}`, scopeKey: c.organizationId,
      detail: { connectionId: c.id, toolkit: c.toolkit, ...(tool ? { tool } : {}) } });
  }
  /** Durable polling/outbox: a restart retries unfinished auth and undelivered
   * task notifications. Provider callbacks and browser query strings are not proof. */
  async reconcile(resume: (c: ServiceConnection) => Promise<boolean>) {
    for (const c of this.all()) {
      try {
        let current = c.status === 'connecting' ? await this.refresh(c.organizationId, c.id) : c;
        if (c.status === 'disconnected' && c.accountId && c.ownerId) {
          try { await this.disconnect(c.organizationId, c.id, c.ownerId); } catch { /* local revocation already succeeded; retry cleanup next sweep */ }
          current = this.get(c.organizationId, c.id);
        }
        if (current.taskId && !current.notifiedAt && ['active', 'expired', 'disconnected', 'denied'].includes(current.status)) {
          if (await resume(current)) { const latest = this.get(current.organizationId, current.id);
            if (latest.status === current.status) { latest.notifiedAt = Date.now(); this.save(latest); } }
        }
      } catch { /* retry transient provider/delivery failures on the next sweep */ }
    }
  }
}
