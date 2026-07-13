import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitProfile, ProjectConfig } from '../domain/types.js';
import { CredentialBroker } from './broker.js';
import { git } from '../world/git.js';
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
 * Selection: project's `gitProfile` → the global default profile → undefined
 * (host fallback: inject nothing, inherit whatever git/gh auth the host has).
 */

const KV_PROFILES = 'git:profiles';
const KV_DEFAULT = 'git:default-profile';

/** The vault handle for one of a profile's secrets. */
export function gitHandle(profile: string, kind: 'ssh' | 'signing' | 'token'): string {
  return `git:${profile}:${kind}`;
}

/** Identity/signing values materialized into a world's worktree-scoped config. */
export interface GitIdentity {
  name: string;
  email: string;
  /** Absolute path to the SSH public/private signing key file (gpg.format=ssh). */
  signingKeyPath?: string;
}

export interface GitProfileStore {
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
}

export class GitProfiles {
  constructor(
    private store: GitProfileStore,
    private broker?: CredentialBroker,
    private home = paths().state,
  ) {}

  list(): GitProfile[] {
    const raw = this.store.kvGet(KV_PROFILES);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as GitProfile[];
    } catch {
      return [];
    }
  }

  get(name: string): GitProfile | undefined {
    return this.list().find((p) => p.name === name);
  }

  defaultProfile(): string | undefined {
    return this.store.kvGet(KV_DEFAULT) || undefined;
  }

  setDefault(name: string | undefined) {
    this.store.kvSet(KV_DEFAULT, name ?? '');
  }

  /**
   * Create/update a profile. Secrets are write-only: a provided non-empty string
   * is stored in the vault under the profile's handle; absent/empty leaves the
   * stored secret untouched. The registry record carries only has-secret flags.
   */
  save(args: { name: string; userName: string; userEmail: string; sshKey?: string; signingKey?: string; githubToken?: string }): GitProfile {
    const name = args.name.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('profile name must be alphanumeric with . _ - only');
    if (!args.userName?.trim() || !args.userEmail?.trim()) throw new Error('userName and userEmail are required');
    const secrets: Array<['ssh' | 'signing' | 'token', string | undefined, keyof GitProfile]> = [
      ['ssh', args.sshKey, 'sshKey'],
      ['signing', args.signingKey, 'signingKey'],
      ['token', args.githubToken, 'githubToken'],
    ];
    const prior = this.get(name);
    const rec: GitProfile = { name, userName: args.userName.trim(), userEmail: args.userEmail.trim() };
    for (const [kind, value, flag] of secrets) {
      if (value?.trim()) {
        this.requireBroker().registerHandle(gitHandle(name, kind), value.trim());
        (rec as any)[flag] = true;
      } else if (prior?.[flag]) {
        (rec as any)[flag] = true; // keep the existing secret
      }
    }
    const rest = this.list().filter((p) => p.name !== name);
    this.store.kvSet(KV_PROFILES, JSON.stringify([...rest, rec]));
    // Key material may have changed — drop any materialized copies.
    fs.rmSync(this.keyDir(name), { recursive: true, force: true });
    return rec;
  }

  delete(name: string) {
    this.store.kvSet(KV_PROFILES, JSON.stringify(this.list().filter((p) => p.name !== name)));
    if (this.defaultProfile() === name) this.setDefault(undefined);
    for (const kind of ['ssh', 'signing', 'token'] as const) {
      this.broker?.deleteHandle(gitHandle(name, kind));
    }
    fs.rmSync(this.keyDir(name), { recursive: true, force: true });
  }

  /** The profile a project's worlds use: project → global default → none (host fallback). */
  resolve(project: ProjectConfig | undefined): GitProfile | undefined {
    const name = project?.gitProfile?.trim() || this.defaultProfile();
    return name ? this.get(name) : undefined;
  }

  /**
   * The identity to write worktree-scoped at world creation (§4A). Materializes
   * the signing key to a 0600 file under the state dir (per profile, refreshed
   * whenever the profile is saved).
   */
  identity(profile: GitProfile, ctx: { taskId?: string }): GitIdentity {
    const id: GitIdentity = { name: profile.userName, email: profile.userEmail };
    if (profile.signingKey) id.signingKeyPath = this.materializeKey(profile.name, 'signing', ctx);
    return id;
  }

  /**
   * Environment for remote git/gh operations (§4B): GIT_SSH_COMMAND for SSH
   * remotes, GH_TOKEN for the gh CLI and https pushes. Resolved JIT via the
   * broker (audited); purely per-subprocess — nothing lands in a config file.
   * GH_TOKEN is what makes account selection concurrency-safe (never
   * `gh auth switch`, which mutates global state under sibling tasks).
   */
  env(profile: GitProfile, ctx: { taskId?: string }): Record<string, string> {
    const env: Record<string, string> = {};
    if (profile.sshKey) {
      const key = this.materializeKey(profile.name, 'ssh', ctx);
      env.GIT_SSH_COMMAND = `ssh -i ${key} -o IdentitiesOnly=yes`;
    }
    if (profile.githubToken) {
      env.GH_TOKEN = this.resolveSecret(profile.name, 'token', ctx);
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
    tier: 'profile' | 'host';
    profile?: string;
    checks: { label: string; ok: boolean; detail?: string }[];
  }> {
    const checks: { label: string; ok: boolean; detail?: string }[] = [];
    const profile = this.resolve(project);
    let env: Record<string, string> = {};
    if (profile) {
      checks.push({ label: 'identity', ok: true, detail: `${profile.userName} <${profile.userEmail}>` });
      checks.push({ label: 'commit signing', ok: !!profile.signingKey, detail: profile.signingKey ? 'ssh signing key stored' : 'no signing key (commits unsigned)' });
      try {
        env = this.env(profile, {});
      } catch (e) {
        checks.push({ label: 'credentials', ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
      checks.push({ label: 'push auth', ok: !!(profile.sshKey || profile.githubToken), detail: profile.sshKey ? 'ssh key' : profile.githubToken ? 'github token' : 'identity only — pushes use the host’s auth' });
    } else {
      const name = await git(process.cwd(), ['config', '--global', 'user.name']);
      checks.push({ label: 'host git identity', ok: name.code === 0 && !!name.stdout.trim(), detail: name.stdout.trim() || 'unset — karmax commits as karmax@localhost' });
    }
    // gh CLI availability under this tier (GH_TOKEN selects the account).
    try {
      await pexec('bash', ['-lc', 'command -v gh >/dev/null && gh auth status >/dev/null 2>&1'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, timeout: 15_000 });
      checks.push({ label: 'gh CLI', ok: true, detail: 'installed and authorized' });
    } catch {
      checks.push({ label: 'gh CLI', ok: false, detail: 'not installed or not authorized — PRs are skipped' });
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

  /** Write a profile's key to a 0600 file (idempotent) and return its path. */
  private materializeKey(profile: string, kind: 'ssh' | 'signing', ctx: { taskId?: string }): string {
    const file = path.join(this.keyDir(profile), `${kind}.key`);
    if (!fs.existsSync(file)) {
      const secret = this.resolveSecret(profile, kind, ctx);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, secret.endsWith('\n') ? secret : `${secret}\n`, { mode: 0o600 });
    }
    return file;
  }

  private resolveSecret(profile: string, kind: 'ssh' | 'signing' | 'token', ctx: { taskId?: string }): string {
    return this.requireBroker().resolve(gitHandle(profile, kind), { taskId: ctx.taskId, caps: [`use-credential:git:${profile}:*`] });
  }

  private keyDir(profile: string): string {
    return path.join(this.home, 'git-profiles', profile);
  }

  private requireBroker(): CredentialBroker {
    if (!this.broker) throw new Error('git profiles: no credential broker configured');
    return this.broker;
  }
}
