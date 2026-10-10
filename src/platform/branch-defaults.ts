import type { Project, RepoBranches } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { defaultBranch } from '../world/git.js';
import { sameRepository } from '../world/repository-identity.js';
import { expandPath } from '../util/expand.js';

export interface RepositoryBranchDefaults {
  base: string;
  target: string;
}

/** New task records carry this after their common base/target have already been
 * resolved against repository metadata. Its absence identifies older queued
 * tasks that still need provisioning's legacy repository-default fallback. */
export const REPOSITORY_BRANCHES_RESOLVED_PARAM = '_repositoryBranchesResolved';

/**
 * Resolve the branch policy for a project's effective first repository.
 *
 * Hosted projects configure an SSH URL, which cannot be passed to `git` as a
 * working directory. Their enrolled repository record is therefore the source
 * of truth. Local/path-only projects retain the existing origin/HEAD probe.
 */
export async function repositoryBranchDefaults(
  store: Pick<Store, 'listProjectRepositories'>,
  project: Project,
  source: string | undefined,
): Promise<RepositoryBranchDefaults | undefined> {
  if (!source) return undefined;
  const linked = (await store.listProjectRepositories(project.id))
    .find((candidate) => sameRepository(candidate.repository.sshUrl, source));
  if (linked) {
    const base = linked.baseBranch ?? linked.repository.defaultBranch;
    return { base, target: linked.targetBranch ?? base };
  }

  const branch = await defaultBranch(expandPath(source)).catch(() => undefined);
  return branch ? { base: branch, target: branch } : undefined;
}

/** A stored per-repository branch map with trimmed names and empty entries
 * dropped; `undefined` when the value is not a map at all. */
export function normalizeRepoBranches(value: unknown): RepoBranches | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: RepoBranches = {};
  for (const [source, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!source.trim() || !entry || typeof entry !== 'object') continue;
    const { base, target } = entry as { base?: unknown; target?: unknown };
    const name = (branch: unknown) => (typeof branch === 'string' ? branch.trim() : '');
    if (name(base) || name(target))
      out[source.trim()] = { ...(name(base) ? { base: name(base) } : {}), ...(name(target) ? { target: name(target) } : {}) };
  }
  return out;
}

/** The entry for whichever of `sources` (spellings of one repository) the map names. */
export function repoBranchesFor(map: RepoBranches | undefined, sources: (string | undefined)[]): RepoBranches[string] | undefined {
  for (const [key, entry] of Object.entries(map ?? {})) {
    if (sources.some((source) => source && sameRepository(expandPath(key), expandPath(source)))) return entry;
  }
  return undefined;
}

const setValue = (value: unknown) => value !== undefined && value !== null && value !== '';

/**
 * Apply the per-repository branch policy to resolved task params.
 *
 * Branch policy belongs to the most specific layer that states one: a layer that
 * sets only a common base/target (an API caller's explicit base) overrides a less
 * specific per-repository map, and a task's empty map turns an inherited one off.
 * A map in effect is re-keyed to the task's repositories, and sets the common
 * pair to its first repository's branches — the pair every task view, pull
 * request and merge-queue domain reads.
 */
export function applyRepoBranches(resolved: Record<string, unknown>, layers: (Record<string, unknown> | undefined)[],
  repos: string[]): void {
  const mapLayer = layers.findIndex((layer) => normalizeRepoBranches(layer?.repoBranches) !== undefined);
  const commonLayer = layers.findIndex((layer) => setValue(layer?.base) || setValue(layer?.target));
  const stored = mapLayer < 0 || (commonLayer >= 0 && commonLayer < mapLayer)
    ? undefined : normalizeRepoBranches(layers[mapLayer]!.repoBranches);
  const map: RepoBranches = {};
  for (const source of repos) {
    const entry = repoBranchesFor(stored, [source]);
    if (entry) map[source] = entry;
  }
  if (!Object.keys(map).length) {
    delete resolved.repoBranches;
    return;
  }
  const first = map[repos[0]!];
  if (first?.base) resolved.base = first.base;
  if (first?.target) resolved.target = first.target;
  resolved.repoBranches = map;
}
