import { proxyActivities, condition, CancellationScope, isCancellation } from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import type { AgentWait, TaskView, WorldHandleLike } from './contract.js';

/**
 * The Do-stage half of the agent's `pause` tool (and of `start_job` jobs a turn
 * left running): park the task, then resume the agent when its jobs exit, when
 * the time is up, or when something else needs it — a message, a child event,
 * a cancellation. Shared by software-dev and just-do.
 *
 * The job watch is ONE heartbeating activity, not a workflow polling loop, so
 * a wait of hours or days adds a handful of history events. It survives worker
 * restarts (Temporal retries it; it re-reads the job files in the world).
 */

const jobWatch = proxyActivities<coreActivities>({
  // Beyond the longest wait (a week): the activity returns at `untilMs` itself.
  startToCloseTimeout: '8 days',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 10, initialInterval: '10s', backoffCoefficient: 2, maximumInterval: '5 minutes' },
});

/** How long to wait for jobs a turn left running without calling `pause`. */
export const IMPLICIT_JOB_WAIT_MINUTES = 60;

/** The wait a finished turn asks for, if any: an explicit `pause`, or the jobs
 * it started and left running without opening a PR or raising to its parent. */
export function requestedWait(turn: {
  wait?: AgentWait; runningJobs?: string[]; openPrRequested?: boolean; raise?: unknown;
}): { wait: AgentWait; implicit: boolean } | undefined {
  if (turn.wait) return { wait: turn.wait, implicit: false };
  if (turn.runningJobs?.length && !turn.openPrRequested && !turn.raise)
    return { wait: { minutes: IMPLICIT_JOB_WAIT_MINUTES, jobs: turn.runningJobs }, implicit: true };
  return undefined;
}

export interface AgentWaitHooks {
  world: WorldHandleLike | undefined;
  /** Length of one minute (ms); only tests shorten it. */
  minuteMs?: number;
  /** Record the wait in the task view (status `waiting`) and publish it. */
  park(waitingFor: NonNullable<TaskView['waitingFor']>): Promise<void>;
  /** Something other than the wait itself needs the agent (or the task was cancelled). */
  interrupted(): boolean;
}

/**
 * Park until the wait is over. Returns the note to resume the agent with, or
 * undefined when it was interrupted by something that brings its own message.
 */
export async function waitForAgent(request: { wait: AgentWait; implicit: boolean }, hooks: AgentWaitHooks): Promise<string | undefined> {
  const { wait, implicit } = request;
  const untilMs = Date.now() + wait.minutes * (hooks.minuteMs ?? 60_000);
  const jobs = wait.jobs ?? [];
  const list = jobs.join(', ');
  await hooks.park(jobs.length
    ? { kind: 'job', detail: `Waiting for ${list}`, until: untilMs }
    : { kind: 'timer', detail: `Paused for ${wait.minutes} min`, until: untilMs });

  if (!jobs.length) {
    const interrupted = await condition(hooks.interrupted, untilMs - Date.now());
    return interrupted ? undefined : `(Resumed: your ${wait.minutes}-minute pause is over.)`;
  }
  const intro = implicit
    ? `(You ended your turn while ${list} ${jobs.length > 1 ? 'were' : 'was'} still running, so the task waited for ${jobs.length > 1 ? 'them' : 'it'}.`
    : '(Resumed:';
  if (!hooks.world) return `${intro} the task has no world to check the jobs in.)`;

  let outcome: { finished: boolean; summary: string } | undefined;
  let failure: unknown;
  let settled = false;
  const scope = new CancellationScope();
  const watching = scope.run(() => jobWatch.awaitJobs(hooks.world as any, jobs, untilMs)).then(
    (result) => { outcome = result; },
    (error) => { if (!isCancellation(error)) failure = error; },
  ).finally(() => { settled = true; });
  await condition(() => settled || hooks.interrupted());
  if (!settled) {
    scope.cancel();
    await watching;
    return `(Your wait for ${list} was interrupted by the message above; ${jobs.length > 1 ? 'they may still be running' : 'it may still be running'}. Call pause again to keep waiting.)`;
  }
  if (!outcome) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    return `${intro} the task could not check on ${list}: ${reason.slice(0, 300)}. ${jobs.length > 1 ? 'They' : 'It'} may still be running; each log is in .karmax-injection/jobs/<id>/log.)`;
  }
  const head = outcome.finished
    ? implicit ? `${intro})` : `(Resumed: ${jobs.length > 1 ? 'your jobs have' : 'your job has'} finished.)`
    : implicit
      ? `${intro} It gave up after ${wait.minutes} min. Call pause with a longer limit if you still need the result.)`
      : `(Resumed: your ${wait.minutes}-minute limit passed before ${jobs.length > 1 ? 'every job finished' : 'the job finished'}. Call pause again to keep waiting.)`;
  return `${head}\n\n${outcome.summary}`;
}
