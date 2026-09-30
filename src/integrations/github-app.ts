import * as __asyncCollections from '../util/async-collections.js';
import crypto from 'node:crypto';
import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { Store } from '../store/db.js';
import type { GitConnection, Repository } from '../domain/types.js';
import { githubPrWebhookObservationKey, pullRequestWebhookEvent, reconcilePullRequestView,
  type GithubPrWebhookEvent } from './github-pr.js';
import { GithubActionsApi } from './github-actions.js';
import { githubActionsRunIdFromUrl } from './github-actions.js';
import { observeDeploymentWorkflowRun } from './github-deployment-monitor.js';
import { taskIdOfBranch, BRAND } from '../domain/brand.js';

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
const githubUserAuthorizationFailureKey = (userId: string, accountId?: string) =>
  `github-app:user:${userId}:${accountId ? `account:${accountId}:` : ''}authorization-failure`;

function permissionLevel(value: unknown): 'write' | 'read' | 'none' {
  return value === 'write' ? 'write' : value === 'read' ? 'read' : 'none';
}

function permissionSatisfies(actual: 'write' | 'read' | 'none', required: GitHubAppPermissionLevel): boolean {
  return actual === 'write' || (required === 'read' && actual === 'read');
}

export type GitHubAppPermissionLevel = 'write' | 'read';

/**
 * The GitHub App is krmax's repository-scoped transport principal. Agent and
 * task capabilities decide which operations may be invoked; the App grant must
 * be broad enough that a permitted operation does not fail later with an opaque
 * provider 403. Installation owners still choose the repositories in scope and
 * explicitly approve every expansion of this envelope on GitHub.
 */
export const GITHUB_APP_PERMISSIONS = {
  actions: 'write',
  administration: 'write',
  attestations: 'write',
  checks: 'write',
  contents: 'write',
  deployments: 'write',
  discussions: 'write',
  emails: 'read',
  environments: 'write',
  issues: 'write',
  members: 'read',
  merge_queues: 'write',
  metadata: 'read',
  packages: 'write',
  pages: 'write',
  pull_requests: 'write',
  repository_hooks: 'write',
  secret_scanning_alerts: 'read',
  secrets: 'write',
  security_events: 'read',
  statuses: 'write',
  actions_variables: 'write',
  vulnerability_alerts: 'read',
  workflows: 'write',
} as const satisfies Record<string, GitHubAppPermissionLevel>;

const GITHUB_APP_PERMISSION_LABELS: Record<keyof typeof GITHUB_APP_PERMISSIONS, string> = {
  actions: 'Actions',
  administration: 'Repository administration',
  attestations: 'Attestations',
  checks: 'Checks',
  contents: 'Contents',
  deployments: 'Deployments',
  discussions: 'Discussions',
  emails: 'Email addresses',
  environments: 'Environments',
  issues: 'Issues',
  members: 'Members',
  merge_queues: 'Merge queues',
  metadata: 'Metadata',
  packages: 'Packages',
  pages: 'Pages',
  pull_requests: 'Pull requests',
  repository_hooks: 'Repository hooks',
  secret_scanning_alerts: 'Secret scanning alerts',
  secrets: 'Actions secrets',
  security_events: 'Security events',
  statuses: 'Commit statuses',
  actions_variables: 'Actions variables',
  vulnerability_alerts: 'Dependabot vulnerability alerts',
  workflows: 'Workflows',
};

const GITHUB_APP_ACCOUNT_PERMISSIONS = new Set<keyof typeof GITHUB_APP_PERMISSIONS>(['emails']);
const GITHUB_APP_ORGANIZATION_PERMISSIONS = new Set<keyof typeof GITHUB_APP_PERMISSIONS>(['members']);

