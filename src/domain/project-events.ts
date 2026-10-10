/**
 * Project events — the durable inbox of things that happened outside a task
 * (wiki planned/external-connectors-and-automations). A GitHub delivery, an
 * incoming webhook, a chat mention or an event a task emitted all become one
 * `ProjectEvent`; an armed task whose `event` trigger matches it starts a run
 * that receives the event.
 *
 * PURE (no Node/Temporal imports) like `triggers.ts`, which imports the filter
 * and template helpers below: the same matching runs in the dispatcher, the API
 * (validation) and the browser preview, and is cheap to unit-test.
 */

import { untrustedBlock } from './untrusted.js';

/** Who caused an event. `self` is an outside system echoing tavya's own action
 *  (a label its GitHub App added); triggers ignore those unless they opt in. */
export type ProjectEventOrigin = 'external' | 'self' | 'task';

export interface ProjectEvent {
  id: string;
  organizationId: string;
  projectId: string;
  /** `github`, `webhook:<id>`, `task:<series or task id>`, `user:<id>`, … */
  source: string;
  /** Dotted event type, e.g. `github.issues.labeled`. */
  type: string;
  /** Delivery key, unique per (project, source): repeats of one occurrence collapse. */
  key: string;
  /** Human link or label for what the event is about (an issue URL). */
  subject?: string;
  occurredAt: number;
  receivedAt: number;
  payload: Record<string, unknown>;
  origin: ProjectEventOrigin;
  /** How many event→run→emit steps led here; bounded to stop loops. */
  hops: number;
}

/** What one event did for one armed task. `pending`: a run is being started
 *  (or told); `started`: it started `runId`; `told`: it went to the unfinished
 *  run `runId` as a message; `deferred`: waiting (dependencies, a queued
 *  concurrency slot, the hourly limit, or a failed start); `skipped`: never will. */
export type ProjectEventClaimState = 'pending' | 'started' | 'told' | 'deferred' | 'skipped';

export interface ProjectEventClaim {
  eventId: string;
  taskId: string;
  state: ProjectEventClaimState;
  reason?: string;
  runId?: string;
  /** '' = the series-wide slot. */
  concurrencyKey?: string;
  /** The event's receipt time: claims are retried oldest event first. */
  receivedAt: number;
  updatedAt: number;
}

/** What a run started by an event carries (`params.trigger`). */
export interface TriggerContext {
  eventId: string;
  source: string;
  type: string;
  key: string;
  subject?: string;
  receivedAt: number;
  hops: number;
  payload: Record<string, unknown>;
  /** Rendered concurrency key, when the trigger declares one. */
  concurrencyKey?: string;
}

export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
export const MAX_EVENT_HOPS = 8;
export const EVENT_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const DEFAULT_MAX_RUNS_PER_HOUR = 60;
const MAX_TYPE_LENGTH = 200;
const MAX_KEY_LENGTH = 300;
const MAX_SUBJECT_LENGTH = 2000;
const PROMPT_PAYLOAD_CHARS = 24_000;
const TITLE_CHARS = 200;

// ─── Filters ─────────────────────────────────────────────────────────────────

export type FilterLiteral = string | number | boolean | null;
/** A `where` value: a literal (equality) or exactly one operator. */
export type FilterValue =
  | FilterLiteral
  | { in: FilterLiteral[] }
  | { contains: string }
  | { matches: string }
  | { exists: boolean };

export type EventFilter = Record<string, FilterValue>;

const OPERATORS = ['in', 'contains', 'matches', 'exists'] as const;

/**
 * Every value at a dotted path. Crossing an array fans out over its elements,
 * so `issue.labels.name` reaches each label's name and a filter matches when
 * any of them does. An exact top-level key wins over path splitting, so a
 * payload key that itself contains a dot stays addressable.
 */
export function valuesAtPath(root: unknown, path: string): unknown[] {
  if (root && typeof root === 'object' && !Array.isArray(root) && Object.hasOwn(root, path))
    return [(root as Record<string, unknown>)[path]];
  let current: unknown[] = [root];
  for (const segment of path.split('.')) {
    const next: unknown[] = [];
    for (const value of current) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item && typeof item === 'object' && !Array.isArray(item) && Object.hasOwn(item, segment))
          next.push((item as Record<string, unknown>)[segment]);
      }
    }
    current = next;
    if (!current.length) return [];
  }
  return current.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

function isOperator(value: FilterValue): value is Exclude<FilterValue, FilterLiteral> {
  return !!value && typeof value === 'object';
}

