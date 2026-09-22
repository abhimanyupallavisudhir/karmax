import * as __asyncCollections from '../util/async-collections.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitProfile, ProjectConfig } from '../domain/types.js';
import { CredentialBroker } from './broker.js';
import { git, isolatedGitEnvironment } from '../world/git.js';
import { expandPath } from '../util/expand.js';
import { paths } from '../config/paths.js';

const pexec = promisify(execFile);

/**
 * Git profiles (PLAN-git-config.md §3): named identity + credentials for the
 * repos karmax works on — the git analogue of the agent config-home accounts.
 *
 * The registry (names, user.name/email, which-secrets-exist flags) lives in the
 * store's kv table; the secrets themselves live in the vault under the profile's
 * handles and are resolved JIT by the broker, per subprocess — never written to
 * any git config file, never journaled (§2 principle 4).
 *
 * Human development resolves in the creator's user scope. Organization scopes
 * remain available for service/automation work with no human creator. Host
 * fallback is a compatibility privilege of legacy org_personal work only.
 */

const LEGACY_KV_PROFILES = 'git:profiles';
const LEGACY_KV_DEFAULT = 'git:default-profile';
export const GITHUB_GIT_PROFILE = 'github';
export const GITHUB_AUTOMATION_PROFILE = 'github-automation';

/** User Git configuration is deliberately outside every tenant namespace. */
export function userGitScope(userId: string): string {
  const id = userId.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('invalid user id for Git profile scope');
  return `user:${id}`;
}

function userIdOfScope(scope: string): string | undefined {
  return scope.startsWith('user:') ? scope.slice('user:'.length) : undefined;
}

/** The vault handle for one of a profile's secrets. */
/** A profile name is a single path segment: alphanumeric plus `. _ -`, and never
 *  `.`/`..` (which `path.join` would resolve out of the profiles directory). */
export function assertProfileName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === '.' || name === '..' || /^\.+$/.test(name))
    throw new Error('profile name must be alphanumeric with . _ - only');
}

export function gitHandle(profile: string, kind: 'ssh' | 'signing' | 'token', organizationId = 'org_personal'): string {
  const userId = userIdOfScope(organizationId);
  if (userId) return `git:user:${userId}:${profile}:${kind}`;
  // Existing handles are assigned to the migrated personal organization. New
  // organizations receive a disjoint vault namespace even when profile names match.
  return organizationId === 'org_personal'
    ? `git:${profile}:${kind}`
    : `git:${organizationId}:${profile}:${kind}`;
}

/** Identity/signing values materialized into a world's worktree-scoped config. */
export interface GitIdentity {
  name: string;
  email: string;
  /** Absolute path to the SSH public/private signing key file (gpg.format=ssh). */
  signingKeyPath?: string;
}

export interface GitProfileStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  kvGet(k: string): (string | undefined) | Promise<string | undefined>;
  kvSet(k: string, v: string): (void) | Promise<void>;
}

export interface PersonalGithubProfileStore extends GitProfileStore {
  listOrganizations(userId: string): (Array<{ id: string; kind: 'personal' | 'team' }>) | Promise<Array<{ id: string; kind: 'personal' | 'team' }>>;
  listGitConnections(organizationId: string): (unknown[]) | Promise<unknown[]>;
}

export class GitProfiles {
  constructor(
    private store: GitProfileStore,
    private broker?: CredentialBroker,
    private home = paths().state,
    private organizationId = 'org_personal',
  ) {}

  async list(): Promise<GitProfile[]> {
    const raw = (await this.store.kvGet(this.profilesKey()))
      ?? (this.organizationId === 'org_personal' ? (await this.store.kvGet(LEGACY_KV_PROFILES)) : undefined);
    if (!raw) return [];
    try {
      const profiles = JSON.parse(raw) as GitProfile[];
      // Linked organization records follow the user's public identity/flags as
      // well as their vault handles. A name/email edit or token rotation should
      // not leave a stale organization snapshot behind.
      return (await __asyncCollections.map(profiles, async (profile) => {
        if (!profile.source) return profile;
        const current = (await new GitProfiles(this.store, this.broker, this.home,
          userGitScope(profile.source.userId)).get(profile.source.profile));
        return current ? { ...current, name: profile.name, source: profile.source } : profile;
      }));
    } catch {
      return [];
    }
  }

