import crypto from 'node:crypto';
import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { Store } from '../store/db.js';
import type { GitConnection, Repository } from '../domain/types.js';
import { pullRequestWebhookEvent, type GithubPrWebhookEvent } from './github-pr.js';

export const GITHUB_APP_PRIVATE_KEY_HANDLE = 'github-app:private-key';
export const GITHUB_APP_WEBHOOK_SECRET_HANDLE = 'github-app:webhook-secret';
export const GITHUB_APP_CLIENT_SECRET_HANDLE = 'github-app:client-secret';
const GITHUB_APP_ID_KEY = 'github-app:id';
const GITHUB_APP_SLUG_KEY = 'github-app:slug';
const GITHUB_APP_CLIENT_ID_KEY = 'github-app:client-id';
export const GITHUB_APP_PUBLIC_URL_KEY = 'github-app:public-url';
const legacyGithubUserTokenHandle = (userId: string) => `github-app:user:${userId}:authorization`;
const githubUserTokenHandle = (userId: string, accountId: string) =>
  `github-app:user:${userId}:account:${accountId}:authorization`;
const githubUserAccountsKey = (userId: string) => `github-app:user:${userId}:accounts`;
const githubUserActiveAccountKey = (userId: string) => `github-app:user:${userId}:active-account`;

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

export interface GitHubUserIdentity {
  id: string;
  login: string;
  name?: string;
}

export interface GitHubUserAccount extends GitHubUserIdentity {
  active: boolean;
}

/** A live observation from GitHub, never a krmax capability grant. `canMerge`
 * is deliberately conservative: GitHub's push/maintain/admin repository roles
 * may request a merge, while branch protection and rulesets still decide the
 * exact pull request at merge time. */
export interface GitHubRepositoryPermission {
  slug: string;
  permission: string;
  roleName?: string;
  canMerge: boolean;
  /** Repository-supported method closest to krmax's merge-commit semantics. */
  mergeMethod: 'merge' | 'squash' | 'rebase';
}

export interface GitHubAppOptions {
  appId?: string;
  appSlug?: string;
  clientId?: string;
  /** A managed deployment shares one App across tenants, so GitHub must allow
   * accounts other than the App owner to install it. Personal/self-hosted Apps
   * remain private to their owner. */
  publicApp?: boolean;
  apiBase?: string;
  fetch?: typeof fetch;
  /** Injectable delay for rate-limit/5xx backoff (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** At most 10,000 repositories per installation — a ceiling on a remote-driven
 *  pagination loop, not a real limit anyone will reach. */
const MAX_REPOSITORY_PAGES = 100;
/** Extra attempts after the first for a retryable GitHub response. */
const MAX_REQUEST_RETRIES = 3;
/** Never sleep longer than this on GitHub's say-so, whatever it asks for. */
const MAX_RETRY_WAIT_MS = 60_000;
/**
 * Methods whose 5xx may be retried.
 *
 * A 5xx says "something went wrong", NOT "nothing happened" — GitHub may have
 * applied the write and then failed to answer (or the connection dropped after
 * it did). So the set is exactly the methods where applying the same request
 * twice leaves the same state:
 *  - GET/HEAD: read-only.
 *  - PUT `/user/installations/:id/repositories/:repo` — the only PUT karmax
 *    sends; it SETS membership of a fixed repository in a fixed installation
 *    (204, no body, no id minted), so a repeat is a no-op. Genuinely idempotent,
 *    not merely idempotent-by-RFC.
 *  - DELETE `/repos/:o/:r/keys/:id` — legacy deploy-key cleanup names an
 *    already-existing resource, so a repeat either deletes it or 404s.
 * POST is deliberately absent: token minting and repository creation are not
 * safe to replay after a processed-then-5xx response. PATCH is absent for the
 * same reason.
 */
const RETRYABLE_5XX_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
/**
 * Retry budget for work driven by an inbound webhook. GitHub abandons a delivery
 * after ~10 s, so a `retry-after: 60` honoured three times would hold the HTTP
 * response open for minutes that nobody is listening to — and `reconcile` makes
 * many requests. Past the budget the error surfaces, the gateway answers 5xx, the
 * delivery claim is released, and GitHub redelivers: the retry still happens, on
 * GitHub's clock instead of inside our request handler.
 */
const WEBHOOK_RETRY_BUDGET_MS = 8_000;
/** Epoch ms after which the ambient caller refuses to keep sleeping, if any. */
const retryDeadline = new AsyncLocalStorage<number>();

/**
 * How long to wait before retrying a failed GitHub response, or `undefined` if
 * the failure is not retryable.
 *
 * Order matters: `retry-after` (secondary rate limit / abuse detection) is
 * GitHub's explicit instruction and wins; then a primary rate limit, recognised
 * by `x-ratelimit-remaining: 0` plus an `x-ratelimit-reset` epoch-SECONDS
 * timestamp; then plain 5xx, which gets exponential-ish backoff.
 *
 * Rate limits are retryable for EVERY method: GitHub rejects a limited request
 * before executing it, so no side effect happened. 5xx is retryable only for
 * `RETRYABLE_5XX_METHODS` — see there.
 */
function retryDelayMs(response: Response, attempt = 0, method = 'GET'): number | undefined {
  const clamp = (ms: number) => Math.min(MAX_RETRY_WAIT_MS, Math.max(0, ms));
  const rateLimited = response.status === 403 || response.status === 429;
  const replayable = rateLimited || RETRYABLE_5XX_METHODS.has(method);
  const retryAfter = Number(response.headers.get('retry-after'));
  if (replayable && Number.isFinite(retryAfter) && response.headers.get('retry-after')) return clamp(retryAfter * 1000);
  if (rateLimited) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (remaining === '0' && Number.isFinite(reset) && reset > 0) return clamp(reset * 1000 - Date.now());
    // A 403 that is NOT a rate limit is a permissions error — never retry it.
    if (response.status === 429) return clamp(1000);
    return undefined;
  }
  if (response.status >= 500 && RETRYABLE_5XX_METHODS.has(method)) return clamp(1000 * 2 ** attempt);
  return undefined;
}

