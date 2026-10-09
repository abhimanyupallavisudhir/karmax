import { concurrentMap } from '../util/concurrent-map.js';
import { missingBaseAdjustment } from './branch-fallback.js';
import { remoteName, worldCheckoutNames } from '../domain/world-location.js';

export { remoteName };
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { WorldRepo, WorldSpec } from './types.js';
import { git, isGitRepo } from './git.js';
import { taskBranch, BRAND } from '../domain/brand.js';

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

/** Write clone credentials into the sandbox for trusted provisioning. GitHub
 * tokens use HTTPS askpass; legacy/non-GitHub sources may use SSH keys. The
 * caller deletes every karmax-auth-* file before the agent runs. */
export async function provisionGitCredentials(target: ProvisionTarget, spec: WorldSpec, home: string): Promise<void> {
  const values = repositoryKeys(spec);
  const tokens = Object.values(spec.gitCredentials?.httpsTokens ?? {})
    .filter((value): value is string => Boolean(value));
  if (!values.length && !tokens.length) return;
  const ssh = path.posix.join(home, '.ssh');
  await runOrThrow(target, `mkdir -p ${quote(ssh)} && chmod 700 ${quote(ssh)}`);
  if (values.length)
    await runOrThrow(target, `ssh-keyscan github.com >> ${quote(path.posix.join(ssh, 'known_hosts'))} 2>/dev/null || true`);
  await concurrentMap([...new Set(values)], 3, async (key, index) => {
    const file = credentialFile(home, index);
    await target.writeFile(file, key.endsWith('\n') ? key : `${key}\n`);
    await runOrThrow(target, `chmod 600 ${quote(file)}`);
  });
  await concurrentMap([...new Set(tokens)], 3, async (token, index) => {
    const tokenFile = credentialTokenFile(home, index);
    const askpassFile = credentialAskpassFile(home, index);
    await target.writeFile(tokenFile, token);
    await target.writeFile(askpassFile, `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' x-access-token ;;
  *) cat ${quote(tokenFile)} ;;
esac
`);
    await runOrThrow(target, `chmod 600 ${quote(tokenFile)} && chmod 700 ${quote(askpassFile)}`);
  });
}

function repositoryKeys(spec: WorldSpec): string[] {
  return Object.entries(spec.gitCredentials?.repositories ?? {})
    .filter(([source, key]) => key && !spec.gitCredentials?.httpsTokens?.[source]).map(([, key]) => key);
}

export function credentialFile(home: string, index: number): string {
  return path.posix.join(home, `.ssh/karmax-auth-${index}`);
}

function credentialTokenFile(home: string, index: number): string {
  return path.posix.join(home, `.ssh/karmax-auth-token-${index}`);
}

function credentialAskpassFile(home: string, index: number): string {
  return path.posix.join(home, `.ssh/karmax-auth-askpass-${index}`);
}

function githubHttpsAuthPrefix(home: string, index: number): string {
  return [
    'GIT_TERMINAL_PROMPT=0',
    `GIT_ASKPASS=${quote(credentialAskpassFile(home, index))}`,
    'GIT_CONFIG_COUNT=2',
    `GIT_CONFIG_KEY_0=${quote('url.https://github.com/.insteadOf')}`,
    `GIT_CONFIG_VALUE_0=${quote('git@github.com:')}`,
    `GIT_CONFIG_KEY_1=${quote('url.https://github.com/.insteadOf')}`,
    `GIT_CONFIG_VALUE_1=${quote('ssh://git@ssh.github.com:443/')}`,
    '',
  ].join(' ');
}

