import type { Project } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { validGitBranch } from '../util/git-ref.js';
import { expandPath } from '../util/expand.js';
import { sameRepository } from '../world/repository-identity.js';
import { repositoryBranchDefaults } from './branch-defaults.js';

/**
 * Per-repository branches ("Different branches per repo"). The task's `base` and
 * `target` are the primary (first) repository's branches and the default for the
 * others; `repoBranches` names the repositories that use different ones, keyed by
 * the source as listed in the project's repositories.
 *
 * An entry may be partial: a blank base follows the primary repository's base, and
 * a blank target follows the entry's own base when it has one, else the primary
 * target. Resolution turns entries into complete pairs and drops every entry that
 * adds nothing (the primary repository, unknown repositories, pairs equal to the
 * common pair), so `{}` means "the same branches everywhere".
 */
export type RepoBranchEntry = { base?: string; target?: string };
export type RepoBranches = Record<string, RepoBranchEntry>;
export interface BranchPair { base: string; target: string }

export const REPO_BRANCHES_PARAM = 'repoBranches';

/** Refuse anything that is not `{ [repo]: { base?, target? } }` with valid branch names. */
export function assertRepoBranches(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('repoBranches must map repositories to { base, target }');
  for (const [repo, entry] of Object.entries(value)) {
    if (!repo.trim()) throw new Error('repoBranches has an empty repository');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`repoBranches entry for ${repo} must be { base, target }`);
    for (const key of ['base', 'target'] as const) {
      const branch = (entry as RepoBranchEntry)[key];
      if (branch === undefined || branch === null || branch === '') continue;
      if (typeof branch !== 'string' || !validGitBranch(branch.trim())) throw new Error(`invalid ${key} branch name for ${repo}`);
    }
  }
}

/** Whether a configured repository source and a key name the same repository. */
export function repoKeyMatches(key: string, source: string): boolean {
  return key === source || sameRepository(key, source) || sameRepository(expandPath(key), expandPath(source));
}

/** The entry a stored value holds for one repository, if any. */
export function repoBranchEntry(value: RepoBranches | undefined, source: string): RepoBranchEntry | undefined {
  if (!value) return undefined;
  const key = Object.keys(value).find((candidate) => repoKeyMatches(candidate, source));
  return key === undefined ? undefined : value[key];
}

/** Complete one entry against the common (primary) pair. */
export function completeRepoBranch(entry: RepoBranchEntry, common: BranchPair): BranchPair {
  const base = entry.base?.trim() || common.base;
  return { base, target: entry.target?.trim() || (entry.base?.trim() ? base : common.target) };
}

/** Complete, deduplicated pairs for the non-primary repositories that differ. */
export function resolveRepoBranches(value: RepoBranches | undefined, repos: string[], common: BranchPair): Record<string, BranchPair> {
  const out: Record<string, BranchPair> = {};
  for (const repo of repos.slice(1)) {
    const entry = repoBranchEntry(value, repo);
    if (!entry) continue;
    const pair = completeRepoBranch(entry, common);
    if (pair.base !== common.base || pair.target !== common.target) out[repo] = pair;
  }
  return out;
}

/**
 * Each non-primary repository's own default branches, for the halves of the
 * common pair nobody chose. Without this a project whose first repository uses
 * `main` would ask a `master` repository for `main` (provisioning would then
 * fall back to its default branch with a warning); with it, every repository
 * starts from its own default, exactly as the primary does.
 */
export async function detectRepoBranches(
  store: Pick<Store, 'listProjectRepositories'>,
  project: Project,
  repos: string[],
  common: BranchPair,
  explicit: { base: boolean; target: boolean },
): Promise<Record<string, BranchPair>> {
  if (explicit.base && explicit.target) return {};
  const out: Record<string, BranchPair> = {};
  await Promise.all(repos.slice(1).map(async (repo) => {
    const detected = await repositoryBranchDefaults(store, project, repo).catch(() => undefined);
    if (!detected) return;
    const pair = { base: explicit.base ? common.base : detected.base, target: explicit.target ? common.target : detected.target };
    if (pair.base !== common.base || pair.target !== common.target) out[repo] = pair;
  }));
  // Keep the project's repository order regardless of probe completion order.
  return Object.fromEntries(repos.filter((repo) => out[repo]).map((repo) => [repo, out[repo]!]));
}

/**
 * The effective per-repository branches for a layered value: a stored value (at
 * any layer, `{}` included) is the whole answer; only when no layer chose
 * per-repository branches are they detected from the repositories themselves.
 */
export async function effectiveRepoBranches(
  store: Pick<Store, 'listProjectRepositories'>,
  project: Project,
  layered: RepoBranches | undefined,
  repos: string[],
  common: BranchPair,
  explicit: { base: boolean; target: boolean },
): Promise<Record<string, BranchPair>> {
  return layered !== undefined
    ? resolveRepoBranches(layered, repos, common)
    : detectRepoBranches(store, project, repos, common, explicit);
}

/** Every repository's pair in project order, for forms: the list to draw. */
export function repoBranchRows(repos: string[], common: BranchPair, resolved: Record<string, BranchPair>): Record<string, BranchPair> {
  return Object.fromEntries(repos.map((repo, index) => [repo, index === 0 ? common : resolved[repo] ?? common]));
}
