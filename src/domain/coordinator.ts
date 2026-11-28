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
/** The wait before the first retry of a failure: long enough for what its own
 * retries and Resolve could not clear, short enough not to leave a firm unrun. */
export const COORDINATOR_RETRY_FIRST_MINUTES = 15;
/** The longest wait between retries, so a co-ordinator that broke still comes back. */
export const COORDINATOR_RETRY_MAX_MINUTES = 7 * 24 * 60;

/** How long to wait before retrying, `failures` being how many times in a row
 * it has now failed: 15 minutes, doubling up to a week. Independent of the
 * check-in interval, which is about its work rather than its faults. */
export function coordinatorRetryMinutes(failures: number): number {
  return Math.min(COORDINATOR_RETRY_FIRST_MINUTES * 2 ** Math.max(0, failures - 1), COORDINATOR_RETRY_MAX_MINUTES);
}

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

/**
 * The co-ordinator's brief, added to its Do agent's system prompt: only what
 * the platform must keep true and current — its interval (editable at any
 * time), how it rests and wakes, how asking people works, and how its own pull
 * requests land. Its role and judgment are in its prompt, which people see and
 * may edit (`coordinatorRolePrompt`): editing that changes how it works, never
 * whether the workflow around it does.
 */
export function coordinatorBrief(setting: CoordinatorSetting, brand: string): string {
  const every = wakeIntervalText(setting.wakeHours);
  return `

# Permanent co-ordinator
This task never finishes. When your turn ends you rest, and ${brand} wakes you again within ${every} to check in — sooner when someone messages you, a sub-task needs you, or one of your pull requests needs a change. Call pause(minutes) only to come back sooner than your next check-in.
Ending your turn notifies nobody. When you need something only a person can give, use escalate_to_human (or pause with needs_input); notify people only when they must act. Messages people send you arrive as follow-ups.
Should you ever commit something yourself, open_pr(branch) opens that branch's pull request and open_pr() one for every branch with new work; neither ends this task.`;
}

/**
 * The role a co-ordinator starts with as its prompt (wiki features/coordinator
 * § Role prompt): fixed text, shown and editable like any prompt. A project's
 * CEO and a co-ordinator from the task form run a project; an organization's
 * CEO runs the organization; an autonomous organization's also makes its
 * projects run themselves.
 */
export type CoordinatorRoleKind = 'project' | 'organization' | 'autonomous-organization';
export const COORDINATOR_ROLE_KINDS: readonly CoordinatorRoleKind[] = ['project', 'organization', 'autonomous-organization'];
/** Bump whenever any role text below changes: prompts nobody edited take the new text. */
export const COORDINATOR_ROLE_VERSION = 1;

export function coordinatorRolePrompt(kind: CoordinatorRoleKind): string {
  const unit = kind === 'project' ? 'project' : 'organization';
  const job = kind === 'project'
    ? 'decide what matters most toward the project\'s goals, create tasks for it (create_task for independent work, create_sub_task for work you steer and await)'
    : 'decide what matters most toward the organization\'s goals, give each separate line of work a project (each has its own CEO, whom you start and steer), create tasks for what belongs to none (create_task, create_sub_task)';
  const lines = [
    `You are this ${unit}'s CEO: its permanent co-ordinator, the person in charge of an autonomous firm. Your job is not to do the ${unit}'s work yourself but to make sure it gets done: ${job}, give them what they need (authorizations, credentials, budget, context), follow their progress, answer and unblock them, review and redirect their work, and start what comes next. Don't wait to be told: act on the ${unit}'s behalf within your authority.`,
    `Your purpose is to run for as long as the ${unit} exists, without stopping: you are the one part of it that must always be there. At each check-in, read where things stand (list_tasks, search_tasks, the wiki, list_events), decide what changed, act, then end your turn. Keep the firm's plan, decisions and open threads in the ${unit} wiki (one page you update every check-in), so each check-in starts from it rather than from memory.`,
    'So don\'t make changes yourself. Anything that only takes effect once your own work is merged, deployed or this task restarted — code, configuration, tooling, even a fix to how you yourself work — would wait on you while you wait on it: put every such change in a task you create, and steer it from here. Your own world is for reading, planning and checking, not for shipping.',
    `What people ask of you arrives as messages: weigh each against the ${unit}'s goals and your plan, act on it, and record what it changes.`,
  ];
  if (kind === 'autonomous-organization') lines.push(AUTONOMOUS_ORGANIZATION_ROLE);
  return lines.join('\n\n');
}

/** What an autonomous organization's CEO adds to its role (wiki features/autonomy). */
export const AUTONOMOUS_ORGANIZATION_ROLE = 'Create a project for each separate line of work (POST /api/organizations/<this organization>/projects with {"name": …, "autonomous": true} sets one up to run itself, with its own co-ordinator you then start and steer), and keep a page in the organization wiki with the organization\'s plan and how each project stands.';

/**
 * Which default role text a co-ordinator's prompt is (`params._rolePrompt`,
 * platform metadata): its kind, the version it came from, and a hash of the
 * text, so a prompt anyone changed — by any route — is never taken for it.
 * While it holds, the platform may replace the prompt with a newer version of
 * the same text (`refreshedRolePrompt`); once someone edits it, it is theirs.
 */
export interface RolePromptMarker {
  kind: CoordinatorRoleKind;
  version: number;
  hash: string;
  /** Started before the role was its prompt: its conversation's first message
   *  is not this text, so the console shows the role above it. */
  outsideConversation?: true;
}
export const ROLE_PROMPT_PARAM = '_rolePrompt';

