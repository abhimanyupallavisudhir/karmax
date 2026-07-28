import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { Store } from '../store/db.js';
import type { GitConnection, Repository } from '../domain/types.js';
import { pullRequestWebhookEvent, type GithubPrWebhookEvent } from './github-pr.js';

const pexec = promisify(execFile);
export const GITHUB_APP_PRIVATE_KEY_HANDLE = 'github-app:private-key';
export const GITHUB_APP_WEBHOOK_SECRET_HANDLE = 'github-app:webhook-secret';
export const GITHUB_APP_CLIENT_SECRET_HANDLE = 'github-app:client-secret';
const GITHUB_APP_ID_KEY = 'github-app:id';
const GITHUB_APP_SLUG_KEY = 'github-app:slug';
const GITHUB_APP_CLIENT_ID_KEY = 'github-app:client-id';
export const GITHUB_APP_PUBLIC_URL_KEY = 'github-app:public-url';
const githubUserTokenHandle = (userId: string) => `github-app:user:${userId}:authorization`;

function publicWebhookOrigin(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
  if (net.isIP(hostname) === 4) {
    const [a = 0, b = 0] = hostname.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  }
  if (net.isIP(hostname) === 6)
    return !(hostname === '::1' || hostname === '::' || hostname.startsWith('fc') || hostname.startsWith('fd')
      || hostname.startsWith('fe8') || hostname.startsWith('fe9') || hostname.startsWith('fea') || hostname.startsWith('feb'));
  return hostname.includes('.');
}

export const repositoryKeyHandle = (repositoryId: string, mode: 'clone' | 'write') =>
  `github:repository:${repositoryId}:${mode}`;

interface GitHubRepositoryPayload {
  id: number | string;
  name: string;
  private: boolean;
  archived?: boolean;
  ssh_url: string;
  default_branch: string;
  owner: { login: string };
}

interface GitHubInstallationPayload {
  id: number | string;
  account: { login: string; type?: 'User' | 'Organization' };
  suspended_at?: string | null;
}

export interface GitHubAppOptions {
  appId?: string;
  appSlug?: string;
  clientId?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  keyPair?: () => Promise<{ privateKey: string; publicKey: string }>;
}

/** Organization-owned GitHub App integration. App and deploy-key secrets live
 * only in the credential broker; durable records carry installation/key IDs. */
export class GitHubAppService {
  private fetcher: typeof fetch;
  private apiBase: string;
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();
  private keyPair: () => Promise<{ privateKey: string; publicKey: string }>;

  constructor(private store: Store, private broker: CredentialBroker, private options: GitHubAppOptions = {}) {
    this.options = {
      ...options,
      appId: options.appId?.trim() || store.kvGet(GITHUB_APP_ID_KEY),
      appSlug: options.appSlug?.trim() || store.kvGet(GITHUB_APP_SLUG_KEY),
      clientId: options.clientId?.trim() || store.kvGet(GITHUB_APP_CLIENT_ID_KEY),
    };
    this.fetcher = options.fetch ?? fetch;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.keyPair = options.keyPair ?? generateEd25519KeyPair;
  }

  configured(): boolean {
    return Boolean(this.options.appId?.trim() && this.broker.hasHandle(GITHUB_APP_PRIVATE_KEY_HANDLE));
  }

