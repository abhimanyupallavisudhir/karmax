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
export type ProviderFailureKind = 'quota' | 'credential';
export type ProviderFailureSource = 'structured' | 'message';

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
  /** Why this account is unavailable. Both categories use the same account-rotation
   *  path, but credential failures always need human attention. */
  kind?: ProviderFailureKind;
}

/** Serializable metadata carried through Temporal ApplicationFailure.details.
 * Provider adapters produce this before human-readable wording is flattened. */
export interface ProviderFailureMetadata {
  kind: ProviderFailureKind;
  permanence: 'hard' | 'transient';
  provider?: 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'mock';
  source: ProviderFailureSource;
  window?: LimitWindow;
  resetHint?: string;
  note?: string;
}

/** A provider-originated account failure. It remains a normal Error to adapters,
 * but preserves routing metadata until the activity serializes it for Temporal. */
export class ProviderFailure extends Error {
  readonly metadata: ProviderFailureMetadata;

  constructor(message: string, metadata: ProviderFailureMetadata) {
    super(message);
    this.name = 'ProviderFailure';
    this.metadata = metadata;
  }
}

export interface LimitClassifierOptions {
  /** Enables semantic phrase-family matching. Use only at the provider adapter
   * boundary; arbitrary build/git errors must remain on the Resolve path. */
  providerOrigin?: boolean;
}

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

function termsNear(tokens: string[], left: Set<string>, right: Set<string>, distance = 5): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (!left.has(tokens[i]!)) continue;
    const from = Math.max(0, i - distance);
    const to = Math.min(tokens.length - 1, i + distance);
    for (let j = from; j <= to; j++) if (right.has(tokens[j]!)) return true;
  }
  return false;
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
    /connection (closed|error|refused|reset|terminated|timed? out)|socket hang ?up|network error|network is unreachable|no route to host|fetch failed|premature close|server disconnected|stream (closed|disconnected|ended unexpectedly|error)|turn interrupted before completion|request timed? out|operation timed? out|tls handshake timeout|temporary failure in name resolution|unexpected eof|broken pipe|econnreset|econnrefused|etimedout|epipe|enetunreach|ehostunreach|eai_again|enotfound|\boverloaded\b|service unavailable|gateway timeout|upstream (?:connect )?error|internal server error|\bserver_error\b/.test(
      lc,
    ) ||
    // Codex app-server reports a dropped connection as a reconnect banner. In
    // task #225 the only terminal text after five internal reconnect attempts was
    // a model-refresh child-process timeout, so neither the old socket matcher nor
    // the HTTP-status matcher recognized the outage.
    /\breconnecting(?:\.{3}|\s)*\s*\d+\s*\/\s*\d+\b/.test(lc) ||
    /timeout waiting for (?:a |the )?child process to exit/.test(lc) ||
    // Short-lived host process-table / descriptor pressure. Disk-full and
    // permission errors are intentionally absent: those need intervention.
    /\b(?:eagain|emfile|enfile)\b/.test(lc) ||
    /\b(?:408|50[0234]|529)\b/.test(lc)
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
export function classifyLimitError(message: string, options: LimitClassifierOptions = {}): LimitClassification {
  const m = String(message ?? '');
  const lc = m.toLowerCase();
  const tokens = words(lc);

  // Machine codes and stable protocol statuses remain authoritative.
  const credential = /invalid_api_key|invalid x-api-key|\b401\b|unauthorized|access denied/.test(lc);
  const hardCode = /insufficient_quota|exceeded your current quota|payment required|\b402\b/.test(lc);

  // Stable human phrases retained for compatibility with old workflow histories and
  // with providers (notably subscription CLIs) that expose no machine error code.
  const knownHardCredit = /out of (?:usage )?credits?|insufficient (?:usage )?credits?/.test(lc);
  const knownLimit =
    /you'?ve hit your|usage limit|usagelimitreached|session limit|weekly limit|rate.?limit|too many requests|\b429\b/.test(lc);

  // Provider-scoped semantic fallback: combine a state word with an account/quota
  // noun within a short window. This generalizes across wording changes without
  // treating arbitrary project errors containing "quota" as provider failures.
  const exhaustion = new Set(['out', 'exhausted', 'depleted', 'insufficient', 'empty', 'consumed', 'spent', 'exceeded']);
  const quotaNouns = new Set(['quota', 'quotas', 'credit', 'credits', 'balance', 'allowance']);
  const limitStates = new Set([...exhaustion, 'hit', 'reached', 'limited', 'remaining']);
  const semanticLimit =
    !!options.providerOrigin &&
    (termsNear(tokens, limitStates, quotaNouns) ||
      /(?:no|zero|0)\s+(?:credits?|quota|allowance)\s+(?:left|remaining|available)/.test(lc) ||
      /(?:maximum|max)\s+(?:usage|requests?)\s+(?:reached|exceeded)/.test(lc));
  const semanticHardCredit =
    !!options.providerOrigin &&
    (termsNear(tokens, exhaustion, new Set(['credit', 'credits', 'balance'])) ||
      /(?:no|zero|0)\s+credits?\s+(?:left|remaining|available)/.test(lc) ||
      /not enough\s+(?:usage\s+)?credits?/.test(lc));

  const hard = credential || hardCode || knownHardCredit || semanticHardCredit;
  const limited = hard || knownLimit || semanticLimit;
  if (!limited) return { limited: false };
  if (hard) return { limited: true, hard: true, kind: credential ? 'credential' : 'quota' };

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
  return { limited: true, kind: 'quota', window, ...(resetHint ? { resetHint } : {}), ...(note ? { note } : {}) };
}

