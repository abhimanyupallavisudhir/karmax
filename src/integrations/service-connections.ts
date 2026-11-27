import * as __asyncCollections from '../util/async-collections.js';
import { currentTiming, timed, toolFailed } from '../timing/index.js';
import crypto from 'node:crypto';
import Composio from '@composio/client';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE, organizationScope } from '../autonomy/vault-keys.js';
import { newId } from '../util/id.js';
import { CONNECTION_PREFIX as PREFIX, OPEN_CONNECTION as OPEN } from './connection-requests.js';
import { delegatingAncestors } from '../platform/delegation.js';
import type { Via } from '../platform/sub-task-asks.js';
import { beginOAuth, finishOAuth, connectionHeaders, leasedOAuthRefresh, type OAuthVault, type OAuthTarget } from '../mcp/connections/oauth.js';
import { RefreshLeases } from '../autonomy/refresh-lease.js';
import { authorizesWithGitHub, openRemoteMcp, remoteMcpAuth, type RemoteMcpTransport } from '../mcp/connections/remote.js';
import { registryServer } from '../mcp/connections/registry.js';
import { validateTransport } from '../mcp/connections/store.js';

const MCP_CREDENTIALS = 'service-connection-mcp:';
const KEY = 'service-connections:composio:api-key';
/** Composio Instant (wiki features/service-connections § Paid tools): the
 * installation's switch, and what one call holds on the organization's credit
 * until Composio says what it charged (its prices are descriptions, not limits). */
const INSTANT_KEY = 'service-connections:instant';
export const INSTANT_CALL_HOLD_MICROS = 500_000;
const TTL = 30 * 60_000;
export interface ServiceConnection {
  id: string;
  organizationId: string;
  /** The person whose account it is; absent on a project's account and on a
   *  task's request nobody has answered yet. */
  ownerId?: string;
  /** The project whose account it is: usable by that project's tasks only,
   *  connected and disconnected by its maintainers (people or agents), never
   *  shared with another project, deleted with the project. Its provider
   *  identity is the project's, not the person's who signed in. */
  ownerProjectId?: string;
  /** The person whose GitHub sign-in a project's GitHub-authorized MCP account uses. */
  signedInBy?: string;
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
  /** A sign-in again of this existing account (its id), asked by a task
   * (`requestReconnect`) or started by its owner: it signs in here, apart, and
   * once it completes the account takes its credentials (`adopt`), keeping its
   * id, grants and sharing; until then the account works as before. A task's
   * then becomes its grant of the account; its owner's own is forgotten. */
  reconnects?: string;
  /** Provider accounts a newer sign-in replaced that the provider could not
   * sign out yet: `reconcile` retries. */
  retiring?: string[];
  /** A native MCP server account (instead of a Composio toolkit). Its OAuth
   * credentials stay in the vault; the gateway calls the server for the task. */
  mcp?: McpServer;
  /** Paid through Composio Instant: no account; each call is charged to the
   * organization's credit at what Composio reports (instant_charge). */
  instant?: boolean;
  /** Changes on every sign-in, so a stale OAuth exchange cannot overwrite it. */
  revision?: string;
  notifiedAt?: number;
  /** An open request a person ignored: it no longer notifies anyone, but stays open. */
  dismissed?: { by: string; at: number };
  /** Whom a task's request asks, when its parent named them (sub-task-asks.ts);
   * absent ⇒ its creator and the organization's owners. */
  audience?: string[];
  /** A sub-task's request: the parent it came through, and its agent's note. */
  via?: Via;
}
/** `github`: the server authorizes through GitHub, so the owner signs in with
 * the installation's GitHub App; `githubAccountId` pins the account used. */
export interface McpServer extends RemoteMcpTransport { auth: 'oauth' | 'none' | 'github'; githubAccountId?: string; registry?: { name: string; version: string } }
type OpenMcp = typeof openRemoteMcp;
/** The installation's GitHub App, as a person's GitHub sign-in. */
export interface GitHubSignIn {
  /** The person's signed-in GitHub account (their active one), if any. */
  account(userId: string): Promise<string | undefined>;
  token(userId: string, accountId: string): Promise<string>;
  /** Where the person signs in to GitHub; returning finishes their pending GitHub connections. */
  authorizationUrl(organizationId: string, userId: string): Promise<string>;
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
  /** Composio Instant: whether any of the toolkit's tools can be paid from the installation's wallet. */
  instantSupported?(toolkit: string): Promise<boolean>;
  /** A session whose calls Composio pays and reports (instant_charge). */
  instantSession?(userId: string, toolkit: string): Promise<string>;
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
  // Instant's fields (docs.composio.dev/docs/instant-tools) postdate the pinned
  // client's types; it sends them as given.
  async instantSupported(toolkit: string) {
    const query = { toolkit_slug: toolkit, limit: 50, include_pricing: true, toolkit_versions: 'latest' };
    const page = await this.client.tools.list(query as unknown as Parameters<Composio['tools']['list']>[0]);
    return page.items.some((tool) => (tool as { instant?: { supported?: boolean } }).instant?.supported === true);
  }
  async instantSession(userId: string, toolkit: string) {
    const body = { user_id: userId, toolkits: { enable: [toolkit] }, instant: { toolkits: { enable: [toolkit] }, return_instant_charge: true },
      multi_account: { enable: false }, manage_connections: { enable: false }, workbench: { enable: false } };
    return (await this.client.toolRouter.session.create(body as unknown as Parameters<Composio['toolRouter']['session']['create']>[0])).session_id;
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
    private openMcp: OpenMcp = openRemoteMcp, private github?: GitHubSignIn) {}
  private vault: OAuthVault = {
    secret: async (c) => {
      const handle = MCP_CREDENTIALS + c.id;
      return await this.broker.hasHandle(handle) ? JSON.parse(await this.broker.resolve(handle, { caps: [`use-credential:${handle}`] })) : {};
    },
    setSecret: async (c, value) => {
      if ((await this.get(c.organizationId, c.id)).revision !== c.revision) throw new Error('Connection changed during authorization. Connect again.');
      (await this.broker.registerHandle(MCP_CREDENTIALS + c.id, JSON.stringify(value), organizationScope(c.organizationId)));
    },
    refresh: (c, _taskId, observed, run) => {
      const handle = MCP_CREDENTIALS + c.id;
      return leasedOAuthRefresh(new RefreshLeases(this.store.db), handle, observed,
        async () => await this.broker.hasHandle(handle) ? this.broker.resolve(handle, { caps: [`use-credential:${handle}`] }) : undefined,
        async (current, next, held) => (await this.store.lock(`vault:${c.organizationId}`), await held())
          && (await this.get(c.organizationId, c.id)).revision === c.revision
          && this.broker.replaceHandleIfUnchanged(handle, current, next, organizationScope(c.organizationId)),
        run);
    },
  };
  private target(c: ServiceConnection): OAuthTarget {
    return { id: c.id, organizationId: c.organizationId, projectId: c.ownerProjectId, label: c.label, auth: c.mcp!.auth === 'github' ? 'oauth' : c.mcp!.auth,
      transport: { type: c.mcp!.type, url: c.mcp!.url }, revision: c.revision ?? '' };
  }

