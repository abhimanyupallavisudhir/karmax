import type { World } from './types.js';
import { worldRelativePath, worldRepos, worldWorkingRelativePath } from './types.js';

/** Git-exclude a materialized secret only in this worktree. Using the shared
 * repository's info/exclude would leak the rule into sibling task worlds and
 * the user's checkout. */
export async function ensureWorldExcluded(world: World, value: string): Promise<void> {
  const rel = worldRelativePath(value);
  const match = worldRepos(world.handle).map((repo) => ({ repo,
    prefix: worldWorkingRelativePath({ ...world.handle, workdir: repo.root }, '.') }))
    .find(({ prefix }) => prefix === '.' || rel === prefix || rel.startsWith(`${prefix}/`));
  if (!match) return;
  const { repo, prefix } = match;
  const inRepo = prefix === '.' ? rel : rel === prefix ? '.' : rel.slice(prefix.length + 1);
  const pattern = `/${inRepo}`;
  await world.exec('bash', ['-c',
    'set -e; git config extensions.worktreeConfig true; '
    + 'd="$(git rev-parse --absolute-git-dir)"; mkdir -p "$d/info"; '
    + 'grep -qxF "$1" "$d/info/exclude" 2>/dev/null || echo "$1" >> "$d/info/exclude"; '
    + 'git config --worktree core.excludesFile "$d/info/exclude"',
    'karmax-exclude', pattern], { cwd: repo.root }).catch(() => undefined);
}
