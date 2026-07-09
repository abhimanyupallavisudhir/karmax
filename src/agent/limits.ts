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
  /** A HARD failure that won't self-recover on a timer — billing/credit exhaustion
   *  or bad auth (typical of an API key out of funds). These escalate to a human
   *  (fund/fix the key) rather than parking for a refresh. */
  hard?: boolean;
}

/**
 * Transient transport/infrastructure failure: the stream or socket died under
 * the turn (host slept, network dropped, provider hiccuped) — nothing the agent
 * said or did. Pure (a string parse). Deliberately conservative: an
 * unrecognized error is NOT transport, so it keeps flowing to the Resolve path
 * instead of being blindly retried. Check limits FIRST — a 429 is a quota
 * signal, not transport.
 */
export function isTransportError(message: string): boolean {
  const lc = String(message ?? '').toLowerCase();
  return (
    /connection (closed|error|refused|reset|terminated)|socket hang ?up|network error|fetch failed|premature close|server disconnected|stream (closed|ended unexpectedly|error)|econnreset|econnrefused|etimedout|epipe|enetunreach|eai_again|enotfound|\boverloaded\b/.test(
      lc,
    ) || /\b(?:50[234]|529)\b/.test(lc)
  );
}

/**
 * A signal-9 / OOM-signature kill: the model subprocess was reaped by SIGKILL
 * (signal 9) or an explicit out-of-memory error surfaced — nothing the agent said
 * or did. The Claude Agent SDK surfaces this as the opaque "Claude Code process
 * terminated by signal SIGKILL" (karmax#4).
 *
 * The SENDER is not encoded in the message and is NOT always the kernel OOM
 * killer. On karmax's single-host deployment two senders dominate: (1) the OS OOM
 * killer under real memory pressure, and (2) karmax's OWN reapOrphans() sweep
 * (src/agent/custody.ts), which SIGKILLs a prior incarnation's in-flight agents
 * after a restart/reload — the confirmed cause in the 2026-07 incident, where
 * journalctl/oomd logged zero kills. Both are environmental and both should
 * retry-and-resume, so this predicate matches either; the caller decides the
 * wording by checking live memory (see signalKillMessage in activities/core.ts).
 *
 * Pure (a string parse) so it is the ONE shared predicate for both the activity's
 * error classifier (classifyTurnError) and the software-dev auto-resolve path
 * (tracked separately) — the two must agree on "is this a signal-9/OOM kill?".
 * Cancellation is filtered out upstream (an aborted turn rethrows before
 * classification), so a SIGKILL that reaches classification is environmental.
 */
export function isResourceKill(message: string): boolean {
  const lc = String(message ?? '').toLowerCase();
  return (
    /\bsigkill\b/.test(lc) ||
    /terminated by signal\s+9\b/.test(lc) ||
    /\bsignal\s+9\b/.test(lc) ||
    /\benomem\b/.test(lc) ||
    /out of memory|cannot allocate memory|memory exhausted|oom[\s-]?kill(?:ed|er)?/.test(lc)
  );
}

/** Detect + classify a usage/session-limit error from its message. Pure. */
export function classifyLimitError(message: string): LimitClassification {
  const m = String(message ?? '');
  const lc = m.toLowerCase();
  // Hard, non-recoverable: billing/credit exhaustion or bad auth (won't refresh on a
  // timer — needs a human to fund/fix). Checked first because "insufficient_quota"
  // also contains "quota".
  const hard = /insufficient_quota|exceeded your current quota|billing|credit balance|payment required|invalid_api_key|invalid x-api-key|\b401\b|unauthorized|access denied/.test(lc);
  const limited =
    hard || /you'?ve hit your|usage limit|session limit|weekly limit|rate.?limit|too many requests|quota|\b429\b/.test(lc);
  if (!limited) return { limited: false };
  if (hard) return { limited: true, hard: true };

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

  // Relative forms (machine-readable, e.g. Codex's `resets_in_seconds`): "in 3600s",
  // "in 90 minutes", "in 3 hours". Checked BEFORE clock times so "3600s" isn't
  // misread as a wall-clock time. Bounded to ≤14 days to reject absurd values.
  const rel = hint.match(/(?:in\s+)?(\d+)\s*(s|sec|secs|second|seconds)\b/);
  if (rel) {
    const secs = parseInt(rel[1]!, 10);
    if (secs > 0 && secs <= 14 * 24 * 3600) return nowMs + secs * 1000;
  }
  const relM = hint.match(/in\s+(\d+)\s*(m|min|mins|minute|minutes)\b/);
  if (relM) {
    const n = parseInt(relM[1]!, 10);
    if (n > 0 && n <= 14 * 24 * 60) return nowMs + n * 60_000;
  }
  const relH = hint.match(/in\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/);
  if (relH) {
    const n = parseInt(relH[1]!, 10);
    if (n > 0 && n <= 14 * 24) return nowMs + n * 3_600_000;
  }

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