  async get(name: string): Promise<GitProfile | undefined> {
    return (await this.list()).find((p) => p.name === name);
  }

  async defaultProfile(): Promise<string | undefined> {
    return ((await this.store.kvGet(this.defaultKey()))
      ?? (this.organizationId === 'org_personal' ? (await this.store.kvGet(LEGACY_KV_DEFAULT)) : undefined)) || undefined;
  }

  async setDefault(name: string | undefined) {
    return this.store.transaction(async () => {
    if (name && !(await this.get(name))) throw new Error(`unknown git profile "${name}" in ${this.scopeLabel()}`);
    (await this.store.kvSet(this.defaultKey(), name ?? ''));

    });
  }

  /** Link an empty organization's service Git configuration to the signed-in
   * member's default user profile. Secrets remain in the user's vault namespace
   * so there is one rotation/revocation authority rather than a stale copy. */
  async reuseUserProfile(userProfiles: GitProfiles): Promise<GitProfile> {
    return this.store.transaction(async () => {
    if (userIdOfScope(this.organizationId)) throw new Error('a user profile cannot reuse another user profile');
    if ((await this.list()).length || (await this.defaultProfile())) throw new Error('organization Git is already configured');
    const userId = userIdOfScope(userProfiles.organizationId);
    if (!userId) throw new Error('source must be a user Git profile');
    const source = (await userProfiles.resolve(undefined));
    if (!source) throw new Error('Add a default Git identity on your profile, then try again.');
    const linked: GitProfile = {
      name: source.name,
      userName: source.userName,
      userEmail: source.userEmail,
      ...(source.github ? { github: source.github } : {}),
      ...(source.sshKey ? { sshKey: true } : {}),
      ...(source.signingKey ? { signingKey: true } : {}),
      ...(source.githubToken ? { githubToken: true } : {}),
      source: { kind: 'user', userId, profile: source.name },
    };
    (await this.store.kvSet(this.profilesKey(), JSON.stringify([linked])));
    (await this.setDefault(linked.name));
    return linked;

    });
  }

  /**
   * Create/update a profile. Secrets are write-only: a provided non-empty string
   * is stored in the vault under the profile's handle; absent/empty leaves the
   * stored secret untouched. The registry record carries only has-secret flags.
   */
  async save(args: { name: string; userName: string; userEmail: string; sshKey?: string; signingKey?: string;
    githubToken?: string; github?: { id: string; login: string; name?: string };
    customIdentity?: { userName?: string; userEmail?: string }; clearSigningKey?: boolean }): Promise<GitProfile> {
    return this.store.transaction(async () => {
    const name = args.name.trim();
    assertProfileName(name);
    if (!args.userName?.trim() || !args.userEmail?.trim()) throw new Error('userName and userEmail are required');
    const secrets: Array<['ssh' | 'signing' | 'token', string | undefined, keyof GitProfile]> = [
      ['ssh', args.sshKey, 'sshKey'],
      ['signing', args.signingKey, 'signingKey'],
      ['token', args.githubToken, 'githubToken'],
    ];
    const prior = (await this.get(name));
    const github = args.github ?? prior?.github;
    const rec: GitProfile = {
      name, userName: args.userName.trim(), userEmail: args.userEmail.trim(),
      ...(github ? { github } : {}),
      ...(args.customIdentity ? { customIdentity: args.customIdentity } : {}),
    };
    for (const [kind, value, flag] of secrets) {
      if (kind === 'signing' && args.clearSigningKey) {
        (await this.broker?.deleteHandle(gitHandle(name, kind, this.organizationId)));
      } else if (value?.trim()) {
        (await this.requireBroker().registerHandle(gitHandle(name, kind, this.organizationId), value.trim()));
        (rec as any)[flag] = true;
      } else if (prior?.[flag] && !prior.source) {
        (rec as any)[flag] = true; // keep the existing secret
      }
    }
    const rest = (await this.list()).filter((p) => p.name !== name);
    (await this.store.kvSet(this.profilesKey(), JSON.stringify([...rest, rec])));
    // Key material may have changed — drop any materialized copies.
    fs.rmSync(this.keyDir(name), { recursive: true, force: true });
    return rec;

    });
  }

