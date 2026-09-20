import type { Store } from '../store/db.js';
import type { OriginPublicationRecorder } from './git-broker.js';

/** Recover the exact heads recorded by PR publication and cloud checkpoints.
 * A task may amend its checkpoint before opening its first PR, or rebase during
 * integration repair. Retain publication history across view replacement so a
 * force-with-lease can replace only that exact prior remote head. */
export async function expectedTaskRemoteHeads(store: Store, taskId: string): Promise<Record<string, string>> {
  const expected: Record<string, string> = {};
  const observations = [
    ...(await store.eventsOfType(taskId, 'pr.opened')),
    ...(await store.eventsOfType(taskId, 'pr.updated')),
    ...(await store.eventsOfType(taskId, 'push.head')),
  ].sort((a, b) => a.seq - b.seq);
  for (const event of observations) {
    const repo = typeof event.payload?.repo === 'string' ? event.payload.repo : '';
    const headSha = typeof event.payload?.headSha === 'string' ? event.payload.headSha : '';
    if (repo && /^[0-9a-f]{40}$/i.test(headSha)) expected[repo] = headSha;
  }
  for (const candidate of (await store.getTask(taskId))?.lastView?.prs ?? []) {
    if (candidate.headSha && !expected[candidate.repo]) expected[candidate.repo] = candidate.headSha;
  }
  return expected;
}

/** Publication can precede PR creation, including collaboration and handoff. */
export function recordTaskPublication(store: Store, taskId: string): OriginPublicationRecorder {
  return async (repo, headSha) => {
    (await store.appendEvent({ taskId, type: 'push.head', ts: Date.now(),
      payload: { repo: repo.name, branch: repo.branch, headSha } }));
  };
}
