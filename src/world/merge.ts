import path from 'node:path';
import fs from 'node:fs';
import { World, WorldRepo, worldRepos } from './types.js';
import { git, gitOrThrow, isDirty, ensureIdentity, headSha } from './git.js';

export interface MergeResult {
  merged: boolean;
  sha?: string;
  conflict?: string;
  landedFiles: string[];
  note?: string;
}

/**
 * The authoritative merge (SPEC §5.2 "Merge", the point of no return). For a
 * multi-repo world it merges every repo, each into `target`, aggregating the
 * landed files (prefixed by repo name) and stopping at the first conflict so the
 * merge agent can resolve it and re-run — repos that already landed re-merge as
 * no-ops, so the retry is safe (partial-merge recoverable, not atomic).
 */
export async function finalizeMerge(world: World, target: string): Promise<MergeResult> {
  const repos = worldRepos(world.handle);
  if (!repos.length) return { merged: false, landedFiles: [], note: 'no source repo (non-git world)' };
  if (repos.length === 1) return finalizeMergeRepo(repos[0]!, target, world.handle.id);

  const landedFiles: string[] = [];
  let sha: string | undefined;
  for (const r of repos) {
    const res = await finalizeMergeRepo(r, target, world.handle.id);
    landedFiles.push(...res.landedFiles.map((f) => `${r.name}/${f}`));
    if (!res.merged) {
      return {
        merged: false,
        landedFiles,
        conflict: res.conflict,
        note: `repo "${r.name}": ${res.note ?? (res.conflict ? 'merge conflict' : 'merge failed')}`,
      };
    }
    sha = res.sha;
  }
  return { merged: true, sha, landedFiles, note: `merged ${repos.length} repos into ${target}` };
}

/** Merge one repo's attempt branch into `target` (the per-repo primitive). */
async function finalizeMergeRepo(worldRepo: WorldRepo, target: string, worldId: string): Promise<MergeResult> {
  const root = worldRepo.root;
  const repo = worldRepo.repo;
  const branch = worldRepo.branch;
  const base = worldRepo.base;
  if (!repo) return { merged: false, landedFiles: [], note: 'no source repo (non-git world)' };

  await ensureIdentity(root);

  // 0. A merge-agent turn may have died (or given up) mid-`git merge`, leaving an
  //    in-progress merge with unresolved conflict hunks. Committing that state
  //    would COMPLETE the merge and land the conflict markers as file content —
  //    abort it and report the conflict so the merge agent gets another turn.
  const unresolved = await git(root, ['diff', '--name-only', '--diff-filter=U']);
  if (unresolved.stdout.trim()) {
    await git(root, ['merge', '--abort']);
    return {
      merged: false,
      landedFiles: [],
      conflict: unresolved.stdout.trim(),
      note: 'the worktree held an unresolved in-progress merge; aborted it',
    };
  }

  // 1. Commit any pending work on the attempt branch. (If the agent resolved a
  //    merge but forgot to commit — MERGE_HEAD present, everything staged, no
  //    unresolved paths — this completes that merge on purpose; the marker scan
  //    below still rejects anything that would land conflict hunks as content.)
  if (await isDirty(root)) {
    await git(root, ['add', '-A']);
    const c = await git(root, ['commit', '-q', '-m', `karmax: work for ${worldId}`]);
    if (c.code !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) {
      return { merged: false, landedFiles: [], note: `commit failed: ${c.stderr || c.stdout}` };
    }
  }

  // Files this attempt changed vs its base (for the landed-files report, and the
  // input to the conflict-marker guard below). When the configured base is absent
  // — world creation silently forks off HEAD instead (see worktree.ts) — the
  // `${base}...HEAD` diff would error and leave an EMPTY list, which both blanks
  // the landed-files report AND skips the marker scan (it early-returns on []).
  // Fall back to every file tracked at HEAD: over-inclusive for the report, but it
  // keeps the safety scan running rather than silently disabling it.
  const baseResolvable = (await git(root, ['rev-parse', '--verify', base])).code === 0;
  const changed = baseResolvable
    ? await git(root, ['diff', '--name-only', `${base}...HEAD`])
    : await git(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
  const landedFiles = changed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const baseNote = baseResolvable ? undefined : `base "${base}" not found — forked off HEAD; scanned all files at HEAD`;

  // 1b. Never land conflict markers as content: scan what this attempt changed.
  const marked = await conflictMarkerFiles(root, landedFiles);
  if (marked.length) {
    return {
      merged: false,
      landedFiles,
      conflict: marked.join('\n'),
      note: 'conflict markers are committed in the branch — resolve them and remove every marker',
    };
  }

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
    const tmp = path.join(repo, '..', `.karmax-merge-${worldId}-${worldRepo.name}`);
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
    return { merged: true, sha, landedFiles, note: baseNote };
  } finally {
    await cleanup?.();
  }
}

/**
 * Files (among `files`, at HEAD) that contain a `<<<<<<<`/`>>>>>>>` marker PAIR
 * at line start. Requiring both ends of the pair keeps files that legitimately
 * mention a single marker (docs, fixtures) from tripping the guard.
 */
async function conflictMarkerFiles(dir: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  const grep = async (pattern: string): Promise<Set<string>> => {
    const r = await git(dir, ['grep', '-l', '-E', pattern, 'HEAD', '--', ...files]);
    return new Set(
      r.stdout.split('\n').map((l) => l.replace(/^HEAD:/, '').trim()).filter(Boolean),
    );
  };
  const open = await grep('^<{7}( |$)');
  if (!open.size) return [];
  const close = await grep('^>{7}( |$)');
  return [...open].filter((f) => close.has(f));
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