  /** GitHub OAuth is the normal human onboarding path: the public account
   * identity supplies both commit fields, while authentication remains in the
   * App's refreshable user grant rather than this profile. */
  async saveGithubIdentity(identity: { id: string | number; login: string; name?: string | null }): Promise<GitProfile> {
    return this.store.transaction(async () => {
    const id = String(identity.id).trim();
    const login = identity.login.trim();
    if (!/^\d+$/.test(id) || !/^[A-Za-z0-9-]+$/.test(login))
      throw new Error('GitHub returned an invalid account identity');
    const prior = (await this.list()).find((profile) => profile.github?.id === id);
    const customIdentity = prior?.customIdentity;
    const profile = (await this.save({
      name: prior?.name ?? ((await this.get(GITHUB_GIT_PROFILE)) ? `github-${id}` : GITHUB_GIT_PROFILE),
      userName: customIdentity?.userName || identity.name?.trim() || login,
      userEmail: customIdentity?.userEmail || `${id}+${login}@users.noreply.github.com`,
      github: { id, login, ...(identity.name?.trim() ? { name: identity.name.trim() } : {}) },
      ...(customIdentity ? { customIdentity } : {}),
    }));
    if (!(await this.defaultProfile())) (await this.setDefault(profile.name));
    return profile;

    });
  }

  async githubProfile(accountId: string): Promise<GitProfile | undefined> {
    return (await this.list()).find((profile) => profile.github?.id === accountId);
  }

  async setActiveGithub(accountId: string): Promise<GitProfile> {
    return this.store.transaction(async () => {
    const profile = (await this.githubProfile(accountId));
    if (!profile) throw new Error('GitHub account identity is not configured');
    (await this.setDefault(profile.name));
    return profile;

    });
  }

  async saveGithubCustomIdentity(accountId: string, args: { userName?: string; userEmail?: string;
    signingKey?: string; removeSigningKey?: boolean }): Promise<GitProfile> {
    return this.store.transaction(async () => {
    const profile = (await this.githubProfile(accountId));
    if (!profile?.github) throw new Error('Connect GitHub before customizing its identity');
    const customIdentity = {
      ...(args.userName?.trim() ? { userName: args.userName.trim() } : {}),
      ...(args.userEmail?.trim() ? { userEmail: args.userEmail.trim() } : {}),
    };
    return (await this.save({
      name: profile.name,
      userName: customIdentity.userName || profile.github.name || profile.github.login,
      userEmail: customIdentity.userEmail || `${profile.github.id}+${profile.github.login}@users.noreply.github.com`,
      github: profile.github,
      ...(Object.keys(customIdentity).length ? { customIdentity } : {}),
      signingKey: args.signingKey,
      clearSigningKey: args.removeSigningKey,
    }));

    });
  }

  /** Compatibility for callers from the single-account UI/API. */
  async saveGithubSigningKey(signingKey: string): Promise<GitProfile> {
    return this.store.transaction(async () => {
    const profile = (await this.resolve(undefined));
    if (!profile?.github) throw new Error('Connect GitHub before adding a signing key');
    return (await this.saveGithubCustomIdentity(profile.github.id, { signingKey }));

    });
  }

  async deleteGithubIdentity(accountId: string): Promise<void> {
    return this.store.transaction(async () => {
    const profile = (await this.githubProfile(accountId));
    if (profile) (await this.delete(profile.name));

    });
  }

  async automationIdentity(): Promise<GitProfile | undefined> {
    return (await this.get(GITHUB_AUTOMATION_PROFILE));
  }

