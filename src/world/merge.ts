import path from 'node:path';
import fs from 'node:fs';
import { World } from './types.js';
import { git, gitOrThrow, isDirty, ensureIdentity, headSha } from './git.js';

export interface MergeResult {
  merged: boolean;
  sha?: string;
  conflict?: string;
  landedFiles: string[];
  note?: string;
}

/**
 * The authoritative merge (SPEC §5.2 "Merge", the point of no return). Robust
 * by design: it commits any pending work on the attempt branch, brings the
 * target into the branch (surfacing conflicts), then lands the branch on the
 * target. This is the deterministic backstop that guarantees real work actually
 * lands — a prior build's showstopper was a merge stage that committed nothing.
 *
 * The merge into the target runs in whichever worktree has the target checked
 * out (git forbids checking a branch out twice); if none, a temporary worktree
 * is used and removed.
 */
export async function finalizeMerge(world: World, target: string): Promise<MergeResult> {
  const root = world.handle.root;
  const repo = world.handle.repo;
  const branch = world.handle.branch;
  const base = world.handle.base;
  if (!repo) return { merged: false, landedFiles: [], note: 'no source repo (non-git world)' };

  await ensureIdentity(root);

  // 1. Commit any pending work on the attempt branch.
  if (await isDirty(root)) {
    await git(root, ['add', '-A']);
    const c = await git(root, ['commit', '-q', '-m', `karmax: work for ${world.handle.id}`]);
    if (c.code !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) {
      return { merged: false, landedFiles: [], note: `commit failed: ${c.stderr || c.stdout}` };
    }
  }

  // Files this attempt changed vs its base (for the landed-files report).
  const changed = await git(root, ['diff', '--name-only', `${base}...HEAD`]);
  const landedFiles = changed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  // Ensure the target branch exists; create it at base if missing.
  if ((await git(repo, ['rev-parse', '--verify', target])).code !== 0) {
    const baseRef = (await git(repo, ['rev-parse', '--verify', base])).code === 0 ? base : 'HEAD';
    await git(repo, ['branch', target, baseRef]);
  }

  // 2. Bring the target into the branch so conflicts surface here (resolvable
  //    by the merge agent in a prior turn). Abort + report on conflict.
  const into = await git(root, [
    'merge',
    '--no-ff',
    '--no-edit',
    '-m',
    `karmax: merge ${target} into ${branch}`,
    target,
  ]);
  if (into.code !== 0) {
    const conflicts = await git(root, ['diff', '--name-only', '--diff-filter=U']);
    await git(root, ['merge', '--abort']);
    return {
      merged: false,
      landedFiles,
      conflict: conflicts.stdout.trim() || into.stderr || into.stdout,
    };
  }

  // 3. Land the branch on the target, in the worktree that holds target.
  const targetDir = await worktreeForBranch(repo, target);
  let cleanup: (() => Promise<void>) | undefined;
  let dir: string;
  if (targetDir) {
    if (await isDirty(targetDir)) {
      return {
        merged: false,
        landedFiles,
        note: `target "${target}" worktree has uncommitted changes; not merging`,
      };
    }
    dir = targetDir;
  } else {
    const tmp = path.join(repo, '..', `.karmax-merge-${world.handle.id}`);
    if (fs.existsSync(tmp)) {
      await git(repo, ['worktree', 'remove', '--force', tmp]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    await gitOrThrow(repo, ['worktree', 'add', '--force', tmp, target]);
    dir = tmp;
    cleanup = async () => {
      await git(repo, ['worktree', 'remove', '--force', tmp]);
      fs.rmSync(tmp, { recursive: true, force: true });
    };
  }

  try {
    await ensureIdentity(dir);
    const land = await git(dir, [
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `karmax: merge ${branch} into ${target}`,
      branch,
    ]);
    if (land.code !== 0) {
      const conflicts = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
      await git(dir, ['merge', '--abort']);
      return { merged: false, landedFiles, conflict: conflicts.stdout.trim() || land.stderr || land.stdout };
    }
    const sha = await headSha(dir);
    return { merged: true, sha, landedFiles };
  } finally {
    await cleanup?.();
  }
}

/** Find the worktree path (if any) that currently has `branch` checked out. */
async function worktreeForBranch(repo: string, branch: string): Promise<string | undefined> {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  let curPath: string | undefined;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) curPath = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim(); // refs/heads/<branch>
      if (ref === `refs/heads/${branch}` && curPath) return curPath;
    }
  }
  return undefined;
}