/** Does one filter entry hold for a payload? */
export function filterEntryMatches(payload: unknown, path: string, expected: FilterValue): boolean {
  const values = valuesAtPath(payload, path);
  if (!isOperator(expected)) return values.some((value) => value === expected);
  if ('exists' in expected) return (values.length > 0 && values.some((v) => v !== null && v !== undefined)) === expected.exists;
  if ('in' in expected) return values.some((value) => expected.in.includes(value as FilterLiteral));
  if ('contains' in expected) {
    const needle = expected.contains.toLowerCase();
    return values.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
  }
  if ('matches' in expected) {
    const pattern = compilePattern(expected.matches);
    return !!pattern && values.some((value) => typeof value === 'string' && pattern.test(value));
  }
  return false;
}

export function filterMatches(payload: unknown, where: EventFilter | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([path, expected]) => filterEntryMatches(payload, path, expected));
}

/** Case-insensitive, and refused (rather than thrown) when invalid. */
function compilePattern(source: string): RegExp | undefined {
  if (source.length > 500) return undefined;
  try { return new RegExp(source, 'i'); } catch { return undefined; }
}

/** Human-readable problems with a filter (empty ⇒ valid). */
export function validateFilter(where: unknown): string[] {
  if (where === undefined) return [];
  if (!where || typeof where !== 'object' || Array.isArray(where)) return ['`where` must be an object of path → value'];
  const errors: string[] = [];
  for (const [path, value] of Object.entries(where as Record<string, unknown>)) {
    if (!path.trim()) { errors.push('a filter path is empty'); continue; }
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) continue;
    if (typeof value !== 'object' || Array.isArray(value)) { errors.push(`filter "${path}" must be a value or an operator`); continue; }
    const keys = Object.keys(value as object);
    const op = keys[0] as (typeof OPERATORS)[number];
    if (keys.length !== 1 || !OPERATORS.includes(op)) {
      errors.push(`filter "${path}" takes exactly one of ${OPERATORS.join(', ')}`);
      continue;
    }
    const arg = (value as Record<string, unknown>)[op];
    if (op === 'in' && !(Array.isArray(arg) && arg.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))))
      errors.push(`filter "${path}": \`in\` needs a list of values`);
    if (op === 'contains' && typeof arg !== 'string') errors.push(`filter "${path}": \`contains\` needs text`);
    if (op === 'exists' && typeof arg !== 'boolean') errors.push(`filter "${path}": \`exists\` needs true or false`);
    if (op === 'matches' && (typeof arg !== 'string' || !compilePattern(arg)))
      errors.push(`filter "${path}": \`matches\` needs a valid regular expression`);
  }
  return errors;
}

// ─── Types and sources ───────────────────────────────────────────────────────

/** `github.issues.*` matches `github.issues.labeled`; `*` alone matches any type. */
export function eventTypeMatches(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

/** `webhook` matches `webhook:abc`; an exact source matches itself. */
export function eventSourceMatches(pattern: string | undefined, source: string): boolean {
  if (!pattern) return true;
  return source === pattern || source.startsWith(`${pattern}:`);
}

export function validEventType(type: unknown): type is string {
  return typeof type === 'string' && type.length > 0 && type.length <= MAX_TYPE_LENGTH
    && /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*$/i.test(type);
}

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * Replace each `{{path}}` with the first value at that path, as plain text.
 * Only titles and concurrency keys are templated — never a prompt or a command,
 * where outside text would become instructions or shell.
 */
export function renderTemplate(template: string, payload: unknown, maxChars = TITLE_CHARS): string {
  const out = template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_match, path: string) => {
    const value = valuesAtPath(payload, path)[0];
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
  return out.replace(/[\r\n\t]+/g, ' ').slice(0, maxChars);
}

export function hasTemplate(text: string | undefined): boolean {
  return !!text && /\{\{\s*[^{}\s]+\s*\}\}/.test(text);
}

// ─── Normalization ───────────────────────────────────────────────────────────

export interface ProjectEventInput {
  type: string;
  key?: string;
  subject?: string;
  occurredAt?: number;
  payload?: unknown;
}

/** Validate what a source supplies; returns a problem or the bounded fields. */
export function normalizeEventInput(input: ProjectEventInput, fallbackKey: () => string):
  { error: string } | { type: string; key: string; subject?: string; occurredAt?: number; payload: Record<string, unknown> } {
  if (!validEventType(input.type)) return { error: 'event `type` must be dotted words, e.g. "orders.created"' };
  const payload = input.payload === undefined ? {} : input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'event `payload` must be a JSON object' };
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (bytes > MAX_EVENT_PAYLOAD_BYTES) return { error: `event payload is ${bytes} bytes; the limit is ${MAX_EVENT_PAYLOAD_BYTES}` };
  const key = input.key === undefined || input.key === '' ? fallbackKey() : String(input.key);
  if (key.length > MAX_KEY_LENGTH) return { error: `event \`key\` is longer than ${MAX_KEY_LENGTH} characters` };
  const subject = input.subject === undefined ? undefined : String(input.subject).slice(0, MAX_SUBJECT_LENGTH);
  const occurredAt = Number.isFinite(input.occurredAt) ? Number(input.occurredAt) : undefined;
  return { type: input.type, key, ...(subject ? { subject } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}),
    payload: payload as Record<string, unknown> };
}

