import type { ReviewAction, ReviewInfo } from '../domain/types.js';

/**
 * Validation for agent-authored review info (`create_review_info`). The console
 * renders it as links and buttons, and every TurnResult carries it into
 * workflow history, so the tool boundary bounds its size and admits only the
 * affordances the tool advertises: `run` and `open` actions (a `payment` button
 * is platform-created) and http(s) URLs.
 */

/** Review captions are orientation, not a second place for the agent's final answer. */
export const MAX_REVIEW_TEXT_LENGTH = 280;
const MAX_ACTIONS = 20;
const MAX_LINKS = 20;
const MAX_LABEL = 120;
const MAX_URL = 2048;
const MAX_OPEN_URLS = 5;
const MAX_COMMAND = 4096;
const MAX_DOCUMENT = 128 * 1024;
/** Well under Temporal's 256 KiB payload warning, with room for the rest of the turn. */
const MAX_TOTAL_BYTES = 192 * 1024;

export class ReviewInfoRejected extends Error {
  override name = 'ReviewInfoRejected';
}

const reject = (reason: string): never => { throw new ReviewInfoRejected(reason); };
const textLength = (value: string) => [...value].length;

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === '') return required ? reject(`${field} is required`) : undefined;
  if (typeof value !== 'string') return reject(`${field} must be a string`);
  const length = textLength(value);
  if (length > max) reject(`${field} is ${length} characters; the maximum is ${max}. Shorten it and retry.`);
  return value;
}

function webUrl(value: unknown, field: string): string {
  const url = text(value, field, MAX_URL, true)!;
  let protocol: string | undefined;
  try { protocol = new URL(url).protocol; } catch { /* not absolute */ }
  if (protocol !== 'http:' && protocol !== 'https:') reject(`${field} must be an absolute http(s) URL`);
  return url;
}

/** A world-relative path, or an absolute URL that must then be http(s). */
function openTarget(value: unknown, field: string): string {
  const target = text(value, field, MAX_URL, true)!;
  return /^[a-z][a-z0-9+.-]*:/i.test(target) ? webUrl(target, field) : target;
}

function action(value: unknown, index: number): ReviewAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject(`actions[${index}] must be an object`);
  const raw = value as Record<string, unknown>;
  const label = text(raw.label, `actions[${index}].label`, MAX_LABEL, true)!;
  if (raw.kind === 'open') return { kind: 'open', label, target: openTarget(raw.target, `actions[${index}].target`) };
  if (raw.kind !== 'run') return reject(`actions[${index}].kind must be "run" or "open"`);
  const openUrls = raw.openUrls === undefined ? undefined
    : Array.isArray(raw.openUrls) && raw.openUrls.length <= MAX_OPEN_URLS
      ? raw.openUrls.map((url, i) => webUrl(url, `actions[${index}].openUrls[${i}]`))
      : reject(`actions[${index}].openUrls must be a list of at most ${MAX_OPEN_URLS} URLs`);
  return {
    kind: 'run', label,
    command: text(raw.command, `actions[${index}].command`, MAX_COMMAND, true)!,
    ...(raw.server === true ? { server: true } : {}),
    ...(openUrls?.length ? { openUrls } : {}),
  };
}

/** Normalize one call's fields, rejecting what the console must never render. */
export function validateReviewInfoCall(info: ReviewInfo): ReviewInfo {
  const out: ReviewInfo = {};
  const caption = text(info.caption, 'caption', MAX_REVIEW_TEXT_LENGTH);
  if (caption !== undefined) out.caption = caption;
  // `summary` is no longer advertised; old/resumed sessions may still send it.
  const summary = text(info.summary, 'summary', MAX_REVIEW_TEXT_LENGTH);
  if (summary !== undefined) out.summary = summary;
  if (info.actions !== undefined) {
    if (!Array.isArray(info.actions)) reject('actions must be a list');
    out.actions = info.actions.map(action);
  }
  if (info.links !== undefined) {
    if (!Array.isArray(info.links) || info.links.length > MAX_LINKS) reject(`links must be a list of at most ${MAX_LINKS}`);
    out.links = info.links.map((link, i) => ({
      label: text(link?.label, `links[${i}].label`, MAX_LABEL, true)!,
      url: webUrl(link?.url, `links[${i}].url`),
    }));
  }
  const diff = text(info.diff, 'diff', MAX_DOCUMENT);
  if (diff !== undefined) out.diff = diff;
  const html = text(info.html, 'html', MAX_DOCUMENT);
  if (html !== undefined) out.html = html;
  return out;
}

/** Bound what a turn accumulates across calls (actions append). */
export function assertReviewInfoTotal(info: ReviewInfo): void {
  if ((info.actions?.length ?? 0) > MAX_ACTIONS) reject(`at most ${MAX_ACTIONS} actions per Review; attach only the most useful ones`);
  const bytes = Buffer.byteLength(JSON.stringify(info));
  if (bytes > MAX_TOTAL_BYTES) reject(`review info is ${bytes} bytes; the maximum is ${MAX_TOTAL_BYTES}`);
}
