import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
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

  private constructor(dbFile: string, opts: { baseURL?: string | { allowedHosts: string[]; fallback?: string }; secret?: string } = {}) {
    this.db = new DatabaseSync(dbFile);
    this.auth = betterAuth({
      appName: 'karmax',
      database: this.db,
      secret: secretFor(dbFile, opts.secret),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      emailAndPassword: { enabled: true, minPasswordLength: 10 },
      session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
      plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] })],
    });
  }

  static async open(dbFile: string, opts: { baseURL?: string | { allowedHosts: string[]; fallback?: string }; secret?: string } = {}): Promise<IdentityService> {
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

  /** First-account setup. The route calling this is available only while empty. */
  async bootstrap(input: { name: string; email: string; password: string }, headers?: Headers): Promise<{ response: Response; user: IdentityUser }> {
    if (this.hasUsers()) throw new Error('karmax has already been set up');
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
