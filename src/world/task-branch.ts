import type { World, WorldRepo } from './types.js';
import { worldRepos, worldRepoTarget } from './types.js';

export interface TaskBranchAncestryResult {
  repaired: Array<{ repo: string; previousHead: string; head: string; baseSha: string; targetSha: string }>;
  errors: Record<string, string>;
}

/**
 * Verify that every task branch still contains the immutable commit from which
 * its world was provisioned. A recovery agent can accidentally replace the
 * branch with a clean tree based on a later-selected target; that tree may be
 * correct, but publishing it would discard the task's recorded custody chain.
 *
 * The one automatic repair is deliberately narrow. It is allowed only when:
 *  - the checkout is clean;
 *  - the selected target is an ancestor of the candidate branch; and
 *  - the selected target and recorded base belong to connected Git history.
 *
 * In that case a two-parent commit retains the candidate's exact tree while
 * reconnecting the provisioned base. No target-relative content changes and no
 * unrelated history can be admitted. Every other case fails closed for manual
 * repair; the publication broker's ancestry check remains authoritative.
 */
export async function ensureTaskBranchAncestry(
  world: World,
  liveTarget: string,
): Promise<TaskBranchAncestryResult> {
  const repaired: TaskBranchAncestryResult['repaired'] = [];
  const errors: Record<string, string> = {};
  const plans: Array<{ repo: WorldRepo; head: string; baseSha: string; targetSha: string }> = [];

  for (const repo of worldRepos(world.handle)) {
    if (!repo.baseSha) continue;
    const ref = `refs/heads/${repo.branch}`;
    const head = await world.exec('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repo.root });
    if (head.code !== 0) {
      errors[repo.name] = `task branch "${repo.branch}" is unavailable; restore that named branch before publishing`;
      continue;
    }
    const headSha = head.stdout.trim();
    const base = await world.exec('git', ['cat-file', '-e', `${repo.baseSha}^{commit}`], { cwd: repo.root });
    if (base.code !== 0) {
      errors[repo.name] = ancestryViolation(repo, 'its recorded base commit is no longer available in the checkout');
      continue;
    }
    const containsBase = await world.exec('git', ['merge-base', '--is-ancestor', repo.baseSha, ref], { cwd: repo.root });
    if (containsBase.code === 0) continue;

    const status = await world.exec('git', ['status', '--porcelain'], { cwd: repo.root });
    if (status.code !== 0 || status.stdout.trim()) {
      errors[repo.name] = ancestryViolation(repo,
        status.code === 0
          ? 'the checkout has uncommitted changes, so Karmax cannot safely repair its ancestry'
          : `the checkout could not be inspected: ${status.stderr || status.stdout}`);
      continue;
    }

    const target = worldRepoTarget(repo, liveTarget);
    const resolvedTarget = await resolveTarget(world, repo, target);
    if (!resolvedTarget) {
      errors[repo.name] = ancestryViolation(repo,
        `selected target "${target}" is not available locally; fetch it and merge it into the provisioned task branch`);
      continue;
    }
    const containsTarget = await world.exec('git', ['merge-base', '--is-ancestor', resolvedTarget, ref], { cwd: repo.root });
    if (containsTarget.code !== 0) {
      errors[repo.name] = ancestryViolation(repo,
        `the candidate does not descend from selected target "${target}" either; merge that target into the original task branch without resetting it`);
      continue;
    }
    const related = await world.exec('git', ['merge-base', repo.baseSha, resolvedTarget], { cwd: repo.root });
    if (related.code !== 0 || !related.stdout.trim()) {
      errors[repo.name] = ancestryViolation(repo,
        `selected target "${target}" has unrelated history; Karmax will not join the histories automatically`);
      continue;
    }
    const [candidateRoots, targetRoots] = await Promise.all([
      rootCommits(world, repo, ref),
      rootCommits(world, repo, resolvedTarget),
    ]);
    if (!candidateRoots || !targetRoots) {
      errors[repo.name] = ancestryViolation(repo, 'Karmax could not inspect the candidate history roots');
      continue;
    }
    const acceptedRoots = new Set(targetRoots);
    const foreignRoots = candidateRoots.filter((root) => !acceptedRoots.has(root));
    if (foreignRoots.length) {
      errors[repo.name] = ancestryViolation(repo,
        'the candidate contains history unrelated to the selected target; Karmax will not admit it through ancestry repair');
      continue;
    }
    plans.push({ repo, head: headSha, baseSha: repo.baseSha, targetSha: resolvedTarget });
  }

  // Validate every checkout before moving any branch. A multi-repository task
  // must never be half-repaired merely because a later checkout is unsafe.
  if (Object.keys(errors).length) return { repaired, errors };

  const prepared: Array<(typeof plans)[number] & { next: string }> = [];
  for (const plan of plans) {
    const { repo } = plan;
    const commit = await world.exec('git', [
      'commit-tree', `${plan.head}^{tree}`,
      '-p', plan.head,
      '-p', plan.baseSha,
      '-m', 'karmax: preserve provisioned task ancestry',
    ], { cwd: repo.root });
    if (commit.code !== 0 || !commit.stdout.trim()) {
      errors[repo.name] = ancestryViolation(repo,
        `Karmax could not create the content-neutral ancestry repair: ${commit.stderr || commit.stdout}`);
      break;
    }
    prepared.push({ ...plan, next: commit.stdout.trim() });
  }
  if (Object.keys(errors).length) return { repaired, errors };

  for (const plan of prepared) {
    const { repo } = plan;
    const ref = `refs/heads/${repo.branch}`;
    const updated = await world.exec('git', ['update-ref', ref, plan.next, plan.head], { cwd: repo.root });
    if (updated.code !== 0) {
      errors[repo.name] = ancestryViolation(repo,
        'the task branch moved while Karmax was checking it; inspect the concurrent change and retry');
      break;
    }
    repaired.push({ repo: repo.name, previousHead: plan.head, head: plan.next,
      baseSha: plan.baseSha, targetSha: plan.targetSha });
  }

  return { repaired, errors };
}

async function rootCommits(world: World, repo: WorldRepo, ref: string): Promise<string[] | undefined> {
  const roots = await world.exec('git', ['rev-list', '--max-parents=0', ref], { cwd: repo.root });
  if (roots.code !== 0) return undefined;
  return roots.stdout.split('\n').map((root) => root.trim()).filter(Boolean);
}

async function resolveTarget(world: World, repo: WorldRepo, target: string): Promise<string | undefined> {
  const candidates = target.startsWith('refs/') || /^[0-9a-f]{40,64}$/i.test(target)
    ? [target]
    : [`refs/heads/${target}`, `refs/remotes/origin/${target}`, target];
  for (const candidate of candidates) {
    const resolved = await world.exec('git', ['rev-parse', '--verify', `${candidate}^{commit}`], { cwd: repo.root });
    const sha = resolved.stdout.trim();
    if (resolved.code === 0 && /^[0-9a-f]{40,64}$/i.test(sha)) return sha;
  }
  return undefined;
}

function ancestryViolation(repo: WorldRepo, detail: string): string {
  const recorded = repo.baseSha ? repo.baseSha.slice(0, 12) : 'unknown';
  return `local recorded-base ancestry violation for branch "${repo.branch}" (base ${recorded}): ${detail}. `
    + 'Karmax did not publish this branch; reconnecting GitHub will not help. Preserve the initially provisioned HEAD as an ancestor, integrate the selected target normally, then retry.';
}
