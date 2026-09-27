import { condition, continueAsNew, defineSignal, proxyActivities, setHandler, isCancellation, workflowInfo } from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import type { GitHubMergeAuthorization, WorldHandleLike, LandingAuthority } from './contract.js';

const core = proxyActivities<Pick<coreActivities, 'mergeGithubPrs'>>({
  startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 },
});
interface LandingWatchInput {
  world: WorldHandleLike;
  previous: GitHubMergeAuthorization;
  authority: LandingAuthority;
  pollMs: number;
  wake?: boolean;
}

/** The task retains its state and leases. Only unchanged read-only polls rotate
 * history here; a changed result returns to the task's normal landing machine. */
export async function githubLandingWatch(input: LandingWatchInput): Promise<GitHubMergeAuthorization> {
  let wake = input.wake ?? false;
  setHandler(defineSignal('providerChanged'), () => { wake = true; });
  const previous = JSON.stringify(input.previous);
  for (let polls = 0; polls < 100; polls++) {
    await condition(() => wake, input.pollMs);
    wake = false;
    let result: GitHubMergeAuthorization;
    try {
      result = await core.mergeGithubPrs(input.world as any, input.previous.prs, {
        mode: 'preflight', authority: input.authority,
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      return { status: 'retryable-error', prs: input.previous.prs, detail: String(error) };
    }
    if (JSON.stringify(result) !== previous) return result;
    if (workflowInfo().continueAsNewSuggested || workflowInfo().historySize >= 10_000_000) break;
  }
  return continueAsNew<typeof githubLandingWatch>({ ...input, wake });
}
