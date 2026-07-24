import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { WorldRepo, WorldSpec } from './types.js';
import { git, isGitRepo } from './git.js';

/** Minimal command/file surface a cloud sandbox exposes during trusted
 * provisioning. Adapters normalize the provider SDK's result shape and convert
 * the timeout unit; they never catch errors or interpret exit codes. */
export interface ProvisionTarget {
  run(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }>;
  writeFile(remotePath: string, content: string | Buffer): Promise<void>;
}

export interface ProvisionRepoOptions {
  /** Workspace root inside the sandbox (single repo root or multi-repo parent). */
  root: string;
  /** Remote $HOME — clone keys are materialized under `$HOME/.ssh`. */
  home: string;
  /** Provider-specific message for repository sources that are not SSH URLs. */
  sshUrlError: string;
  /** Provider-specific warning when no corresponding host checkout exists. */
  copyGlobsWarning: string;
}

/** Provision commands default to this ceiling; a large monorepo clone over a
 * slow link can legitimately need more than the old hard-coded 10 minutes. */
export function provisionTimeoutMs(): number {
  return envInt('KARMAX_WORLD_PROVISION_TIMEOUT_MS', 10 * 60_000, 1);
}

export async function runOrThrow(target: ProvisionTarget, command: string, timeoutMs = provisionTimeoutMs()): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await target.run(command, timeoutMs);
  if (result.code !== 0) throw new Error(String(result.stderr || result.stdout || `remote command failed (${result.code})`));
  return result;
}

/** Write read-only clone keys into the sandbox for trusted provisioning. The
 * caller must delete them (rm -f $HOME/.ssh/karmax-auth-*) before the agent
 * runs; pushes and merges go through the host-side Git broker. */
export async function provisionGitCredentials(target: ProvisionTarget, spec: WorldSpec, home: string): Promise<void> {
  const values = [spec.gitCredentials?.sshKey, ...Object.values(spec.gitCredentials?.repositories ?? {})]
    .filter((value): value is string => Boolean(value));
  if (!values.length) return;
  const ssh = path.posix.join(home, '.ssh');
  await runOrThrow(target, `mkdir -p ${quote(ssh)} && chmod 700 ${quote(ssh)} && ssh-keyscan github.com >> ${quote(path.posix.join(ssh, 'known_hosts'))} 2>/dev/null || true`);
  for (const [index, key] of [...new Set(values)].entries()) {
    const file = credentialFile(home, index);
    await target.writeFile(file, key.endsWith('\n') ? key : `${key}\n`);
    await runOrThrow(target, `chmod 600 ${quote(file)}`);
  }
}

export function credentialFile(home: string, index: number): string {
  return path.posix.join(home, `.ssh/karmax-auth-${index}`);
}