  async saveAutomationIdentity(args: { userName?: string; userEmail?: string; signingKey?: string;
    removeSigningKey?: boolean }): Promise<GitProfile | undefined> {
    return this.store.transaction(async () => {
    const customIdentity = {
      ...(args.userName?.trim() ? { userName: args.userName.trim() } : {}),
      ...(args.userEmail?.trim() ? { userEmail: args.userEmail.trim() } : {}),
    };
    const profile = (await this.save({
      name: GITHUB_AUTOMATION_PROFILE,
      userName: customIdentity.userName || 'krmax',
      userEmail: customIdentity.userEmail || `krmax+${this.organizationId.replace(/[^a-z0-9.-]/gi, '-')}@localhost`,
      ...(Object.keys(customIdentity).length ? { customIdentity } : {}),
      signingKey: args.signingKey,
      clearSigningKey: args.removeSigningKey,
    }));
    (await this.setDefault(profile.name));
    return profile;

    });
  }

  async delete(name: string) {
    return this.store.transaction(async () => {
    const profile = (await this.get(name));
    (await this.store.kvSet(this.profilesKey(), JSON.stringify((await this.list()).filter((p) => p.name !== name))));
    if ((await this.defaultProfile()) === name) (await this.setDefault(undefined));
    if (!profile?.source) {
      for (const kind of ['ssh', 'signing', 'token'] as const) {
        (await this.broker?.deleteHandle(gitHandle(name, kind, this.organizationId)));
      }
    }
    fs.rmSync(this.keyDir(name), { recursive: true, force: true });

    });
  }

  /** Resolve a named override (legacy organization automation) or this scope's default. */
  async resolve(project: ProjectConfig | undefined): Promise<GitProfile | undefined> {
    const name = project?.gitProfile?.trim() || (await this.defaultProfile());
    return name ? (await this.get(name)) : undefined;
  }

  /**
   * The identity to write worktree-scoped at world creation (§4A). Materializes
   * the signing key to a 0600 file under the state dir (per profile, refreshed
   * whenever the profile is saved).
   */
  async identity(profile: GitProfile, ctx: { taskId?: string }): Promise<GitIdentity> {
    const id: GitIdentity = { name: profile.userName, email: profile.userEmail };
    if (profile.signingKey) id.signingKeyPath = (await this.materializeKey(profile.name, 'signing', ctx));
    return id;
  }

  /** Secret material used only while provisioning an isolated remote world.
   * The caller passes it directly to the provider; it is never journaled or
   * stored in the serializable world handle. */
  async worldCredentials(profile: GitProfile, ctx: { taskId?: string }): Promise<{ sshKey?: string }> {
    return {
      ...(profile.sshKey ? { sshKey: (await this.resolveSecret(profile.name, 'ssh', ctx)) } : {}),
    };
  }