  status(userId?: string): { configured: boolean; appId?: string; appSlug?: string; oauthConfigured: boolean;
    webhookConfigured: boolean; syncMode: 'webhook' | 'on-demand'; userAuthorized: boolean } {
    let syncMode: 'webhook' | 'on-demand' = 'on-demand';
    try {
      const publicUrl = this.store.kvGet(GITHUB_APP_PUBLIC_URL_KEY);
      if (publicUrl && publicWebhookOrigin(new URL(publicUrl))) syncMode = 'webhook';
    } catch {}
    return {
      configured: this.configured(),
      ...(this.options.appId ? { appId: this.options.appId } : {}),
      ...(this.options.appSlug ? { appSlug: this.options.appSlug } : {}),
      oauthConfigured: Boolean(this.options.clientId && this.broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE)),
      webhookConfigured: this.broker.hasHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE),
      syncMode,
      userAuthorized: Boolean(userId && this.broker.hasHandle(githubUserTokenHandle(userId))),
    };
  }

  configure(input: { appId: string | number; appSlug: string; privateKey: string; webhookSecret?: string;
    clientId?: string; clientSecret?: string }): ReturnType<GitHubAppService['status']> {
    const appId = String(input.appId).trim();
    const appSlug = input.appSlug.trim();
    if (!/^\d+$/.test(appId)) throw new Error('GitHub App id must be numeric');
    if (!/^[A-Za-z0-9-]+$/.test(appSlug)) throw new Error('GitHub App slug is invalid');
    try { crypto.createPrivateKey(input.privateKey); }
    catch { throw new Error('GitHub App private key is not a valid PEM key'); }
    this.options.appId = appId;
    this.options.appSlug = appSlug;
    this.options.clientId = input.clientId?.trim() || this.options.clientId;
    this.store.kvSet(GITHUB_APP_ID_KEY, appId);
    this.store.kvSet(GITHUB_APP_SLUG_KEY, appSlug);
    if (this.options.clientId) this.store.kvSet(GITHUB_APP_CLIENT_ID_KEY, this.options.clientId);
    this.broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, input.privateKey);
    if (input.webhookSecret) this.broker.registerHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE, input.webhookSecret);
    if (input.clientSecret) this.broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, input.clientSecret);
    this.tokenCache.clear();
    return this.status();
  }

  /** Payload for GitHub's App Manifest flow. The browser posts this directly to
   * GitHub, so Karmax never needs a pre-created App or a server-side PAT. */
  manifest(publicUrl: string, state: string): { action: string; manifest: Record<string, unknown> } {
    const parsed = new URL(publicUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error('Krmax needs an http(s) browser URL to set up GitHub');
    const origin = parsed.origin;
    const hostname = new URL(origin).hostname.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35) || 'host';
    const manifest: Record<string, unknown> = {
      name: `Krmax ${hostname} ${crypto.randomBytes(4).toString('hex')}`,
      url: origin,
      public: false,
      // Keep the CSRF state in the path. GitHub's manifest validator is
      // needlessly strict about some otherwise-valid callback query strings,
      // while the path form is still a full URL and survives the round trip.
      redirect_url: `${origin}/api/github/manifest/callback/${encodeURIComponent(state)}`,
      setup_url: `${origin}/api/github/callback`,
      setup_on_update: true,
      callback_urls: [`${origin}/api/github/oauth/callback`],
      default_permissions: { administration: 'write', contents: 'write', metadata: 'read', pull_requests: 'write' },
    };
    // GitHub rejects loopback/private webhook URLs because its delivery service
    // cannot reach them. Local Karmax instances reconcile installations on
    // demand instead. Installation lifecycle events are deliberately omitted:
    // GitHub Apps receive them automatically and GitHub rejects attempts to
    // subscribe to installation_repositories explicitly.
    if (publicWebhookOrigin(parsed)) {
      manifest.hook_attributes = { url: `${origin}/api/github/webhook`, active: true };
      // Pull-request lifecycle is the one non-installation feed karmax subscribes
      // to: it is what turns a PR karmax opened into task events (SPEC §5.4).
      manifest.default_events = ['pull_request', 'pull_request_review'];
    }
    return {
      action: 'https://github.com/settings/apps/new',
      manifest,
    };
  }

  async convertManifest(code: string): Promise<ReturnType<GitHubAppService['status']>> {
    if (!code.trim()) throw new Error('GitHub App manifest code is missing');
    const response = await this.fetcher(`${this.apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST', headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub manifest conversion failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const value = await response.json() as any;
    return this.configure({ appId: value.id, appSlug: value.slug, privateKey: value.pem,
      webhookSecret: value.webhook_secret, clientId: value.client_id, clientSecret: value.client_secret });
  }

  userAuthorizationUrl(state: string, publicUrl: string): string {
    if (!this.options.clientId || !this.broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE))
      throw new Error('GitHub user authorization is unavailable; configure the App client id and secret');
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', `${new URL(publicUrl).origin}/api/github/oauth/callback`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async authorizeUser(userId: string, code: string, publicUrl?: string): Promise<void> {
    if (!this.options.clientId) throw new Error('GitHub App client id is missing');
    const clientSecret = this.broker.resolve(GITHUB_APP_CLIENT_SECRET_HANDLE,
      { caps: [`use-credential:${GITHUB_APP_CLIENT_SECRET_HANDLE}`] });
    const value = await this.oauthToken({ client_id: this.options.clientId, client_secret: clientSecret, code,
      ...(publicUrl ? { redirect_uri: `${new URL(publicUrl).origin}/api/github/oauth/callback` } : {}) });
    if (!value.access_token) throw new Error(value.error_description || value.error || 'GitHub returned no user access token');
    this.saveUserToken(userId, value);
  }

  installationUrl(state: string): string {
    if (!this.configured()) throw new Error('GitHub App is not configured');
    const slug = this.options.appSlug?.trim();
    if (!slug || !/^[A-Za-z0-9-]+$/.test(slug)) throw new Error('GitHub App slug is not configured');
    const url = new URL(`https://github.com/apps/${slug}/installations/new`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  verifyWebhook(raw: Buffer, signature: string | undefined): boolean {
    if (!signature?.startsWith('sha256=') || !this.broker.hasHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE)) return false;
    const secret = this.broker.resolve(GITHUB_APP_WEBHOOK_SECRET_HANDLE, { caps: [`use-credential:${GITHUB_APP_WEBHOOK_SECRET_HANDLE}`] });
    const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
    const actual = Buffer.from(signature);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  async connectInstallation(organizationId: string, installationId: string): Promise<{ connection: GitConnection; repositories: Repository[] }> {
    const installation = await this.appRequest<GitHubInstallationPayload>(`/app/installations/${encodeURIComponent(installationId)}`);
    const connection = this.store.upsertGitConnection({ organizationId, provider: 'github',
      installationId: String(installation.id), accountLogin: installation.account.login,
      accountType: installation.account.type, suspendedAt: installation.suspended_at ? Date.parse(installation.suspended_at) : undefined });
    return { connection, repositories: await this.reconcile(connection) };
  }

  async reconcile(connection: GitConnection): Promise<Repository[]> {
    const token = await this.installationToken(connection);
    const remote: GitHubRepositoryPayload[] = [];
    for (let page = 1; ; page++) {
      const response = await this.request<{ repositories: GitHubRepositoryPayload[] }>(
        `/installation/repositories?per_page=100&page=${page}`, token,
      );
      remote.push(...response.repositories);
      if (response.repositories.length < 100) break;
    }
    const active = new Set<string>();
    const repositories: Repository[] = [];
    for (const item of remote.filter((repo) => !repo.archived)) {
      const repository = this.store.upsertRepository({ organizationId: connection.organizationId, provider: 'github',
        providerId: String(item.id), owner: item.owner.login, name: item.name, sshUrl: item.ssh_url,
        defaultBranch: item.default_branch, private: item.private, gitConnectionId: connection.id });
      active.add(repository.id);
      await this.ensureDeployKeys(repository, token);
      repositories.push(repository);
    }
    for (const repository of this.store.listRepositories(connection.organizationId)) {
      if (repository.gitConnectionId === connection.id && !active.has(repository.id)) await this.removeRepository(repository, token);
    }
    return repositories;
  }

  async handleWebhook(event: string, deliveryId: string, raw: Buffer, signature: string | undefined):
  Promise<{ accepted: boolean; reconciled?: number; events?: GithubPrWebhookEvent[] }> {
    if (!this.verifyWebhook(raw, signature)) throw new Error('invalid GitHub webhook signature');
    if (!this.store.recordGithubDelivery(deliveryId, event)) return { accepted: false };
    const payload = JSON.parse(raw.toString('utf8')) as any;
    const installationId = String(payload.installation?.id ?? '');
    if (!installationId) return { accepted: true };
    const connection = this.store.db.prepare('SELECT * FROM git_connections WHERE provider=? AND installationId=?')
      .get('github', installationId) as any;
    if (!connection) return { accepted: true };
    if (event === 'installation' && (payload.action === 'deleted' || payload.action === 'suspend')) {
      const saved = this.store.upsertGitConnection({ organizationId: connection.organizationId, provider: 'github', installationId,
        accountLogin: connection.accountLogin, accountType: connection.accountType ?? undefined, suspendedAt: Date.now() });
      this.tokenCache.delete(saved.id);
      return { accepted: true, reconciled: 0 };
    }
    if (event === 'pull_request' || event === 'pull_request_review') {
      // The PR lifecycle karmax itself started: correlated back to its task so
      // the timeline shows it and `event` triggers can fire on it. Correlation is
      // by branch name, which anyone can pick — so the task must also belong to
      // the tenant that installed this App, or a `karmax/<id>` branch pushed to
      // any repo would inject events into someone else's task.
      const prEvent = pullRequestWebhookEvent(event, payload);
      if (!prEvent || !this.ownsTask(connection.organizationId, prEvent.taskId)) return { accepted: true };
      return { accepted: true, events: [prEvent] };
    }
    if (['installation', 'installation_repositories', 'repository'].includes(event)) {
      const repositories = await this.reconcile({ ...connection, provider: 'github' });
      return { accepted: true, reconciled: repositories.length };
    }
    return { accepted: true };
  }

  /** Is `taskId` a live task of the organization that installed the App? */
  private ownsTask(organizationId: string, taskId: string): boolean {
    const task = this.store.getTask(taskId);
    const project = task ? this.store.getProject(task.projectId) : undefined;
    return project?.organizationId === organizationId;
  }

  async installationToken(connection: GitConnection): Promise<string> {
    const cached = this.tokenCache.get(connection.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (connection.suspendedAt) throw new Error('GitHub App installation is suspended');
    const created = await this.appRequest<{ token: string; expires_at: string }>(
      `/app/installations/${encodeURIComponent(connection.installationId)}/access_tokens`, { method: 'POST' },
    );
    const value = { token: created.token, expiresAt: Date.parse(created.expires_at) };
    this.tokenCache.set(connection.id, value);
    return value.token;
  }

  /** Read-only material is for provisioning; write material is broker-only. */
  repositorySshKey(repositoryId: string, mode: 'clone' | 'write'): string {
    const keys = this.store.repositoryDeployKeys(repositoryId);
    if (!keys) throw new Error(`repository ${repositoryId} has no deploy keys`);
    const handle = mode === 'clone' ? keys.cloneHandle : keys.writeHandle;
    return this.broker.resolve(handle, { caps: [`use-credential:${handle}`] });
  }

  async brokerCredentials(repository: Repository): Promise<{ sshKey: string; env: Record<string, string> }> {
    if (!repository.gitConnectionId) throw new Error('repository has no GitHub App connection');
    const connection = this.store.getGitConnection(repository.gitConnectionId);
    if (!connection) throw new Error('repository GitHub App connection is missing');
    return { sshKey: this.repositorySshKey(repository.id, 'write'), env: { GH_TOKEN: await this.installationToken(connection) } };
  }

  /** Create a GitHub repository, add it to a selected-repository App
   * installation, enroll isolated deploy keys, and return the durable record. */
  async createRepository(connectionId: string, userId: string, input: {
    name: string; description?: string; private?: boolean; defaultBranch?: string; autoInit?: boolean;
  }): Promise<Repository> {
    const connection = this.store.getGitConnection(connectionId);
    if (!connection) throw new Error('GitHub connection not found');
    const name = this.repositoryName(input.name);
    const pathname = connection.accountType === 'Organization'
      ? `/orgs/${encodeURIComponent(connection.accountLogin)}/repos`
      : '/user/repos';
    const created = await this.userRequest<GitHubRepositoryPayload>(userId, pathname, {
      method: 'POST', body: JSON.stringify({ name, description: input.description?.trim().slice(0, 350) || undefined,
        private: input.private !== false, auto_init: input.autoInit !== false }),
    });
    return this.enrollRepository(connection, userId, created, input.defaultBranch);
  }

  /** Idempotently provision a platform-owned repository. A previous attempt can
   * succeed at GitHub and then be interrupted before the durable record or
   * deploy keys are saved; retrying must adopt that exact private repository
   * instead of repeatedly failing with GitHub's "name already exists" 422. */
  async ensureRepository(connectionId: string, userId: string, input: {
    name: string; description?: string; private?: boolean; defaultBranch?: string; autoInit?: boolean;
  }): Promise<Repository> {
    const connection = this.store.getGitConnection(connectionId);
    if (!connection) throw new Error('GitHub connection not found');
    const name = this.repositoryName(input.name);
    let repository: GitHubRepositoryPayload;
    try {
      repository = await this.userRequest<GitHubRepositoryPayload>(userId,
        `/repos/${encodeURIComponent(connection.accountLogin)}/${encodeURIComponent(name)}`,
      );
      if (repository.archived) throw new Error(`existing GitHub repository ${connection.accountLogin}/${name} is archived`);
      if (input.private !== false && !repository.private)
        throw new Error(`existing GitHub repository ${connection.accountLogin}/${name} must be private`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('GitHub API 404')) throw error;
      const pathname = connection.accountType === 'Organization'
        ? `/orgs/${encodeURIComponent(connection.accountLogin)}/repos`
        : '/user/repos';
      repository = await this.userRequest<GitHubRepositoryPayload>(userId, pathname, {
        method: 'POST', body: JSON.stringify({ name, description: input.description?.trim().slice(0, 350) || undefined,
          private: input.private !== false, auto_init: input.autoInit !== false }),
      });
    }
    return this.enrollRepository(connection, userId, repository, input.defaultBranch);
  }

  private repositoryName(input: string): string {
    const name = input.trim();
    if (!name || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name))
      throw new Error('repository name may contain letters, numbers, dots, dashes, and underscores');
    return name;
  }

  private async enrollRepository(connection: GitConnection, userId: string,
    created: GitHubRepositoryPayload, defaultBranch?: string): Promise<Repository> {
    // Installation may have been limited to selected repositories. User
    // authorization lets Karmax enroll the repository without sending the
    // operator back through GitHub settings. The PUT is idempotent for selected
    // installations; installations covering every repository may reject it,
    // but their installation token can already see the repository.
    try {
      await this.userRequest(userId,
        `/user/installations/${encodeURIComponent(connection.installationId)}/repositories/${encodeURIComponent(String(created.id))}`,
        { method: 'PUT' });
    } catch (error) {
      this.tokenCache.delete(connection.id);
      const installationToken = await this.installationToken(connection);
      try {
        await this.request(`/repos/${encodeURIComponent(created.owner.login)}/${encodeURIComponent(created.name)}`,
          installationToken);
      } catch {
        throw error;
      }
    }
    this.tokenCache.delete(connection.id);
    const installationToken = await this.installationToken(connection);
    const repository = this.store.upsertRepository({ organizationId: connection.organizationId, provider: 'github',
      providerId: String(created.id), owner: created.owner.login, name: created.name, sshUrl: created.ssh_url,
      defaultBranch: defaultBranch?.trim() || created.default_branch || 'main', private: created.private,
      gitConnectionId: connection.id });
    await this.ensureDeployKeys(repository, installationToken);
    return repository;
  }

  /** Remove every repository-scoped key Karmax installed for a tenant. Failure
   * is surfaced so organization deletion can be retried instead of orphaning a
   * write-capable deploy key in GitHub. */
  async disconnectOrganization(organizationId: string): Promise<void> {
    for (const connection of this.store.listGitConnections(organizationId)) {
      const repositories = this.store.listRepositories(organizationId).filter((repo) => repo.gitConnectionId === connection.id);
      const token = repositories.length ? await this.installationToken(connection) : undefined;
      for (const repository of repositories) {
        const keys = this.store.repositoryDeployKeys(repository.id);
        if (!keys) continue;
        await this.deleteDeployKey(repository, keys.cloneKeyId, token!);
        await this.deleteDeployKey(repository, keys.writeKeyId, token!);
        this.broker.deleteHandle(keys.cloneHandle);
        this.broker.deleteHandle(keys.writeHandle);
      }
      this.tokenCache.delete(connection.id);
    }
  }

  private async ensureDeployKeys(repository: Repository, installationToken: string): Promise<void> {
    if (this.store.repositoryDeployKeys(repository.id)) return;
    const clone = await this.keyPair();
    const write = await this.keyPair();
    let cloneKeyId: string | undefined;
    let writeKeyId: string | undefined;
    const cloneHandle = repositoryKeyHandle(repository.id, 'clone');
    const writeHandle = repositoryKeyHandle(repository.id, 'write');
    try {
      const cloneCreated = await this.request<{ id: number | string }>(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/keys`, installationToken,
        { method: 'POST', body: JSON.stringify({ title: `karmax clone ${repository.id}`, key: clone.publicKey, read_only: true }) },
      );
      cloneKeyId = String(cloneCreated.id);
      const writeCreated = await this.request<{ id: number | string }>(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/keys`, installationToken,
        { method: 'POST', body: JSON.stringify({ title: `karmax broker ${repository.id}`, key: write.publicKey, read_only: false }) },
      );
      writeKeyId = String(writeCreated.id);
      this.broker.registerHandle(cloneHandle, clone.privateKey);
      this.broker.registerHandle(writeHandle, write.privateKey);
      this.store.setRepositoryDeployKeys({ repositoryId: repository.id, cloneKeyId,
        writeKeyId, cloneHandle, writeHandle });
    } catch (error) {
      if (cloneKeyId) await this.deleteDeployKey(repository, cloneKeyId, installationToken).catch(() => undefined);
      if (writeKeyId) await this.deleteDeployKey(repository, writeKeyId, installationToken).catch(() => undefined);
      this.broker.deleteHandle(cloneHandle);
      this.broker.deleteHandle(writeHandle);
      throw error;
    }
  }

  private async removeRepository(repository: Repository, installationToken: string): Promise<void> {
    const keys = this.store.repositoryDeployKeys(repository.id);
    if (keys) {
      await Promise.all([
        this.deleteDeployKey(repository, keys.cloneKeyId, installationToken),
        this.deleteDeployKey(repository, keys.writeKeyId, installationToken),
      ].map((promise) => promise.catch(() => undefined)));
      this.broker.deleteHandle(keys.cloneHandle);
      this.broker.deleteHandle(keys.writeHandle);
    }
    this.store.deleteRepository(repository.id);
  }

  private async deleteDeployKey(repository: Repository, keyId: string, token: string): Promise<void> {
    await this.request(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/keys/${encodeURIComponent(keyId)}`,
      token, { method: 'DELETE' }).catch((error) => {
        // Retried tenant deletion may encounter a key removed by the first
        // attempt before the local transaction committed.
        if (!(error instanceof Error) || !error.message.includes('GitHub API 404')) throw error;
      });
  }

  /** Small tracked-file inspection path used by hosted onboarding proposals. */
  async fileContents(repository: Repository, filePath: string): Promise<string | undefined> {
    try {
      if (!repository.gitConnectionId) return undefined;
      const connection = this.store.getGitConnection(repository.gitConnectionId);
      if (!connection) return undefined;
      const token = await this.installationToken(connection);
      const value = await this.request<{ content?: string; encoding?: string }>(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/`
        + filePath.split('/').map(encodeURIComponent).join('/'), token);
      if (!value.content) return undefined;
      return Buffer.from(value.content, (value.encoding as BufferEncoding) ?? 'base64').toString('utf8');
    } catch { return undefined; }
  }

  private appJwt(): string {
    if (!this.configured()) throw new Error('GitHub App is not configured');
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.options.appId }));
    const privateKey = this.broker.resolve(GITHUB_APP_PRIVATE_KEY_HANDLE, { caps: [`use-credential:${GITHUB_APP_PRIVATE_KEY_HANDLE}`] });
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
  }

  private appRequest<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    return this.request(pathname, this.appJwt(), init);
  }

  private async request<T = unknown>(pathname: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.apiBase}${pathname}`, { ...init, headers: {
      accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28', 'content-type': 'application/json', ...(init.headers ?? {}),
    } });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private saveUserToken(userId: string, value: any): void {
    const now = Date.now();
    this.broker.registerHandle(githubUserTokenHandle(userId), JSON.stringify({
      accessToken: String(value.access_token),
      expiresAt: value.expires_in ? now + Number(value.expires_in) * 1000 : undefined,
      refreshToken: value.refresh_token ? String(value.refresh_token) : undefined,
      refreshExpiresAt: value.refresh_token_expires_in ? now + Number(value.refresh_token_expires_in) * 1000 : undefined,
    }));
  }

  /** Resolve the operator's user token, refreshing when the recorded expiry is
   * near. `forceRefresh` ignores that clock: it is the recovery path for a token
   * GitHub invalidated *before* its recorded expiry (revocation, client-secret
   * rotation, or a single-use refresh chain consumed by a concurrent instance).
   * A dead credential is cleared so `status().userAuthorized` flips to false and
   * the operator is told to reconnect, rather than 401ing against it forever. */
  private async userToken(userId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const handle = githubUserTokenHandle(userId);
    if (!this.broker.hasHandle(handle)) throw new Error('Authorize your GitHub account before creating repositories');
    const stored = JSON.parse(this.broker.resolve(handle, { caps: [`use-credential:${handle}`] })) as {
      accessToken: string; expiresAt?: number; refreshToken?: string; refreshExpiresAt?: number;
    };
    if (!opts.forceRefresh && (!stored.expiresAt || stored.expiresAt > Date.now() + 60_000)) return stored.accessToken;
    if (!stored.refreshToken || (stored.refreshExpiresAt && stored.refreshExpiresAt <= Date.now())) {
      this.broker.deleteHandle(handle);
      throw new Error('GitHub authorization expired; reconnect GitHub from Organization settings');
    }
    if (!this.options.clientId) throw new Error('GitHub App client id is missing');
    const clientSecret = this.broker.resolve(GITHUB_APP_CLIENT_SECRET_HANDLE,
      { caps: [`use-credential:${GITHUB_APP_CLIENT_SECRET_HANDLE}`] });
    const value = await this.oauthToken({ client_id: this.options.clientId, client_secret: clientSecret,
      grant_type: 'refresh_token', refresh_token: stored.refreshToken });
    if (!value.access_token) {
      // The refresh token itself is dead — GitHub returns an OAuth error body
      // (HTTP 200) rather than a token. Clearing here forces a clean reconnect.
      this.broker.deleteHandle(handle);
      const reason = value.error_description || value.error;
      throw new Error(`GitHub authorization expired; reconnect GitHub from Organization settings${reason ? ` (${reason})` : ''}`);
    }
    this.saveUserToken(userId, value);
    return String(value.access_token);
  }

  /** A user-token GitHub request that self-heals a server-side invalidation: on a
   * 401 it forces a token refresh once and retries, so a token karmax's own clock
   * still trusts (but GitHub has revoked) recovers instead of failing the caller. */
  private async userRequest<T = unknown>(userId: string, pathname: string, init: RequestInit = {}): Promise<T> {
    try {
      return await this.request<T>(pathname, await this.userToken(userId), init);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('GitHub API 401')) throw error;
      return await this.request<T>(pathname, await this.userToken(userId, { forceRefresh: true }), init);
    }
  }

  private async oauthToken(input: Record<string, string>): Promise<any> {
    const response = await this.fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(input).toString(),
    });
    if (!response.ok) throw new Error(`GitHub OAuth failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    return response.json();
  }
}

async function generateEd25519KeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deploy-key-'));
  const file = path.join(dir, 'id_ed25519');
  try {
    await pexec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'karmax', '-f', file], { timeout: 15_000 });
    return { privateKey: fs.readFileSync(file, 'utf8'), publicKey: fs.readFileSync(`${file}.pub`, 'utf8').trim() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}