export async function provisionGitRepos(target: ProvisionTarget, spec: WorldSpec, options: ProvisionRepoOptions):
  Promise<{ root: string; repos: WorldRepo[]; warnings: string[]; workdir?: string }> {
  const branch = spec.branch ?? `karmax/${spec.taskId}`;
  const sources = (spec.repos?.length ? spec.repos : spec.repo ? [spec.repo] : []).map((value) => value.trim()).filter(Boolean);
  const warnings: string[] = [];
  if (sources.some((source) => !isSshRemote(source))) throw new Error(options.sshUrlError);
  const root = options.root;
  if (!sources.length) {
    await runOrThrow(target, `mkdir -p ${quote(root)} && git -C ${quote(root)} init -q -b ${quote(spec.base || 'main')}`);
    await configureRepo(target, root, spec, branch, false);
    return { root, repos: [], warnings, ...(spec.scratch ? { workdir: root } : {}) };
  }
  const multi = sources.length > 1 || spec.scratch;
  const allNames = uniqueNames([...(spec.scratch ? ['scratch'] : []), ...sources.map(remoteName)]);
  const scratchName = spec.scratch ? allNames[0]! : undefined;
  const names = spec.scratch ? allNames.slice(1) : allNames;
  if (multi) await runOrThrow(target, `mkdir -p ${quote(root)}`);
  const workdir = spec.scratch ? path.posix.join(root, scratchName!) : undefined;
  if (workdir) {
    await runOrThrow(target, `mkdir -p ${quote(workdir)} && git -C ${quote(workdir)} init -q -b ${quote(spec.base || 'main')}`);
    await configureRepo(target, workdir, spec, branch, false);
  }
  const uniqueKeys = [...new Set([spec.gitCredentials?.sshKey, ...Object.values(spec.gitCredentials?.repositories ?? {})]
    .filter((value): value is string => Boolean(value)))];
  const repos: WorldRepo[] = [];
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]!;
    const branchPolicy = spec.repositoryBranches?.[source];
    const base = branchPolicy?.base ?? spec.base;
    const targetBranch = branchPolicy?.target ?? spec.target;
    const repoRoot = multi ? path.posix.join(root, names[index]!) : root;
    const key = spec.gitCredentials?.repositories?.[source] ?? spec.gitCredentials?.sshKey;
    const keyIndex = key ? uniqueKeys.indexOf(key) : -1;
    const ssh = keyIndex >= 0
      ? `GIT_SSH_COMMAND=${quote(`ssh -i ${credentialFile(options.home, keyIndex)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`)} `
      : '';
    await cloneWithRetry(target, `${ssh}git clone -q --origin origin ${quote(source)} ${quote(repoRoot)}`, repoRoot);
    const localPath = spec.copySources?.[index];
    if (localPath) await seedFromLocalCheckout(target, repoRoot, localPath, [base, spec.branch], names[index]!, warnings);
    const requested = spec.branch ?? base;
    const remoteRef = `refs/remotes/origin/${requested}`;
    const refCheck = await target.run(`git -C ${quote(repoRoot)} show-ref --verify --quiet ${quote(remoteRef)}`, 120_000);
    const remoteRefExists = refCheck.code === 0;
    if (spec.branch && !remoteRefExists) throw new Error(`repository "${source}" has no remote branch "${spec.branch}" to review`);
    if (!spec.branch && !remoteRefExists) warnings.push(`repo "${names[index]}": base branch "${base}" not found — forked off the remote default branch instead`);
    const resolved = await target.run(`git -C ${quote(repoRoot)} rev-parse ${quote(remoteRefExists ? remoteRef : 'refs/remotes/origin/HEAD')}`, 120_000);
    const baseSha = resolved.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseSha)) throw new Error(`repository "${source}" has no resolvable base commit`);
    await configureRepo(target, repoRoot, spec, branch, true, remoteRefExists, base);
    repos.push({ name: names[index]!, repo: source, root: repoRoot, branch, base, target: targetBranch, baseSha,
      ...(localPath ? { localPath } : {}) });
  }
  if (spec.copyGlobs?.length) {
    let copied = 0;
    for (let index = 0; index < repos.length; index++) {
      const source = spec.copySources?.[index];
      if (!source) continue;
      copied += await uploadCopyGlobs(target, source, repos[index]!.root, spec.copyGlobs);
    }
    if (!copied) warnings.push(options.copyGlobsWarning);
  }
  return { root, repos, warnings, ...(workdir ? { workdir } : {}) };
}

/** Rewrite the sandbox's remote-tracking refs with the host checkout's truth.
 * A world provisioned from a local-path repo must fork off the LOCAL branch
 * state: the checkout is the authoritative repository (merges land there, see
 * git-broker.ts) and origin is only clone transport, so origin may lag it
 * indefinitely. Seeding runs right after the clone and overwrites
 * `refs/remotes/origin/<ref>`, leaving the rest of provisioning (branch
 * checkout, baseSha resolution) untouched. Best-effort: on failure the world
 * falls back to origin's state, with a warning that says so. */
