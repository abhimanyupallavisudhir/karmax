import { proxyActivities, condition, CancellationScope, isCancellation } from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import type { AgentWait, HumanAudience, TaskView, Urgency, WorldHandleLike } from './contract.js';

/**
 * The Do-stage half of the agent's `pause` tool: park the task, then resume the agent when its jobs exit, when
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

/** Durable jobs a turn started and left running, without pausing for them,
 * opening a PR, or raising to its parent. The task never waits on these on its
 * own — the job may be runaway or deliberately long-lived — but the agent is
 * reminded once (only the turn that started a job reports it), so a result it
 * meant to come back for is not silently dropped. */
export function unattendedJobsReminder(turn: {
  wait?: AgentWait; runningJobs?: string[]; openPrRequested?: boolean; raise?: unknown;
}): string | undefined {
  const jobs = turn.runningJobs ?? [];
  if (turn.wait || !jobs.length || turn.openPrRequested || turn.raise) return undefined;
  const list = jobs.join(', ');
  const one = jobs.length === 1;
  return `Your turn ended while ${list} ${one ? 'is' : 'are'} still running. If you need ${one ? 'its' : 'their'} result, call pause with ${one ? 'it' : 'them'} and a time limit, then end your turn. If ${one ? 'it is' : 'they are'} no longer needed, stop ${one ? 'it' : 'them'} with stop_job. Otherwise finish, and say why ${one ? 'it keeps' : 'they keep'} running.`;
}

export interface AgentWaitHooks {
  world: WorldHandleLike | undefined;
  /** For a `needsInput` pause: whom the workflow asked — people, or a
   * sub-task's parent agent — resolved from the agent's request and the
   * task's input route. */
  ask?: { kind: 'human'; audience: HumanAudience; detail: string; urgency?: Urgency }
    | { kind: 'parent'; detail: string };
  /** Length of one minute (ms); only tests shorten it. */
  minuteMs?: number;
  /** Record the wait in the task view (status `waiting`) and publish it. */
  park(waitingFor: NonNullable<TaskView['waitingFor']>): Promise<void>;
  /** Something other than the wait itself needs the agent (or the task was cancelled). */
  interrupted(): boolean;
  /** Work the task can do while the agent stays paused (software-dev ≥1.27:
   * other agents called meanwhile). `serve` runs it and restores the wait's
   * view; the wait then carries on unless that work interrupted it. */
  serveable?(): boolean;
  serve?(): Promise<void>;
}

/**
 * Park until the wait is over. Returns the note to resume the agent with, or
 * undefined when it was interrupted by something that brings its own message.
 */
export async function waitForAgent(wait: AgentWait, hooks: AgentWaitHooks): Promise<string | undefined> {
  const untilMs = Date.now() + wait.minutes * (hooks.minuteMs ?? 60_000);
  const jobs = wait.jobs ?? [];
  const list = jobs.join(', ');
  // A wait is shown by what it waits for: the jobs' names when every one has one.
  const named = jobs.length && wait.jobNames?.length === jobs.length ? wait.jobNames.join(', ') : undefined;
  // An ask is what the task is waiting on, whatever else the agent watches:
  // it reads Needs input (or names the parent) and notifies, where a timer or
  // job wait does neither.
  await hooks.park(hooks.ask
    ? { ...hooks.ask, ...(jobs.length ? { jobs } : {}), until: untilMs }
    : jobs.length
    ? { kind: 'job', detail: `Waiting for ${list}`, ...(named ? { summary: named } : {}), jobs, until: untilMs }
    : { kind: 'timer', detail: `Waiting ${wait.minutes} min`, until: untilMs });

  const serveable = () => !!hooks.serve && !!hooks.serveable?.();
  if (!jobs.length) {
    let interrupted: boolean;
    for (;;) {
      interrupted = await condition(() => hooks.interrupted() || serveable(), Math.max(0, untilMs - Date.now()));
      if (!interrupted || hooks.interrupted() || !serveable()) break;
      await hooks.serve!();
    }
    if (interrupted) return undefined;
    return hooks.ask
      ? `(Resumed: nobody answered within your ${wait.minutes}-minute limit. Carry on without the answer, or pause again to keep waiting.)`
      : `(Resumed: your ${wait.minutes}-minute pause is over.)`;
  }
  const world = hooks.world;
  if (!world) return '(Resumed: the task has no world to check the jobs in.)';

  let outcome: { finished: boolean; summary: string } | undefined;
  let failure: unknown;
  let settled = false;
  const scope = new CancellationScope();
  const watching = scope.run(() => jobWatch.awaitJobs(world, jobs, untilMs)).then(
    (result) => { outcome = result; },
    (error) => { if (!isCancellation(error)) failure = error; },
  ).finally(() => { settled = true; });
  for (;;) {
    await condition(() => settled || hooks.interrupted() || serveable());
    if (settled || hooks.interrupted()) break;
    await hooks.serve!();
  }
  if (!settled) {
    scope.cancel();
    await watching;
    return `(Your wait for ${list} was interrupted by the message above; ${jobs.length > 1 ? 'they may still be running' : 'it may still be running'}. Call pause again to keep waiting.)`;
  }
  if (!outcome) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    return `(Resumed: the task could not check on ${list}: ${reason.slice(0, 300)}. ${jobs.length > 1 ? 'They' : 'It'} may still be running; each log is in .karmax-injection/jobs/<id>/log.)`;
  }
  const head = outcome.finished
    ? `(Resumed: ${jobs.length > 1 ? 'your jobs have' : 'your job has'} finished.)`
    : `(Resumed: your ${wait.minutes}-minute limit passed before ${jobs.length > 1 ? 'every job finished' : 'the job finished'}${hooks.ask ? ' or anyone answered' : ''}. Call pause again to keep waiting.)`;
  return `${head}\n\n${outcome.summary}`;
}