// ─── What a run receives ─────────────────────────────────────────────────────

export function triggerContext(event: ProjectEvent, concurrencyKey?: string): TriggerContext {
  return {
    eventId: event.id,
    source: event.source,
    type: event.type,
    key: event.key,
    ...(event.subject ? { subject: event.subject } : {}),
    receivedAt: event.receivedAt,
    hops: event.hops,
    payload: event.payload,
    ...(concurrencyKey ? { concurrencyKey } : {}),
  };
}

/**
 * The prompt section a triggered run's agent reads: what fired it, then the
 * payload quoted as untrusted data (it was written by whoever sent the event).
 */
export function triggerPromptSection(trigger: TriggerContext): string {
  let json = JSON.stringify(trigger.payload, null, 2);
  if (json.length > PROMPT_PAYLOAD_CHARS) json = `${json.slice(0, PROMPT_PAYLOAD_CHARS)}\n… (truncated; the full event is in $TAVYA_EVENT)`;
  const about = trigger.subject ? ` about ${trigger.subject}` : '';
  return [
    `This run was started by the event \`${trigger.type}\` from \`${trigger.source}\`${about}.`,
    untrustedBlock('event payload', json),
  ].join('\n');
}

/** The message an unfinished run receives for a further event of its key. */
export function triggerMessage(trigger: TriggerContext): string {
  return triggerPromptSection(trigger).replace(/^This run was started by the event/, 'While you work on this, another event arrived:');
}

/**
 * What a run started by an event looks like: the event on `params.trigger`
 * (commands read it from `$TAVYA_EVENT`), the prompt section appended, and a
 * title rendered from `{{path}}` placeholders when the template has any.
 */
export function applyTriggerContext<P extends Record<string, unknown>>(title: string, params: P, trigger: TriggerContext): { title: string; params: P } {
  const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
  return {
    title: hasTemplate(title) ? (renderTemplate(title, trigger.payload).trim() || title) : title,
    params: { ...params, trigger, prompt: [prompt, triggerPromptSection(trigger)].filter(Boolean).join('\n\n') },
  };
}

/**
 * Fit an outside payload into the inbox's limit, keeping its shape: long text
 * and long lists are shortened step by step, and `_truncated` says so. A sender
 * that needs every byte can be fetched from by the run itself.
 */
export function boundEventPayload(payload: Record<string, unknown>, maxBytes = MAX_EVENT_PAYLOAD_BYTES): Record<string, unknown> {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  if (size(payload) <= maxBytes) return payload;
  for (const [textLimit, listLimit] of [[4000, 50], [1000, 20], [300, 5]] as const) {
    const trimmed = trimValue(payload, textLimit, listLimit, 0) as Record<string, unknown>;
    if (size(trimmed) <= maxBytes - 32) return { ...trimmed, _truncated: true };
  }
  const scalars = Object.entries(payload).filter(([, value]) => value === null || typeof value !== 'object')
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 300) : value]);
  return { ...Object.fromEntries(scalars), _truncated: true };
}

function trimValue(value: unknown, textLimit: number, listLimit: number, depth: number): unknown {
  if (typeof value === 'string') return value.length > textLimit ? `${value.slice(0, textLimit)}…` : value;
  if (!value || typeof value !== 'object') return value;
  if (depth > 8) return '…';
  if (Array.isArray(value)) return value.slice(0, listLimit).map((item) => trimValue(item, textLimit, listLimit, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimValue(item, textLimit, listLimit, depth + 1)]));
}
