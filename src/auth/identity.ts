import { identitySqliteDatabase } from '../store/identity-sqlite.js';
import { betterAuth } from 'better-auth';
import { admin, genericOAuth } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalAccountName } from '../domain/account-names.js';
import { openSqlDatabase, type SqlDatabase } from '../store/sql.js';
import { importSqliteDatabase, type SqliteImportResult } from '../store/postgres-migration.js';
import { BRAND, DEFAULT_SITE_NAME } from '../domain/brand.js';

export interface IdentityUser {
  id: string;
  email: string;
  emailVerified?: boolean;
  name: string;
  role?: string | null;
  createdAt: Date | string;
}

export interface IdentitySession {
  session: { id: string; userId: string; expiresAt: Date | string };
  user: IdentityUser;
}

/** The outbound-email surface identity needs for confirmation / reset mail.
 *  Kept minimal so `src/auth` doesn't depend on the autonomy layer. */
export interface Mailer {
  configured(): boolean | Promise<boolean>;
  send(msg: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

/** A small, provider-agnostic HTML body for a one-action transactional email. */
export function emailHtml(heading: string, body: string, cta: string, url: string, footer: string,
  siteName = DEFAULT_SITE_NAME): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
  <div style="font-size:20px;font-weight:600;margin-bottom:16px">◇ ${esc(siteName)}</div>
  <h1 style="font-size:18px;margin:0 0 12px">${esc(heading)}</h1>
  <p style="font-size:14px;line-height:1.5;color:#444;margin:0 0 20px">${esc(body)}</p>
  <p style="margin:0 0 24px"><a href="${esc(url)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500">${esc(cta)}</a></p>
  <p style="font-size:12px;color:#888;line-height:1.5;margin:0 0 8px">Or paste this link into your browser:<br><a href="${esc(url)}" style="color:#666;word-break:break-all">${esc(url)}</a></p>
  <p style="font-size:12px;color:#888;line-height:1.5;margin:16px 0 0">${esc(footer)}</p>
</div>`;
}

function secretFor(dbFile: string, supplied?: string): string {
  if (supplied) return supplied;
  if (dbFile === ':memory:') return crypto.randomBytes(32).toString('base64url');
  const file = `${dbFile}.secret`;
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    // ONLY "the file isn't there" means first boot. Treating every read error as
    // first boot meant a transient EACCES/EIO regenerated the signing secret,
    // silently invalidating every live session and every outstanding password
    // reset / email verification link — and then overwrote the real secret.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return value;
}

export interface GitHubAuthorization {
  userId: string;
  accountId: string;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
}

export interface IdentityOptions {
  /** PostgreSQL target for hosted identity state; dbFile remains the import source. */
  databaseUrl?: string;
  baseURL?: string | { allowedHosts: string[]; fallback?: string };
  secret?: string;
    /** Read lazily so changing Installation → Site identity applies to new mail
   * immediately, without restarting the identity service. */
  siteName?: () => string | Promise<string>;
  oidc?: { providerId: string; discoveryUrl: string; issuer?: string; clientId: string; clientSecret: string; scopes?: string[] };
  google?: { clientId: string; clientSecret: string };
  github?: {
    clientId: string;
    clientSecret: string;
    /** GitHub Apps use fine-grained permissions, not OAuth App scopes. */
    app?: boolean;
    /** Adopt the sign-in grant as the user's development GitHub identity. */
    onAuthorization?: (authorization: GitHubAuthorization) => Promise<void>;
  };
}

/**
 * Authentication boundary. Better Auth owns passwords, hashing, cookies,
 * sessions, rate limits, and account records; karmax only consumes the verified
 * user id and applies its own project/task capability policy.
 */
export class IdentityService {
   auth!: any;
  private db!: SqlDatabase;
  private sqlite?: ReturnType<typeof identitySqliteDatabase>;
  private pool?: Pool;
  migration?: SqliteImportResult;
  private organizationNames?: () => Array<{ id: string; name: string }> | Promise<Array<{ id: string; name: string }>>;
  private accountClosed?: (userId: string) => Promise<boolean>;

  /** Installation-wide outbound email, injected after construction (main.ts wires
   *  it once the vault/broker exist). The Better Auth hooks below read it lazily,
   *  so a provider connected later in Settings takes effect with no restart. When
   *  unset or unconfigured, the hooks no-op — an email-less install still works,
   *  it just cannot confirm addresses or reset passwords by mail. */
  mailer?: Mailer;

  /** Whether account email (confirmation, password reset) can actually be sent. */
  async canSendEmail(): Promise<boolean> {
    return Boolean(this.mailer && (await this.mailer.configured()));
  }

   oidcProviderId?: string;
  /** Whether "Continue with Google" is offered. Google is a *consumer* identity
   *  option and deliberately does not consume the single generic-OIDC enterprise
   *  slot above — an installation pointed at Okta must still be able to offer it. */
   googleEnabled!: boolean;
  /** Whether GitHub sign-in is available through the deployment App (or the
   * legacy standalone OAuth fallback). */
   githubEnabled!: boolean;
  private sessionsRevoked?: (userId: string) => Promise<void>;
  connectSessionRevocation(listener: (userId: string) => Promise<void>): void { this.sessionsRevoked = listener; }

  async sessionActive(sessionId: string, userId: string): Promise<boolean> {
    const session = await this.db.prepare('SELECT expiresAt FROM session WHERE id=? AND userId=?').get(sessionId, userId) as { expiresAt: number | string | Date } | undefined;
    if (!session) return false;
    const expiry = typeof session.expiresAt === 'number' ? session.expiresAt : new Date(session.expiresAt).getTime();
    return expiry > Date.now();
  }

  private constructor(dbFile: string, opts: IdentityOptions = {}) {
  }

  static async create(dbFile: string, opts: IdentityOptions = {}) {
    if (opts.oidc?.issuer) {
      // Better Auth now verifies ID tokens against the discovered issuer, but
      // no longer accepts an operator-specified issuer in GenericOAuthConfig.
      const response = await fetch(opts.oidc.discoveryUrl, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`OIDC discovery failed: HTTP ${response.status}`);
      const discovered = await response.json() as { issuer?: string };
      if (discovered.issuer !== opts.oidc.issuer) throw new Error('OIDC discovery issuer mismatch');
    }
    const instance = new IdentityService(dbFile, opts);
    await instance.initialize(dbFile, opts);
    return instance;
  }

  private async initialize(dbFile: string, opts: IdentityOptions = {}) {

    this.db = openSqlDatabase(opts.databaseUrl ?? dbFile);
    this.pool = opts.databaseUrl ? new Pool({ connectionString: opts.databaseUrl, application_name: 'karmax' }) : undefined;
    this.sqlite = this.pool ? undefined : identitySqliteDatabase(this.db);
    // Same durability pragmas the metadata store uses (src/store/db.ts): karmax
    // runs the gateway, the worker and every activity in one process, so a
    // concurrent writer must wait rather than fail with SQLITE_BUSY.
    if (dbFile !== ':memory:') {
      try {
        (await this.db.exec('PRAGMA journal_mode=WAL'));
        (await this.db.exec('PRAGMA busy_timeout=5000'));
        (await this.db.exec('PRAGMA synchronous=NORMAL'));
      } catch { /* a read-only or non-file database keeps its defaults */ }
    }
    this.oidcProviderId = opts.oidc?.providerId;
    this.googleEnabled = !!opts.google;
    this.githubEnabled = !!opts.github;
    const trustedSocialProviders = [
      ...(opts.google ? ['google' as const] : []),
      ...(opts.github ? ['github' as const] : []),
    ];
    const socialProviders = {
      ...(opts.google ? { google: {
        clientId: opts.google.clientId,
        clientSecret: opts.google.clientSecret,
      } } : {}),
      ...(opts.github ? { github: {
        clientId: opts.github.clientId,
        clientSecret: opts.github.clientSecret,
        disableDefaultScope: opts.github.app === true,
      } } : {}),
    };
    const adoptGithubAuthorization = async (account: Record<string, any>) => {
      if (account.providerId !== 'github' || !account.accessToken || !opts.github?.onAuthorization) return;
      try {
        await opts.github.onAuthorization({
          userId: String(account.userId),
          accountId: String(account.accountId),
          accessToken: String(account.accessToken),
          ...(account.refreshToken ? { refreshToken: String(account.refreshToken) } : {}),
          ...(account.accessTokenExpiresAt ? { accessTokenExpiresAt: new Date(account.accessTokenExpiresAt) } : {}),
          ...(account.refreshTokenExpiresAt ? { refreshTokenExpiresAt: new Date(account.refreshTokenExpiresAt) } : {}),
        });
      } catch (error) {
        // Authentication is the recovery path for a stale development grant.
        // A transient adoption failure must not turn a valid GitHub sign-in into
        // a Karmax lockout; the next sign-in/update retries the same hook.
        console.error('[github] could not connect sign-in authorization:', error instanceof Error ? error.message : error);
      }
    };
    const siteName = async () => (await opts.siteName?.()) || DEFAULT_SITE_NAME;
    this.auth = betterAuth({
      appName: (await siteName()),
      database: this.pool ?? { db: this.sqlite!, type: 'sqlite', transaction: true },
      secret: secretFor(dbFile, opts.secret),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      // Native Better Auth social sign-in. No gateway routes are needed:
      // /api/auth/* is proxied verbatim, including each provider callback.
      // Google uses openid/email/profile without offline access. A shared GitHub
      // App uses its fine-grained account/repository permissions (OAuth scopes do
      // not apply) and its user grant is also adopted by the development profile.
      ...(trustedSocialProviders.length ? { socialProviders } : {}),
      databaseHooks: {
        session: { create: { before: async (session: Record<string, unknown>) => {
          if (await this.accountClosed?.(String(session.userId))) return false;
        } }, delete: { after: async (session: Record<string, unknown>) => {
          await this.sessionsRevoked?.(String(session.userId));
        } } },
        user: { create: { before: async (user: Record<string, unknown>) => {
          (await this.assertUserNameAvailable(String(user.name ?? '')));
        } } },
        account: {
          create: { before: async (account: Record<string, unknown>) => {
            if (await this.accountClosed?.(String(account.userId))) return false;
          }, ...(opts.github?.onAuthorization ? { after: adoptGithubAuthorization } : {}) },
          update: { before: async (account: Record<string, unknown>) => {
            if (account.userId && await this.accountClosed?.(String(account.userId))) return false;
          }, after: async (account: Record<string, unknown>) => {
            if (account.providerId === 'credential' && account.password) await this.revokeUserSessions(String(account.userId));
            if (opts.github?.onAuthorization) await adoptGithubAuthorization(account);
          } },
        },
      },
      // Account linking. A user who signed up with email+password and later uses
      // Google or GitHub on the same address should land in the SAME
      // account, not a duplicate. The merge key is the email address, so BOTH
      // sides of it have to be trustworthy, and only one of them is settled here:
      //
      //  - the incoming side, via `trustedProviders`. Google asserts
      //    `email_verified`; Better Auth's GitHub adapter reads `user:email` and
      //    checks GitHub's per-address `verified` bit. A provider that does NOT
      //    verify addresses in this list would be an account-takeover path — a
      //    stranger registers the victim's address there and is merged into the
      //    victim's karmax account.
      //  - the LOCAL side is Better Auth's `requireLocalEmailVerified`, left at
      //    its default (true) deliberately. karmax's own signup never verified
      //    the address, so an unverified local account merely *claims* it; if
      //    that were allowed to absorb a social login, registering someone else's
      //    address here would capture their provider sign-in. Which means linking
      //    happens for a verified local account and is refused (`account_not_linked`)
      //    otherwise — a real user-facing case that web/app.js explains on the
      //    sign-in card rather than leaving on Better Auth's bare error page.
      ...(trustedSocialProviders.length ? { account: { accountLinking: {
        enabled: true,
        trustedProviders: trustedSocialProviders,
      } } } : {}),
      emailAndPassword: {
        enabled: true, minPasswordLength: 10,
        // Password reset is delivered by the installation's outbound mailer. A
        // no-op when email isn't configured (the request still returns ok so we
        // don't disclose which addresses exist).
        sendResetPassword: async ({ user, url }: { user: IdentityUser; url: string }) => {
          if (!this.mailer || !(await this.mailer.configured())) return;
          const brand = (await siteName());
          await this.mailer.send({
            to: user.email,
            subject: `Reset your ${brand} password`,
            text: `Hi ${user.name || ''},\n\nSomeone asked to reset the password for your ${brand} account. Open the link below to choose a new one:\n\n${url}\n\nIf you didn't request this, you can ignore this email — your password won't change.`,
            html: emailHtml(`Reset your ${brand} password`,
              `Someone asked to reset the password for your ${brand} account. Click below to choose a new one.`,
              'Reset password', url,
              `If you didn't request this, you can ignore this email — your password won't change.`, brand),
          }).catch((e) => console.error('[email] password reset send failed:', e instanceof Error ? e.message : e));
        },
      },
      emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }: { user: IdentityUser; url: string }) => {
          if (!this.mailer || !(await this.mailer.configured())) return;
          const brand = (await siteName());
          await this.mailer.send({
            to: user.email,
            subject: `Confirm your ${brand} email`,
            text: `Hi ${user.name || ''},\n\nConfirm this email address to finish setting up your ${brand} account:\n\n${url}\n\nIf you didn't create this account, you can ignore this email.`,
            html: emailHtml(`Confirm your ${brand} email`,
              `Confirm this email address to finish setting up your ${brand} account.`,
              'Confirm email', url,
              `If you didn't create this account, you can ignore this email.`, brand),
          }).catch((e) => {
            // Deliberately rethrown, unlike the password-reset send above.
            // Swallowing this answered the explicit "Resend link" button with
            // 200, so the console said "check your inbox" while Resend had
            // refused the message — the reason (an unverified domain) was
            // visible only in the container log. Better Auth swallows a throw
            // on the sign-up path itself, so a broken mailer still cannot stop
            // an account being created; see tests/identity-email.test.ts.
            console.error('[email] verification send failed:', e instanceof Error ? e.message : e);
            throw e;
          });
        },
      },
      // An address typo must not strand a new account behind a verification
      // email it can never receive. Better Auth updates an unverified account
      // immediately and sends a fresh link to the corrected address; an already
      // verified account keeps its current address until the new one is verified.
      user: {
        changeEmail: {
          enabled: true,
          updateEmailWithoutVerification: true,
        },
      },
      session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
      // Better Auth defaults `rateLimit.enabled` to `isProduction`, and karmax
      // never sets NODE_ENV=production — so sign-in, password reset and email
      // verification were unthrottled in EVERY deployment, hosted included.
      // Enable it explicitly; the stricter per-path rules Better Auth ships for
      // the credential endpoints then apply on top of this window.
      // In-memory storage (the default) is right here: karmax runs the gateway,
      // the worker and every activity in ONE process, and `storage: 'database'`
      // additionally needs a rateLimit table whose schema Better Auth and
      // node:sqlite disagree about (bigint vs number).
      rateLimit: { enabled: true, window: 60, max: 100 },
      plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] }),
        ...(opts.oidc ? [genericOAuth({ config: [{ providerId: opts.oidc.providerId,
          discoveryUrl: opts.oidc.discoveryUrl, clientId: opts.oidc.clientId,
          clientSecret: opts.oidc.clientSecret, scopes: opts.oidc.scopes ?? ['openid', 'profile', 'email'],
          pkce: true, requireIdTokenVerification: true }] })] : [])],
    });
  }

  static async open(dbFile: string, opts: IdentityOptions = {}): Promise<IdentityService> {

    const service = (await IdentityService.create(dbFile, opts));
    const { runMigrations } = await getMigrations(service.auth.options);
    await runMigrations();
    if (opts.databaseUrl)
      service.migration = (await importSqliteDatabase(dbFile, service.db, 'identity', { sentinelTable: 'user' }));
    // Better Auth's first request checks the schema using a separate checkout.
    // Complete that check before bootstrap takes the SQLite transaction lock.
    await service.auth.api.getSession({ headers: new Headers() });
    // Better Auth intentionally permits duplicate display names, but every
    // karmax user owns a same-named personal organization. This index closes the
    // concurrent-signup gap around the cross-store application check.
    (await service.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_name_nocase ON user(name COLLATE NOCASE)'));
    return service;
  
  }

  async hasUsers(): Promise<boolean> {
    return Number(((await this.db.prepare('SELECT COUNT(*) AS n FROM user').get()) as any)?.n ?? 0) > 0;
  }

  async listUsers(): Promise<IdentityUser[]> {
    return ((await this.db.prepare('SELECT id, email, name, role, createdAt FROM user ORDER BY createdAt').all()) as any[])
      .map((u) => ({ ...u, createdAt: new Date(u.createdAt) }));
  }

  async userById(id: string): Promise<IdentityUser | undefined> {
    const row = await this.db.prepare('SELECT id, email, name, role, createdAt FROM user WHERE id=?').get(id) as any;
    return row ? { ...row, createdAt: new Date(row.createdAt) } : undefined;
  }

  /** Connect Better Auth's user lifecycle to the organization namespace. */
  connectOrganizationNames(lookup: () => Array<{ id: string; name: string }> | Promise<Array<{ id: string; name: string }>>): void {
    this.organizationNames = lookup;
  }

  connectAccountClosure(lookup: (userId: string) => Promise<boolean>): void {
    this.accountClosed = lookup;
  }

  async assertUserNameAvailable(name: string): Promise<string> {
    const value = name.trim();
    if (!value) throw new Error('user name is required');
    const key = canonicalAccountName(value);
    if ((await this.listUsers()).some((user) => canonicalAccountName(user.name) === key))
      throw new Error(`name "${value}" is already used by a user`);
    if ((await this.organizationNames?.())?.some((organization) => canonicalAccountName(organization.name) === key))
      throw new Error(`name "${value}" is already used by an organization`);
    return value;
  }

  /** Public account data for a self-service portability export. Password hashes,
   * OAuth tokens, verification values and sessions are deliberately unreachable:
   * this method projects an allowlist instead of redacting a raw auth database. */
  async exportUserData(userId: string): Promise<{ profile: Record<string, unknown>; authentication: { providers: string[] } }> {
    const row = (await this.db.prepare('SELECT * FROM user WHERE id=?').get(userId)) as any;
    if (!row) throw new Error('user not found');
    const profile: Record<string, unknown> = {
      id: String(row.id),
      name: String(row.name ?? ''),
      email: String(row.email ?? ''),
      emailVerified: Boolean(row.emailVerified),
      ...(row.image ? { image: String(row.image) } : {}),
      ...(row.role ? { role: String(row.role) } : {}),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
    return { profile, authentication: { providers: (await this.providersForUser(userId)).sort() } };
  }

  async session(headers: Headers): Promise<IdentitySession | undefined> {
    const result = await this.auth.api.getSession({ headers }).catch(() => null);
    if (result?.user && await this.accountClosed?.(String(result.user.id))) return undefined;
    return result?.session && result?.user ? result as IdentitySession : undefined;
  }

  async signIn(email: string, password: string, headers?: Headers): Promise<Response> {
    return this.auth.api.signInEmail({ body: { email, password }, headers, asResponse: true });
  }

  /**
   * Self-service account creation. A new identity deliberately receives no
   * karmax grants here: an administrator (or a later invitation flow) decides
   * which projects and profile it may use. Authentication must never imply
   * authorization.
   */
  async signUp(input: { name: string; email: string; password: string }, headers?: Headers): Promise<Response> {
    return this.auth.api.signUpEmail({ body: { ...input, name: (await this.assertUserNameAvailable(input.name)) }, headers, asResponse: true });
  }

  async signOut(headers: Headers): Promise<Response> {
    return this.auth.api.signOut({ headers, asResponse: true });
  }

  async changeEmail(newEmail: string, callbackURL: string, headers: Headers): Promise<Response> {
    return this.auth.api.changeEmail({ body: { newEmail, callbackURL }, headers, asResponse: true });
  }

  async changePassword(currentPassword: string, newPassword: string, headers: Headers): Promise<Response> {
    return this.auth.api.changePassword({
      body: { currentPassword, newPassword, revokeOtherSessions: false },
      headers,
      asResponse: true,
    });
  }

  async beginSso(callbackURL: string, headers?: Headers): Promise<Response> {
    if (!this.oidcProviderId) throw new Error('enterprise SSO is not configured');
    return this.auth.api.signInWithOAuth2({ body: { providerId: this.oidcProviderId, callbackURL }, headers, asResponse: true });
  }

  async providersForUser(userId: string): Promise<string[]> {
    return ((await this.db.prepare('SELECT providerId FROM account WHERE userId=?').all(userId)) as any[]).map((row) => String(row.providerId));
  }

  async providersForUserAsync(userId: string): Promise<string[]> {
    if (!this.pool) return (await this.providersForUser(userId));
    const result = await this.pool.query('SELECT "providerId" FROM account WHERE "userId"=$1', [userId]);
    return result.rows.map(row => String(row.providerId));
  }

  async revokeUserSessions(userId: string): Promise<void> {
    return this.db.transaction(async () => {

    (await this.db.prepare('DELETE FROM session WHERE userId=?').run(userId));
    await this.sessionsRevoked?.(userId);
  
    });
  }

  /** First-account setup. The route calling this is available only while empty. */
  async bootstrap(input: { name: string; email: string; password: string }, headers?: Headers): Promise<{ response: Response; user: IdentityUser }> {
    return this.db.transaction(async () => {

    if ((await this.hasUsers())) throw new Error(`${BRAND} has already been set up`);
    const response = await this.auth.api.signUpEmail({
      body: { ...input, name: (await this.assertUserNameAvailable(input.name)) }, headers, asResponse: true });
    if (!response.ok) throw new Error((await response.clone().json().catch(() => ({})) as any)?.message ?? 'could not create account');
    // Promote the account this call actually created, resolved by its own email —
    // NOT `listUsers()[0]`. The surrounding transaction serializes the empty-
    // installation check, so only one concurrent bootstrap may create an admin.
    const created = (await response.clone().json().catch(() => ({})) as any)?.user as { id?: string } | undefined;
    const email = input.email.trim().toLowerCase();
    const user = (await this.listUsers()).find((candidate) => (created?.id ? candidate.id === created.id
      : String(candidate.email).toLowerCase() === email));
    if (!user) throw new Error('account creation did not persist');
    (await this.db.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(user.id));
    return { response, user: { ...user, role: 'admin' } };
  
    });
  }

  async createUser(input: { name: string; email: string; password: string }): Promise<IdentityUser> {
    const result = await this.auth.api.createUser({
      body: { ...input, name: (await this.assertUserNameAvailable(input.name)), role: 'user' } });
    return (result?.user ?? result) as IdentityUser;
  }

  async removeUser(userId: string): Promise<void> {
    return this.db.transaction(async () => {

    // Better Auth's admin plugin normally checks an HTTP admin session. At this
    // boundary karmax has already checked `user:write`; deleting the auth rows in
    // one transaction also revokes every session immediately.
    (await this.db.exec('BEGIN IMMEDIATE'));
    try {
      (await this.db.prepare('DELETE FROM session WHERE userId = ?').run(userId));
      (await this.db.prepare('DELETE FROM account WHERE userId = ?').run(userId));
      // Password reset verifications store the user id as their value.
      (await this.db.prepare("DELETE FROM verification WHERE value=? AND identifier LIKE 'reset-password:%'").run(userId));
      (await this.db.prepare('DELETE FROM user WHERE id = ?').run(userId));
      (await this.db.exec('COMMIT'));
    } catch (e) {
      (await this.db.exec('ROLLBACK'));
      throw e;
    }
  
    });
  }

  async close(): Promise<void> {
    await this.sqlite?.destroy();
    (await this.db.close());
    await this.pool?.end();
  }
}
