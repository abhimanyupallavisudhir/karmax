import type { World } from './types.js';
import { worldRelativePath, worldRepos } from './types.js';
import type { ResolvedFileSecret } from '../autonomy/project-secrets.js';

/**
 * Materialize file-shaped project secrets into a live world (PLAN-state §3.1).
 * A provider-agnostic duty performed right after creation: each file is written
 * 0600 and git-excluded in its enclosing repo, so status/merge/checkpoint never
 * see it — new secret files are excluded everywhere by construction, not by a
 * name hardcoded per surface. Returns the world-relative paths written: the
 * materialization manifest the caller records on the (non-secret) world handle.
 */
export async function materializeFileSecrets(world: World, files: ResolvedFileSecret[]): Promise<string[]> {
  const written: string[] = [];
  const repos = worldRepos(world.handle);
  for (const file of files) {
    const rel = worldRelativePath(file.path);
    await world.writeFile(rel, file.value);
    // chmod + exclude are best-effort: a backend without a shell (memory) still
    // holds the file; the checkpoint manifest is the safety net there.
    await world.exec('chmod', [file.mode.toString(8), rel]).catch(() => undefined);
    // The enclosing repo: the only one (single-repo world) or the one whose
    // subdirectory prefixes the path. A path outside every repo needs no
    // exclusion — no repo's status can see it.
    await ensureWorldExcluded(world, rel);
    written.push(rel);
  }
  return written;
}

/**
 * Git-exclude a world-relative path WORKTREE-scoped, not via the shared
 * info/exclude (--git-path resolves that to the common dir, which would leak
 * the pattern into the user's own checkout and sibling worlds). Same mechanism
 * as the git identity: enable worktreeConfig (additive, idempotent) and point
 * this worktree's core.excludesFile at an exclude file in its private git dir.
 * Best-effort: backends without a shell keep the file; manifests are the net.
 */
export async function ensureWorldExcluded(world: World, rel: string): Promise<void> {
  const repos = worldRepos(world.handle);
  const repo = repos.length <= 1 ? repos[0] : repos.find((r) => rel === r.name || rel.startsWith(`${r.name}/`));
  if (!repo) return; // outside every repo — no status can see it
  const inRepo = repos.length > 1 && rel.startsWith(`${repo.name}/`) ? rel.slice(repo.name.length + 1) : rel;
  const pattern = `/${inRepo}`;
  await world.exec('bash', ['-c',
    `set -e; git config extensions.worktreeConfig true; d="$(git rev-parse --absolute-git-dir)"; mkdir -p "$d/info"; ` +
    `grep -qxF "$1" "$d/info/exclude" 2>/dev/null || echo "$1" >> "$d/info/exclude"; ` +
    `git config --worktree core.excludesFile "$d/info/exclude"`,
    'karmax-exclude', pattern], { cwd: repo.root }).catch(() => undefined);
}

/** The manifest of secret-materialized paths a handle carries (never values). */
export function secretFileManifest(meta: Record<string, unknown> | undefined): Set<string> {
  const raw = meta?.secretFiles;
  return new Set(Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []);
}