/** Convert a provider message into a typed failure when it is recognizable, while
 * leaving unrelated provider errors alone. This is the human-wording fallback; a
 * structured provider signal should call `providerFailure` directly. */
export function providerErrorFromMessage(
  provider: ProviderFailureMetadata['provider'],
  message: string,
  source: ProviderFailureSource = 'message',
): Error {
  const cls = classifyLimitError(message, { providerOrigin: true });
  if (!cls.limited) return new Error(message);
  return new ProviderFailure(message, {
    kind: cls.kind ?? 'quota',
    permanence: cls.hard ? 'hard' : 'transient',
    provider,
    source,
    ...(cls.window ? { window: cls.window } : {}),
    ...(cls.resetHint ? { resetHint: cls.resetHint } : {}),
    ...(cls.note ? { note: cls.note } : {}),
  });
}

/** Construct a typed failure from a provider-native quota/error event. */
export function providerFailure(
  message: string,
  metadata: Omit<ProviderFailureMetadata, 'source'> & { source?: ProviderFailureSource },
): ProviderFailure {
  return new ProviderFailure(message, { ...metadata, source: metadata.source ?? 'structured' });
}

/** Prefer adapter metadata; fall back to semantic matching only because third-party
 * adapters and older provider rails may still throw plain Errors. */
export function classifyProviderTurnError(
  err: unknown,
  provider?: ProviderFailureMetadata['provider'],
): { classification: LimitClassification; metadata?: ProviderFailureMetadata } {
  if (err instanceof ProviderFailure) {
    const m = err.metadata;
    return {
      classification: {
        limited: true,
        hard: m.permanence === 'hard' || undefined,
        kind: m.kind,
        window: m.window,
        resetHint: m.resetHint,
        note: m.note,
      },
      metadata: m,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const classification = classifyLimitError(message, { providerOrigin: true });
  if (!classification.limited) return { classification };
  return {
    classification,
    metadata: {
      kind: classification.kind ?? 'quota',
      permanence: classification.hard ? 'hard' : 'transient',
      provider,
      source: 'message',
      ...(classification.window ? { window: classification.window } : {}),
      ...(classification.resetHint ? { resetHint: classification.resetHint } : {}),
      ...(classification.note ? { note: classification.note } : {}),
    },
  };
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
