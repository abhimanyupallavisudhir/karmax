/**
 * Usage/session-limit detection + reset-time resolution (SPEC §6.2).
 *
 * `classifyLimitError` is PURE (a string parse) so the deterministic workflow can
 * decide whether a failed turn hit a quota limit. `resetAtFromHint` does the
 * wall-clock/timezone math that turns a human-readable "resets 3:45pm" hint into
 * an absolute instant — it takes `nowMs` explicitly so it stays testable and is
 * only ever called from an activity (never the workflow sandbox).
 *
 * Ground truth (verified against Claude Code docs, 2026-07):
 *   - Subscription (Max/Pro) limits surface only as human-readable strings, e.g.
 *     "You've hit your session limit · resets 3:45pm",
 *     "You've hit your weekly limit · resets Mon 12:00am",
 *     "You've hit your Opus limit · resets 3:45pm".
 *     There is NO machine timestamp and NO quota API — hence parse-with-fallback.
 *   - API-key paths surface a 429 (with retry-after/-reset headers upstream if we
 *     ever thread them through); classification still works off the message.
 */
export type LimitWindow = '5h' | 'weekly' | 'model';

export interface LimitClassification {
  limited: boolean;
  window?: LimitWindow;
  /** Human-readable reset hint extracted from the error, e.g. "3:45pm", "Mon 12:00am". */
  resetHint?: string;
  /** e.g. the model name for a model-specific limit ("opus"). */
  note?: string;
}

/** Detect + classify a usage/session-limit error from its message. Pure. */
export function classifyLimitError(message: string): LimitClassification {
  const m = String(message ?? '');
  const lc = m.toLowerCase();
  const limited =
    /you'?ve hit your|usage limit|session limit|weekly limit|rate.?limit|too many requests|quota|\b429\b/.test(lc);
  if (!limited) return { limited: false };

  let window: LimitWindow = '5h';
  let note: string | undefined;
  if (/weekly limit/.test(lc)) {
    window = 'weekly';
  } else if (/session limit|5-?hour/.test(lc)) {
    window = '5h';
  } else {
    const modelLimit = lc.match(/\b(opus|sonnet|haiku)\b[^.]*limit/);
    if (modelLimit) {
      window = 'model';
      note = modelLimit[1];
    }
  }
  const resetMatch = m.match(/resets?\s+([^\n."']+?)(?:\s*[.\n"']|$)/i);
  const resetHint = resetMatch ? resetMatch[1]!.trim() : undefined;
  return { limited: true, window, ...(resetHint ? { resetHint } : {}), ...(note ? { note } : {}) };
}

/**
 * Resolve an absolute reset instant (epoch ms) from a human-readable hint, in the
 * host local timezone. Falls back conservatively (5h for a session/model limit,
 * 7d for a weekly limit) when the hint is missing or unparseable. Never returns a
 * past instant or one absurdly far out.
 *
 * NOTE (v1 limitation): parsing is in the HOST local timezone. If karmax runs in a
 * different zone than the account's, a `quotaTimezone` setting should be threaded
 * in here later; for now local time matches the common single-host deployment.
 */
export function resetAtFromHint(resetHint: string | undefined, window: LimitWindow, nowMs: number): number {
  const fallback = () => nowMs + (window === 'weekly' ? 7 * 24 : 5) * 3_600_000;
  if (!resetHint) return fallback();
  const hint = resetHint.trim().toLowerCase();

  const timeMatch = hint.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!timeMatch) return fallback();
  let hour = parseInt(timeMatch[1]!, 10);
  const min = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
  const ampm = timeMatch[3];
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return fallback();

  const now = new Date(nowMs);
  const target = new Date(nowMs);
  target.setHours(hour, min, 0, 0);

  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayMatch = hint.match(/\b(sun|mon|tue|wed|thu|fri|sat)/);
  if (dayMatch) {
    const targetDow = days.indexOf(dayMatch[1]!);
    let delta = (targetDow - now.getDay() + 7) % 7;
    if (delta === 0 && target.getTime() <= nowMs) delta = 7;
    target.setDate(target.getDate() + delta);
  } else if (target.getTime() <= nowMs) {
    target.setDate(target.getDate() + 1); // already past today → tomorrow
  }

  const at = target.getTime();
  if (at <= nowMs || at > nowMs + 8 * 24 * 3_600_000) return fallback();
  return at;
}
