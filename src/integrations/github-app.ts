import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { Store } from '../store/db.js';
import type { GitConnection, Repository } from '../domain/types.js';

const pexec = promisify(execFile);
export const GITHUB_APP_PRIVATE_KEY_HANDLE = 'github-app:private-key';
export const GITHUB_APP_WEBHOOK_SECRET_HANDLE = 'github-app:webhook-secret';
export const GITHUB_APP_CLIENT_SECRET_HANDLE = 'github-app:client-secret';
const GITHUB_APP_ID_KEY = 'github-app:id';
const GITHUB_APP_SLUG_KEY = 'github-app:slug';
const GITHUB_APP_CLIENT_ID_KEY = 'github-app:client-id';
export const GITHUB_APP_PUBLIC_URL_KEY = 'github-app:public-url';
const githubUserTokenHandle = (userId: string) => `github-app:user:${userId}:authorization`;

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
    webhookConfigured: boolean; userAuthorized: boolean } {
    return {
      configured: this.configured(),
      ...(this.options.appId ? { appId: this.options.appId } : {}),
      ...(this.options.appSlug ? { appSlug: this.options.appSlug } : {}),
      oauthConfigured: Boolean(this.options.clientId && this.broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE)),
      webhookConfigured: this.broker.hasHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE),
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
      throw new Error('Karmax needs an http(s) browser URL to set up GitHub');
    const origin = parsed.origin;
    const hostname = new URL(origin).hostname.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35) || 'host';
    return {
      action: 'https://github.com/settings/apps/new',
      manifest: {
        name: `Karmax ${hostname} ${crypto.randomBytes(4).toString('hex')}`,
        url: origin,
        public: false,
        // Keep the CSRF state in the path. GitHub's manifest validator is
        // needlessly strict about some otherwise-valid callback query strings,
        // while the path form is still a full URL and survives the round trip.
        redirect_url: `${origin}/api/github/manifest/callback/${encodeURIComponent(state)}`,
        setup_url: `${origin}/api/github/callback`,
        setup_on_update: true,
        callback_urls: [`${origin}/api/github/oauth/callback`],
        hook_attributes: { url: `${origin}/api/github/webhook`, active: true },
        default_permissions: { administration: 'write', contents: 'write', metadata: 'read', pull_requests: 'write' },
        default_events: ['installation', 'installation_repositories', 'repository'],
      },
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

  async handleWebhook(event: string, deliveryId: string, raw: Buffer, signature: string | undefined): Promise<{ accepted: boolean; reconciled?: number }> {
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
    if (['installation', 'installation_repositories', 'repository'].includes(event)) {
      const repositories = await this.reconcile({ ...connection, provider: 'github' });
      return { accepted: true, reconciled: repositories.length };
    }
    return { accepted: true };
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
    name: string; description?: string; private?: boolean; defaultBranch?: string;
  }): Promise<Repository> {
    const connection = this.store.getGitConnection(connectionId);
    if (!connection) throw new Error('GitHub connection not found');
    const name = input.name.trim();
    if (!name || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name))
      throw new Error('repository name may contain letters, numbers, dots, dashes, and underscores');
    const userToken = await this.userToken(userId);
    const pathname = connection.accountType === 'Organization'
      ? `/orgs/${encodeURIComponent(connection.accountLogin)}/repos`
      : '/user/repos';
    const created = await this.request<GitHubRepositoryPayload>(pathname, userToken, {
      method: 'POST', body: JSON.stringify({ name, description: input.description?.trim().slice(0, 350) || undefined,
        private: input.private !== false, auto_init: true }),
    });
    // Installation may have been limited to selected repositories. User
    // authorization lets Karmax enroll the new repository without sending the
    // operator back through GitHub settings.
    await this.request(`/user/installations/${encodeURIComponent(connection.installationId)}/repositories/${encodeURIComponent(String(created.id))}`,
      userToken, { method: 'PUT' });
    this.tokenCache.delete(connection.id);
    const installationToken = await this.installationToken(connection);
    const repository = this.store.upsertRepository({ organizationId: connection.organizationId, provider: 'github',
      providerId: String(created.id), owner: created.owner.login, name: created.name, sshUrl: created.ssh_url,
      defaultBranch: input.defaultBranch?.trim() || created.default_branch || 'main', private: created.private,
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

  private async userToken(userId: string): Promise<string> {
    const handle = githubUserTokenHandle(userId);
    if (!this.broker.hasHandle(handle)) throw new Error('Authorize your GitHub account before creating repositories');
    const stored = JSON.parse(this.broker.resolve(handle, { caps: [`use-credential:${handle}`] })) as {
      accessToken: string; expiresAt?: number; refreshToken?: string; refreshExpiresAt?: number;
    };
    if (!stored.expiresAt || stored.expiresAt > Date.now() + 60_000) return stored.accessToken;
    if (!stored.refreshToken || (stored.refreshExpiresAt && stored.refreshExpiresAt <= Date.now()))
      throw new Error('GitHub authorization expired; reconnect GitHub from Organization settings');
    if (!this.options.clientId) throw new Error('GitHub App client id is missing');
    const clientSecret = this.broker.resolve(GITHUB_APP_CLIENT_SECRET_HANDLE,
      { caps: [`use-credential:${GITHUB_APP_CLIENT_SECRET_HANDLE}`] });
    const value = await this.oauthToken({ client_id: this.options.clientId, client_secret: clientSecret,
      grant_type: 'refresh_token', refresh_token: stored.refreshToken });
    if (!value.access_token) throw new Error(value.error_description || value.error || 'GitHub token refresh failed');
    this.saveUserToken(userId, value);
    return String(value.access_token);
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
