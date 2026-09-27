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
    + 'combined="$d/info/karmax-exclude"; secrets="$d/info/karmax-secret-exclude"; '
    + 'base="$(git config --path --get core.excludesFile || printf %s "${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore")"; '
    + 'if [ "$base" = "$combined" ]; then base="$(git config --worktree --path --get karmax.secretExcludeBase)"; '
    // Recover the inherited setting when upgrading a worktree made by the old helper.
    + 'elif [ "$base" = "$d/info/exclude" ]; then '
    + 'cat "$base" >> "$secrets"; '
    + 'base="$(git config --local --path --get core.excludesFile || git config --global --path --get core.excludesFile '
    + '|| printf %s "${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore")"; fi; '
    + 'git config --worktree karmax.secretExcludeBase "$base"; '
    + 'grep -qxF "$1" "$secrets" 2>/dev/null || printf "%s\\n" "$1" >> "$secrets"; '
    + 'tmp="$(mktemp "$combined.XXXXXX")"; trap \'rm -f "$tmp"\' EXIT; '
    + '{ if [ -f "$base" ]; then cat "$base"; fi; printf "\\n"; cat "$secrets"; } > "$tmp"; '
    + 'mv "$tmp" "$combined"; git config --worktree core.excludesFile "$combined"',
    'karmax-exclude', pattern], { cwd: repo.root }).catch(() => undefined);
}
