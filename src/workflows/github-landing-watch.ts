import { condition, continueAsNew, defineSignal, patched, proxyActivities, setHandler, isCancellation, workflowInfo } from '@temporalio/workflow';
import { msToNumber, type Duration } from '@temporalio/common';
import type { coreActivities } from '../activities/core.js';
import type { GitHubMergeAuthorization, WorldHandleLike, LandingAuthority } from './contract.js';
import { githubWatchDelayMs } from './contract.js';

const core = proxyActivities<Pick<coreActivities, 'mergeGithubPrs'>>({
  startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 },
});
interface LandingWatchInput {
  world: WorldHandleLike;
  previous: GitHubMergeAuthorization;
  authority: LandingAuthority;
  pollMs: number;
  wake?: boolean;
  /** Unchanged looks so far, carried across continue-as-new (backoff). */
  unchanged?: number;
  /** The tightest GitHub budget the last look saw (backoff). */
  budget?: GitHubMergeAuthorization['rateLimit'];
}

/** The task retains its state and leases. Only unchanged read-only polls rotate
 * history here; a changed result returns to the task's normal landing machine.
 * A webhook wakes it at once; between them it looks again after a delay that
 * doubles while nothing changes and waits out an almost spent GitHub hour
 * (githubWatchDelayMs). */
export async function githubLandingWatch(input: LandingWatchInput): Promise<GitHubMergeAuthorization> {
  const backoff = patched('github-landing-watch-backoff-v1');
  let wake = input.wake ?? false;
  let unchanged = input.unchanged ?? 0;
  let budget = input.budget;
  setHandler(defineSignal('providerChanged'), () => { wake = true; });
  const previous = JSON.stringify(input.previous);
  for (let polls = 0; polls < 100; polls++) {
    await condition(() => wake, backoff
      ? githubWatchDelayMs(msToNumber(input.pollMs as Duration), unchanged, Date.now(), budget) : input.pollMs);
    wake = false;
    let result: GitHubMergeAuthorization;
    try {
      result = await core.mergeGithubPrs(input.world as any, input.previous.prs, {
        mode: 'preflight', authority: input.authority, ...(backoff ? { rateBudget: true } : {}),
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      return { status: 'retryable-error', prs: input.previous.prs, detail: String(error) };
    }
    if (backoff) {
      const { rateLimit, ...observed } = result;
      budget = rateLimit;
      result = observed;
    }
    if (JSON.stringify(result) !== previous) return result;
    unchanged++;
    if (workflowInfo().continueAsNewSuggested || workflowInfo().historySize >= 10_000_000) break;
  }
  return continueAsNew<typeof githubLandingWatch>({ ...input, wake,
    ...(backoff ? { unchanged, ...(budget ? { budget } : {}) } : {}) });
}
