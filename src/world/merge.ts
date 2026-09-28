import { conflictMarkerFiles as scanConflictMarkers } from './conflict-markers.js';
import path from 'node:path';
import { validGitBranch } from '../util/git-ref.js';
import fs from 'node:fs';
import { World, WorldRepo, WorldGitIdentity, worldRepos, worldRepoTarget, orderCheckouts } from './types.js';
import { git, gitOrThrow, isDirty, ensureIdentity, headSha } from './git.js';
import { paths } from '../config/paths.js';
import { withWorktreeLock } from './worktree-lock.js';
import { serializeProjectWikiOperation } from '../wiki/repository.js';

/**
 * Where throwaway merge/landing worktrees are created: under karmax storage,
 * never as a sibling of the user's repository. A crash between `worktree add`
 * and the cleanup used to leave a `.karmax-merge-…` directory sitting in the
 * user's source tree, next to a repo karmax does not own.
 */
export function scratchWorktreeHome(): string {
  const dir = path.join(paths().worlds, '.merge-scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Per-invocation `-c` config for the profile identity (wiki plans/PLAN-git-config §4A):
 *  merge commits land in the TARGET's worktree (or a temp one), which carries no
 *  worktree-scoped profile config — inject it per command instead so those
 *  commits are attributed (and signed) exactly like the attempt's. */
function identityArgs(id?: WorldGitIdentity): string[] {
  if (!id) return [];
  const args = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`];
  if (id.signingKeyPath) args.push('-c', 'gpg.format=ssh', '-c', `user.signingKey=${id.signingKeyPath}`, '-c', 'commit.gpgsign=true');
  return args;
}

export interface MergeResult {
  merged: boolean;
  sha?: string;
  conflict?: string;
  /** Uncommitted paths that blocked the merge (newline-joined). Commit-vs-gitignore
   *  is a judgment call, so a dirty tree is rejected back to the task agent
   *  instead of being blind-swept (wiki plans/PLAN-git-config §6). */
  dirty?: string;
  landedFiles: string[];
  note?: string;
}

/**
 * The authoritative merge (SPEC §5.2 "Merge", the point of no return). For a
 * world with several checkouts — one per repo, and/or several branches of one
 * repo when the task's change is partitioned into several pull requests — it
 * merges every checkout into its target, aggregating the landed files (prefixed
 * by checkout name) and stopping at the first conflict so the task agent can
 * resolve it and re-run; checkouts that already landed re-merge as no-ops, so
 * the retry is safe (partial-merge recoverable, not atomic).
 *
 * Checkouts are merged in stack order (`orderCheckouts`), so a branch based on a
 * sibling lands after it and each pull request carries only its own change.
 */
export async function finalizeMerge(world: World, target: string, identity?: WorldGitIdentity): Promise<MergeResult> {
  const repos = orderCheckouts(worldRepos(world.handle));
  if (!repos.length) return { merged: false, landedFiles: [], note: 'no source repo (non-git world)' };
  if (repos.length === 1) return finalizeMergeRepo(repos[0]!, worldRepoTarget(repos[0]!, target), world.handle.id, identity);

  const landedFiles: string[] = [];
  // The reported commit is the one that landed in the world's primary repo (the
  // one task summaries name). The last repo merged is usually the project wiki
  // companion, whose untouched target would otherwise stand in for the task's.
  const primary = world.handle.repo ?? repos.find((r) => r.role !== 'project-wiki')?.repo;
  let sha: string | undefined;
  let primarySha: string | undefined;
  for (const r of repos) {
    const res = await finalizeMergeRepo(r, worldRepoTarget(r, target), world.handle.id, identity);
    landedFiles.push(...res.landedFiles.map((f) => `${r.name}/${f}`));
    if (!res.merged) {
      const label = r.role === 'project-wiki' ? `project wiki "${r.name}"` : `repo "${r.name}"`;
      return {
        merged: false,
        landedFiles,
        conflict: res.conflict,
        dirty: res.dirty ? res.dirty.split('\n').map((f) => `${r.name}/${f}`).join('\n') : undefined,
        note: `${label}: ${res.note ?? (res.conflict ? 'merge conflict' : 'merge failed')}`,
      };
    }
    sha = res.sha;
    if (r.repo === primary) primarySha = res.sha;
  }
  const targets = [...new Set(repos.map((repo) => worldRepoTarget(repo, target)))];
  return { merged: true, sha: primarySha ?? sha, landedFiles,
    note: targets.length === 1 ? `merged ${repos.length} repos into ${targets[0]}` : `merged ${repos.length} repos into their configured targets` };
}

/** Merge one repo's attempt branch into `target` (the per-repo primitive).
 *  Exported for the Git broker: a cloud world whose repo is authoritative to a
 *  host-local checkout lands through this exact machinery (same conflict/dirty
 *  guards, same target-worktree landing) after importing its branch bundle. */
export async function finalizeMergeRepo(worldRepo: WorldRepo, target: string, worldId: string, identity?: WorldGitIdentity): Promise<MergeResult> {
  const land = () => finalizeMergeRepoUnlocked(worldRepo, target, worldId, identity);
  return worldRepo.role === 'project-wiki' && worldRepo.repo
    ? serializeProjectWikiOperation(worldRepo.repo, land) : land();
}

async function finalizeMergeRepoUnlocked(worldRepo: WorldRepo, target: string, worldId: string, identity?: WorldGitIdentity): Promise<MergeResult> {
  // `target` is task input; as a positional git argument a leading `-` would be an option.
  if (!validGitBranch(target)) throw new Error(`invalid target branch "${target}"`);
  const root = worldRepo.root;
  const repo = worldRepo.repo;
  const branch = worldRepo.branch;
  const base = worldRepo.base;
  const asIdentity = identityArgs(identity);
  if (!repo) return { merged: false, landedFiles: [], note: 'no source repo (non-git world)' };

  if (!identity) await ensureIdentity(root);

  // 0. A merge-agent turn may have died (or given up) mid-`git merge`, leaving an
  //    in-progress merge with unresolved conflict hunks. Committing that state
  //    would COMPLETE the merge and land the conflict markers as file content —
  //    abort it and report the conflict so the task agent gets another turn.
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

  // 1. A dirty tree is the task agent's to resolve, never machinery's: commit-
  //    vs-gitignore is a judgment call, and a blind `git add -A` here would land
  //    files generated AFTER the Review gate (test artifacts, logs) unseen.
  //    Reject with the file list so the workflow loops back to the task agent
  //    (wiki plans/PLAN-git-config §6). One mechanical exception: a RESOLVED but
  //    uncommitted merge (MERGE_HEAD present; step 0 ruled out unresolved paths)
  //    is completed on purpose — that is a forgotten `git commit`, not a
  //    judgment call — and the marker scan below still rejects anything that
  //    would land conflict hunks as content.
  if (await isDirty(root)) {
    const mergeHead = (await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
    if (!mergeHead) {
      const st = await git(root, ['status', '--porcelain']);
      const dirty = st.stdout.split('\n').map((s) => s.slice(3).trim()).filter(Boolean).join('\n');
      return {
        merged: false,
        landedFiles: [],
        dirty,
        note: 'uncommitted changes in the worktree — commit what belongs in the change; gitignore or delete what does not',
      };
    }
    await git(root, ['add', '-A']);
    const c = await git(root, [...asIdentity, 'commit', '-q', '-m', `karmax: work for ${worldId}`]);
    if (c.code !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) {
      return { merged: false, landedFiles: [], note: `commit failed: ${c.stderr || c.stdout}` };
    }
  }

  // Files this attempt changed vs its base (for the landed-files report, and the
  // input to the conflict-marker guard below). When the configured base is absent
  // (e.g. a persisted world from before setup corrected missing bases), the
  // `${base}...HEAD` diff would error and leave an EMPTY list, which both blanks
  // the landed-files report AND skips the marker scan (it early-returns on []).
  // Fall back to every file tracked at HEAD: over-inclusive for the report, but it
  // keeps the safety scan running rather than silently disabling it.
  const baseResolvable = (await git(root, ['rev-parse', '--verify', base])).code === 0;
  const changed = baseResolvable
    ? await git(root, ['diff', '-z', '--name-only', `${base}...HEAD`])
    : await git(root, ['ls-tree', '-rz', '--name-only', 'HEAD']);
  if (changed.code !== 0) throw new Error(`could not list changed files: ${changed.stderr}`);
  const landedFiles = changed.stdout.split('\0').filter(Boolean);
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

  // A companion repo participates in every task world even when the task never
  // touched it (notably the project wiki). If its branch introduces no changes,
  // there is nothing to land: do not let unrelated, uncommitted work in that
  // repo's canonical checkout block changes in the other repos. The target's
  // committed ref is the comparison point, so this does not ignore actual task
  // work and does not inspect or mutate the dirty checkout.
  const unique = await git(repo, ['diff', '--quiet', `${target}...${branch}`]);
  if (unique.code === 0) {
    const targetSha = await git(repo, ['rev-parse', target]);
    return { merged: true, sha: targetSha.stdout.trim(), landedFiles, note: baseNote };
  }

  // 2. Bring the target into the branch so conflicts surface here (resolvable
  //    by the task agent in a prior turn). Abort + report on conflict.
  const into = await git(root, [
    ...asIdentity,
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
    // Two independent fixes, both needed: the scratch worktree lives under karmax
    // storage rather than beside the user's repo, AND add/remove is serialized so
    // a departing world cannot delete an arriving world's git plumbing.
    const tmp = path.join(scratchWorktreeHome(), `.karmax-merge-${worldId}-${worldRepo.name}`);
    await withWorktreeLock(repo, async () => {
      if (fs.existsSync(tmp)) {
        await git(repo, ['worktree', 'remove', '--force', tmp]);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      await gitOrThrow(repo, ['worktree', 'add', '--force', tmp, target]);
    });
    dir = tmp;
    cleanup = async () => {
      await withWorktreeLock(repo, () => git(repo, ['worktree', 'remove', '--force', tmp]));
      fs.rmSync(tmp, { recursive: true, force: true });
    };
  }

  try {
    if (!identity) await ensureIdentity(dir);
    const land = await git(dir, [
      ...asIdentity,
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
  return scanConflictMarkers(args => git(dir, args), 'HEAD', files);
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
