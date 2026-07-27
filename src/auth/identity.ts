import { betterAuth } from 'better-auth';
import { admin, genericOAuth } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface IdentityUser {
  id: string;
  email: string;
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
  configured(): boolean;
  send(msg: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

/** A small, provider-agnostic HTML body for a one-action transactional email. */
export function emailHtml(heading: string, body: string, cta: string, url: string, footer: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
  <div style="font-size:20px;font-weight:600;margin-bottom:16px">◇ krmax</div>
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
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first boot */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return value;
}

/**
 * Authentication boundary. Better Auth owns passwords, hashing, cookies,
 * sessions, rate limits, and account records; karmax only consumes the verified
 * user id and applies its own project/task capability policy.
 */
export class IdentityService {
  readonly auth: any;
  private db: DatabaseSync;

  /** Installation-wide outbound email, injected after construction (main.ts wires
   *  it once the vault/broker exist). The Better Auth hooks below read it lazily,
   *  so a provider connected later in Settings takes effect with no restart. When
   *  unset or unconfigured, the hooks no-op — an email-less install still works,
   *  it just cannot confirm addresses or reset passwords by mail. */
  mailer?: Mailer;

  readonly oidcProviderId?: string;
  private constructor(dbFile: string, opts: { baseURL?: string | { allowedHosts: string[]; fallback?: string }; secret?: string;
    oidc?: { providerId: string; discoveryUrl: string; issuer?: string; clientId: string; clientSecret: string; scopes?: string[] } } = {}) {
    this.db = new DatabaseSync(dbFile);
    this.oidcProviderId = opts.oidc?.providerId;
    this.auth = betterAuth({
      appName: 'krmax',
      database: this.db,
      secret: secretFor(dbFile, opts.secret),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      emailAndPassword: {
        enabled: true, minPasswordLength: 10,
        // Password reset is delivered by the installation's outbound mailer. A
        // no-op when email isn't configured (the request still returns ok so we
        // don't disclose which addresses exist).
        sendResetPassword: async ({ user, url }: { user: IdentityUser; url: string }) => {
          if (!this.mailer?.configured()) return;
          await this.mailer.send({
            to: user.email,
            subject: 'Reset your krmax password',
            text: `Hi ${user.name || ''},\n\nSomeone asked to reset the password for your krmax account. Open the link below to choose a new one:\n\n${url}\n\nIf you didn't request this, you can ignore this email — your password won't change.`,
            html: emailHtml('Reset your krmax password',
              `Someone asked to reset the password for your krmax account. Click below to choose a new one.`,
              'Reset password', url,
              `If you didn't request this, you can ignore this email — your password won't change.`),
          }).catch((e) => console.error('[email] password reset send failed:', e instanceof Error ? e.message : e));
        },
      },
      emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }: { user: IdentityUser; url: string }) => {
          if (!this.mailer?.configured()) return;
          await this.mailer.send({
            to: user.email,
            subject: 'Confirm your krmax email',
            text: `Hi ${user.name || ''},\n\nConfirm this email address to finish setting up your krmax account:\n\n${url}\n\nIf you didn't create this account, you can ignore this email.`,
            html: emailHtml('Confirm your krmax email',
              `Confirm this email address to finish setting up your krmax account.`,
              'Confirm email', url,
              `If you didn't create this account, you can ignore this email.`),
          }).catch((e) => console.error('[email] verification send failed:', e instanceof Error ? e.message : e));
        },
      },
      session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
      plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] }),
        ...(opts.oidc ? [genericOAuth({ config: [{ providerId: opts.oidc.providerId,
          discoveryUrl: opts.oidc.discoveryUrl, issuer: opts.oidc.issuer, clientId: opts.oidc.clientId,
          clientSecret: opts.oidc.clientSecret, scopes: opts.oidc.scopes ?? ['openid', 'profile', 'email'],
          pkce: true, requireIssuerValidation: true }] })] : [])],
    });
  }

  static async open(dbFile: string, opts: { baseURL?: string | { allowedHosts: string[]; fallback?: string }; secret?: string;
    oidc?: { providerId: string; discoveryUrl: string; issuer?: string; clientId: string; clientSecret: string; scopes?: string[] } } = {}): Promise<IdentityService> {
    const service = new IdentityService(dbFile, opts);
    const { runMigrations } = await getMigrations(service.auth.options);
    await runMigrations();
    return service;
  }

  hasUsers(): boolean {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM user').get() as any)?.n ?? 0) > 0;
  }

  listUsers(): IdentityUser[] {
    return (this.db.prepare('SELECT id, email, name, role, createdAt FROM user ORDER BY createdAt').all() as any[])
      .map((u) => ({ ...u, createdAt: new Date(u.createdAt) }));
  }

  async session(headers: Headers): Promise<IdentitySession | undefined> {
    const result = await this.auth.api.getSession({ headers }).catch(() => null);
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
    return this.auth.api.signUpEmail({ body: input, headers, asResponse: true });
  }

  async signOut(headers: Headers): Promise<Response> {
    return this.auth.api.signOut({ headers, asResponse: true });
  }

  async beginSso(callbackURL: string, headers?: Headers): Promise<Response> {
    if (!this.oidcProviderId) throw new Error('enterprise SSO is not configured');
    return this.auth.api.signInWithOAuth2({ body: { providerId: this.oidcProviderId, callbackURL }, headers, asResponse: true });
  }

  providersForUser(userId: string): string[] {
    return (this.db.prepare('SELECT providerId FROM account WHERE userId=?').all(userId) as any[]).map((row) => String(row.providerId));
  }

  revokeUserSessions(userId: string): void {
    this.db.prepare('DELETE FROM session WHERE userId=?').run(userId);
  }

  /** First-account setup. The route calling this is available only while empty. */
  async bootstrap(input: { name: string; email: string; password: string }, headers?: Headers): Promise<{ response: Response; user: IdentityUser }> {
    if (this.hasUsers()) throw new Error('krmax has already been set up');
    const response = await this.auth.api.signUpEmail({ body: input, headers, asResponse: true });
    if (!response.ok) throw new Error((await response.clone().json().catch(() => ({})) as any)?.message ?? 'could not create account');
    const user = this.listUsers()[0];
    if (!user) throw new Error('account creation did not persist');
    this.db.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(user.id);
    return { response, user: { ...user, role: 'admin' } };
  }

  async createUser(input: { name: string; email: string; password: string }): Promise<IdentityUser> {
    const result = await this.auth.api.createUser({ body: { ...input, role: 'user' } });
    return (result?.user ?? result) as IdentityUser;
  }

  async removeUser(userId: string): Promise<void> {
    // Better Auth's admin plugin normally checks an HTTP admin session. At this
    // boundary karmax has already checked `user:write`; deleting the auth rows in
    // one transaction also revokes every session immediately.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM session WHERE userId = ?').run(userId);
      this.db.prepare('DELETE FROM account WHERE userId = ?').run(userId);
      this.db.prepare('DELETE FROM user WHERE id = ?').run(userId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
