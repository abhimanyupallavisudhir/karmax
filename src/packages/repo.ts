import fs from 'node:fs';
import path from 'node:path';
import { git, gitOrThrow } from '../world/git.js';
import { WorkflowManifest } from '../contrib/manifests.js';
import { parseManifest } from './schema.js';
import { PackageStore } from './store.js';

/**
 * A workflow package loaded from a git repo (PLAN-dynamic-repos §21c, SPEC §4.2).
 * A workflow is a package of ordinary durable-execution *code* — not config — so
 * loading one means fetching its repo, pinning it to an exact commit, and reading
 * its manifest. The git SHA is the precise version pin (§4.3); the manifest's
 * semver is the human-facing name.
 */
export interface LoadedPackage {
  manifest: WorkflowManifest;
  /** Exact commit the version is pinned to — the real identity (§4.3). */
  sha: string;
  /** The ref that was requested (tag / branch / sha). */
  ref: string;
  /** Immutable checkout of the package at `sha`. */
  dir: string;
  /** Absolute path to the durable workflow module (`workflow.ts|js|mjs`), if present. */
  workflowEntry?: string;
}

/** Manifest filenames tried in order — JSON first (pure data, no code executed). */
const MANIFEST_NAMES = ['manifest.json'];
const WORKFLOW_NAMES = ['workflow.mjs', 'workflow.js', 'workflow.ts'];

/**
 * A package name becomes a directory under the cache home, so it must not be a
 * relative path component. The old sanitizer replaced "unsafe" characters but
 * left dots alone, so the name `..` produced `path.join(cacheHome, '..')` — the
 * clone (and later the recursive `rmSync` in the manager) landed *outside* the
 * cache. The name/manifest mismatch check that would have caught it runs only
 * after the write. Require a leading alphanumeric, which excludes `.`/`..` and
 * dotfiles by construction.
 */
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/i;

/** Schemes we are willing to hand to `git clone`. `ext::` is deliberately absent:
 *  it makes git run an arbitrary host command. */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'ssh:', 'git:', 'file:']);

/** Validate a package name before it is used to build any filesystem path. */
export function assertSafePackageName(name: string, what = 'package name'): string {
  if (typeof name !== 'string' || !PACKAGE_NAME_PATTERN.test(name) || name.includes('\0'))
    throw new Error(`invalid ${what} "${name}": use letters, digits, "_", "-", "." and start with a letter or digit`);
  return name;
}

/**
 * Validate a clone source before it reaches `git clone`.
 *
 * `execFile` stops *shell* injection, but git itself parses its arguments: a URL
 * beginning with `-` is read as an option (`--upload-pack=<cmd>` runs a host
 * command), and the `ext::` transport runs its argument through a shell. So:
 * reject leading `-`, reject any `::` (the transport-helper separator), and
 * allow only known-safe schemes. A bare path (local repo, `user@host:path` scp
 * syntax) has no scheme and is permitted — `..` in it is harmless because the
 * destination directory is ours, not the caller's. Callers must additionally pass
 * `--` before the URL and `-c protocol.ext.allow=never`.
 */
export function assertSafeCloneUrl(raw: string): string {
  const url = String(raw ?? '').trim();
  if (!url) throw new Error('invalid repository url: empty');
  if (url.includes('\0') || /[\r\n]/.test(url)) throw new Error('invalid repository url: control characters');
  if (url.startsWith('-')) throw new Error(`invalid repository url "${url}": must not start with "-" (git would read it as an option)`);
  if (url.includes('::')) throw new Error(`invalid repository url "${url}": transport helpers ("ext::", "…::…") are not allowed`);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url) ?? /^([A-Za-z][A-Za-z0-9+.-]*):(?![\\/])/.exec(url);
  if (scheme && !ALLOWED_URL_SCHEMES.has(`${scheme[1]!.toLowerCase()}:`))
    throw new Error(`invalid repository url "${url}": unsupported scheme "${scheme[1]}:"`);
  return url;
}

/** Hardening flags applied to the clone/fetch of an untrusted package repo:
 *  belt-and-braces against the `ext::` transport even if a URL check is bypassed. */
const GIT_SAFE_CONFIG = ['-c', 'protocol.ext.allow=never'];

/**
 * Loads workflow packages from git repos into a local, SHA-keyed cache and
 * validates their manifests before anything in the system trusts them. This is
 * the *fetch + verify* half of dynamic loading; getting the code into a running
 * worker is the worker-bundle step (§21c-2 / §21e).
 */
export class WorkflowRepoLoader {
  constructor(private cacheHome: string) {}