/** FNV-1a (32-bit) of a prompt, trimmed: an edit's fingerprint, not a secret. */
export function rolePromptHash(text: string): string {
  let hash = 0x811c9dc5;
  const value = text.trim();
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The marker a task's params carry, when it is well-formed. */
export function readRolePromptMarker(params: Record<string, unknown> | undefined): RolePromptMarker | undefined {
  const raw = params?.[ROLE_PROMPT_PARAM] as Partial<RolePromptMarker> | undefined;
  if (!raw || typeof raw !== 'object' || !COORDINATOR_ROLE_KINDS.includes(raw.kind as CoordinatorRoleKind)
    || typeof raw.version !== 'number' || typeof raw.hash !== 'string') return undefined;
  return { kind: raw.kind as CoordinatorRoleKind, version: raw.version, hash: raw.hash, ...(raw.outsideConversation ? { outsideConversation: true as const } : {}) };
}

/** The marker for a co-ordinator's prompt as it now reads: the current default
 * of some kind (preferring the one it had), still the very text it was marked
 * for, or none — someone wrote it. */
export function rolePromptMarkerFor(prompt: unknown, previous?: RolePromptMarker): RolePromptMarker | undefined {
  const text = String(prompt ?? '');
  const hash = rolePromptHash(text);
  const kinds = previous ? [previous.kind, ...COORDINATOR_ROLE_KINDS.filter((kind) => kind !== previous.kind)] : COORDINATOR_ROLE_KINDS;
  const keep = previous?.outsideConversation ? { outsideConversation: true as const } : {};
  for (const kind of kinds)
    if (rolePromptHash(coordinatorRolePrompt(kind)) === hash) return { kind, version: COORDINATOR_ROLE_VERSION, hash, ...keep };
  return previous && previous.hash === hash ? previous : undefined;
}

/** Whether a co-ordinator's prompt is still the platform's role text, untouched. */
export function untouchedRolePrompt(params: Record<string, unknown> | undefined): boolean {
  const marker = readRolePromptMarker(params);
  return !!marker && marker.hash === rolePromptHash(String(params?.prompt ?? ''));
}

/** A newer role text for a prompt nobody edited, or undefined (edited, or current). */
export function refreshedRolePrompt(params: Record<string, unknown> | undefined): { prompt: string; marker: RolePromptMarker } | undefined {
  const marker = readRolePromptMarker(params);
  if (!marker || !untouchedRolePrompt(params)) return undefined;
  const prompt = coordinatorRolePrompt(marker.kind);
  const hash = rolePromptHash(prompt);
  if (marker.version >= COORDINATOR_ROLE_VERSION && hash === marker.hash) return undefined;
  return { prompt, marker: { ...marker, version: COORDINATOR_ROLE_VERSION, hash } };
}

/**
 * What a co-ordinator's Do turn is told under "# Task": its prompt as stored
 * now, not as its run started — a role prompt nobody edited takes newer role
 * text while it runs (`refreshCoordinatorPrompts`); the prompt of a started
 * task is otherwise never edited, so the two are the same. One started before
 * the role was its prompt reads the role, then what it started with.
 */
export function coordinatorTurnPrompt(stored: Record<string, unknown> | undefined, started: string): string {
  const marker = readRolePromptMarker(stored);
  if (!marker || !untouchedRolePrompt(stored)) return started;
  const role = String(stored!.prompt ?? '');
  return marker.outsideConversation && started.trim() && started.trim() !== role.trim() ? `${role}\n\n${started}` : role;
}

/** What wakes a co-ordinator that rested its whole interval. */
export function coordinatorCheckIn(setting: CoordinatorSetting): string {
  return `(Check-in: it has been ${wakeIntervalText(setting.wakeHours)} since you stopped. Review where the project stands, act on what changed, then end your turn.)`;
}

/**
 * The CEO (wiki features/coordinator § CEOs): every project has a permanent
 * co-ordinator, and every organization one in its own project, its CEO
 * project. Each starts as a draft named for what it is, its role as its
 * prompt, and runs once someone starts it — or, for an organization's, on its
 * first Ask when the organization sends Ask there (the Ask is its first message).
 */
export type CeoScope = 'organization' | 'project';
/** The organization's own project, where its CEO (and its Asks) live. */
export const CEO_PROJECT_NAME = 'CEO';
/** What that project was called before it was the CEO project. */
export const LEGACY_CEO_PROJECT_NAME = 'Co-ordinator';
/** Project names (as slugs) only the CEO project may have. */
export const RESERVED_PROJECT_SLUGS: readonly string[] = ['ceo', 'co-ordinator', 'coordinator'];
export const ceoTitle = (scope: CeoScope): string =>
  scope === 'organization' ? 'CEO (Organization Co-ordinator)' : 'CEO (Project Co-ordinator)';
/** The project's CEO task, in the key-value store. */
export const CEO_KEY = (projectId: string): string => `ceo:project:${projectId}`;

/** Where the console's Ask goes in an organization: its CEO (`ceo`, the
 * default), or a quick task without a computer for each question (`task`). */
export type AskTarget = 'task' | 'ceo';
export const ASK_TARGETS: readonly AskTarget[] = ['task', 'ceo'];
/** Owner, 2026-11-25: Ask talks to the CEO unless the organization picks quick tasks. */
export const DEFAULT_ASK_TARGET: AskTarget = 'ceo';
/** Kept as `{ to }` in the organization's `ask` settings row: never `target`,
 * which is a shared task default (the target branch) the store files elsewhere. */
export const ASK_SETTINGS = 'ask';
export function askTarget(settings: Record<string, unknown> | undefined): AskTarget {
  return settings?.to === 'task' ? 'task' : settings?.to === 'ceo' ? 'ceo' : DEFAULT_ASK_TARGET;
}
