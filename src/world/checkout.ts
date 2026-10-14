import path from 'node:path';
import { World, WorldCheckoutSpec, WorldHandle, WorldRepo, worldRepos } from './types.js';

/**
 * The multi-PR primitive, shared by every backend (SPEC §11.1 `addCheckout`).
 *
 * A `WorldRepo` is already `(source repo, directory, branch, base, target)` —
 * which is exactly a pull request — and merge, the PR stage and the merge-queue
 * domains all iterate them. So adding a branch to a task is adding a checkout,
 * and the only thing that differs between backends is WHERE the git commands
 * run: the local provider runs them on the host, every container/remote provider
 * runs them inside the sandbox through `exec`. Both drive `addCheckoutWith`.
 */

export interface CheckoutOps {
  git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Clear a stale path so `git worktree add` cannot trip over it. */
  removeDir(absPath: string): Promise<void>;
}

/** Legal checkout name: also a directory name and a branch-name fragment. */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Validate a requested checkout against the world's existing ones and resolve
 * it into the `WorldRepo` it will become. Pure — every backend shares these
 * rules, and the failures are the ones an agent can act on.
 */
export function planCheckout(handle: WorldHandle, spec: WorldCheckoutSpec): { from: WorldRepo; added: WorldRepo } {
  const repos = worldRepos(handle);
  const name = spec.name?.trim() ?? '';
  if (!NAME.test(name)) {
    throw new Error(`invalid checkout name "${spec.name}" — use letters, digits, "-", "_" or "."`);
  }
  if (repos.some((r) => r.name === name)) throw new Error(`checkout "${name}" already exists in this world`);
  // A flat world root IS a checkout's working tree, so a sibling could only go
  // inside it (where the first checkout's git would see it) or outside the world
  // boundary (breaking file/PTY confinement). The layout is chosen at Setup, so
  // this is a configuration error rather than something to paper over here.
  if (repos.some((r) => r.root === handle.root)) {
    throw new Error('this world has a flat layout, so it can hold only one checkout —'
      + ' create it with layout "nested" to allow several branches');
  }

  const from = spec.from ? repos.find((r) => r.name === spec.from) : repos[0];
  if (!from) {
    throw new Error(spec.from ? `no checkout named "${spec.from}" to branch from` : 'this world has no checkout to branch from');
  }
  const branch = spec.branch?.trim() || `${handle.branch}-${name}`;
  if (repos.some((r) => r.branch === branch)) throw new Error(`branch "${branch}" is already checked out in this world`);
  // A base naming a SIBLING checkout is a stacked pull request: record that
  // sibling's BRANCH as the base, so both the merge ordering (orderCheckouts)
  // and the landed-file diff read the stack off plain handle data.
  const sibling = spec.base ? repos.find((r) => r.name === spec.base) : undefined;
  const base = sibling ? sibling.branch : (spec.base?.trim() || from.base);

  const added: WorldRepo = {
    name,
    repo: from.repo,
    ...(from.source ? { source: from.source } : {}),
    ...(from.localPath ? { localPath: from.localPath } : {}),
    ...(from.sourceAuthority ? { sourceAuthority: from.sourceAuthority } : {}),
    root: path.posix.join(handle.root, name),
    branch,
    base,
    ...(spec.target ?? from.target ? { target: spec.target ?? from.target } : {}),
    targetPinned: spec.target ? true : from.targetPinned,
  };
  return { from, added };
}

/**
 * Create the planned checkout and return the world handle that now contains it.
 * `after` lets a backend carry over anything git config does not inherit by
 * itself (the local provider's worktree-scoped identity and node_modules link).
 */
export async function addCheckoutWith(
  handle: WorldHandle,
  spec: WorldCheckoutSpec,
  ops: CheckoutOps,
  after?: (from: WorldRepo, added: WorldRepo) => Promise<void>,
): Promise<WorldHandle> {
  const { from, added } = planCheckout(handle, spec);

  // Run git from the source checkout: `git worktree add` operates on the common
  // repository, so this works whether that checkout is a linked worktree (local)
  // or a plain clone (sandbox) — which is what lets the two backends share this.
  if ((await ops.git(from.root, ['rev-parse', '--verify', added.base])).code !== 0) {
    throw new Error(`base "${added.base}" does not exist in repo "${from.name}"`);
  }
  await ops.git(from.root, ['worktree', 'remove', '--force', added.root]);
  await ops.removeDir(added.root);
  await ops.git(from.root, ['worktree', 'prune']);

  const exists = (await ops.git(from.root, ['rev-parse', '--verify', added.branch])).code === 0;
  const add = await ops.git(from.root, exists
    ? ['worktree', 'add', added.root, added.branch]
    : ['worktree', 'add', '-b', added.branch, added.root, added.base]);
  if (add.code !== 0) {
    throw new Error(`could not check out "${added.name}": ${add.stderr || add.stdout}`);
  }
  await after?.(from, added);

  return { ...handle, repos: [...worldRepos(handle), added] };
}

/**
 * `addCheckout` for every backend whose repos live inside the world and whose
 * only handle on them is `exec` — container, E2B, Daytona. Their provisioning
 * already leaves a real clone per repo in the sandbox, so a branch is one
 * `git worktree add` in there, and the sandbox clone's repo-scoped git config
 * (identity, signing) is inherited by the new checkout for free.
 */
export async function addCheckoutViaExec(world: World, spec: WorldCheckoutSpec): Promise<WorldHandle> {
  const ops: CheckoutOps = {
    git: (cwd, args) => world.exec('git', args, { cwd }),
    removeDir: async (absPath) => { await world.exec('rm', ['-rf', absPath], { cwd: world.handle.root }); },
  };
  const next = await addCheckoutWith(world.handle, spec, ops);
  world.handle = next;
  return next;
}