  /**
   * Environment for remote git/gh operations (§4B): GIT_SSH_COMMAND for SSH
   * remotes, GH_TOKEN for the gh CLI and https pushes. Resolved JIT via the
   * broker (audited); purely per-subprocess — nothing lands in a config file.
   * GH_TOKEN is what makes account selection concurrency-safe (never
   * `gh auth switch`, which mutates global state under sibling tasks).
   */
  async env(profile: GitProfile, ctx: { taskId?: string }): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    if (profile.sshKey) {
      const key = (await this.materializeKey(profile.name, 'ssh', ctx));
      const knownHosts = this.materializeKnownHosts(profile.name);
      // A fresh hosted container has no known_hosts file. `accept-new` permits
      // that first connection without weakening protection against a changed
      // host key on subsequent operations.
      env.GIT_SSH_COMMAND = `ssh -i ${key} -o IdentitiesOnly=yes -o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=accept-new`;
    }
    if (profile.githubToken) {
      env.GH_TOKEN = (await this.resolveSecret(profile.name, 'token', ctx));
      // https remotes: a tiny askpass that answers prompts with $GH_TOKEN (GitHub
      // accepts the token for both username and password), keeping the secret in
      // env only — never in a config file or the process argv.
      env.GIT_ASKPASS = this.materializeAskpass(profile.name);
    }
    return env;
  }

  /**
   * The preflight/doctor check (PLAN-git-config.md §7): which tier a project's
   * remote operations resolve to, and whether that tier can actually reach the
   * repos' remotes non-interactively. Read-only; never throws.
   */
  async preflight(project: ProjectConfig | undefined): Promise<{
    tier: 'profile' | 'host' | 'unconfigured';
    profile?: string;
    checks: { label: string; ok: boolean; detail?: string }[];
  }> {
    const checks: { label: string; ok: boolean; detail?: string }[] = [];
    const profile = (await this.resolve(project));
    if (!profile && this.organizationId !== 'org_personal') {
      return {
        tier: 'unconfigured',
        checks: [{
          label: 'organization Git account',
          ok: false,
          detail: 'No Git profile is configured. Host Git identities and credentials are not shared with organizations.',
        }],
      };
    }
    let env: Record<string, string> = this.organizationId === 'org_personal' ? {} : isolatedGitEnvironment();
    if (profile) {
      checks.push({ label: 'identity', ok: true, detail: `${profile.userName} <${profile.userEmail}>` });
      checks.push({ label: 'commit signing', ok: !!profile.signingKey, detail: profile.signingKey ? 'ssh signing key stored' : 'no signing key (commits unsigned)' });
      try {
        env = { ...env, ...(await this.env(profile, {})) };
      } catch (e) {
        checks.push({ label: 'credentials', ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
      checks.push({
        label: 'push auth',
        ok: !!(profile.sshKey || profile.githubToken),
        detail: profile.sshKey ? 'ssh key' : profile.githubToken ? 'github token'
          : this.organizationId === 'org_personal'
            ? 'identity only — pushes use the host’s auth'
            : 'identity only — add an organization SSH key or GitHub token to push',
      });
    } else {
      const name = await git(process.cwd(), ['config', '--global', 'user.name']);
      checks.push({ label: 'host git identity', ok: name.code === 0 && !!name.stdout.trim(), detail: name.stdout.trim() || 'unset — karmax commits as karmax@localhost' });
    }
    // A GitHub API token for remote policy 'pr'. PRs go through the REST API, so
    // this is a token question, not a `gh` installation question — the CLI is
    // only consulted as the personal organization's host-login fallback.
    if (profile?.githubToken) {
      checks.push({ label: 'GitHub pull requests', ok: true, detail: 'profile GitHub token' });
    } else if (this.organizationId !== 'org_personal') {
      checks.push({ label: 'GitHub pull requests', ok: false,
        detail: 'connect the repositories to the GitHub App, or add a GitHub token to this profile' });
    } else if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
      checks.push({ label: 'GitHub pull requests', ok: true, detail: 'host GH_TOKEN' });
    } else {
      try {
        const { stdout } = await pexec('gh', ['auth', 'token'], { env: { ...process.env, ...env }, timeout: 15_000 });
        checks.push({ label: 'GitHub pull requests', ok: !!stdout.trim(), detail: 'host `gh` login' });
      } catch {
        checks.push({ label: 'GitHub pull requests', ok: false,
          detail: 'no GitHub token — add one to the profile, or authorize `gh` on the host' });
      }
    }
    // Each configured repo: origin remote present + reachable non-interactively.
    for (const r of project?.repos ?? []) {
      const repo = expandPath(r);
      const origin = await git(repo, ['remote', 'get-url', 'origin']);
      if (origin.code !== 0) {
        checks.push({ label: `repo ${r}`, ok: false, detail: 'no origin remote — nothing to push to' });
        continue;
      }
      const reach = await git(repo, ['ls-remote', '--heads', 'origin'], { timeoutMs: 20_000, env });
      checks.push({ label: `repo ${r}`, ok: reach.code === 0, detail: reach.code === 0 ? `origin reachable (${origin.stdout.trim()})` : (reach.stderr || 'origin unreachable non-interactively').slice(0, 200) });
    }
    return { tier: profile ? 'profile' : 'host', profile: profile?.name, checks };
  }

  /** A per-profile askpass script echoing $GH_TOKEN (holds no secret itself). */
  private materializeAskpass(profile: string): string {
    const file = path.join(this.keyDir(profile), 'askpass.sh');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, '#!/bin/sh\necho "$GH_TOKEN"\n', { mode: 0o700 });
    }
    return file;
  }

  /** A profile-private trust-on-first-use file, durable across container
   * restarts through KARMAX_HOME and never shared across tenant profiles. */
  private materializeKnownHosts(profile: string): string {
    const file = path.join(this.keyDir(profile), 'known_hosts');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, '', { mode: 0o600 });
    }
    return file;
  }

  /** Write a profile's key to a 0600 file (idempotent) and return its path. */
  private async materializeKey(profile: string, kind: 'ssh' | 'signing', ctx: { taskId?: string }): Promise<string> {
    const file = path.join(this.keyDir(profile), `${kind}.key`);
    if (!fs.existsSync(file)) {
      const secret = (await this.resolveSecret(profile, kind, ctx));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, secret.endsWith('\n') ? secret : `${secret}\n`, { mode: 0o600 });
    }
    return file;
  }

  private async resolveSecret(profile: string, kind: 'ssh' | 'signing' | 'token', ctx: { taskId?: string }): Promise<string> {
    const record = (await this.get(profile));
    const scope = record?.source ? userGitScope(record.source.userId) : this.organizationId;
    const sourceProfile = record?.source?.profile ?? profile;
    const handle = gitHandle(sourceProfile, kind, scope);
    return this.requireBroker().resolve(handle, {
      taskId: ctx.taskId,
      caps: [`use-credential:${handle}`],
    });
  }

  /** Per-profile directory for materialized key files. The name is validated
   *  again here because `delete()` and the materializers take it straight from
   *  the request: `..` once resolved to the state directory itself, and the
   *  recursive `rmSync` after a save would have deleted every database. */
  private keyDir(profile: string): string {
    assertProfileName(profile);
    const root = path.join(this.home, 'git-profiles');
    return this.organizationId === 'org_personal'
      ? path.join(root, profile)
      : path.join(root, this.organizationId, profile);
  }

  private profilesKey(): string {
    const userId = userIdOfScope(this.organizationId);
    if (userId) return `git:profiles:user:${userId}`;
    return `git:profiles:${this.organizationId}`;
  }

  private defaultKey(): string {
    const userId = userIdOfScope(this.organizationId);
    if (userId) return `git:default-profile:user:${userId}`;
    return `git:default-profile:${this.organizationId}`;
  }

  private scopeLabel(): string {
    const userId = userIdOfScope(this.organizationId);
    return userId ? `user ${userId}` : `organization ${this.organizationId}`;
  }

  private requireBroker(): CredentialBroker {
    if (!this.broker) throw new Error('git profiles: no credential broker configured');
    return this.broker;
  }
}

/**
 * Give a user's otherwise-empty personal workspace a live reference to their
 * GitHub-backed profile. This is intentionally identity/config inheritance,
 * not credential copying: repository transport still requires the workspace's
 * own GitHub App installation.
 *
 * The helper is safe to call from either side of onboarding. GitHub social auth
 * can create the user profile before the gateway provisions the workspace,
 * while email/password users normally receive the workspace first and connect
 * GitHub later.
 */
export async function inheritPersonalGithubProfile(store: PersonalGithubProfileStore,
  broker: CredentialBroker | undefined, userId: string): Promise<GitProfile | undefined> {
  const personal = (await store.listOrganizations(userId)).find((organization) => organization.kind === 'personal');
  if (!personal || (await store.listGitConnections(personal.id)).length) return undefined;
  const organizationProfiles = new GitProfiles(store, broker, undefined, personal.id);
  if ((await organizationProfiles.list()).length || (await organizationProfiles.defaultProfile())) return undefined;
  const userProfiles = new GitProfiles(store, broker, undefined, userGitScope(userId));
  if (!(await userProfiles.resolve(undefined))?.github) return undefined;
  return (await organizationProfiles.reuseUserProfile(userProfiles));
}
