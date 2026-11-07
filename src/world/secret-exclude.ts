import type { World } from './types.js';
import { worldRelativePath, worldRepos, worldWorkingRelativePath } from './types.js';

/** Git-exclude materialized paths (secrets, resources) only in this
 * worktree. Using the shared repository's info/exclude would leak the rule
 * into sibling task worlds and the user's checkout. One command per checkout,
 * however many paths: world setup excludes every resource it restores. */
export async function ensureWorldExcluded(world: World, values: string | string[]): Promise<void> {
  const byRepo = new Map<string, { root: string; patterns: string[] }>();
  for (const value of typeof values === 'string' ? [values] : values) {
    const rel = worldRelativePath(value);
    const match = worldRepos(world.handle).map((repo) => ({ repo,
      prefix: worldWorkingRelativePath({ ...world.handle, workdir: repo.root }, '.') }))
      .find(({ prefix }) => prefix === '.' || rel === prefix || rel.startsWith(`${prefix}/`));
    if (!match) continue;
    const { repo, prefix } = match;
    const inRepo = prefix === '.' ? rel : rel === prefix ? '.' : rel.slice(prefix.length + 1);
    const entry = byRepo.get(repo.root) ?? { root: repo.root, patterns: [] };
    entry.patterns.push(`/${inRepo}`);
    byRepo.set(repo.root, entry);
  }
  for (const { root, patterns } of byRepo.values()) await excludeIn(world, root, patterns);
}

async function excludeIn(world: World, root: string, patterns: string[]): Promise<void> {
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
    + 'for p in "$@"; do grep -qxF "$p" "$secrets" 2>/dev/null || printf "%s\\n" "$p" >> "$secrets"; done; '
    + 'tmp="$(mktemp "$combined.XXXXXX")"; trap \'rm -f "$tmp"\' EXIT; '
    + '{ if [ -f "$base" ]; then cat "$base"; fi; printf "\\n"; cat "$secrets"; } > "$tmp"; '
    + 'mv "$tmp" "$combined"; git config --worktree core.excludesFile "$combined"',
    'karmax-exclude', ...patterns], { cwd: root }).catch(() => undefined);
}