async function seedFromLocalCheckout(target: ProvisionTarget, repoRoot: string, localRepo: string,
  refs: Array<string | undefined>, name: string, warnings: string[]): Promise<void> {
  const wanted = [...new Set(refs.filter((ref): ref is string => Boolean(ref)))];
  try {
    if (!(await isGitRepo(localRepo))) return;
    const seeds: string[] = [];
    const bases: string[] = [];
    for (const ref of wanted) {
      const local = await git(localRepo, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`]);
      if (local.code !== 0) continue; // ref lives only on origin (if anywhere) — the clone state stands
      const localSha = local.stdout.trim();
      const origin = await target.run(`git -C ${quote(repoRoot)} rev-parse --verify --quiet ${quote(`refs/remotes/origin/${ref}`)}`, 120_000);
      const originSha = origin.code === 0 ? origin.stdout.trim() : undefined;
      if (originSha === localSha) continue;
      if (originSha && (await git(localRepo, ['cat-file', '-e', `${originSha}^{commit}`])).code === 0) bases.push(originSha);
      else if (originSha) warnings.push(`repo "${name}": origin/${ref} has commits the local checkout lacks — the world forked off the local state`);
      seeds.push(ref);
    }
    if (!seeds.length) return;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-world-seed-'));
    try {
      const bundlePath = path.join(temp, 'seed.bundle');
      const bundled = await git(localRepo, ['bundle', 'create', bundlePath,
        ...seeds.map((ref) => `refs/heads/${ref}`), ...(bases.length ? ['--not', ...bases] : [])]);
      if (bundled.code !== 0) throw new Error(bundled.stderr || bundled.stdout);
      const bundleName = '.karmax-seed.bundle';
      const bundleRemote = path.posix.join(repoRoot, bundleName);
      await target.writeFile(bundleRemote, fs.readFileSync(bundlePath));
      const refspecs = seeds.map((ref) => quote(`+refs/heads/${ref}:refs/remotes/origin/${ref}`)).join(' ');
      await runOrThrow(target, `git -C ${quote(repoRoot)} fetch ${quote(bundleName)} ${refspecs} && rm -f ${quote(bundleRemote)}`);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  } catch (error) {
    warnings.push(`repo "${name}": could not seed from local checkout ${localRepo} — using its origin state (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function uploadCopyGlobs(target: ProvisionTarget, sourceRoot: string, remoteRoot: string, globs: string[]): Promise<number> {
  if (!fs.existsSync(sourceRoot)) return 0;
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  let copied = 0;
  for (const glob of globs) {
    const pattern = globToRegExp(glob);
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      await target.writeFile(path.posix.join(remoteRoot, entry.name), fs.readFileSync(path.join(sourceRoot, entry.name)));
      copied++;
    }
  }
  return copied;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Network clones fail transiently (DNS hiccup, provider egress warm-up); a
 * failed provision destroys the whole sandbox and rebills the attempt, so a
 * couple of in-place retries are much cheaper than a workflow-level retry. */
async function cloneWithRetry(target: ProvisionTarget, command: string, repoRoot: string): Promise<void> {
  const attempts = 1 + envInt('KARMAX_WORLD_CLONE_RETRIES', 2, 0);
  for (let attempt = 1; ; attempt++) {
    try {
      await runOrThrow(target, command);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      // A failed clone can leave a partial checkout that would fail the retry.
      await target.run(`rm -rf ${quote(repoRoot)}`, 120_000).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, envInt('KARMAX_WORLD_CLONE_RETRY_MS', 2_000, 0) * attempt));
    }
  }
}

async function configureRepo(target: ProvisionTarget, root: string, spec: WorldSpec, branch: string,
  hasOrigin: boolean, requestedRemoteRefExists = false, base = spec.base): Promise<void> {
  const identity = spec.gitIdentity;
  await runOrThrow(target, `git -C ${quote(root)} config user.name ${quote(identity?.name ?? 'karmax')} && git -C ${quote(root)} config user.email ${quote(identity?.email ?? 'karmax@localhost')}`);
  // Commit signing stays in the trusted Git broker. Leaving a long-lived signing
  // key in an agent-controlled world would make the isolation boundary moot.
  if (!hasOrigin) return;
  const checkout = spec.branch
    ? `git -C ${quote(root)} checkout -q -B ${quote(spec.branch)} ${quote(`origin/${spec.branch}`)}`
    : requestedRemoteRefExists
      ? `git -C ${quote(root)} checkout -q -B ${quote(base)} ${quote(`origin/${base}`)} && git -C ${quote(root)} checkout -q -b ${quote(branch)}`
      : `git -C ${quote(root)} checkout -q -b ${quote(branch)}`;
  await runOrThrow(target, checkout);
}

function isSshRemote(value: string): boolean {
  return /^(?:ssh:\/\/|git@)[^\s]+/.test(value);
}

function remoteName(remote: string): string {
  const raw = remote.replace(/\/$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') || 'repo';
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  return !safe || /^\.+$/.test(safe) ? 'repo' : safe;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count ? `${name}-${count + 1}` : name;
  });
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envInt(name: string, fallback: number, min: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}
