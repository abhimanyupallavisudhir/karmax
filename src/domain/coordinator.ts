import { ValidationError } from '../platform/errors.js';

/**
 * A permanent co-ordinator (`params.coordinator`, wiki features/coordinator):
 * a task whose agent runs its project like the head of an autonomous firm. It
 * creates and steers other tasks, lands its own changes branch by branch (never
 * the task-finishing proposal), never finishes, and is woken again at most
 * `wakeHours` after it stops — and a failure of it is a critical ask.
 *
 * Pure: read by the platform, the deterministic workflow and the store alike.
 */
export interface CoordinatorSetting {
  /** The longest it rests after it stops before it checks in again (hours; decimals allowed). */
  wakeHours: number;
}

export const DEFAULT_COORDINATOR_WAKE_HOURS = 24;
/** One minute: a shorter rest would only spin the agent. */
export const MIN_COORDINATOR_WAKE_HOURS = 1 / 60;
/** A year: the bound of a sensible check-in. */
export const MAX_COORDINATOR_WAKE_HOURS = 24 * 365;

/** The setting a task's params carry, normalized; absent: not a co-ordinator.
 * Lenient, for readers of stored params (an invalid stored interval falls back
 * to the default rather than stopping a running co-ordinator). */
export function coordinatorSetting(params: Record<string, unknown> | undefined): CoordinatorSetting | undefined {
  const raw = params?.coordinator;
  if (raw === undefined || raw === null || raw === false) return undefined;
  const hours = typeof raw === 'object' && !Array.isArray(raw) ? Number((raw as { wakeHours?: unknown }).wakeHours) : NaN;
  return { wakeHours: validHours(hours) ? hours : DEFAULT_COORDINATOR_WAKE_HOURS };
}

/** Validate a caller's `params.coordinator`: `true` (the default interval) or
 * `{ wakeHours }`. Null when it is not one. */
export function normalizeCoordinatorSetting(raw: unknown): CoordinatorSetting | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return { wakeHours: DEFAULT_COORDINATOR_WAKE_HOURS };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('coordinator must be { wakeHours }');
  const value = (raw as { wakeHours?: unknown }).wakeHours;
  if (value === undefined || value === null || value === '') return { wakeHours: DEFAULT_COORDINATOR_WAKE_HOURS };
  const hours = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof hours !== 'number' || !validHours(hours))
    throw new ValidationError(`coordinator.wakeHours must be a number of hours from 1 minute (${+MIN_COORDINATOR_WAKE_HOURS.toFixed(4)}) to ${MAX_COORDINATOR_WAKE_HOURS}`);
  return { wakeHours: hours };
}

function validHours(hours: number): boolean {
  return Number.isFinite(hours) && hours >= MIN_COORDINATOR_WAKE_HOURS - 1e-9 && hours <= MAX_COORDINATOR_WAKE_HOURS;
}

/** "24 hours", "1.5 hours", "30 minutes": how a check-in interval is said. */
export function wakeIntervalText(hours: number): string {
  if (hours < 1) {
    const minutes = Math.round(hours * 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const rounded = +hours.toFixed(2);
  return `${rounded} hour${rounded === 1 ? '' : 's'}`;
}

/** The co-ordinator's brief, added to its Do agent's system prompt. */
export function coordinatorBrief(setting: CoordinatorSetting, brand: string): string {
  const every = wakeIntervalText(setting.wakeHours);
  return `

# Your role: permanent co-ordinator
You are this project's permanent co-ordinator — the person in charge of an autonomous firm, its CEO. Your job is not to do the project's work yourself but to make sure it gets done: decide what matters most toward the goals above, create tasks for it (create_task for independent work, create_sub_task for work you steer and await), give them what they need (authorizations, credentials, budget, context), follow their progress, answer and unblock them, review and redirect their work, and start what comes next. Don't wait to be told: act on the project's behalf within your authority.
This task never finishes. When your turn ends you rest, and ${brand} wakes you again within ${every} to check in — sooner when someone messages you, a sub-task needs you, or one of your pull requests needs a change. At each check-in: read where things stand (list_tasks, search_tasks, the wiki, list_events), decide what changed, act, then end your turn. Keep the firm's plan, decisions and open threads in the project wiki (one page you update every check-in), so each check-in starts from it rather than from memory.
Ending your turn notifies nobody. When you need something only a person can give, use escalate_to_human (or pause with needs_input); notify people only when they must act. Call pause(minutes) only to come back sooner than your next check-in.
Your own changes land branch by branch: open_pr(branch) opens that branch's pull request now, and open_pr() opens one for every branch with new work. Neither ends this task.`;
}

/** What wakes a co-ordinator that rested its whole interval. */
export function coordinatorCheckIn(setting: CoordinatorSetting): string {
  return `(Check-in: it has been ${wakeIntervalText(setting.wakeHours)} since you stopped. Review where the project stands, act on what changed, then end your turn.)`;
}