export function isGithubWorkflowPermissionRejection(value: unknown): boolean {
  return /refusing to allow a GitHub App to create or update workflow [`'"]?\.github\/workflows\//i
    .test(String(value ?? ''));
}

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
  permissions?: Record<string, string>;
  html_url?: string;
}

interface GitHubAppPayload {
  slug?: string;
  owner?: { login?: string; type?: 'User' | 'Organization' };
  permissions?: Record<string, string>;
}

export interface GitHubWorkflowPermissionStatus {
  app: 'write' | 'read' | 'none';
  installation?: 'write' | 'read' | 'none';
  ready: boolean;
  appSettingsUrl: string;
  installationSettingsUrl?: string;
}

export interface GitHubAppPermissionStatus {
  ready: boolean;
  appSettingsUrl: string;
  installationSettingsUrl?: string;
  permissions: Array<{
    key: keyof typeof GITHUB_APP_PERMISSIONS;
    label: string;
    required: GitHubAppPermissionLevel;
    app: 'write' | 'read' | 'none';
    installation?: 'write' | 'read' | 'none';
    ready: boolean;
  }>;
  missingApp: string[];
  missingInstallation: string[];
}

export interface GitHubUserIdentity {
  id: string;
  login: string;
  name?: string;
}

export interface GitHubUserAccount extends GitHubUserIdentity {
  active: boolean;
}

export type GitHubUserAuthorizationFailureCode =
  | 'refresh_token_missing'
  | 'refresh_token_expired'
  | 'refresh_rejected'
  | 'refresh_request_failed';

/** Secret-free, durable context for the most recent user-token refresh failure. */
export interface GitHubUserAuthorizationFailure {
  code: GitHubUserAuthorizationFailureCode;
  summary: string;
  occurredAt: number;
  disconnected: boolean;
  accountId?: string;
  providerError?: string;
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

export interface GithubProjectWebhookEvent {
  projectId: string;
  type: 'github.workflow.failed';
  payload: {
    repository: string;
    repositoryId: string;
    workflow: string;
    runId: number;
    attempt: number;
    conclusion: string;
    headSha: string;
    branch: string;
    url: string;
    source: 'workflow_run' | 'check_run' | 'deployment_monitor';
    originatingTaskId?: string;
    incidentKey?: string;
    evidence?: Record<string, unknown>;
  };
}

/** A default-branch repository change that may refresh an opted-in Git-backed
 * password store. The gateway performs the expensive Git/GPG work after the
 * webhook has been acknowledged. */
export interface GithubVaultPushEvent {
  organizationId: string;
  repositoryId: string;
  revision: string;
}

export interface GithubWebhookResult {
  accepted: boolean;
  reconciled?: number;
  events?: GithubPrWebhookEvent[];
  projectEvents?: GithubProjectWebhookEvent[];
  vaultPushes?: GithubVaultPushEvent[];
}

export type GitHubRepositoryFileStatus =
  | { status: 'present'; bytes: number }
  | { status: 'missing' }
  | { status: 'unreadable'; error: string };

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
  private fetcher!: typeof fetch;
  private apiBase!: string;
  private tokenCache = new Map<string, { token: string; expiresAt: number }>();
  /** In-flight token mints, keyed by connection — collapses concurrent callers. */
  private tokenMints = new Map<string, Promise<string>>();
  /** GitHub refresh tokens are single-use. Sharing one refresh per account is a
   * correctness requirement: two callers must not consume the same chain. */
  private userTokenRefreshes = new Map<string, Promise<string>>();
  /** Bounds refreshes while an installation owner is still approving a newly
   * requested permission; without this, every landing poll would mint a token. */
  private tokenInvalidatedAt = new Map<string, number>();

  constructor(private store: Store, private broker: CredentialBroker, private options: GitHubAppOptions = {}) {
  }

  static async create(store: Store, broker: CredentialBroker, options: GitHubAppOptions = {}) {
    const instance = new GitHubAppService(store, broker, options);
    await instance.initialize(store, broker, options);
    return instance;
  }

  private async initialize(store: Store, broker: CredentialBroker, options: GitHubAppOptions = {}) {

    this.options = {
      ...options,
      appId: options.appId?.trim() || (await store.kvGet(GITHUB_APP_ID_KEY)),
      appSlug: options.appSlug?.trim() || (await store.kvGet(GITHUB_APP_SLUG_KEY)),
      clientId: options.clientId?.trim() || (await store.kvGet(GITHUB_APP_CLIENT_ID_KEY)),
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

  async status(userId?: string): Promise<{ configured: boolean; appId?: string; appSlug?: string; oauthConfigured: boolean;
    webhookConfigured: boolean; syncMode: 'webhook' | 'on-demand'; userAuthorized: boolean;
    lastAuthorizationFailure?: GitHubUserAuthorizationFailure }> {
    let syncMode: 'webhook' | 'on-demand' = 'on-demand';
    try {
      const publicUrl = (await this.store.kvGet(GITHUB_APP_PUBLIC_URL_KEY));
      if (publicUrl && publicWebhookOrigin(new URL(publicUrl))) syncMode = 'webhook';
    } catch {}
    const lastAuthorizationFailure = userId ? (await this.lastUserAuthorizationFailure(userId)) : undefined;
    return {
      configured: this.configured(),
      ...(this.options.appId ? { appId: this.options.appId } : {}),
      ...(this.options.appSlug ? { appSlug: this.options.appSlug } : {}),
      oauthConfigured: Boolean(this.options.clientId && this.broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE)),
      webhookConfigured: this.broker.hasHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE),
      syncMode,
      userAuthorized: Boolean(userId && ((await this.userAccounts(userId)).some((account) =>
        this.broker.hasHandle(githubUserTokenHandle(userId, account.id)))
        || this.broker.hasHandle(legacyGithubUserTokenHandle(userId)))),
      ...(lastAuthorizationFailure ? { lastAuthorizationFailure } : {}),
    };
  }

  /** GitHub changes an App's URL slug when its display name is renamed. Keep
   * the locally cached slug aligned with the authenticated `/app` response so
   * later installation links do not keep pointing at the retired brand URL. */
  private async rememberAppSlug(slug: string): Promise<void> {
    if (slug === this.options.appSlug) return;
    this.options.appSlug = slug;
    (await this.store.kvSet(GITHUB_APP_SLUG_KEY, slug));
  }

  async configure(input: { appId: string | number; appSlug: string; privateKey: string; webhookSecret?: string;
    clientId?: string; clientSecret?: string }): Promise<ReturnType<GitHubAppService['status']>> {
    const appId = String(input.appId).trim();
    const appSlug = input.appSlug.trim();
    if (!/^\d+$/.test(appId)) throw new Error('GitHub App id must be numeric');
    if (!/^[A-Za-z0-9-]+$/.test(appSlug)) throw new Error('GitHub App slug is invalid');
    try { crypto.createPrivateKey(input.privateKey); }
    catch { throw new Error('GitHub App private key is not a valid PEM key'); }
    this.options.appId = appId;
    this.options.appSlug = appSlug;
    this.options.clientId = input.clientId?.trim() || this.options.clientId;
    (await this.store.kvSet(GITHUB_APP_ID_KEY, appId));
    (await this.store.kvSet(GITHUB_APP_SLUG_KEY, appSlug));
    if (this.options.clientId) (await this.store.kvSet(GITHUB_APP_CLIENT_ID_KEY, this.options.clientId));
    (await this.broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, input.privateKey));
    if (input.webhookSecret) (await this.broker.registerHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE, input.webhookSecret));
    if (input.clientSecret) (await this.broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, input.clientSecret));
    this.tokenCache.clear();
    return (await this.status());
  }

  /** Payload for GitHub's App Manifest flow. The browser posts this directly to
   * GitHub, so Karmax never needs a pre-created App or a server-side PAT. */
  manifest(publicUrl: string, state: string): { action: string; manifest: Record<string, unknown> } {
    const parsed = new URL(publicUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error(`${BRAND} needs an http(s) browser URL to set up GitHub`);
    const origin = parsed.origin;
    const hostname = new URL(origin).hostname.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35) || 'host';
    const manifest: Record<string, unknown> = {
      name: `${BRAND} ${hostname} ${crypto.randomBytes(4).toString('hex')}`,
      url: origin,
      public: this.options.publicApp === true,
      // Keep the CSRF state in the path. GitHub's manifest validator is
      // needlessly strict about some otherwise-valid callback query strings,
      // while the path form is still a full URL and survives the round trip.
      redirect_url: `${origin}/api/github/manifest/callback/${encodeURIComponent(state)}`,
      setup_url: `${origin}/api/github/callback`,
      setup_on_update: true,
      callback_urls: [`${origin}/api/github/oauth/callback`, `${origin}/api/auth/callback/github`],
      // The App is a broad repository transport principal. Its installation is
      // still repository-scoped, its credentials remain in trusted services,
      // and every mutation exposed to an agent is independently gated by a
      // krmax capability. This avoids treating provider permissions as a second,
      // incomplete authorization system that fails only after work is ready.
      default_permissions: { ...GITHUB_APP_PERMISSIONS },
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
      manifest.default_events = ['push', 'pull_request', 'pull_request_review', 'check_run', 'merge_group', 'workflow_run'];
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
    return (await this.configure({ appId: value.id, appSlug: value.slug, privateKey: value.pem,
      webhookSecret: value.webhook_secret, clientId: value.client_id, clientSecret: value.client_secret }));
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
    await this.store.transaction(async () => {
      await this.assertUserOpen(userId);
      await this.saveUserToken(userId, identity.id, value);
      (await this.clearUserAuthorizationFailure(userId, identity.id));
      (await this.clearUserAuthorizationFailure(userId));
      (await this.saveUserIdentity(userId, identity, options.makeActive));
    });
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
    await this.store.transaction(async () => {
      await this.assertUserOpen(userId);
      (await this.broker.registerHandle(githubUserTokenHandle(userId, identity.id), JSON.stringify({
        accessToken: authorization.accessToken,
        ...(authorization.accessTokenExpiresAt ? { expiresAt: authorization.accessTokenExpiresAt.getTime() } : {}),
        ...(authorization.refreshToken ? { refreshToken: authorization.refreshToken } : {}),
        ...(authorization.refreshTokenExpiresAt ? { refreshExpiresAt: authorization.refreshTokenExpiresAt.getTime() } : {}),
      })));
      (await this.clearUserAuthorizationFailure(userId, identity.id));
      (await this.clearUserAuthorizationFailure(userId));
      (await this.saveUserIdentity(userId, identity, false));
    });
    return identity;
  }

  private async saveUserIdentity(userId: string, identity: GitHubUserIdentity, makeActive = false): Promise<void> {
    const accounts = (await this.userAccounts(userId));
    const prior = accounts.find((account) => account.id === identity.id);
    const next = [...accounts.filter((account) => account.id !== identity.id), { ...prior, ...identity }];
    (await this.saveUserAccounts(userId, next));
    if (makeActive || !(await this.activeUserAccountId(userId)))
      (await this.store.kvSet(githubUserActiveAccountKey(userId), identity.id));
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

  private async userAccounts(userId: string): Promise<GitHubUserIdentity[]> {
    try {
      const value = JSON.parse((await this.store.kvGet(githubUserAccountsKey(userId))) ?? '[]');
      return Array.isArray(value) ? value.filter((account): account is GitHubUserIdentity =>
        /^\d+$/.test(String(account?.id ?? '')) && /^[A-Za-z0-9-]+$/.test(String(account?.login ?? ''))) : [];
    } catch { return []; }
  }

  private async saveUserAccounts(userId: string, accounts: GitHubUserIdentity[]): Promise<void> {
    (await this.store.kvSet(githubUserAccountsKey(userId), JSON.stringify(accounts)));
  }

  private async userAuthorizationFailure(userId: string, accountId?: string): Promise<GitHubUserAuthorizationFailure | undefined> {
    try {
      const value = JSON.parse((await this.store.kvGet(githubUserAuthorizationFailureKey(userId, accountId))) ?? 'null');
      if (!value || typeof value !== 'object' || !Number.isFinite(value.occurredAt)
        || typeof value.code !== 'string' || typeof value.summary !== 'string') return undefined;
      return value as GitHubUserAuthorizationFailure;
    } catch { return undefined; }
  }

  private async lastUserAuthorizationFailure(userId: string): Promise<GitHubUserAuthorizationFailure | undefined> {
    const failures = [(await this.userAuthorizationFailure(userId)),
      ...(await __asyncCollections.map((await this.userAccounts(userId)), async (account) => (await this.userAuthorizationFailure(userId, account.id))))]
      .filter((failure): failure is GitHubUserAuthorizationFailure => Boolean(failure));
    return failures.sort((left, right) => right.occurredAt - left.occurredAt)[0];
  }

  private async clearUserAuthorizationFailure(userId: string, accountId?: string): Promise<void> {
    (await this.store.kvDelete(githubUserAuthorizationFailureKey(userId, accountId)));
  }

  private async recordUserAuthorizationFailure(userId: string, accountId: string | undefined,
    failure: Omit<GitHubUserAuthorizationFailure, 'occurredAt' | 'accountId'>): Promise<GitHubUserAuthorizationFailure> {
    const recorded: GitHubUserAuthorizationFailure = {
      ...failure,
      occurredAt: Date.now(),
      ...(accountId ? { accountId } : {}),
    };
    (await this.store.kvSet(githubUserAuthorizationFailureKey(userId, accountId), JSON.stringify(recorded)));
    (await this.store.appendAudit({
      principalId: `user:${userId}`,
      action: 'github.user-authorization.refresh-failed',
      scopeKey: `user:${userId}`,
      detail: { ...recorded },
    }));
    return recorded;
  }

  private async recordRefreshContentionRecovery(userId: string, accountId: string | undefined,
    providerError?: string): Promise<void> {
    (await this.store.appendAudit({
      principalId: `user:${userId}`,
      action: 'github.user-authorization.refresh-contention-recovered',
      scopeKey: `user:${userId}`,
      detail: { ...(accountId ? { accountId } : {}), ...(providerError ? { providerError } : {}) },
    }));
  }

  async activeUserAccountId(userId: string): Promise<string | undefined> {
    const configured = (await this.userAccounts(userId)).filter((account) =>
      this.broker.hasHandle(githubUserTokenHandle(userId, account.id)));
    const active = (await this.store.kvGet(githubUserActiveAccountKey(userId)));
    return configured.some((account) => account.id === active) ? active : configured[0]?.id;
  }

  async listUserAccounts(userId: string): Promise<GitHubUserAccount[]> {
    await this.migrateLegacyUserAuthorization(userId);
    const active = (await this.activeUserAccountId(userId));
    return (await this.userAccounts(userId))
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
    (await this.store.kvSet(githubUserActiveAccountKey(userId), accountId));
  }

  async removeUserAccount(userId: string, accountId: string): Promise<string> {
    const accounts = await this.listUserAccounts(userId);
    if (!accounts.some((account) => account.id === accountId)) throw new Error('GitHub account is not connected');
    if (accounts.length <= 1) throw new Error('Connect a new GitHub account first');
    (await this.broker.deleteHandle(githubUserTokenHandle(userId, accountId)));
    (await this.clearUserAuthorizationFailure(userId, accountId));
    const remaining = accounts.filter((account) => account.id !== accountId);
    (await this.saveUserAccounts(userId, remaining));
    const active = (await this.activeUserAccountId(userId)) ?? remaining[0]!.id;
    (await this.store.kvSet(githubUserActiveAccountKey(userId), active));
    return active;
  }

  /** Only offer installations this human can administer. App credentials alone
   * must never allow linking an arbitrary installation into another tenant. */
  async connectableInstallations(userId: string, githubAccountId?: string): Promise<Array<{ id: string; accountLogin: string; accountType: string }>> {
    const accountId = githubAccountId ?? await this.activeUserAccountId(userId);
    const identity = await this.userIdentity(userId, accountId);
    const result: Array<{ id: string; accountLogin: string; accountType: string }> = [];
    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
      const response = await this.userRequest<{ installations: Array<GitHubInstallationPayload> }>(userId,
        `/user/installations?per_page=100&page=${page}`, {}, accountId);
      if (!Array.isArray(response.installations)) throw new Error('GitHub returned no installation list');
      for (const installation of response.installations) {
        if (installation.suspended_at) continue;
        const account = installation.account;
        let allowed = account.type === 'User' && account.login.toLowerCase() === identity.login.toLowerCase();
        if (account.type === 'Organization') {
          try {
            const membership = await this.userRequest<{ state: string; role: string }>(userId,
              `/user/memberships/orgs/${encodeURIComponent(account.login)}`, {}, accountId);
            allowed = membership.state === 'active' && membership.role === 'admin';
          } catch (error) {
            if (!/404/.test(String(error))) throw error;
          }
        }
        if (allowed) result.push({ id: String(installation.id), accountLogin: account.login, accountType: account.type! });
      }
      if (response.installations.length < 100) return result;
    }
    throw new Error('GitHub installation list exceeded the pagination limit');
  }

  async connectExistingInstallation(organizationId: string, userId: string, installationId: string) {
    if (!(await this.connectableInstallations(userId)).some(installation => installation.id === installationId))
      throw new Error('This GitHub installation is not available to this account');
    return this.connectInstallation(organizationId, installationId);
  }

  /** The installation on the GitHub user's own account. GitHub organizations
   * the user administers are deliberately excluded: choosing one is ambiguous. */
  async ownInstallation(userId: string, githubAccountId: string): Promise<string | undefined> {
    return (await this.connectableInstallations(userId, githubAccountId))
      .find(installation => installation.accountType === 'User')?.id;
  }

  installationUrl(state: string): string {
    if (!this.configured()) throw new Error('GitHub App is not configured');
    const slug = this.options.appSlug?.trim();
    if (!slug || !/^[A-Za-z0-9-]+$/.test(slug)) throw new Error('GitHub App slug is not configured');
    const url = new URL(`https://github.com/apps/${slug}/installations/new`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Observe both permission layers GitHub applies to workflow-file pushes.
   * The App owner first adds Workflows(write) to the App registration; every
   * account that already installed the App must then approve that expansion.
   * Keeping the two states separate makes the required human action explicit. */
  async workflowPermissionStatus(connection?: GitConnection): Promise<GitHubWorkflowPermissionStatus> {
    if (!this.configured()) throw new Error('GitHub App is not configured');
    const app = await this.appRequest<GitHubAppPayload>('/app');
    const slug = String(app.slug ?? this.options.appSlug ?? '').trim();
    if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new Error('GitHub App slug is invalid');
    (await this.rememberAppSlug(slug));
    const owner = String(app.owner?.login ?? '').trim();
    const appSettingsUrl = app.owner?.type === 'Organization' && owner
      ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/${encodeURIComponent(slug)}/permissions`
      : `https://github.com/settings/apps/${encodeURIComponent(slug)}/permissions`;
    const appPermission = permissionLevel(app.permissions?.workflows);
    if (!connection) return { app: appPermission, ready: appPermission === 'write', appSettingsUrl };
    const installation = await this.appRequest<GitHubInstallationPayload>(
      `/app/installations/${encodeURIComponent(connection.installationId)}`,
    );
    const installationPermission = permissionLevel(installation.permissions?.workflows);
    const installationSettingsUrl = installation.html_url?.startsWith('https://github.com/')
      ? installation.html_url
      : connection.accountType === 'Organization'
        ? `https://github.com/organizations/${encodeURIComponent(connection.accountLogin)}/settings/installations/${encodeURIComponent(connection.installationId)}`
        : `https://github.com/settings/installations/${encodeURIComponent(connection.installationId)}`;
    return {
      app: appPermission,
      installation: installationPermission,
      ready: appPermission === 'write' && installationPermission === 'write',
      appSettingsUrl,
      installationSettingsUrl,
    };
  }

  /** Observe the complete operational permission envelope at both GitHub
   * approval layers. The App owner changes the registration first; every
   * existing installation owner must then approve that expansion separately. */
  async permissionStatus(connection?: GitConnection): Promise<GitHubAppPermissionStatus> {
    if (!this.configured()) throw new Error('GitHub App is not configured');
    const app = await this.appRequest<GitHubAppPayload>('/app');
    const slug = String(app.slug ?? this.options.appSlug ?? '').trim();
    if (!/^[A-Za-z0-9-]+$/.test(slug)) throw new Error('GitHub App slug is invalid');
    (await this.rememberAppSlug(slug));
    const owner = String(app.owner?.login ?? '').trim();
    const appSettingsUrl = app.owner?.type === 'Organization' && owner
      ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/${encodeURIComponent(slug)}/permissions`
      : `https://github.com/settings/apps/${encodeURIComponent(slug)}/permissions`;
    let installation: GitHubInstallationPayload | undefined;
    if (connection) installation = await this.appRequest<GitHubInstallationPayload>(
      `/app/installations/${encodeURIComponent(connection.installationId)}`,
    );
    const installationSettingsUrl = installation?.html_url?.startsWith('https://github.com/')
      ? installation.html_url
      : connection
        ? connection.accountType === 'Organization'
          ? `https://github.com/organizations/${encodeURIComponent(connection.accountLogin)}/settings/installations/${encodeURIComponent(connection.installationId)}`
          : `https://github.com/settings/installations/${encodeURIComponent(connection.installationId)}`
        : undefined;
    const permissions = (Object.entries(GITHUB_APP_PERMISSIONS) as Array<
      [keyof typeof GITHUB_APP_PERMISSIONS, GitHubAppPermissionLevel]
    >).map(([key, required]) => {
      const appLevel = permissionLevel(app.permissions?.[key]);
      const installationApplies = Boolean(connection)
        && !GITHUB_APP_ACCOUNT_PERMISSIONS.has(key)
        && (!GITHUB_APP_ORGANIZATION_PERMISSIONS.has(key) || connection?.accountType === 'Organization');
      const installationLevel = installationApplies ? permissionLevel(installation?.permissions?.[key]) : undefined;
      const appReady = permissionSatisfies(appLevel, required);
      const installationReady = !installationApplies || permissionSatisfies(installationLevel ?? 'none', required);
      return {
        key, label: GITHUB_APP_PERMISSION_LABELS[key], required, app: appLevel,
        ...(installationLevel ? { installation: installationLevel } : {}),
        ready: appReady && installationReady,
      };
    });
    return {
      ready: permissions.every((permission) => permission.ready),
      appSettingsUrl,
      ...(installationSettingsUrl ? { installationSettingsUrl } : {}),
      permissions,
      missingApp: permissions.filter((permission) => !permissionSatisfies(permission.app, permission.required))
        .map((permission) => permission.label),
      missingInstallation: connection
        ? permissions.filter((permission) => permission.installation !== undefined
          && !permissionSatisfies(permission.installation, permission.required))
          .map((permission) => permission.label)
        : [],
    };
  }

  /** Human-readable recovery for Git's remote-rejection message. */
  async workflowPermissionGuidance(repository: Repository): Promise<string> {
    const connection = repository.gitConnectionId
      ? (await this.store.getGitConnection(repository.gitConnectionId))
      : undefined;
    if (!connection) return 'Reconnect this repository through the GitHub App, then retry the task.';
    const observed = await this.workflowPermissionStatus(connection);
    if (observed.app !== 'write') {
      return `The installation operator must grant the ${BRAND} GitHub App Workflows: read and write at ${observed.appSettingsUrl}. `
        + `Then the owner of ${connection.accountLogin} must approve the updated App permission at ${observed.installationSettingsUrl}. Retry the task after both steps.`;
    }
    if (observed.installation !== 'write') {
      return `The ${BRAND} GitHub App now requests Workflows: read and write, but ${connection.accountLogin} has not approved it. `
        + `Approve the updated App permission at ${observed.installationSettingsUrl}, then retry the task.`;
    }
    return 'GitHub reports Workflows: read and write as approved. Refresh the GitHub connection in organization settings and retry the task; if GitHub still rejects it, review the App installation on GitHub.';
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
    const connection = (await this.store.upsertGitConnection({ organizationId, provider: 'github',
      installationId: String(installation.id), accountLogin: installation.account.login,
      accountType: installation.account.type, suspendedAt: installation.suspended_at ? Date.parse(installation.suspended_at) : undefined }));
    return { connection, repositories: await this.reconcile(connection) };
  }

  async disconnectInstallation(connectionId: string): Promise<void> {
    this.tokenCache.delete(connectionId);
    this.tokenMints.delete(connectionId);
    (await this.store.deleteGitConnection(connectionId));
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
      const repository = (await this.store.upsertRepository({ organizationId: connection.organizationId, provider: 'github',
        providerId: String(item.id), owner: item.owner.login, name: item.name, sshUrl: item.ssh_url,
        defaultBranch: item.default_branch, private: item.private, gitConnectionId: connection.id }));
      active.add(repository.id);
      await this.removeLegacyDeployKeys(repository, token);
      repositories.push(repository);
    }
    for (const repository of (await this.store.listRepositories(connection.organizationId))) {
      if (repository.gitConnectionId === connection.id && !active.has(repository.id)) await this.removeRepository(repository, token);
    }
    return repositories;
  }

  async handleWebhook(event: string, deliveryId: string, raw: Buffer, signature: string | undefined):
  Promise<GithubWebhookResult> {
    if (!this.verifyWebhook(raw, signature)) throw new Error('invalid GitHub webhook signature');
    // The delivery id is CLAIMED here (so two concurrent copies of one delivery
    // cannot both reconcile) but the claim is provisional: `dispatchWebhook` does
    // unbounded network I/O, and if that throws the claim must be released. It
    // used to be permanent — the exception became a gateway error, GitHub
    // redelivered, and the redelivery short-circuited as a duplicate, losing the
    // reconcile forever.
    if (!(await this.store.recordGithubDelivery(deliveryId, event))) return { accepted: false };
    try {
      // Bounded retry budget: this call is inside GitHub's ~10 s delivery
      // timeout, so a long backoff must fail fast and let GitHub redeliver
      // rather than hold the response open (see WEBHOOK_RETRY_BUDGET_MS).
      return await retryDeadline.run(Date.now() + WEBHOOK_RETRY_BUDGET_MS, () => this.dispatchWebhook(event, raw));
    } catch (error) {
      (await this.store.releaseGithubDelivery(deliveryId));
      throw error;
    }
  }

  private async dispatchWebhook(event: string, raw: Buffer):
  Promise<GithubWebhookResult> {
    const payload = JSON.parse(raw.toString('utf8')) as any;
    const installationId = String(payload.installation?.id ?? '');
    if (!installationId) return { accepted: true };
    const connections = await this.store.gitConnectionsForInstallation('github', installationId);
    // Every connection represents a separate Tavya tenant but uses the same
    // GitHub installation. Run remote reconciliation concurrently so adding
    // tenants does not multiply webhook latency. allSettled is deliberate: if
    // one tenant fails, let the others finish before releasing the delivery for
    // retry, avoiding overlapping attempts against still-running work.
    const settled = await Promise.allSettled(connections.map((connection) =>
      this.dispatchConnectionWebhook(event, payload, connection)));
    const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (failed) throw failed.reason;
    const result: GithubWebhookResult = { accepted: true };
    for (const entry of settled) {
      const next = (entry as PromiseFulfilledResult<GithubWebhookResult>).value;
      if (next.reconciled !== undefined) result.reconciled = (result.reconciled ?? 0) + next.reconciled;
      if (next.events?.length) (result.events ??= []).push(...next.events);
      if (next.projectEvents?.length) (result.projectEvents ??= []).push(...next.projectEvents);
      if (next.vaultPushes?.length) (result.vaultPushes ??= []).push(...next.vaultPushes);
    }
    return result;
  }

  private async dispatchConnectionWebhook(event: string, payload: any, connection: GitConnection): Promise<GithubWebhookResult> {
    const installationId = connection.installationId;
    if (event === 'installation' && (payload.action === 'deleted' || payload.action === 'suspend')) {
      const saved = (await this.store.upsertGitConnection({ organizationId: connection.organizationId, provider: 'github', installationId,
        accountLogin: connection.accountLogin, accountType: connection.accountType ?? undefined, suspendedAt: Date.now() }));
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
      const saved = (await this.store.upsertGitConnection({ organizationId: connection.organizationId, provider: 'github', installationId,
        accountLogin: payload.installation?.account?.login ?? connection.accountLogin,
        accountType: payload.installation?.account?.type ?? connection.accountType ?? undefined,
        suspendedAt: undefined }));
      this.tokenCache.delete(saved.id);
      const repositories = await this.reconcile(saved);
      return { accepted: true, reconciled: repositories.length };
    }
    if (event === 'push' && payload.deleted !== true) {
      const repositoryPayload = payload.repository;
      const repository = (await this.store.listRepositories(connection.organizationId)).find((candidate) =>
        (repositoryPayload?.id && candidate.providerId === String(repositoryPayload.id))
        || `${candidate.owner}/${candidate.name}`.toLowerCase() === String(repositoryPayload?.full_name ?? '').toLowerCase());
      if (repository && payload.ref === `refs/heads/${repository.defaultBranch}`) {
        return { accepted: true, vaultPushes: [{ organizationId: connection.organizationId,
          repositoryId: repository.id, revision: String(payload.after ?? '') }] };
      }
      return { accepted: true };
    }
    const projectEvents = (await this.failedDefaultBranchWorkflowEvents(event, payload, connection.organizationId));
    if (event === 'workflow_run') {
      const repositoryPayload = payload.repository;
      const repository = (await this.store.listRepositories(connection.organizationId)).find((candidate) =>
        (repositoryPayload?.id && candidate.providerId === String(repositoryPayload.id))
        || `${candidate.owner}/${candidate.name}`.toLowerCase() === String(repositoryPayload?.full_name ?? '').toLowerCase());
      if (repository) (await observeDeploymentWorkflowRun(this.store, repository, payload.workflow_run));
      return { accepted: true, ...(projectEvents.length ? { projectEvents } : {}) };
    }
    if (event === 'pull_request' || event === 'pull_request_review' || event === 'check_run') {
      // The PR lifecycle karmax itself started: correlated back to its task so
      // the timeline shows it and `event` triggers can fire on it. Correlation is
      // by branch name, which anyone can pick — so the task must also belong to
      // the tenant that installed this App, or a `tavya/<id>` branch pushed to
      // any repo would inject events into someone else's task.
      const prEvent = pullRequestWebhookEvent(event, payload);
      if (!prEvent || !(await this.ownsTask(connection.organizationId, prEvent.taskId)))
        return { accepted: true, ...(projectEvents.length ? { projectEvents } : {}) };
      const view = (await this.store.getTask(prEvent.taskId))?.lastView;
      if (view) {
        const reconciled = reconcilePullRequestView(view, prEvent.payload);
        if (reconciled !== view) (await this.store.saveView(prEvent.taskId, reconciled));
      }
      const observation = githubPrWebhookObservationKey(prEvent);
      if (observation) {
        const digest = crypto.createHash('sha256').update(observation).digest('hex');
        if (!(await this.store.kvClaim(`github:pr-observation:v1:${digest}`, prEvent.taskId)))
          return { accepted: true, ...(projectEvents.length ? { projectEvents } : {}) };
      }
      return { accepted: true, events: [prEvent], ...(projectEvents.length ? { projectEvents } : {}) };
    }
    if (['installation', 'installation_repositories', 'repository'].includes(event)) {
      const repositories = await this.reconcile({ ...connection, provider: 'github' });
      return { accepted: true, reconciled: repositories.length };
    }
    return { accepted: true };
  }

  /** A merged revision is immutable history. A default-branch workflow failure
   * therefore fans out to the projects that actually attach this repository;
   * the gateway turns each event into a new recovery task. check_run is a
   * compatibility path for Apps that have not yet accepted workflow_run. */
  private async failedDefaultBranchWorkflowEvents(event: string, payload: any,
    organizationId: string): Promise<GithubProjectWebhookEvent[]> {
    if (!['workflow_run', 'check_run'].includes(event) || payload.action !== 'completed') return [];
    const repositoryPayload = payload.repository;
    const repository = (await this.store.listRepositories(organizationId)).find((candidate) =>
      (repositoryPayload?.id && candidate.providerId === String(repositoryPayload.id))
      || `${candidate.owner}/${candidate.name}`.toLowerCase() === String(repositoryPayload?.full_name ?? '').toLowerCase());
    if (!repository) return [];
    const failed = new Set(['action_required', 'failure', 'stale', 'startup_failure', 'timed_out']);
    const workflowRun = payload.workflow_run;
    const checkRun = payload.check_run;
    const conclusion = String(workflowRun?.conclusion ?? checkRun?.conclusion ?? '').toLowerCase();
    const branch = String(workflowRun?.head_branch ?? checkRun?.check_suite?.head_branch ?? '');
    if (!failed.has(conclusion) || branch !== repository.defaultBranch) return [];
    const url = String(workflowRun?.html_url ?? checkRun?.details_url ?? '');
    const runId = Number(workflowRun?.id ?? githubActionsRunIdFromUrl(url)
      ?? checkRun?.check_suite?.id ?? checkRun?.id);
    if (!Number.isSafeInteger(runId) || runId <= 0) return [];
    const headSha = String(workflowRun?.head_sha ?? checkRun?.head_sha ?? checkRun?.check_suite?.head_sha ?? '');
    const headRefs = [
      ...(Array.isArray(workflowRun?.pull_requests) ? workflowRun.pull_requests : []),
      ...(Array.isArray(checkRun?.pull_requests) ? checkRun.pull_requests : []),
    ].map((pr: any) => String(pr?.head?.ref ?? pr?.head?.label ?? ''));
    // A head label is `owner:branch`; a ref is the bare branch.
    const originatingTaskId = headRefs.map((ref) => taskIdOfBranch(ref.slice(ref.indexOf(':') + 1)))
      .find((id) => id && /^task_[A-Za-z0-9_-]+$/.test(id));
    const base = {
      repository: `${repository.owner}/${repository.name}`,
      repositoryId: repository.id,
      workflow: String(workflowRun?.name ?? checkRun?.name ?? 'GitHub workflow'),
      runId,
      attempt: Math.max(1, Number(workflowRun?.run_attempt ?? 1) || 1),
      conclusion,
      headSha,
      branch,
      url,
      source: event as 'workflow_run' | 'check_run',
      ...(originatingTaskId ? { originatingTaskId } : {}),
    };
    return (await this.store.projectIdsForRepository(repository.id)).map((projectId) => ({
      projectId, type: 'github.workflow.failed' as const, payload: base,
    }));
  }

  /** Is `taskId` a live task of the organization that installed the App? */
  private async ownsTask(organizationId: string, taskId: string): Promise<boolean> {
    const task = (await this.store.getTask(taskId));
    const project = task ? (await this.store.getProject(task.projectId)) : undefined;
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
    const connection = (await this.store.getGitConnection(repository.gitConnectionId));
    if (!connection) throw new Error('repository GitHub App connection is missing');
    const token = await this.installationToken(connection);
    return { httpsToken: token, env: { GH_TOKEN: token } };
  }

  /** Repository-bound Actions client. Tokens remain inside this service and a
   * 401 forces the cached installation token to be minted again once. */
  async actions(repository: Repository): Promise<GithubActionsApi> {
    if (!repository.gitConnectionId) throw new Error('repository has no GitHub App connection');
    const connection = (await this.store.getGitConnection(repository.gitConnectionId));
    if (!connection) throw new Error('repository GitHub App connection is missing');
    return new GithubActionsApi(async (options) => {
      if (options?.forceRefresh) {
        this.tokenCache.delete(connection.id);
        this.tokenMints.delete(connection.id);
      }
      return this.installationToken(connection);
    }, { apiBase: this.apiBase, fetch: this.fetcher });
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
    const connection = (await this.store.getGitConnection(repository.gitConnectionId));
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
    const connection = (await this.store.getGitConnection(connectionId));
    if (!connection) throw new Error('GitHub connection not found');
    const name = this.repositoryName(input.name);
    const pathname = connection.accountType === 'Organization'
      ? `/orgs/${encodeURIComponent(connection.accountLogin)}/repos`
      : '/user/repos';
    if (options.accountId) await this.assertUserAccount(userId, options.accountId);
    const created = await this.userRequest<GitHubRepositoryPayload>(userId, pathname, {
      method: 'POST', body: JSON.stringify({ name, description: input.description?.trim().slice(0, 350) || undefined,
        private: input.private !== false, auto_init: input.autoInit !== false }),
    }, options.accountId);
    return this.enrollRepository(connection, userId, created, input.defaultBranch, options.accountId);
  }

  /** Idempotently provision a platform-owned repository. A previous attempt can
   * succeed at GitHub and then be interrupted before the durable record or
   * repository record is saved; retrying must adopt that exact private repository
   * instead of repeatedly failing with GitHub's "name already exists" 422. */
  async ensureRepository(connectionId: string, userId: string, input: {
    name: string; description?: string; private?: boolean; defaultBranch?: string; autoInit?: boolean;
  }): Promise<Repository> {
    const connection = (await this.store.getGitConnection(connectionId));
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
    const repository = (await this.store.upsertRepository({ organizationId: connection.organizationId, provider: 'github',
      providerId: String(created.id), owner: created.owner.login, name: created.name, sshUrl: created.ssh_url,
      defaultBranch: defaultBranch?.trim() || created.default_branch || 'main', private: created.private,
      gitConnectionId: connection.id }));
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
    for (const connection of (await this.store.listGitConnections(organizationId))) {
      const repositories = (await this.store.listRepositories(organizationId)).filter((repo) => repo.gitConnectionId === connection.id);
      const hasLegacyKeys = (await __asyncCollections.some(repositories, async (repository) => (await this.store.repositoryDeployKeys(repository.id))));
      const token = hasLegacyKeys && !connection.suspendedAt ? await this.installationToken(connection) : undefined;
      for (const repository of repositories) {
        const keys = (await this.store.repositoryDeployKeys(repository.id));
        if (!keys) continue;
        if (token) {
          await this.deleteDeployKey(repository, keys.cloneKeyId, token);
          await this.deleteDeployKey(repository, keys.writeKeyId, token);
        }
        (await this.broker.deleteHandle(keys.cloneHandle));
        (await this.broker.deleteHandle(keys.writeHandle));
        (await this.store.clearRepositoryDeployKeys(repository.id));
      }
      this.tokenCache.delete(connection.id);
    }
  }

  /** One-way migration away from the two per-repository deploy keys. New
   * connections never create these records; a refresh removes old remote keys,
   * deletes their private material, and clears the compatibility row. */
  private async removeLegacyDeployKeys(repository: Repository, installationToken: string): Promise<void> {
    const keys = (await this.store.repositoryDeployKeys(repository.id));
    if (!keys) return;
    await this.deleteDeployKey(repository, keys.cloneKeyId, installationToken);
    await this.deleteDeployKey(repository, keys.writeKeyId, installationToken);
    (await this.broker.deleteHandle(keys.cloneHandle));
    (await this.broker.deleteHandle(keys.writeHandle));
    (await this.store.clearRepositoryDeployKeys(repository.id));
  }

  private async removeRepository(repository: Repository, installationToken: string): Promise<void> {
    const keys = (await this.store.repositoryDeployKeys(repository.id));
    if (keys) {
      await Promise.all([
        this.deleteDeployKey(repository, keys.cloneKeyId, installationToken),
        this.deleteDeployKey(repository, keys.writeKeyId, installationToken),
      ].map((promise) => promise.catch(() => undefined)));
      (await this.broker.deleteHandle(keys.cloneHandle));
      (await this.broker.deleteHandle(keys.writeHandle));
      (await this.store.clearRepositoryDeployKeys(repository.id));
    }
    (await this.store.deleteRepository(repository.id));
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
    const result = await this.repositoryFile(repository, filePath);
    return result.status === 'present' ? result.content : undefined;
  }

  /** File presence with diagnostic fidelity for deployment monitoring. A raw
   * 404 means absent; permissions, suspension, and API faults must not be
   * flattened into the same answer. */
  async repositoryFileStatus(repository: Repository, filePath: string): Promise<GitHubRepositoryFileStatus> {
    const result = await this.repositoryFile(repository, filePath);
    return result.status === 'present' ? { status: 'present', bytes: Buffer.byteLength(result.content) } : result;
  }

  /** Top-level entry names on the default branch; undefined when unreadable. */
  async rootEntries(repository: Repository): Promise<string[] | undefined> {
    try {
      const value = await this.contents<Array<{ name?: string }>>(repository, '');
      return Array.isArray(value) ? value.map((entry) => String(entry.name ?? '')).filter(Boolean) : undefined;
    } catch { return undefined; }
  }

  private async contents<T>(repository: Repository, filePath: string): Promise<T> {
    if (!repository.gitConnectionId) throw new Error('repository has no GitHub App connection');
    const connection = (await this.store.getGitConnection(repository.gitConnectionId));
    if (!connection) throw new Error('repository GitHub App connection is missing');
    const token = await this.installationToken(connection);
    return this.request<T>(
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/`
      + filePath.split('/').map(encodeURIComponent).join('/'), token);
  }

  private async repositoryFile(repository: Repository, filePath: string): Promise<
    | { status: 'present'; content: string }
    | { status: 'missing' }
    | { status: 'unreadable'; error: string }> {
    try {
      const value = await this.contents<{ content?: string; encoding?: string }>(repository, filePath);
      if (!value.content) return { status: 'unreadable', error: 'GitHub returned the file without content' };
      return { status: 'present', content: Buffer.from(value.content,
        (value.encoding as BufferEncoding) ?? 'base64').toString('utf8') };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return /GitHub API 404\b/.test(message) ? { status: 'missing' } : { status: 'unreadable', error: message };
    }
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

  private async saveUserToken(userId: string, accountId: string, value: any): Promise<void> {
    await this.saveTokenHandle(githubUserTokenHandle(userId, accountId), value);
  }

  private async saveTokenHandle(handle: string, value: any): Promise<void> {
    const now = Date.now();
    (await this.broker.registerHandle(handle, JSON.stringify({
      accessToken: String(value.access_token),
      expiresAt: value.expires_in ? now + Number(value.expires_in) * 1000 : undefined,
      refreshToken: value.refresh_token ? String(value.refresh_token) : undefined,
      refreshExpiresAt: value.refresh_token_expires_in ? now + Number(value.refresh_token_expires_in) * 1000 : undefined,
    })));
  }

  private resolvedUserToken(handle: string): { raw: string; value: {
    accessToken: string; expiresAt?: number; refreshToken?: string; refreshExpiresAt?: number;
  } } | undefined {
    if (!this.broker.hasHandle(handle)) return undefined;
    const raw = this.broker.resolve(handle, { caps: [`use-credential:${handle}`] });
    return { raw, value: JSON.parse(raw) };
  }

  /** Delete only the credential whose refresh attempt failed. A different
   * process may already have rotated the single-use chain and stored its new
   * token while this request was in flight. */
  private async deleteUserTokenIfUnchanged(handle: string, observed: string): Promise<boolean> {
    return this.broker.deleteHandleIfUnchanged(handle, observed);
  }

  private replacementUserToken(handle: string, observed: string): string | undefined {
    const current = this.resolvedUserToken(handle);
    return current && current.raw !== observed && current.value.accessToken
      ? current.value.accessToken
      : undefined;
  }

  private refreshFailureSummary(code: GitHubUserAuthorizationFailureCode, providerError?: string): string {
    if (code === 'refresh_token_missing')
      return 'The GitHub access token expired without a refresh token. Reconnect GitHub.';
    if (code === 'refresh_token_expired')
      return 'The GitHub refresh token reached its recorded expiry. Reconnect GitHub.';
    if (code === 'refresh_request_failed')
      return `GitHub token refresh could not complete${providerError ? ` (${providerError})` : ''}. The stored connection was preserved.`;
    return `GitHub rejected the refresh token${providerError ? ` (${providerError})` : ''}. Reconnect GitHub.`;
  }

  private safeOauthError(value: unknown): string | undefined {
    const candidate = typeof value === 'string' ? value.trim() : '';
    return /^[a-z][a-z0-9_.-]{0,63}$/i.test(candidate) ? candidate : undefined;
  }

  private async refreshUserAccessToken(userId: string, accountId: string | undefined, handle: string,
    forceRefresh: boolean): Promise<string> {
    const resolved = this.resolvedUserToken(handle);
    if (!resolved) throw new Error('Connect GitHub on your profile, then try again.');
    const { raw: observed, value: stored } = resolved;
    if (!forceRefresh && (!stored.expiresAt || stored.expiresAt > Date.now() + 60_000)) return stored.accessToken;

    const unusable = !stored.refreshToken
      ? 'refresh_token_missing' as const
      : stored.refreshExpiresAt && stored.refreshExpiresAt <= Date.now()
        ? 'refresh_token_expired' as const
        : undefined;
    if (unusable) {
      const replacement = this.replacementUserToken(handle, observed);
      if (replacement) {
        (await this.recordRefreshContentionRecovery(userId, accountId));
        return replacement;
      }
      const deleted = await this.deleteUserTokenIfUnchanged(handle, observed);
      if (!deleted) {
        const raced = this.replacementUserToken(handle, observed);
        if (raced) {
          (await this.recordRefreshContentionRecovery(userId, accountId));
          return raced;
        }
      }
      const failure = (await this.recordUserAuthorizationFailure(userId, accountId, {
        code: unusable,
        summary: this.refreshFailureSummary(unusable),
        disconnected: deleted || !this.broker.hasHandle(handle),
      }));
      throw new Error(`${failure.summary} [${failure.code}]`);
    }

    if (!this.options.clientId) throw new Error('GitHub App client id is missing');
    const clientSecret = this.broker.resolve(GITHUB_APP_CLIENT_SECRET_HANDLE,
      { caps: [`use-credential:${GITHUB_APP_CLIENT_SECRET_HANDLE}`] });
    let value: any;
    try {
      value = await this.oauthToken({ client_id: this.options.clientId, client_secret: clientSecret,
        grant_type: 'refresh_token', refresh_token: stored.refreshToken! });
    } catch (error) {
      const status = error instanceof Error ? error.message.match(/GitHub OAuth failed \((\d{3})\)/)?.[1] : undefined;
      const providerError = status ? `http_${status}` : 'request_failed';
      const failure = (await this.recordUserAuthorizationFailure(userId, accountId, {
        code: 'refresh_request_failed',
        summary: this.refreshFailureSummary('refresh_request_failed', providerError),
        disconnected: false,
        providerError,
      }));
      throw new Error(`${failure.summary} [${failure.code}]`);
    }
    if (!value.access_token) {
      const providerError = this.safeOauthError(value.error);
      const replacement = this.replacementUserToken(handle, observed);
      if (replacement) {
        (await this.recordRefreshContentionRecovery(userId, accountId, providerError));
        return replacement;
      }
      const deleted = await this.deleteUserTokenIfUnchanged(handle, observed);
      if (!deleted) {
        const raced = this.replacementUserToken(handle, observed);
        if (raced) {
          (await this.recordRefreshContentionRecovery(userId, accountId, providerError));
          return raced;
        }
      }
      const failure = (await this.recordUserAuthorizationFailure(userId, accountId, {
        code: 'refresh_rejected',
        summary: this.refreshFailureSummary('refresh_rejected', providerError),
        disconnected: deleted || !this.broker.hasHandle(handle),
        ...(providerError ? { providerError } : {}),
      }));
      throw new Error(`${failure.summary} [${failure.code}]`);
    }
    await this.store.transaction(async () => {
      await this.assertUserOpen(userId);
      await this.saveTokenHandle(handle, value);
    });
    (await this.clearUserAuthorizationFailure(userId, accountId));
    (await this.store.appendAudit({
      principalId: `user:${userId}`,
      action: 'github.user-authorization.refreshed',
      scopeKey: `user:${userId}`,
      detail: { ...(accountId ? { accountId } : {}) },
    }));
    return String(value.access_token);
  }

  /** Resolve the signed-in person's refreshable GitHub authorization for
   * user-attributed work (repository creation, pull requests, comments). This
   * is intentionally distinct from installationToken(): GitHub records actions
   * made with this token as the person, not as the organization App. Concurrent
   * callers share one refresh because GitHub refresh tokens are single-use. */
  async userAccessToken(userId: string, opts: { forceRefresh?: boolean; accountId?: string } = {}): Promise<string> {
    await this.assertUserOpen(userId);
    const accountId = opts.accountId ?? (await this.activeUserAccountId(userId));
    const handle = accountId ? githubUserTokenHandle(userId, accountId) : legacyGithubUserTokenHandle(userId);
    const resolved = this.resolvedUserToken(handle);
    if (!resolved) throw new Error('Connect GitHub on your profile, then try again.');
    if (!opts.forceRefresh && (!resolved.value.expiresAt || resolved.value.expiresAt > Date.now() + 60_000))
      return resolved.value.accessToken;
    const inFlight = this.userTokenRefreshes.get(handle);
    if (inFlight) return inFlight;
    const refresh = this.refreshUserAccessToken(userId, accountId, handle, opts.forceRefresh === true)
      .finally(() => this.userTokenRefreshes.delete(handle));
    this.userTokenRefreshes.set(handle, refresh);
    return refresh;
  }

  private async assertUserOpen(userId: string): Promise<void> {
    if (await this.store.kvGet(`account-closed:${userId}`)) throw new Error('account is closed');
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
    (await this.broker.registerHandle(githubUserTokenHandle(userId, identity.id), stored));
    const accounts = (await this.userAccounts(userId));
    (await this.saveUserAccounts(userId, [...accounts.filter((account) => account.id !== identity.id), identity]));
    if (!(await this.store.kvGet(githubUserActiveAccountKey(userId)))) (await this.store.kvSet(githubUserActiveAccountKey(userId), identity.id));
    (await this.broker.deleteHandle(legacy));
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
