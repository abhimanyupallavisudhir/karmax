import { git } from './git.js';
import { withWorktreeLock } from './worktree-lock.js';

export interface LocalTargetSyncResult {
  coherent: boolean;
  /** Transient transport failure rather than a preserved local-state conflict. */
  retryable?: boolean;
  target: string;
  sha?: string;
  updated?: boolean;
  checkout?: string;
  detail?: string;
}

/**
 * Reconcile one already-fetched remote target into its canonical local branch.
 *
 * PR policy makes origin the protected-history authority, but a configured host
 * checkout is still the code Karmax may be running. It must therefore be a clean
 * mirror before a GitHub merge is considered locally complete. We only perform
 * a fast-forward: local-only commits or a dirty checked-out target are preserved
 * and surfaced as an invariant violation instead of being reset, overwritten, or
 * silently left behind.
 */
export async function syncLocalTarget(
  repository: string,
  target: string,
  trackingRef = `refs/remotes/origin/${target}`,
): Promise<LocalTargetSyncResult> {
  const valid = await git(repository, ['check-ref-format', '--branch', target]);
  if (valid.code !== 0) return { coherent: false, target, detail: `invalid target branch "${target}"` };

  return withWorktreeLock(repository, async () => {
    const remote = await git(repository, ['rev-parse', '--verify', `${trackingRef}^{commit}`]);
    if (remote.code !== 0) {
      return { coherent: false, target, detail: `fetched target ${trackingRef} is not a commit` };
    }
    const remoteSha = remote.stdout.trim();
    const localRef = `refs/heads/${target}`;
    const local = await git(repository, ['rev-parse', '--verify', `${localRef}^{commit}`]);

    if (local.code !== 0) {
      const created = await git(repository, ['branch', target, trackingRef]);
      return created.code === 0
        ? { coherent: true, target, sha: remoteSha, updated: true }
        : { coherent: false, target, sha: remoteSha, detail: `could not create local target: ${created.stderr || created.stdout}` };
    }

    const localSha = local.stdout.trim();
    const worktree = await targetWorktree(repository, localRef);
    if (worktree) {
      const status = await git(worktree, ['status', '--porcelain']);
      if (status.code !== 0 || status.stdout.trim()) {
        return {
          coherent: false,
          target,
          sha: remoteSha,
          checkout: worktree,
          detail: status.code !== 0
            ? `could not inspect the local target checkout: ${status.stderr || status.stdout}`
            : `local target checkout has uncommitted changes:\n${status.stdout.trim()}`,
        };
      }
    }

    if (localSha === remoteSha) {
      return { coherent: true, target, sha: remoteSha, updated: false, ...(worktree ? { checkout: worktree } : {}) };
    }

    const canFastForward = await git(repository, ['merge-base', '--is-ancestor', localRef, trackingRef]);
    if (canFastForward.code !== 0) {
      const remoteBehind = await git(repository, ['merge-base', '--is-ancestor', trackingRef, localRef]);
      const relation = remoteBehind.code === 0 ? 'local target has commits not present on origin' : 'local and origin targets have diverged';
      return {
        coherent: false,
        target,
        sha: remoteSha,
        ...(worktree ? { checkout: worktree } : {}),
        detail: `${relation} (local ${localSha.slice(0, 12)}, origin ${remoteSha.slice(0, 12)}); preserving both histories`,
      };
    }

    const advanced = worktree
      ? await git(worktree, ['merge', '--ff-only', trackingRef])
      : await git(repository, ['branch', '-f', target, trackingRef]);
    if (advanced.code !== 0) {
      return {
        coherent: false,
        target,
        sha: remoteSha,
        ...(worktree ? { checkout: worktree } : {}),
        detail: `could not fast-forward the local target: ${advanced.stderr || advanced.stdout}`,
      };
    }
    return { coherent: true, target, sha: remoteSha, updated: true, ...(worktree ? { checkout: worktree } : {}) };
  });
}

async function targetWorktree(repository: string, localRef: string): Promise<string | undefined> {
  const listed = await git(repository, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']);
  if (listed.code !== 0) return undefined;
  for (const block of listed.stdout.trim().split(/\n\n+/)) {
    const lines = block.split('\n');
    if (!lines.includes(`branch ${localRef}`)) continue;
    const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (worktree) return worktree;
  }
  return undefined;
}