export async function provisionGitRepos(target: ProvisionTarget, spec: WorldSpec, options: ProvisionRepoOptions):
  Promise<{ root: string; repos: WorldRepo[]; warnings: string[]; workdir?: string; ephemeralPaths: string[] }> {
  const sources = (spec.repos?.length ? spec.repos : spec.repo ? [spec.repo] : []).map((value) => value.trim()).filter(Boolean);
  const warnings: string[] = [];
  const ephemeralPaths: string[] = [];
  if (sources.some((source) => !isSshRemote(source))) throw new Error(options.sshUrlError);
  const root = options.root;
  if (!sources.length) {
    await runOrThrow(target, `mkdir -p ${quote(root)}`);
    return { root, repos: [], warnings, ephemeralPaths, ...(spec.scratch ? { workdir: root } : {}) };
  }
  const multi = sources.length > 1 || spec.scratch || spec.layout === 'nested';
  const allNames = worldCheckoutNames([...(spec.scratch ? ['scratch'] : []), ...sources]);
  const scratchName = spec.scratch ? allNames[0]! : undefined;
  const names = (spec.scratch ? allNames.slice(1) : allNames)
    .map((name, index) => spec.checkouts?.[index]?.name ?? name);
  if (multi) await runOrThrow(target, `mkdir -p ${quote(root)}`);
  const workdir = spec.scratch ? path.posix.join(root, scratchName!) : undefined;
  if (workdir) {
    await runOrThrow(target, `mkdir -p ${quote(workdir)}`);
  }
  const uniqueKeys = [...new Set(repositoryKeys(spec))];
  const uniqueTokens = [...new Set(Object.values(spec.gitCredentials?.httpsTokens ?? {})
    .filter((value): value is string => Boolean(value)))];
  const repos = await concurrentMap(sources, 3, async (source, index): Promise<WorldRepo> => {
    const recorded = spec.checkouts?.[index];
    const repoSpec = { ...spec, ...recorded };
    const branch = recorded?.branch ?? spec.branch ?? taskBranch(spec.taskId);
    const branchPolicy = recorded ?? spec.repositoryBranches?.[source];
    let base = branchPolicy?.base ?? spec.base;
    let targetBranch = branchPolicy?.target ?? spec.target;
    const repoRoot = multi ? path.posix.join(root, names[index]!) : root;
    const key = spec.gitCredentials?.httpsTokens?.[source] ? undefined : spec.gitCredentials?.repositories?.[source];
    const token = spec.gitCredentials?.httpsTokens?.[source];
    const keyIndex = key ? uniqueKeys.indexOf(key) : -1;
    const tokenIndex = token ? uniqueTokens.indexOf(token) : -1;
    const auth = keyIndex >= 0
      ? `GIT_SSH_COMMAND=${quote(`ssh -i ${credentialFile(options.home, keyIndex)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`)} `
      : tokenIndex >= 0 ? githubHttpsAuthPrefix(options.home, tokenIndex) : '';
    await cloneWithRetry(target, `${auth}git clone -q --origin origin ${quote(source)} ${quote(repoRoot)}`, repoRoot);
    const localPath = spec.copySources?.[index];
    const sourceAuthority = recorded?.sourceAuthority ?? spec.repositoryAuthorities?.[source] ?? 'project';
    if (localPath && sourceAuthority !== 'origin')
      await seedFromLocalCheckout(target, repoRoot, localPath, [base, repoSpec.branch], names[index]!, warnings);
    const requested = repoSpec.branch ?? base;
    let remoteRef = `refs/remotes/origin/${requested}`;
    const refCheck = await target.run(`git -C ${quote(repoRoot)} show-ref --verify --quiet ${quote(remoteRef)}`, 120_000);
    const remoteRefExists = refCheck.code === 0;
    if (repoSpec.branch && !remoteRefExists) throw new Error(`repository "${source}" has no remote branch "${repoSpec.branch}" to review`);
    let branchAdjustment;
    if (!repoSpec.branch && !remoteRefExists) {
      const fallback = await runOrThrow(target, `git -C ${quote(repoRoot)} symbolic-ref refs/remotes/origin/HEAD`);
      const prefix = 'refs/remotes/origin/';
      const ref = fallback.stdout.trim();
      if (!ref.startsWith(prefix)) throw new Error(`repository "${source}" has no named remote default branch`);
      branchAdjustment = missingBaseAdjustment(names[index]!, base, targetBranch, ref.slice(prefix.length));
      base = branchAdjustment.base;
      targetBranch = branchAdjustment.target;
      remoteRef = ref;
      warnings.push(branchAdjustment.warning);
    }
    if (!repoSpec.branch && targetBranch && targetBranch !== base) {
      const check = await target.run(`git -C ${quote(repoRoot)} show-ref --verify --quiet ${quote(`refs/remotes/origin/${targetBranch}`)}`, 120_000);
      if (check.code !== 0) throw new Error(`repository "${source}": target branch "${targetBranch}" does not exist; choose an existing target before starting the task`);
    }
    const resolved = await target.run(`git -C ${quote(repoRoot)} rev-parse ${quote(remoteRef)}`, 120_000);
    const baseSha = resolved.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseSha)) throw new Error(`repository "${source}" has no resolvable base commit`);
    await configureRepo(target, repoRoot, repoSpec, branch, true, true, base);
    return { name: names[index]!, repo: source, root: repoRoot, branch, base,
      ...(targetBranch ? { target: targetBranch } : {}), targetPinned: Boolean(branchPolicy?.target || (branchAdjustment && index > 0)), baseSha,
      ...(branchAdjustment ? { branchAdjustment } : {}),
      ...(localPath ? { localPath } : {}), ...(sourceAuthority === 'origin' ? { sourceAuthority } : {}) };
  });
  if (repos[0]?.branchAdjustment) {
    for (const repo of repos.slice(1)) if (repo.target && repo.target !== repos[0].target) repo.targetPinned = true;
  }
  if (spec.copyGlobs?.length) {
    let copied = 0;
    for (let index = 0; index < repos.length; index++) {
      const source = spec.copySources?.[index];
      if (!source) continue;
      const uploaded = await uploadCopyGlobs(target, source, repos[index]!.root, spec.copyGlobs);
      copied += uploaded.length;
      ephemeralPaths.push(...uploaded.map((file) => multi ? `${repos[index]!.name}/${file}` : file));
    }
    if (!copied) warnings.push(options.copyGlobsWarning);
  }
  return { root, repos, warnings, ephemeralPaths, ...(workdir ? { workdir } : {}) };
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

async function uploadCopyGlobs(target: ProvisionTarget, sourceRoot: string, remoteRoot: string, globs: string[]): Promise<string[]> {
  if (!fs.existsSync(sourceRoot)) return [];
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  const copied = new Set<string>();
  for (const glob of globs) {
    const pattern = globToRegExp(glob);
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      await target.writeFile(path.posix.join(remoteRoot, entry.name), fs.readFileSync(path.join(sourceRoot, entry.name)));
      copied.add(entry.name);
    }
  }
  return [...copied];
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
  await runOrThrow(target, `git -C ${quote(root)} config user.name ${quote(identity?.name ?? BRAND)} && git -C ${quote(root)} config user.email ${quote(identity?.email ?? `${BRAND}@localhost`)}`);
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

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envInt(name: string, fallback: number, min: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}