/** Organization-owned GitHub App integration. Durable App secrets live only in
 * the credential broker. Git transport uses short-lived installation tokens. */
export class GitHubAppService {
  private fetcher: typeof fetch;
  private apiBase: string;
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();
  /** In-flight token mints, keyed by connection — collapses concurrent callers. */
  private tokenMints = new Map<string, Promise<string>>();
  /** Bounds refreshes while an installation owner is still approving a newly
   * requested permission; without this, every landing poll would mint a token. */
  private tokenInvalidatedAt = new Map<string, number>();

  constructor(private store: Store, private broker: CredentialBroker, private options: GitHubAppOptions = {}) {
    this.options = {
      ...options,
      appId: options.appId?.trim() || store.kvGet(GITHUB_APP_ID_KEY),
      appSlug: options.appSlug?.trim() || store.kvGet(GITHUB_APP_SLUG_KEY),
      clientId: options.clientId?.trim() || store.kvGet(GITHUB_APP_CLIENT_ID_KEY),
    };
    this.fetcher = options.fetch ?? fetch;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  }

  configured(): boolean {
    return Boolean(this.options.appId?.trim() && this.broker.hasHandle(GITHUB_APP_PRIVATE_KEY_HANDLE));
  }

  /** OAuth client owned by this deployment's App. Kept behind the service so
   * callers do not need to know the vault handle or durable metadata keys. */
  oauthCredentials(): { clientId: string; clientSecret: string } | undefined {
    const clientId = this.options.clientId?.trim();
    if (!clientId || !this.broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE)) return undefined;
    return { clientId, clientSecret: this.broker.resolve(GITHUB_APP_CLIENT_SECRET_HANDLE,
      { caps: [`use-credential:${GITHUB_APP_CLIENT_SECRET_HANDLE}`] }) };
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
      userAuthorized: Boolean(userId && (this.userAccounts(userId).some((account) =>
        this.broker.hasHandle(githubUserTokenHandle(userId, account.id)))
        || this.broker.hasHandle(legacyGithubUserTokenHandle(userId)))),
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
      public: this.options.publicApp === true,
      // Keep the CSRF state in the path. GitHub's manifest validator is
      // needlessly strict about some otherwise-valid callback query strings,
      // while the path form is still a full URL and survives the round trip.
      redirect_url: `${origin}/api/github/manifest/callback/${encodeURIComponent(state)}`,
      setup_url: `${origin}/api/github/callback`,
      setup_on_update: true,
      callback_urls: [`${origin}/api/github/oauth/callback`, `${origin}/api/auth/callback/github`],
      // Landing certifies the exact PR head only after GitHub's combined check
      // rollup is successful. `checks` covers CheckRun contexts (including
      // Actions); `statuses` covers legacy commit-status contexts. Both are
      // read-only and are required to distinguish pending CI from failed CI.
      // Better Auth also reads the user's verified email addresses when linking
      // a GitHub sign-in to an existing Karmax account.
      default_permissions: {
        checks: 'read', contents: 'write', email_addresses: 'read', metadata: 'read',
        pull_requests: 'write', statuses: 'read',
      },
    };
    // GitHub rejects loopback/private webhook URLs because its delivery service
    // cannot reach them. Local Karmax instances reconcile installations on
    // demand instead. Installation lifecycle events are deliberately omitted:
    // GitHub Apps receive them automatically and GitHub rejects attempts to
    // subscribe to installation_repositories explicitly.
    if (publicWebhookOrigin(parsed)) {
      manifest.hook_attributes = { url: `${origin}/api/github/webhook`, active: true };
      // PR/check/merge-group lifecycle turns provider progress for a Karmax task
      // into durable events and wakes its reconciliation loop (SPEC §5.4).
      manifest.default_events = ['pull_request', 'pull_request_review', 'check_run', 'merge_group'];
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

  userAuthorizationUrl(state: string, publicUrl: string, options: { login?: string; selectAccount?: boolean } = {}): string {
    if (!this.options.clientId || !this.broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE))
      throw new Error('GitHub user authorization is unavailable; configure the App client id and secret');
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', `${new URL(publicUrl).origin}/api/github/oauth/callback`);
    url.searchParams.set('state', state);
    if (options.login?.trim()) url.searchParams.set('login', options.login.trim());
    if (options.selectAccount) url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  async authorizeUser(userId: string, code: string, publicUrl?: string,
    options: { expectedAccountId?: string; makeActive?: boolean } = {}): Promise<GitHubUserIdentity> {
    if (!this.options.clientId) throw new Error('GitHub App client id is missing');
    const clientSecret = this.broker.resolve(GITHUB_APP_CLIENT_SECRET_HANDLE,
      { caps: [`use-credential:${GITHUB_APP_CLIENT_SECRET_HANDLE}`] });
    const value = await this.oauthToken({ client_id: this.options.clientId, client_secret: clientSecret, code,
      ...(publicUrl ? { redirect_uri: `${new URL(publicUrl).origin}/api/github/oauth/callback` } : {}) });
    if (!value.access_token) throw new Error(value.error_description || value.error || 'GitHub returned no user access token');
    const identity = await this.identityForToken(String(value.access_token));
    if (options.expectedAccountId && identity.id !== options.expectedAccountId)
      throw new Error(`GitHub connected @${identity.login}, but this reconnect belongs to another account`);
    this.saveUserToken(userId, identity.id, value);
    this.saveUserIdentity(userId, identity, options.makeActive);
    return identity;
  }

  /** Reuse the user access token Better Auth just received while signing in.
   * This links identity and development authorship without a second OAuth flow. */
  async adoptUserAuthorization(userId: string, expectedAccountId: string, authorization: {
    accessToken: string;
    refreshToken?: string;
    accessTokenExpiresAt?: Date;
    refreshTokenExpiresAt?: Date;
  }): Promise<GitHubUserIdentity> {
    const identity = await this.identityForToken(authorization.accessToken);
    if (identity.id !== expectedAccountId)
      throw new Error(`GitHub signed in as @${identity.login}, but returned a mismatched account id`);
    this.broker.registerHandle(githubUserTokenHandle(userId, identity.id), JSON.stringify({
      accessToken: authorization.accessToken,
      ...(authorization.accessTokenExpiresAt ? { expiresAt: authorization.accessTokenExpiresAt.getTime() } : {}),
      ...(authorization.refreshToken ? { refreshToken: authorization.refreshToken } : {}),
      ...(authorization.refreshTokenExpiresAt ? { refreshExpiresAt: authorization.refreshTokenExpiresAt.getTime() } : {}),
    }));
    this.saveUserIdentity(userId, identity, false);
    return identity;
  }

  private saveUserIdentity(userId: string, identity: GitHubUserIdentity, makeActive = false): void {
    const accounts = this.userAccounts(userId);
    const prior = accounts.find((account) => account.id === identity.id);
    const next = [...accounts.filter((account) => account.id !== identity.id), { ...prior, ...identity }];
    this.saveUserAccounts(userId, next);
    if (makeActive || !this.activeUserAccountId(userId))
      this.store.kvSet(githubUserActiveAccountKey(userId), identity.id);
  }

  /** Public account data needed for the commit byline. A stable GitHub noreply
   * address is derived later, so this does not request private-email access. */
  async userIdentity(userId: string, accountId?: string): Promise<GitHubUserIdentity> {
    const value = await this.userRequest<{ id?: string | number; login?: string; name?: string | null }>(
      userId, '/user', {}, accountId);
    return this.parseUserIdentity(value);
  }

  private async identityForToken(token: string): Promise<GitHubUserIdentity> {
    return this.parseUserIdentity(await this.request<{ id?: string | number; login?: string; name?: string | null }>('/user', token));
  }

  private parseUserIdentity(value: { id?: string | number; login?: string; name?: string | null }): GitHubUserIdentity {
    const id = String(value.id ?? '').trim();
    const login = String(value.login ?? '').trim();
    if (!/^\d+$/.test(id) || !/^[A-Za-z0-9-]+$/.test(login))
      throw new Error('GitHub returned an invalid account identity');
    return { id, login, ...(value.name?.trim() ? { name: value.name.trim() } : {}) };
  }

  private userAccounts(userId: string): GitHubUserIdentity[] {
    try {
      const value = JSON.parse(this.store.kvGet(githubUserAccountsKey(userId)) ?? '[]');
      return Array.isArray(value) ? value.filter((account): account is GitHubUserIdentity =>
        /^\d+$/.test(String(account?.id ?? '')) && /^[A-Za-z0-9-]+$/.test(String(account?.login ?? ''))) : [];
    } catch { return []; }
  }

  private saveUserAccounts(userId: string, accounts: GitHubUserIdentity[]): void {
    this.store.kvSet(githubUserAccountsKey(userId), JSON.stringify(accounts));
  }

  activeUserAccountId(userId: string): string | undefined {
    const configured = this.userAccounts(userId).filter((account) =>
      this.broker.hasHandle(githubUserTokenHandle(userId, account.id)));
    const active = this.store.kvGet(githubUserActiveAccountKey(userId));
    return configured.some((account) => account.id === active) ? active : configured[0]?.id;
  }

  async listUserAccounts(userId: string): Promise<GitHubUserAccount[]> {
    await this.migrateLegacyUserAuthorization(userId);
    const active = this.activeUserAccountId(userId);
    return this.userAccounts(userId)
      .filter((account) => this.broker.hasHandle(githubUserTokenHandle(userId, account.id)))
      .map((account) => ({ ...account, active: account.id === active }));
  }

  /** Revalidate a token-authority-pinned account against the delegated user's
   * connected OAuth accounts before any external write. */
  async assertUserAccount(userId: string, accountId: string): Promise<GitHubUserAccount> {
    const account = (await this.listUserAccounts(userId)).find((candidate) => candidate.id === accountId);
    if (!account) throw new Error('the pinned GitHub account is not connected to the delegated human');
    return account;
  }

  async repositoryPermission(userId: string, slug: string, accountId?: string): Promise<GitHubRepositoryPermission> {
    if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) throw new Error('invalid GitHub repository');
    try {
      // `GET /repos/{owner}/{repo}` reports the authenticated user's effective
      // role in `permissions`. Unlike the collaborator-permission endpoint it
      // does not require Administration(read), so the App keeps its existing
      // least-privilege metadata/contents/PR permission set.
      const value = await this.userRequest<any>(userId, `/repos/${slug}`, {}, accountId);
      const effective = value?.permissions ?? {};
      const permission = effective.admin ? 'admin'
        : effective.maintain ? 'maintain'
          : effective.push ? 'write'
            : effective.triage ? 'triage'
              : effective.pull ? 'read'
                : 'none';
      const roleName = value?.role_name ? String(value.role_name) : undefined;
      return {
        slug,
        permission,
        ...(roleName ? { roleName } : {}),
        // Custom roles are represented by their effective permissions. For the
        // built-ins, `push` covers write/maintain/admin; retain the names as a
        // defensive fallback for older GitHub Enterprise payloads.
        canMerge: Boolean(effective.push || effective.maintain || effective.admin),
        mergeMethod: value?.allow_merge_commit !== false ? 'merge'
          : value?.allow_squash_merge !== false ? 'squash'
            : 'rebase',
      };
    } catch (error) {
      if (error instanceof Error && /GitHub API 404\b/.test(error.message))
        return { slug, permission: 'none', canMerge: false, mergeMethod: 'merge' };
      throw error;
    }
  }

  async setActiveUserAccount(userId: string, accountId: string): Promise<void> {
    const accounts = await this.listUserAccounts(userId);
    if (!accounts.some((account) => account.id === accountId)) throw new Error('GitHub account is not connected');
    this.store.kvSet(githubUserActiveAccountKey(userId), accountId);
  }

  async removeUserAccount(userId: string, accountId: string): Promise<string> {
    const accounts = await this.listUserAccounts(userId);
    if (!accounts.some((account) => account.id === accountId)) throw new Error('GitHub account is not connected');
    if (accounts.length <= 1) throw new Error('Connect a new GitHub account first');
    this.broker.deleteHandle(githubUserTokenHandle(userId, accountId));
    const remaining = accounts.filter((account) => account.id !== accountId);
    this.saveUserAccounts(userId, remaining);
    const active = this.activeUserAccountId(userId) ?? remaining[0]!.id;
    this.store.kvSet(githubUserActiveAccountKey(userId), active);
    return active;
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

  disconnectInstallation(connectionId: string): void {
    this.tokenCache.delete(connectionId);
    this.tokenMints.delete(connectionId);
    this.store.deleteGitConnection(connectionId);
  }

  async reconcile(connection: GitConnection): Promise<Repository[]> {
    const token = await this.installationToken(connection);
    const remote: GitHubRepositoryPayload[] = [];
    // A page ceiling, and a shape check. The loop had neither: a `for (;;)` over
    // a paginated endpoint is an unbounded remote-controlled loop, and a response
    // missing `repositories` threw a bare `TypeError: not iterable` that told the
    // operator nothing. 100 pages = 10,000 repositories, far beyond any real
    // installation.
    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
      const response = await this.request<{ repositories: GitHubRepositoryPayload[] }>(
        `/installation/repositories?per_page=100&page=${page}`, token,
      );
      if (!Array.isArray(response?.repositories))
        throw new Error('GitHub /installation/repositories returned no repository list');
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
      await this.removeLegacyDeployKeys(repository, token);
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
    // The delivery id is CLAIMED here (so two concurrent copies of one delivery
    // cannot both reconcile) but the claim is provisional: `dispatchWebhook` does
    // unbounded network I/O, and if that throws the claim must be released. It
    // used to be permanent — the exception became a gateway error, GitHub
    // redelivered, and the redelivery short-circuited as a duplicate, losing the
    // reconcile forever.
    if (!this.store.recordGithubDelivery(deliveryId, event)) return { accepted: false };
    try {
      // Bounded retry budget: this call is inside GitHub's ~10 s delivery
      // timeout, so a long backoff must fail fast and let GitHub redeliver
      // rather than hold the response open (see WEBHOOK_RETRY_BUDGET_MS).
      return await retryDeadline.run(Date.now() + WEBHOOK_RETRY_BUDGET_MS, () => this.dispatchWebhook(event, raw));
    } catch (error) {
      this.store.releaseGithubDelivery(deliveryId);
      throw error;
    }
  }

  private async dispatchWebhook(event: string, raw: Buffer):
  Promise<{ accepted: boolean; reconciled?: number; events?: GithubPrWebhookEvent[] }> {
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
    // The inverse transition. Without it `suspendedAt` was write-only: the ONLY
    // path that ever cleared it was the browser install callback, so an
    // `installation.unsuspend` fell through to `reconcile()` →
    // `installationToken()` → "installation is suspended", and the connection
    // stayed dead until someone reinstalled the App by hand. `created` is here for
    // the same reason — a reinstall of a previously-suspended installation.
    if (event === 'installation' && (payload.action === 'unsuspend' || payload.action === 'created')) {
      const saved = this.store.upsertGitConnection({ organizationId: connection.organizationId, provider: 'github', installationId,
        accountLogin: payload.installation?.account?.login ?? connection.accountLogin,
        accountType: payload.installation?.account?.type ?? connection.accountType ?? undefined,
        suspendedAt: undefined });
      this.tokenCache.delete(saved.id);
      const repositories = await this.reconcile(saved);
      return { accepted: true, reconciled: repositories.length };
    }
    if (event === 'pull_request' || event === 'pull_request_review' || event === 'check_run') {
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

  /**
   * Mint (or reuse) an installation token.
   *
   * Three things this deliberately gets right:
   *  - the SUSPENDED check runs before the cache read, so a connection suspended
   *    while a valid token was cached stops working immediately rather than
   *    keeping GitHub access for up to an hour;
   *  - a malformed `expires_at` yields `NaN`, and every `NaN > x` comparison is
   *    false — so the cache silently never hit and karmax minted a fresh token on
   *    every single call. An unparseable expiry now falls back to GitHub's
   *    documented one-hour lifetime (minus the same safety margin);
   *  - concurrent callers share ONE in-flight mint instead of racing N of them
   *    (each mint invalidates nothing, but N round trips per burst is pure waste
   *    and counts against the App's rate limit).
   */
  async installationToken(connection: GitConnection): Promise<string> {
    if (connection.suspendedAt) throw new Error('GitHub App installation is suspended');
    const cached = this.tokenCache.get(connection.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const inFlight = this.tokenMints.get(connection.id);
    if (inFlight) return inFlight;
    const mint = (async () => {
      const created = await this.appRequest<{ token: string; expires_at: string }>(
        `/app/installations/${encodeURIComponent(connection.installationId)}/access_tokens`, { method: 'POST' },
      );
      const parsed = Date.parse(created.expires_at ?? '');
      const expiresAt = Number.isFinite(parsed) ? parsed : Date.now() + 3600_000;
      this.tokenCache.set(connection.id, { token: created.token, expiresAt });
      return created.token;
    })().finally(() => this.tokenMints.delete(connection.id));
    this.tokenMints.set(connection.id, mint);
    return mint;
  }

  /** Drop a token minted before an installation-permission upgrade. Calls are
   * deliberately rate-limited: a held landing task polls while the human is on
   * GitHub's approval screen, and token minting must not follow that poll rate. */
  invalidateInstallationToken(connectionId: string, cooldownMs = 60_000): boolean {
    const now = Date.now();
    const last = this.tokenInvalidatedAt.get(connectionId) ?? 0;
    if (now - last < cooldownMs) return false;
    this.tokenInvalidatedAt.set(connectionId, now);
    this.tokenCache.delete(connectionId);
    return true;
  }

  async brokerCredentials(repository: Repository): Promise<{ httpsToken: string; env: Record<string, string> }> {
    if (!repository.gitConnectionId) throw new Error('repository has no GitHub App connection');
    const connection = this.store.getGitConnection(repository.gitConnectionId);
    if (!connection) throw new Error('repository GitHub App connection is missing');
    const token = await this.installationToken(connection);
    return { httpsToken: token, env: { GH_TOKEN: token } };
  }

  /**
   * Mint a read-only token scoped to one repository for trusted world
   * provisioning. It is deliberately not cached: the caller materializes it
   * only long enough to clone, then removes it before the agent starts.
   */
  async repositoryCloneToken(repository: Repository): Promise<string> {
    return this.repositoryToken(repository);
  }

  /** Mint the least-powerful clone credential for one repository. The sandbox
   * never receives the installation-wide token used by trusted host services. */
  private async repositoryToken(repository: Repository): Promise<string> {
    if (!repository.gitConnectionId) throw new Error('repository has no GitHub App connection');
    const connection = this.store.getGitConnection(repository.gitConnectionId);
    if (!connection) throw new Error('repository GitHub App connection is missing');
    if (connection.suspendedAt) throw new Error('GitHub App installation is suspended');
    if (!/^\d+$/.test(repository.providerId ?? ''))
      throw new Error(`repository ${repository.id} has no GitHub repository id`);
    const created = await this.appRequest<{ token: string }>(
      `/app/installations/${encodeURIComponent(connection.installationId)}/access_tokens`,
      { method: 'POST', body: JSON.stringify({
        repository_ids: [Number(repository.providerId)],
        permissions: { contents: 'read' },
      }) },
    );
    if (!created.token) throw new Error('GitHub returned no installation token');
    return created.token;
  }

  /** Create a GitHub repository, add it to a selected-repository App
   * installation, and return the durable record. */
  async createRepository(connectionId: string, userId: string, input: {
    name: string; description?: string; private?: boolean; defaultBranch?: string; autoInit?: boolean;
  }, options: { accountId?: string } = {}): Promise<Repository> {
    const connection = this.store.getGitConnection(connectionId);
    if (!connection) throw new Error('GitHub connection not found');
    const accounts = await this.listUserAccounts(userId);
    const account = options.accountId
      ? accounts.find((candidate) => candidate.id === options.accountId)
      : accounts.find((candidate) => candidate.active) ?? accounts[0];
    if (!account) throw new Error('GitHub account is not connected for this user');
    // A personal installation can create only in its own account. Check before
    // POST /user/repos so a mismatched delegated account cannot create a repo and
    // then fail later while enrolling it into somebody else's installation.
    if (connection.accountType === 'User' && account.login.toLowerCase() !== connection.accountLogin.toLowerCase())
      throw new Error('selected GitHub account does not match this GitHub App connection');
    const name = this.repositoryName(input.name);
    const pathname = connection.accountType === 'Organization'
      ? `/orgs/${encodeURIComponent(connection.accountLogin)}/repos`
      : '/user/repos';
    const created = await this.userRequest<GitHubRepositoryPayload>(userId, pathname, {
      method: 'POST', body: JSON.stringify({ name, description: input.description?.trim().slice(0, 350) || undefined,
        private: input.private !== false, auto_init: input.autoInit !== false }),
    }, account.id);
    return this.enrollRepository(connection, userId, created, input.defaultBranch, account.id);
  }

  /** Idempotently provision a platform-owned repository. A previous attempt can
   * succeed at GitHub and then be interrupted before the durable record or
   * repository record is saved; retrying must adopt that exact private repository
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
    created: GitHubRepositoryPayload, defaultBranch?: string, accountId?: string): Promise<Repository> {
    // Installation may have been limited to selected repositories. User
    // authorization lets Karmax enroll the repository without sending the
    // operator back through GitHub settings. The PUT is idempotent for selected
    // installations; installations covering every repository may reject it,
    // but their installation token can already see the repository.
    try {
      await this.userRequest(userId,
        `/user/installations/${encodeURIComponent(connection.installationId)}/repositories/${encodeURIComponent(String(created.id))}`,
        { method: 'PUT' }, accountId);
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
    await this.removeLegacyDeployKeys(repository, installationToken);
    return repository;
  }

  /** Remove deploy keys left by versions that predate installation-token Git
   * transport. Failure is surfaced so organization deletion can be retried
   * instead of orphaning a write-capable key in GitHub.
   *
   * A SUSPENDED (or deleted) installation is the exception: `installationToken`
   * refuses to mint for one, so minting unconditionally whenever repositories
   * existed made every retry of an organization delete fail identically —
   * permanently blocking deletion, the opposite of what the paragraph above
   * promises. GitHub has already revoked the installation's access in that case,
   * so its deploy keys are inert; skip the remote deletes and still clean up the
   * local broker handles, which are the part karmax actually owns. */
  async disconnectOrganization(organizationId: string): Promise<void> {
    for (const connection of this.store.listGitConnections(organizationId)) {
      const repositories = this.store.listRepositories(organizationId).filter((repo) => repo.gitConnectionId === connection.id);
      const hasLegacyKeys = repositories.some((repository) => this.store.repositoryDeployKeys(repository.id));
      const token = hasLegacyKeys && !connection.suspendedAt ? await this.installationToken(connection) : undefined;
      for (const repository of repositories) {
        const keys = this.store.repositoryDeployKeys(repository.id);
        if (!keys) continue;
        if (token) {
          await this.deleteDeployKey(repository, keys.cloneKeyId, token);
          await this.deleteDeployKey(repository, keys.writeKeyId, token);
        }
        this.broker.deleteHandle(keys.cloneHandle);
        this.broker.deleteHandle(keys.writeHandle);
        this.store.clearRepositoryDeployKeys(repository.id);
      }
      this.tokenCache.delete(connection.id);
    }
  }

  /** One-way migration away from the two per-repository deploy keys. New
   * connections never create these records; a refresh removes old remote keys,
   * deletes their private material, and clears the compatibility row. */
  private async removeLegacyDeployKeys(repository: Repository, installationToken: string): Promise<void> {
    const keys = this.store.repositoryDeployKeys(repository.id);
    if (!keys) return;
    await this.deleteDeployKey(repository, keys.cloneKeyId, installationToken);
    await this.deleteDeployKey(repository, keys.writeKeyId, installationToken);
    this.broker.deleteHandle(keys.cloneHandle);
    this.broker.deleteHandle(keys.writeHandle);
    this.store.clearRepositoryDeployKeys(repository.id);
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
      this.store.clearRepositoryDeployKeys(repository.id);
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

  /** Injectable so tests do not actually wait out a rate-limit backoff. */
  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /**
   * One GitHub API call, with the two retries the API's own contract asks for.
   *
   * Neither existed before: a secondary rate limit (403/429 with `retry-after`, or
   * a primary limit with `x-ratelimit-remaining: 0` and `x-ratelimit-reset`) was
   * turned straight into an exception, and a transient 5xx failed the whole
   * reconcile/PR operation. Both are explicitly retryable, and GitHub tells us
   * exactly how long to wait — honouring that is politer AND more reliable than
   * failing and being redelivered.
   *
   * Deliberately bounded and conservative: at most `MAX_REQUEST_RETRIES` attempts,
   * each wait capped at `MAX_RETRY_WAIT_MS`, and only for conditions that cannot
   * duplicate a side effect — rate limits (rejected before execution) on any
   * method, and 5xx only on `RETRYABLE_5XX_METHODS`. A 5xx on a POST/PATCH is
   * raised, because GitHub may have applied it; so is a 4xx that is not a rate
   * limit. An ambient `retryDeadline` (the webhook path) can cut the budget short.
   */
  private async request<T = unknown>(pathname: string, token: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(`${this.apiBase}${pathname}`, { ...init, headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28', 'content-type': 'application/json', ...(init.headers ?? {}),
      } });
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return await response.json() as T;
      }
      let waitMs = attempt < MAX_REQUEST_RETRIES ? retryDelayMs(response, attempt, method) : undefined;
      const deadline = retryDeadline.getStore();
      if (waitMs !== undefined && deadline !== undefined && Date.now() + waitMs > deadline) waitMs = undefined;
      if (waitMs === undefined) throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 500)}`);
      await this.sleep(waitMs);
    }
  }

  private saveUserToken(userId: string, accountId: string, value: any): void {
    this.saveTokenHandle(githubUserTokenHandle(userId, accountId), value);
  }

  private saveTokenHandle(handle: string, value: any): void {
    const now = Date.now();
    this.broker.registerHandle(handle, JSON.stringify({
      accessToken: String(value.access_token),
      expiresAt: value.expires_in ? now + Number(value.expires_in) * 1000 : undefined,
      refreshToken: value.refresh_token ? String(value.refresh_token) : undefined,
      refreshExpiresAt: value.refresh_token_expires_in ? now + Number(value.refresh_token_expires_in) * 1000 : undefined,
    }));
  }

  /** Resolve the signed-in person's refreshable GitHub authorization for
   * user-attributed work (repository creation, pull requests, comments). This
   * is intentionally distinct from installationToken(): GitHub records actions
   * made with this token as the person, not as the organization App.
   * `forceRefresh` recovers from early invalidation; a dead refresh grant is
   * cleared so status flips to disconnected instead of 401ing forever. */
  async userAccessToken(userId: string, opts: { forceRefresh?: boolean; accountId?: string } = {}): Promise<string> {
    const accountId = opts.accountId ?? this.activeUserAccountId(userId);
    const handle = accountId ? githubUserTokenHandle(userId, accountId) : legacyGithubUserTokenHandle(userId);
    if (!this.broker.hasHandle(handle)) throw new Error('Connect GitHub on your profile, then try again.');
    const stored = JSON.parse(this.broker.resolve(handle, { caps: [`use-credential:${handle}`] })) as {
      accessToken: string; expiresAt?: number; refreshToken?: string; refreshExpiresAt?: number;
    };
    if (!opts.forceRefresh && (!stored.expiresAt || stored.expiresAt > Date.now() + 60_000)) return stored.accessToken;
    if (!stored.refreshToken || (stored.refreshExpiresAt && stored.refreshExpiresAt <= Date.now())) {
      this.broker.deleteHandle(handle);
      throw new Error('Reconnect GitHub on your profile, then try again.');
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
      throw new Error('Reconnect GitHub on your profile, then try again.');
    }
    this.saveTokenHandle(handle, value);
    return String(value.access_token);
  }

  /** A user-token GitHub request that self-heals a server-side invalidation: on a
   * 401 it forces a token refresh once and retries, so a token karmax's own clock
   * still trusts (but GitHub has revoked) recovers instead of failing the caller. */
  private async userRequest<T = unknown>(userId: string, pathname: string, init: RequestInit = {}, accountId?: string): Promise<T> {
    try {
      return await this.request<T>(pathname, await this.userAccessToken(userId, { accountId }), init);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('GitHub API 401')) throw error;
      return await this.request<T>(pathname, await this.userAccessToken(userId, { forceRefresh: true, accountId }), init);
    }
  }

  /** Move the pre-multi-account authorization into the account-addressed vault
   * namespace after discovering its stable GitHub id. This is lazy so boot never
   * depends on GitHub being reachable. */
  private async migrateLegacyUserAuthorization(userId: string): Promise<void> {
    const legacy = legacyGithubUserTokenHandle(userId);
    if (!this.broker.hasHandle(legacy)) return;
    const identity = await this.userIdentity(userId);
    const stored = this.broker.resolve(legacy, { caps: [`use-credential:${legacy}`] });
    this.broker.registerHandle(githubUserTokenHandle(userId, identity.id), stored);
    const accounts = this.userAccounts(userId);
    this.saveUserAccounts(userId, [...accounts.filter((account) => account.id !== identity.id), identity]);
    if (!this.store.kvGet(githubUserActiveAccountKey(userId))) this.store.kvSet(githubUserActiveAccountKey(userId), identity.id);
    this.broker.deleteHandle(legacy);
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

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}
