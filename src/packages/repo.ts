import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
const MANIFEST_NAMES = ['manifest.json', 'manifest.mjs', 'manifest.js', 'manifest.ts'];
const WORKFLOW_NAMES = ['workflow.mjs', 'workflow.js', 'workflow.ts'];

/**
 * Loads workflow packages from git repos into a local, SHA-keyed cache and
 * validates their manifests before anything in the system trusts them. This is
 * the *fetch + verify* half of dynamic loading; getting the code into a running
 * worker is the worker-bundle step (§21c-2 / §21e).
 */
export class WorkflowRepoLoader {
  constructor(private cacheHome: string) {}

  /** Where a given package name keeps its working clone and version snapshots. */
  private nameDir(name: string): string {
    return path.join(this.cacheHome, name.replace(/[^a-z0-9_.-]/gi, '-'));
  }

  /**
   * Fetch `url` at `ref`, snapshot it at its exact commit, validate the manifest,
   * and (optionally) register it in `store`. Idempotent: a SHA already snapshotted
   * is reused rather than re-fetched.
   */
  async load(spec: { url: string; ref?: string; name?: string }, store?: PackageStore): Promise<LoadedPackage> {
    const name = spec.name ?? deriveName(spec.url);
    const ref = spec.ref ?? 'HEAD';
    const work = path.join(this.nameDir(name), '.work');

    // Clone once, then fetch on subsequent loads. Local paths and URLs both work.
    if (!fs.existsSync(path.join(work, '.git'))) {
      fs.mkdirSync(path.dirname(work), { recursive: true });
      await gitOrThrow(path.dirname(work), ['clone', '--quiet', spec.url, work]);
    } else {
      await git(work, ['fetch', '--quiet', '--tags', '--prune', 'origin']);
    }

    // Resolve the ref to a concrete commit — the pin. `origin/<ref>` first so a
    // branch name tracks the fetched remote tip, not a stale local branch.
    const sha = (await firstOk(work, [
      ['rev-parse', '--verify', '--quiet', `origin/${ref}^{commit}`],
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    ])) ?? (await gitOrThrow(work, ['rev-parse', 'HEAD']));

    // Snapshot the exact commit into an immutable, .git-free version dir.
    const dir = path.join(this.nameDir(name), sha);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      const tarball = path.join(this.nameDir(name), `.${sha}.tar`);
      await gitOrThrow(work, ['archive', '--format=tar', '-o', tarball, sha]);
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
async function firstOk(cwd: string, cmds: string[][]): Promise<string | undefined> {
  for (const args of cmds) {
    const r = await git(cwd, args);
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

/** Read + validate the package manifest. JSON is parsed; a module is imported. */
async function readManifest(dir: string): Promise<WorkflowManifest> {
  const file = firstExisting(dir, MANIFEST_NAMES);
  if (!file) throw new Error(`no manifest (${MANIFEST_NAMES.join(' / ')}) in ${dir}`);
  let data: unknown;
  if (file.endsWith('.json')) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    // A manifest module exports the manifest as default or as `manifest`. This
    // runs the module in the host process (not the deterministic sandbox); the
    // PR review gate (§4.4) is the trust boundary for what gets loaded at all.
    const mod = await import(pathToFileURL(file).href);
    data = mod.default ?? mod.manifest ?? mod;
  }
  return parseManifest(data);
}

/** Extract a tarball with the `tar` CLI (present on the platforms we target). */
async function extractTar(tarball: string, dest: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('tar', ['-xf', tarball, '-C', dest]);
}