  /** Where a given package name keeps its working clone and version snapshots.
   *  Both segments are validated (not merely scrubbed) so no input can produce a
   *  path outside `cacheHome`. */
  private nameDir(name: string, namespace?: string): string {
    const safeName = assertSafePackageName(name);
    return namespace
      ? path.join(this.cacheHome, 'organizations', assertSafePackageName(namespace, 'organization id'), safeName)
      : path.join(this.cacheHome, safeName);
  }

  /**
   * Fetch `url` at `ref`, snapshot it at its exact commit, validate the manifest,
   * and (optionally) register it in `store`. Idempotent: a SHA already snapshotted
   * is reused rather than re-fetched.
   */
  async load(
    spec: { url: string; ref?: string; name?: string },
    store?: PackageStore,
    namespace?: string,
    env?: Record<string, string>,
  ): Promise<LoadedPackage> {
    // Validate BOTH untrusted inputs before either touches the filesystem or git.
    const url = assertSafeCloneUrl(spec.url);
    const name = assertSafePackageName(spec.name ?? deriveName(url));
    const ref = spec.ref ?? 'HEAD';
    const nameDir = this.nameDir(name, namespace);
    const work = path.join(nameDir, '.work');

    // Clone once, then fetch on subsequent loads. Local paths and URLs both work.
    // `--` terminates option parsing so a URL can never be read as a git flag.
    if (!fs.existsSync(path.join(work, '.git'))) {
      fs.mkdirSync(path.dirname(work), { recursive: true });
      await gitOrThrow(path.dirname(work), [...GIT_SAFE_CONFIG, 'clone', '--quiet', '--', url, work], { env });
    } else {
      const origin = await gitOrThrow(work, ['remote', 'get-url', 'origin'], { env });
      if (origin.trim() !== url) throw new Error('workflow cache belongs to a different repository; use a distinct package name');
      await gitOrThrow(work, [...GIT_SAFE_CONFIG, 'fetch', '--quiet', '--tags', '--prune', 'origin'], { env });
    }

    // Resolve the ref to a concrete commit — the pin. `origin/<ref>` first so a
    // branch name tracks the fetched remote tip, not a stale local branch.
    const sha = (await firstOk(work, [
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `origin/${ref}^{commit}`],
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    ], env));
    if (!sha) throw new Error(`workflow ref does not resolve to a commit: ${ref}`);

    // Snapshot the exact commit into an immutable, .git-free version dir.
    const dir = path.join(nameDir, sha);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      const tarball = path.join(nameDir, `.${sha}.tar`);
      await gitOrThrow(work, ['archive', '--format=tar', '-o', tarball, sha], { env });
      await extractTar(tarball, dir);
      fs.rmSync(tarball, { force: true });
    }

    const { manifest, workflowEntry } = await inspectDir(dir);
    // The manifest's own name is authoritative for registration/resolution. Only
    // when a caller pinned an explicit name do we treat a disagreement as an
    // error — otherwise the URL-derived name is just a cache-dir guess.
    if (spec.name && manifest.name !== spec.name) {
      throw new Error(`package at ${spec.url} declares name "${manifest.name}" but was loaded as "${spec.name}"`);
    }
    if (store) store.register(manifest);
    return { manifest, sha, ref, dir, workflowEntry };
  }

  /**
   * Read + validate a package from an already-cached snapshot dir, without git.
   * Used to reload installed packages at boot from `~/.karmax/workflows/...`
   * even if the origin is unreachable (SPEC §4.2 — the repos live on disk).
   */
  async inspect(dir: string): Promise<{ manifest: WorkflowManifest; workflowEntry?: string }> {
    return inspectDir(dir);
  }
}

async function inspectDir(dir: string): Promise<{ manifest: WorkflowManifest; workflowEntry?: string }> {
  return { manifest: await readManifest(dir), workflowEntry: firstExisting(dir, WORKFLOW_NAMES) };
}

function deriveName(url: string): string {
  return url.replace(/\.git$/, '').replace(/\/+$/, '').split(/[\\/]/).pop() || 'workflow';
}

/** Return the trimmed stdout of the first git command that succeeds, else undefined. */
async function firstOk(cwd: string, cmds: string[][], env?: Record<string, string>): Promise<string | undefined> {
  for (const args of cmds) {
    const r = await git(cwd, args, { env });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return undefined;
}

function firstExisting(dir: string, names: string[]): string | undefined {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Manifests are data. Never import package code into the server to inspect it. */
async function readManifest(dir: string): Promise<WorkflowManifest> {
  const file = firstExisting(dir, MANIFEST_NAMES);
  if (!file) throw new Error(`no manifest.json in ${dir}; executable manifests are not supported`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('manifest.json must be a regular file');
  return parseManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Extract a tarball with the `tar` CLI (present on the platforms we target). */
async function extractTar(tarball: string, dest: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('tar', ['-xf', tarball, '-C', dest]);
}