  configured(): Promise<boolean> { return this.broker.hasHandle(KEY); }
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
  private async backend() {
    if (!await this.configured()) throw new ConnectionError('Connections need a Composio project API key configured by the installation administrator', 503);
    return this.client ??= this.factory(await this.broker.resolve(KEY, { caps: [`use-credential:${KEY}`] }));
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
  /** Whether agents may use paid tools through Composio Instant, on their organization's credit. */
  async instantEnabled(): Promise<boolean> { return (await this.store.kvGet(INSTANT_KEY)) === 'on'; }
  async setInstant(enabled: boolean) {
    if (enabled && !await this.configured()) throw new ConnectionError('Save the Composio key first');
    (await this.store.kvSet(INSTANT_KEY, enabled ? 'on' : 'off'));
  }
  /** The provider identity an organization's Instant sessions run under. */
  private async instantUser(org: string) {
    const installation = (await this.store.kvGet('service-connections:installation')) ?? 'installation';
    return 'karmax_' + crypto.createHash('sha256').update(JSON.stringify([installation, org, 'instant'])).digest('hex');
  }
  async all(): Promise<ServiceConnection[]> { return (await this.store.kvEntries(PREFIX)).map(row => JSON.parse(row.value)); }
  async get(org: string, id: string) {
    const raw = (await this.store.kvGet(PREFIX + id));
    const c: ServiceConnection | undefined = raw ? JSON.parse(raw) : undefined;
    if (!c || c.organizationId !== org) throw new ConnectionError('Connection not found', 404);
    return c;
  }
  private async save(c: ServiceConnection) {
    c.updatedAt = Date.now();
    // Ignoring silences one open request; an account that later needs attention asks afresh.
    if (!OPEN.includes(c.status)) delete c.dismissed;
    if (!c.taskId) { (await this.store.kvSet(PREFIX + c.id, JSON.stringify(c))); return c; }
    // A task's request is announced on the task with the write that changed it,
    // whichever path changed it: its conversation and inbox follow the events.
    return this.store.transaction(async () => {
      const raw = (await this.store.kvGet(PREFIX + c.id));
      const before: ServiceConnection | undefined = raw ? JSON.parse(raw) : undefined;
      (await this.store.kvSet(PREFIX + c.id, JSON.stringify(c)));
      const announce = async (type: string, payload: Record<string, unknown>) =>
        (await this.store.appendEvent({ taskId: c.taskId!, type, ts: c.updatedAt, payload: { requestId: c.id, ...payload } }));
      // A paid tool (Composio Instant) is usable at once: nobody is asked.
      if (!before) { if (!c.instant) (await announce('connection.requested', { connectionId: c.id, toolkit: c.toolkit, ...(c.why ? { why: c.why } : {}),
        ...(c.via ? { via: c.via } : {}), ...(c.reconnects ? { reconnects: c.reconnects } : {}), ...(c.audience ? { audience: c.audience } : {}),
        ...(c.ownerProjectId ? { ownerProjectId: c.ownerProjectId } : {}) })); }
      else if (before.status !== c.status) (await announce('connection.updated', { connectionId: c.id, status: c.status }));
      if (c.dismissed && !before?.dismissed) (await announce('connection.dismissed', {}));
      return c;
    });
  }
  view(c: ServiceConnection) {
    const { accountId, sessionId, notifiedAt, retiring, ...view } = c;
    return { ...view, ...(c.status === 'disconnected' && accountId ? { disconnectPending: true } : {}) };
  }
  /** Whose account it is: `project:<id>` or `user:<id>`. */
  private actor(c: ServiceConnection): string {
    if (c.ownerProjectId) return `project:${c.ownerProjectId}`;
    if (!c.ownerId) throw new ConnectionError('Connection has no owner');
    return `user:${c.ownerId}`;
  }
  /** The person whose GitHub sign-in a GitHub-authorized account uses. */
  private githubUser(c: ServiceConnection) { return c.ownerProjectId ? c.signedInBy : c.ownerId; }
  private async user(c: ServiceConnection) {
    return this.store.transaction(async () => {
    if (!c.ownerId && !c.ownerProjectId) throw new ConnectionError('Connection has no owner');
    (await this.store.lock('kv:service-connections:installation'));
    let installation = (await this.store.kvGet('service-connections:installation'));
    if (!installation) { installation = crypto.randomUUID(); (await this.store.kvSet('service-connections:installation', installation)); }
    // A project's accounts live under the project's own provider identity, so
    // whichever maintainer signs in, they stay the project's (and never a person's).
    const owner = c.ownerProjectId ? `project:${c.ownerProjectId}` : c.ownerId;
    return 'karmax_' + crypto.createHash('sha256').update(JSON.stringify([installation, c.organizationId, owner])).digest('hex');
      });
  }
  /** `taskIds`: the task and those it acts with the authority of (a sub-task's parents, delegation.ts). */
  canUse(c: ServiceConnection, taskIds: string[], projectId: string) {
    if (c.ownerProjectId) return c.ownerProjectId === projectId;
    return (!!c.taskId && taskIds.includes(c.taskId)) || c.projectIds.includes(projectId);
  }
  /** A task and the tasks whose connections it uses, nearest first. */
  private async taskChain(taskId: string): Promise<string[]> {
    return [taskId, ...(await delegatingAncestors(this.store, taskId)).map((task) => task.id)];
  }
  async list(org: string, ctx: { ownerId?: string; taskId?: string; projectId?: string }) {
    const chain = ctx.taskId ? await this.taskChain(ctx.taskId) : [];
    return (await this.all()).filter(c => c.organizationId === org && (ctx.taskId
      ? this.canUse(c, chain, ctx.projectId!) : (!!ctx.ownerId && c.ownerId === ctx.ownerId) || (!!ctx.projectId && c.projectIds.includes(ctx.projectId)))).map(c => this.view(c));
  }
  async pending(taskId: string) { return (await this.all()).filter(c => c.taskId === taskId && OPEN.includes(c.status)); }
  async catalog(search = '') { return this.remote(async () => (await this.backend()).catalog(search.slice(0, 200))); }
  /** `via`: a sub-task's parent at work, which a new request comes through (sub-task-asks.ts). */
  async request(org: string, toolkit: string, taskId: string, role: string, why: string, via?: Via) {
    this.slug(toolkit);
    // A paid tool Composio's wallet can pay for, when nobody in the
    // organization connected an account of their own: usable at once, each
    // call on the organization's credit. Asked before the transaction: it is a
    // call to Composio.
    const instant = await this.instantEnabled() && !(await this.all()).some(c => c.organizationId === org && c.toolkit === toolkit && this.isAccount(c))
      && await (async () => { const backend = await this.backend(); return !!backend.instantSupported && await backend.instantSupported(toolkit).catch(() => false); })();
    return this.store.transaction(async () => {
    // One open request per task and app.
    (await this.store.lock(`service-connections:${org}:${taskId}`));
    const existing = (await this.all()).find(c => c.organizationId === org && c.toolkit === toolkit && c.taskId === taskId && !['disconnected', 'expired'].includes(c.status));
    if (existing) return existing;
    // A sub-task uses the account its parent connected.
    const ancestors = (await this.taskChain(taskId)).slice(1);
    const inherited = (await this.all()).find(c => c.organizationId === org && c.toolkit === toolkit && c.status === 'active'
      && !!c.taskId && ancestors.includes(c.taskId));
    if (inherited) return inherited;
    if (instant) return (await this.save({ id: newId('conn'), organizationId: org, toolkit, label: toolkit, instant: true,
      taskId, role, why: why.slice(0, 2000), projectIds: [], status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
      ...(via ? { via } : {}) }));
    return (await this.save({ id: newId('conn'), organizationId: org, toolkit, label: toolkit,
      taskId, role, why: why.slice(0, 2000), projectIds: [], status: 'requested', createdAt: Date.now(), updatedAt: Date.now(),
      ...(via ? { via } : {}) }));
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
    if (!remote) throw new ConnectionError('This MCP server runs as a local process. Ask the user to add it in Settings → Connected apps (+ Add custom MCP).');
    if (remote.fields.some((f: any) => f.isRequired || f.isSecret))
      throw new ConnectionError('This MCP server needs an API key. Ask the user to add it in Settings → Connected apps (+ Add custom MCP).');
    return { transport: remote.transport as RemoteMcpTransport, label: entry.title && entry.title !== entry.name ? entry.title : entry.name,
      registry: { name: entry.name, version: entry.version } };
  }
  async requestMcp(org: string, server: Awaited<ReturnType<ServiceConnections['resolveMcp']>>, taskId: string, role: string, why: string, via?: Via) {
    const ancestors = (await this.taskChain(taskId)).slice(1);
    const open = async () => (await this.all()).find(c => c.organizationId === org && c.mcp?.url === server.transport.url && c.taskId === taskId && !['disconnected', 'expired'].includes(c.status))
      ?? (await this.all()).find(c => c.organizationId === org && c.mcp?.url === server.transport.url && c.status === 'active' && !!c.taskId && ancestors.includes(c.taskId));
    const prior = (await open());
    if (prior) return prior;
    let auth: McpServer['auth'];
    try { auth = await remoteMcpAuth(server.transport); } catch { throw new ConnectionError('Could not reach that MCP server. Check its URL.', 502); }
    if (auth === 'oauth' && await authorizesWithGitHub(server.transport)) auth = 'github';
    return this.store.transaction(async () => (await this.store.lock(`service-connections:${org}:${taskId}`), await open()) ?? (await this.save({ id: newId('conn'), organizationId: org,
      toolkit: `mcp:${server.registry?.name ?? new URL(server.transport.url).hostname}`.slice(0, 120), label: server.label.slice(0, 120),
      mcp: { ...server.transport, auth, ...(server.registry ? { registry: server.registry } : {}) },
      taskId, role, why: why.slice(0, 2000), projectIds: [], status: 'requested', createdAt: Date.now(), updatedAt: Date.now(),
      ...(via ? { via } : {}) })));
  }
  /**
   * A task asks for an account it can use to be signed in again: it lacks a
   * permission, or the provider no longer honours it. Only a fresh sign-in can
   * change what the provider granted, so it is never answered with an existing
   * account; it asks whoever the account is (its owner, or the project's
   * maintainers), and the account stays usable until the new sign-in completes.
   */
  async requestReconnect(org: string, connectionId: string, taskId: string, projectId: string, role: string, why: string, via?: Via) {
    const used = (await this.get(org, connectionId));
    if (!this.canUse(used, await this.taskChain(taskId), projectId)) throw new ConnectionError('This account has not been shared with this task or project', 403);
    const account = used.grantedConnectionId ? (await this.get(org, used.grantedConnectionId)) : used;
    if (account.instant) throw new ConnectionError('A paid tool has no account to sign in again', 409);
    if (!['active', 'expired'].includes(account.status) || (!account.ownerId && !account.ownerProjectId))
      throw new ConnectionError(`This account is ${account.status}: ask for the app again with request_connection (mcp or toolkit), not reconnect`, 409);
    return this.store.transaction(async () => {
      (await this.store.lock(`service-connections:${org}:${taskId}`));
      const open = (await this.all()).find(c => c.organizationId === org && c.taskId === taskId && c.reconnects === account.id && OPEN.includes(c.status));
      if (open) return open;
      return this.save({ id: newId('conn'), organizationId: org, toolkit: account.toolkit, label: account.label,
        ...(account.mcp ? { mcp: { ...account.mcp, githubAccountId: undefined } } : {}),
        ...(account.ownerProjectId ? { ownerProjectId: account.ownerProjectId, projectIds: [account.ownerProjectId] }
          : { ownerId: account.ownerId, projectIds: [], audience: [`user:${account.ownerId}`] }),
        taskId, role, why: why.slice(0, 2000), reconnects: account.id, status: 'requested', createdAt: Date.now(), updatedAt: Date.now(),
        ...(via ? { via } : {}) });
    });
  }
  /**
   * A sign-in again has completed: the account it signs in takes its
   * credentials, and the provider account they replace is signed out. A task's
   * request becomes its grant of the account; its owner's own sign-in is
   * forgotten. Returns the account. An account disconnected meanwhile is not
   * revived: the sign-in stays an account of its own.
   */
  private async adopt(r: ServiceConnection): Promise<ServiceConnection> {
    return this.locked(r.reconnects!, async () => {
      const account = await this.get(r.organizationId, r.reconnects!).catch(() => undefined);
      if (!account || ['disconnected', 'denied'].includes(account.status) || account.ownerId !== r.ownerId || account.ownerProjectId !== r.ownerProjectId) {
        r.reconnects = undefined; (await this.save(r));
        return r;
      }
      const replaced = account.accountId !== r.accountId ? account.accountId : undefined;
      if (r.mcp) {
        // Copy before the account's revision changes: a refresh of the old
        // credentials racing this one is then refused (vault.refresh).
        if (r.mcp.auth !== 'none' && r.mcp.auth !== 'github')
          (await this.broker.registerHandle(MCP_CREDENTIALS + account.id, JSON.stringify(await this.vault.secret(r)), organizationScope(account.organizationId)));
        account.mcp = { ...account.mcp!, githubAccountId: r.mcp.githubAccountId };
        if (r.signedInBy) account.signedInBy = r.signedInBy;
      } else Object.assign(account, { accountId: r.accountId, sessionId: r.sessionId });
      if (account.status !== 'active') account.notifiedAt = undefined;
      Object.assign(account, { status: 'active', revision: crypto.randomUUID() });
      if (replaced) account.retiring = [...(account.retiring ?? []), replaced];
      (await this.save(account));
      (await this.audit(account, r.signedInBy ?? r.ownerId ?? this.actor(r), 'reconnected'));
      (await this.broker.deleteHandle(PREFIX + r.id)); (await this.broker.deleteHandle(MCP_CREDENTIALS + r.id));
      if (r.taskId) {
        Object.assign(r, { grantedConnectionId: account.id, label: account.label, accountId: undefined, sessionId: undefined, status: 'active' });
        (await this.save(r));
      } else (await this.store.kvDelete(PREFIX + r.id));
      await this.retire(account).catch(() => { /* reconcile retries */ });
      return r.taskId ? r : account;
    });
  }
  /** A connection whose sign-in just completed: a sign-in again moves onto its account. */
  private async signedIn(c: ServiceConnection) {
    return c.reconnects && c.status === 'active' && !c.grantedConnectionId ? this.adopt(c) : c;
  }
  /** Sign out, at the provider, the accounts a newer sign-in replaced. */
  private async retire(account: ServiceConnection) {
    for (const old of [...(account.retiring ?? [])]) {
      await this.remote(async () => (await this.backend()).disconnect(old));
      const current = (await this.get(account.organizationId, account.id));
      current.retiring = (current.retiring ?? []).filter(id => id !== old);
      if (!current.retiring.length) delete current.retiring;
      (await this.save(current));
    }
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
  /**
   * Sign an account in. `ownerId` is the person signing in; `ownerProjectId`
   * makes it (or a task's request of that project) the project's account,
   * which any of its maintainers — checked by the gateway — may connect,
   * people and agents alike.
   */
  async connect(org: string, ownerId: string | undefined, input: { id?: string; toolkit?: string; label?: string; restart?: boolean; useConnectionId?: string; redirect?: string; ownerProjectId?: string }): Promise<{ connection: ReturnType<ServiceConnections['view']>; url?: string; callback?: 'mcp' | 'github' }> {
    const result = await this.signIn(org, ownerId, input);
    // Signing an account in again goes on outside the account's lock: a sign-in
    // that completes at once moves onto the account, which takes that lock.
    return 'again' in result ? this.connect(org, ownerId, { id: result.again, restart: result.restart, redirect: input.redirect }) : result;
  }
  private async signIn(org: string, ownerId: string | undefined, input: { id?: string; toolkit?: string; label?: string; restart?: boolean; useConnectionId?: string; redirect?: string; ownerProjectId?: string }) {
    return this.locked(input.id ?? `${org}:${input.ownerProjectId ? `project:${input.ownerProjectId}` : ownerId}:${input.toolkit}`, async () => {
      let c = input.id ? (await this.get(org, input.id)) : undefined;
      const project = input.ownerProjectId ?? c?.ownerProjectId;
      if (project) {
        if (c?.ownerProjectId && c.ownerProjectId !== project) throw new ConnectionError('This account belongs to another project', 403);
        if (c?.ownerId) throw new ConnectionError('This account is a person’s. Connect a new one for the project.', 409);
        if ((await this.store.getProject(project))?.organizationId !== org) throw new ConnectionError('Project not found', 404);
        if (c?.taskId && (await this.store.getTask(c.taskId))?.projectId !== project)
          throw new ConnectionError('A task’s request can become only its own project’s account', 403);
        if (input.useConnectionId) throw new ConnectionError('A project’s account is its own sign-in');
      } else {
        if (!ownerId) throw new ConnectionError('Sign in as a person to connect your own account', 403);
        if (c?.ownerId && c.ownerId !== ownerId) throw new ConnectionError('This connection belongs to another person', 403);
      }
      // Signing an account in again happens apart, so it keeps working until the new sign-in completes.
      if (c?.status === 'active' && input.restart && !c.grantedConnectionId && !c.instant && !c.reconnects) {
        const open = (await this.all()).find(r => r.organizationId === org && r.reconnects === c!.id && !r.taskId && OPEN.includes(r.status));
        const r = open ?? (await this.save({ id: newId('conn'), organizationId: org, toolkit: c.toolkit, label: c.label,
          ...(c.mcp ? { mcp: { ...c.mcp, githubAccountId: undefined } } : {}),
          ...(c.ownerProjectId ? { ownerProjectId: c.ownerProjectId, projectIds: [c.ownerProjectId] } : { ownerId: c.ownerId, projectIds: [] }),
          reconnects: c.id, status: 'requested', createdAt: Date.now(), updatedAt: Date.now() }));
        return { again: r.id, restart: !!open };
      }
      if (c?.status === 'active') return { connection: this.view(c) };
      if (c && project) Object.assign(c, { ownerProjectId: project, projectIds: [project], ownerId: undefined });
      if (input.useConnectionId && ownerId) {
        if (!c?.taskId) throw new ConnectionError('Only a task request can use an existing account');
        if (c.reconnects) throw new ConnectionError('Only a new sign-in can change what the account allows: sign in again');
        const account = (await this.get(org, input.useConnectionId));
        if (account.ownerId !== ownerId) throw new ConnectionError('This connection belongs to another person', 403);
        if (!this.sameApp(c, account) || !this.isAccount(account)) throw new ConnectionError('That account is not connected for this app');
        // An unfinished sign-in for this request is no longer needed.
        if (c.accountId) await this.remote(async () => (await this.backend()).disconnect(c!.accountId!));
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
      if (input.restart && c?.status === 'connecting' && c.accountId && await this.remote(async () => (await this.backend()).active(c!.accountId!, toolkit))) {
        c.sessionId = await this.remote(async () => (await this.backend()).session((await this.user(c!)), toolkit, c!.accountId!));
        c.status = 'active'; c.notifiedAt = undefined;
        (await this.broker.deleteHandle(PREFIX + c.id)); (await this.save(c));
        return { connection: this.view(await this.signedIn(c)) };
      }
      if (!input.restart && c?.status === 'connecting' && Date.now() - c.updatedAt < TTL && await this.broker.hasHandle(PREFIX + c.id))
        return { connection: this.view(c), url: await this.broker.resolve(PREFIX + c.id, { caps: [`use-credential:${PREFIX + c.id}`] }) };
      c ??= { id: newId('conn'), organizationId: org, toolkit, label: (input.label || toolkit).slice(0, 120),
        projectIds: project ? [project] : [], ...(project ? { ownerProjectId: project } : {}),
        status: 'requested', createdAt: Date.now(), updatedAt: Date.now() };
      if (!project) c.ownerId = ownerId;
      c.grantedConnectionId = undefined;
      // Retire the previous provider account before replacing its only local
      // reference, so failed/abandoned sign-ins cannot leave orphaned accounts.
      if (c.accountId) {
        await this.remote(async () => (await this.backend()).disconnect(c!.accountId!));
        c.accountId = undefined; c.sessionId = undefined; c.status = 'expired'; c.notifiedAt = undefined;
        (await this.broker.deleteHandle(PREFIX + c.id)); (await this.save(c));
      }
      const auth = await this.remote(async () => (await this.backend()).authorize((await this.user(c!)), toolkit));
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
  private async connectMcp(c: ServiceConnection, ownerId: string | undefined, redirect?: string) {
    Object.assign(c, { ...(c.ownerProjectId ? { signedInBy: ownerId } : { ownerId }), grantedConnectionId: undefined, revision: crypto.randomUUID(), notifiedAt: undefined });
    (await this.broker.deleteHandle(MCP_CREDENTIALS + c.id));
    if (c.mcp!.auth === 'none') { c.status = 'active'; (await this.save(c)); (await this.audit(c, ownerId ?? this.actor(c), 'connected')); return { connection: this.view(await this.signedIn(c)) }; }
    // Requests recorded before GitHub sign-in existed say `oauth`, which GitHub cannot serve.
    if (c.mcp!.auth === 'oauth' && await authorizesWithGitHub(c.mcp!)) c.mcp!.auth = 'github';
    if (c.mcp!.auth === 'github') {
      if (!this.github) throw new ConnectionError('GitHub sign-in is not set up on this installation. Ask its administrator to set up the GitHub App.', 503);
      if (!ownerId) throw new ConnectionError('GitHub sign-in needs a person: ask a project maintainer to connect it', 403);
      c.mcp!.githubAccountId = undefined;
      if (await this.signedInWithGitHub(c)) return { connection: this.view(await this.signedIn(c)) };
      c.status = 'connecting'; (await this.save(c));
      try { return { connection: this.view(c), url: await this.github.authorizationUrl(c.organizationId, ownerId), callback: 'github' as const }; }
      catch (e) { throw new ConnectionError(e instanceof Error ? e.message : 'GitHub sign-in is unavailable', 503); }
    }
    if (!redirect) throw new ConnectionError('Configure the public Tavya URL before signing in to MCP servers', 503);
    c.status = 'connecting'; (await this.save(c));
    try {
      const { authorizationUrl } = await beginOAuth(this.vault, this.target(c), this.actor(c), redirect);
      return { connection: this.view(c), url: authorizationUrl, callback: 'mcp' as const };
    } catch (e) { throw new ConnectionError(e instanceof Error ? e.message : 'MCP authorization failed', 502); }
  }
  /** Activates a GitHub-authorized connection once its owner is signed in to GitHub. */
  private async signedInWithGitHub(c: ServiceConnection) {
    const person = this.githubUser(c);
    const accountId = person ? await this.github?.account(person) : undefined;
    if (!accountId) return false;
    Object.assign(c, { status: 'active', notifiedAt: undefined, mcp: { ...c.mcp!, githubAccountId: accountId } });
    (await this.save(c)); (await this.audit(c, person!, 'connected'));
    return true;
  }
  /** Completes the owner's MCP sign-in from the browser callback's state and code. */
  /** `ownerId`: the person finishing it; a project's account is finished by
   *  any of its maintainers (checked by the gateway), people or agents. */
  async finishMcp(org: string, id: string, ownerId: string | undefined, state: unknown, code: unknown) {
    return this.locked(id, async () => {
      const c = (await this.get(org, id));
      if (!c.mcp || (!c.ownerProjectId && c.ownerId !== ownerId)) throw new ConnectionError('Only the connection owner can finish this sign-in', 403);
      if (c.status !== 'connecting') throw new ConnectionError('This sign-in is no longer pending. Connect again.', 409);
      try { await finishOAuth(this.vault, this.target(c), this.actor(c), state as string, code as string); }
      catch (e) { throw new ConnectionError(e instanceof Error ? e.message : 'MCP authorization failed'); }
      c.status = 'active'; c.notifiedAt = undefined;
      (await this.save(c)); (await this.audit(c, ownerId ?? this.actor(c), 'connected'));
      return this.view(await this.signedIn(c));
    });
  }
  async refresh(org: string, id: string) {
    return this.locked(id, async () => {
      const c = (await this.get(org, id));
      if (c.mcp) {
        // MCP sign-in completes only through its callback (or, for GitHub, the
        // owner's GitHub sign-in); abandoned sign-ins expire.
        if (c.status === 'connecting' && c.mcp.auth === 'github' && this.githubUser(c) && await this.signedInWithGitHub(c)) return this.signedIn(c);
        if (c.status === 'connecting' && Date.now() - c.updatedAt > TTL) { c.status = 'expired'; c.notifiedAt = undefined; (await this.save(c)); }
        return c;
      }
      if (!['connecting', 'active'].includes(c.status) || !c.accountId) return c;
      const active = await this.remote(async () => (await this.backend()).active(c.accountId!, c.toolkit));
      if (active && c.status === 'connecting') {
        c.sessionId = await this.remote(async () => (await this.backend()).session((await this.user(c)), c.toolkit, c.accountId!));
        c.status = 'active'; c.notifiedAt = undefined;
        (await this.broker.deleteHandle(PREFIX + c.id));
        (await this.save(c));
        return this.signedIn(c);
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
    if (c.ownerProjectId) throw new ConnectionError('This account belongs to the project that connected it; only its tasks use it', 403);
    if (c.ownerId !== ownerId) throw new ConnectionError('Only the connection owner can change access', 403);
    if (projectIds.length > 100 || (await __asyncCollections.some(projectIds, async id => (await this.store.getProject(id))?.organizationId !== org)))
      throw new ConnectionError('Projects must belong to this organization');
    c.projectIds = [...new Set(projectIds)];
    (await this.audit(c, ownerId, 'access-changed'));
    return this.view((await this.save(c)));
    });
  }
  /** Silence an open request without answering it: the task keeps waiting. */
  async dismiss(org: string, id: string, by: string) {
    return this.locked(id, async () => {
      const c = (await this.get(org, id));
      if (!OPEN.includes(c.status)) throw new ConnectionError(`This connection is ${c.status}, not a request`);
      c.dismissed ??= { by, at: Date.now() };
      (await this.audit((await this.save(c)), by, 'dismissed'));
      return this.view(c);
    });
  }
  /** `ownerId`: the person disconnecting their own account, else who acts (a
   *  project's maintainers and a request's deciders are checked by the gateway). */
  async disconnect(org: string, id: string, ownerId: string | undefined) {
    return this.locked(id, async () => {
      const c = (await this.get(org, id));
      if (c.ownerId && c.ownerId !== ownerId) throw new ConnectionError('Only the connection owner can disconnect', 403);
      // Revoke local access first, even if upstream deletion is unavailable.
      if (!['disconnected', 'denied'].includes(c.status)) c.notifiedAt = undefined;
      // A project's account stays the project's, to reconnect.
      // A declined request, a sign-in again among them, is denied; an account, disconnected.
      c.status = (c.ownerId || c.ownerProjectId) && !(c.reconnects && !c.grantedConnectionId) ? 'disconnected' : 'denied'; c.projectIds = c.ownerProjectId ? [c.ownerProjectId] : []; c.sessionId = undefined;
      (await this.save(c)); (await this.broker.deleteHandle(PREFIX + id)); (await this.broker.deleteHandle(MCP_CREDENTIALS + id));
      for (const grant of (await this.all()).filter(g => g.grantedConnectionId === c.id && g.status !== 'disconnected'))
        (await this.save({ ...grant, status: 'disconnected', notifiedAt: undefined }));
      if (c.accountId) { await this.remote(async () => (await this.backend()).disconnect(c.accountId!)); c.accountId = undefined; (await this.save(c)); }
      (await this.audit(c, ownerId ?? this.actor(c), 'disconnected'));
      return this.view(c);
    });
  }
  private async authorized(org: string, id: string, taskId: string, projectId: string) {
    const c = (await this.get(org, id));
    // A paid tool (Composio Instant) is no one's account: the task that asked for it, and its sub-tasks, use it.
    if (c.instant) {
      if (!this.canUse(c, await this.taskChain(taskId), projectId)) throw new ConnectionError('This account has not been shared with this task or project', 403);
      if (c.status !== 'active') throw new ConnectionError('This paid tool is no longer available', 409);
      return c;
    }
    if (c.ownerProjectId) {
      if ((await this.store.getProject(c.ownerProjectId))?.organizationId !== org) throw new ConnectionError('The project that owned this account no longer exists', 403);
    } else if (!c.ownerId || !(await this.store.organizationMembership(org, c.ownerId))) throw new ConnectionError('The account owner is no longer a member of this organization', 403);
    if (!this.canUse(c, await this.taskChain(taskId), projectId)) throw new ConnectionError('This account has not been shared with this task or project', 403);
    const account = c.grantedConnectionId && c.status === 'active' ? (await this.get(org, c.grantedConnectionId)) : c;
    if (c.status !== 'active' || account.ownerId !== c.ownerId || account.status !== 'active' || !(account.mcp || account.sessionId))
      throw new ConnectionError(`Reconnect this account in ${c.ownerProjectId ? 'Project settings' : 'Settings'} → Connected apps before using it`, 409);
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
    return timed('service.catalog.remote', () => this.remote(async () => (await this.backend()).tools(c.toolkit, search.slice(0, 200))));
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
      if (c.instant) return this.executeInstant(c, taskId, projectId, slug, args);
      if (!await timed('service.account-check.remote', () => this.remote(async () => (await this.backend()).active(c.accountId!, c.toolkit)))) {
        // Unless a sign-in again replaced the account meanwhile (`adopt`).
        const current = (await this.get(c.organizationId, c.id));
        if (current.accountId === c.accountId) { current.status = 'expired'; current.sessionId = undefined; (await this.save(current)); }
        throw new ConnectionError(`Account access expired; reconnect it in ${c.ownerProjectId ? 'Project settings' : 'Settings'} → Connected apps`, 409);
      }
      // Membership may have changed while checking the provider account.
      (await this.authorized(org, id, taskId, projectId));
      (await this.audit(c, `task:${taskId}`, 'execute', slug));
      // Composio's plan caps tool calls for the whole installation; the
      // operator's service-limits page counts them here (failed ones too).
      try {
        return await timed('service.action.remote', () => this.remote(async () => (await (await this.backend()).execute(c.sessionId!, slug, args))), undefined, toolFailed);
      } finally { await this.store.countServiceUsage('composio.tool-calls').catch(() => {}); }
    });
  }
  /** A paid tool through Composio Instant: hold a bound on the organization's
   * credit, call, book what Composio says it charged, release the hold. */
  private async executeInstant(c: ServiceConnection, taskId: string, projectId: string, slug: string, args: Record<string, unknown>) {
    if (!await this.instantEnabled()) throw new ConnectionError('Paid tools are switched off on this installation', 409);
    const backend = await this.backend();
    if (!backend.instantSession) throw new ConnectionError('Paid tools are unavailable', 409);
    if (!c.sessionId) { c.sessionId = await this.remote(async () => backend.instantSession!(await this.instantUser(c.organizationId), c.toolkit)); (await this.save(c)); }
    const { holdGeneration, ComputeCreditExhausted } = await import('../world/managed-compute.js');
    const holdId = `instant:${crypto.randomUUID()}`;
    const held = await holdGeneration(this.store, { id: holdId, organizationId: c.organizationId, taskId, provider: 'composio',
      costMicros: INSTANT_CALL_HOLD_MICROS, until: Date.now() + 15 * 60_000, what: `a paid ${c.toolkit} call` })
      .catch((e) => { throw e instanceof ComputeCreditExhausted ? new ConnectionError(e.message, 402) : e; });
    (await this.audit(c, `task:${taskId}`, 'execute', slug));
    let result: unknown;
    try {
      result = await timed('service.action.remote', () => this.remote(async () => {
        try { return await backend.execute(c.sessionId!, slug, args); }
        catch (e) {
          if ((e as { status?: number }).status === 402)
            throw new ConnectionError('The installation’s paid-tools balance at Composio has run out, not your credit: nothing was charged. Try again once the operator has topped it up.', 402);
          throw e;
        }
      }), undefined, toolFailed);
      return result;
    } finally {
      await this.store.countServiceUsage('composio.tool-calls').catch(() => {});
      const charge = (result as { instant_charge?: { amount?: unknown }; log_id?: unknown } | undefined);
      const amount = Number(charge?.instant_charge?.amount);
      if (Number.isFinite(amount) && amount > 0)
        (await this.store.recordUsage({ id: `usage:composio:${typeof charge?.log_id === 'string' ? charge.log_id : crypto.randomUUID()}`,
          organizationId: c.organizationId, projectId, taskId, provider: 'composio', kind: 'agent.cost', quantity: 0, unit: 'request',
          costMicros: Math.round(amount * 1e6), startedAt: Date.now(), endedAt: Date.now(), fundingSource: 'managed', costClassification: 'incurred',
          metadata: { tool: slug, costBasis: 'composio-instant-charge' } }).catch((e) => console.warn(`[karmax] could not book a paid ${c.toolkit} call:`, e)));
      if (held) await this.store.closeComputeHold(holdId).catch(() => undefined);
    }
  }
  /** One bounded MCP session with the account's current credentials. Never retried. */
  private async mcpCall<T>(c: ServiceConnection, taskId: string, run: (client: Awaited<ReturnType<OpenMcp>>) => Promise<T>): Promise<T> {
    let headers: Record<string, string>;
    try {
      headers = c.mcp!.auth === 'github'
        ? { Authorization: `Bearer ${await this.github!.token(this.githubUser(c)!, c.mcp!.githubAccountId!)}` }
        : await connectionHeaders(this.vault, this.target(c), taskId);
    }
    catch { throw new ConnectionError(`Account access expired; reconnect it in ${c.ownerProjectId ? 'Project settings' : 'Settings'} → Connected apps`, 409); }
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
  /** Remove a connection and every secret it holds. */
  private async forget(c: ServiceConnection) {
    (await this.broker.deleteHandle(PREFIX + c.id)); (await this.broker.deleteHandle(MCP_CREDENTIALS + c.id));
    (await this.store.kvDelete(PREFIX + c.id));
  }
  /**
   * A project is being deleted: its own accounts are signed out at the
   * provider and forgotten (one the provider cannot sign out now stays,
   * revoked, until `reconcile` manages to), its tasks' unanswered requests and
   * grants go, and accounts people shared with it stay theirs, unshared.
   */
  async deleteProject(org: string, projectId: string, taskIds: string[]) {
    const tasks = new Set(taskIds);
    for (const c of (await this.all()).filter((candidate) => candidate.organizationId === org)) {
      if (c.ownerProjectId === projectId) {
        try { await this.disconnect(org, c.id, undefined); } catch { /* retried by reconcile */ }
        const after = (await this.get(org, c.id));
        if (!after.accountId) (await this.forget(after));
      } else if (c.taskId && tasks.has(c.taskId) && (!c.ownerId || c.grantedConnectionId)) {
        (await this.forget(c));
      } else if (c.projectIds.includes(projectId)) {
        await this.locked(c.id, async () => {
          const current = (await this.get(org, c.id));
          current.projectIds = current.projectIds.filter((id) => id !== projectId);
          (await this.save(current)); (await this.audit(current, 'system:project-deleted', 'access-changed'));
        });
      }
    }
  }
  /** Durable polling/outbox: a restart retries unfinished auth and undelivered
   * task notifications. Provider callbacks and browser query strings are not proof. */
  async reconcile(resume: (c: ServiceConnection) => Promise<boolean>) {
    for (const c of (await this.all())) {
      try {
        let current = c.status === 'connecting' ? await this.refresh(c.organizationId, c.id) : c;
        if (c.status === 'disconnected' && c.accountId && (c.ownerId || c.ownerProjectId)) {
          try { await this.disconnect(c.organizationId, c.id, c.ownerId); } catch { /* local revocation already succeeded; retry cleanup next sweep */ }
          current = (await this.get(c.organizationId, c.id));
        }
        // A sign-in again whose account did not take it yet, or old sign-ins the provider kept.
        if (current.reconnects && current.status === 'active' && !current.grantedConnectionId) current = await this.adopt(current);
        if (current.retiring?.length) await this.retire(current);
        // An owner's own sign-in again that never completed leaves nothing behind.
        if (current.reconnects && !current.taskId && ['expired', 'denied', 'disconnected'].includes(current.status)) {
          if (current.accountId) await this.remote(async () => (await this.backend()).disconnect(current.accountId!));
          (await this.forget(current)); continue;
        }
        // A deleted project's account, signed out at the provider at last.
        if (current.ownerProjectId && !current.accountId && !(await this.store.getProject(current.ownerProjectId))) {
          (await this.forget(current)); continue;
        }
        if (current.taskId && !current.notifiedAt && ['active', 'expired', 'disconnected', 'denied'].includes(current.status)) {
          if (await resume(current)) { const latest = (await this.get(current.organizationId, current.id));
            if (latest.status === current.status) { latest.notifiedAt = Date.now(); (await this.save(latest)); } }
        }
      } catch { /* retry transient provider/delivery failures on the next sweep */ }
    }
  }
}
