import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  claudeAccessToken,
  claudeAccessTokenExpiresAt,
  claudeSignIn,
  hasClaudeNativeCredential,
  scrubbedEnv,
} from '../autonomy/config-homes.js';
import { modelLoginsFor, type ModelLogins } from '../autonomy/model-logins.js';
import { trackProcess } from '../util/processes.js';
import { withTimeout } from '../util/timeout.js';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { localProviderCli } from './provider-cli.js';
import { createCustodyEnv, killAgent } from './custody.js';
import { BRAND } from '../domain/brand.js';
import { ProviderFailure, ProviderOutage, providerFailure } from './limits.js';

/**
 * Proactive quota (RESOLVE-PLAN §2 / #6). `claude -p '/usage'` prints a parseable
 * subscription panel — session %, weekly %, per-model %, each with a reset instant
 * and timezone. We shell it out per login and surface real numbers on the dashboard,
 * so the user isn't blind to quota until an agent hits a wall (the reactive path).
 *
 * IMPORTANT feasibility facts:
 *  - The panel renders ONLY for a login with a full interactive-login
 *    `.credentials.json` (broad OAuth scopes). A `claude setup-token` credential
 *    authenticates inference but its usage query returns nothing (header only) — so
 *    setup-token logins report `unavailable` here and fall back to reactive tracking.
 *  - Current Codex app-server exposes the same information without a model turn
 *    through the stable `account/rateLimits/read` method. It returns absolute reset
 *    instants and can include additional per-model limit buckets.
 * The Claude probe runs in a throwaway config dir holding a refresh-token-free
 * projection of the login's `.credentials.json`. A plain copy is not isolated:
 * OAuth refresh can rotate the token server-side, then deleting the throwaway
 * copy strands the canonical home with the revoked predecessor. Codex's app-server
 * account read uses its native CODEX_HOME, as Codex agent turns do.
 */

export interface UsageWindow {
  /** 0–100. */
  pct: number;
  /** Raw reset text as shown, e.g. "Jul 5, 2:19am". */
  resetLabel: string;
  /** IANA timezone the label is in, e.g. "Europe/London". */
  tz?: string;
  /** Best-effort absolute reset instant (epoch ms) for a countdown; display uses the label. */
  resetAt?: number;
}

export interface UsageSnapshot {
  ok: true;
  /** When this was probed (epoch ms). */
  at: number;
  /** Rolling session window (the 5h limit). */
  session?: UsageWindow;
  /** Weekly window across all models. */
  week?: UsageWindow;
  /** Per-model weekly windows (e.g. Opus/Fable), when the panel breaks them out. */
  models?: { name: string; pct: number; resetLabel: string; tz?: string; resetAt?: number }[];
}

export interface UsageUnavailable {
  ok: false;
  at: number;
  /** Why no numbers — setup-token, logged-out, not-subscription, no-rate-limits, or probe-failed. */
  reason: string;
}

export type UsageResult = UsageSnapshot | UsageUnavailable;

/** Injectable runner (tests): given the probe args, return combined stdout+stderr. */
export type UsageRunner = (configDir: string) => Promise<string>;

/** Injectable Codex app-server request (tests), given the home it runs in;
 * returns account/rateLimits/read. */
export type CodexUsageRunner = (configHome?: string) => Promise<unknown>;
const codexRefreshes = new Map<string, { promise: Promise<unknown>; force: boolean }>();
const claudeRefreshes = new Map<string, Promise<string>>();
/** Codex authenticates with its access token (about ten days) and refreshes it
 * only in its last five minutes; it never reads the one-hour ID token's expiry.
 * A remote projection cannot refresh, so the host renews it a day ahead, which
 * leaves a failed early refresh (a provider sign-in outage) a day to recover. */
export const CODEX_REMOTE_ACCESS_TOKEN_REFRESH_AHEAD_MS = 24 * 60 * 60_000;
/** Enough access-token lifetime for sandbox startup and the first Responses
 * stream. Long turns remain protected by the bounded terminal-401 recovery in codex.ts. */
export const CODEX_REMOTE_ACCESS_TOKEN_SAFETY_MS = 10 * 60_000;
/** Codex's own fallback when an access token carries no readable expiry. */
const CODEX_TOKEN_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60_000;
/** Leave enough access-token lifetime for sandbox startup and the first Claude
 * request. Mid-turn expiry is handled by the adapter's bounded recovery. */
export const CLAUDE_REMOTE_ACCESS_TOKEN_SAFETY_MS = 10 * 60_000;

// ── Parsing ──────────────────────────────────────────────────────────────────
// Lines look like (the separator is a middle dot · U+00B7):
//   Current session: 3% used · resets Jul 5, 2:19am (Europe/London)
//   Current week (all models): 1% used · resets Jul 9, 12:59pm (Europe/London)
//   Current week (Fable): 0% used · resets Jul 9, 12:59pm (Europe/London)
const SESSION_RE = /Current session:\s*(\d+)%\s*used.*?resets\s+(.+?)\s*\(([^)]+)\)/i;
const WEEK_ALL_RE = /Current week\s*\(all models\):\s*(\d+)%\s*used.*?resets\s+(.+?)\s*\(([^)]+)\)/i;
const WEEK_MODEL_RE = /Current week\s*\(([^)]+)\):\s*(\d+)%\s*used.*?resets\s+(.+?)\s*\(([^)]+)\)/gi;
const SUBSCRIPTION_RE = /using your subscription/i;

/** Pure parse of the `/usage` panel text into a snapshot. `now` seeds the reset-year guess. */
export function parseUsagePanel(text: string, now: number): UsageResult {
  const win = (pct: string, label: string, tz: string): UsageWindow => ({
    pct: Math.max(0, Math.min(100, parseInt(pct, 10))),
    resetLabel: label.trim(),
    tz: tz.trim() || undefined,
    resetAt: labelToEpoch(label.trim(), tz.trim(), now),
  });

  const s = SESSION_RE.exec(text);
  const wa = WEEK_ALL_RE.exec(text);
  const models: NonNullable<UsageSnapshot['models']> = [];
  WEEK_MODEL_RE.lastIndex = 0;
  for (let m; (m = WEEK_MODEL_RE.exec(text)); ) {
    if (/^all models$/i.test(m[1]!)) continue; // that's the `week` field, not a per-model row
    const w = win(m[2]!, m[3]!, m[4]!);
    models.push({ name: m[1]!.trim(), pct: w.pct, resetLabel: w.resetLabel, tz: w.tz, resetAt: w.resetAt });
  }

  if (!s && !wa && models.length === 0) {
    // No numbers. Distinguish "subscription but usage query returned nothing"
    // (setup-token) from "not logged in / not a subscription".
    return { ok: false, at: now, reason: SUBSCRIPTION_RE.test(text) ? 'setup-token' : 'not-subscription' };
  }
  return {
    ok: true,
    at: now,
    ...(s ? { session: win(s[1]!, s[2]!, s[3]!) } : {}),
    ...(wa ? { week: win(wa[1]!, wa[2]!, wa[3]!) } : {}),
    ...(models.length ? { models } : {}),
  };
}

// Codex app-server returns windows as { usedPercent, windowDurationMins,
// resetsAt }, where resetsAt is epoch seconds. Keep the dashboard contract
// provider-neutral by translating those into the same snapshot shape as Claude.
export function parseCodexRateLimits(payload: any, now: number): UsageResult {
  const byId = payload?.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object'
    ? Object.values(payload.rateLimitsByLimitId).filter(Boolean) as any[]
    : [];
  const primary = byId.find((b) => b?.limitId === 'codex') ?? payload?.rateLimits ?? byId[0];
  const seen = new Set<string>();
  const extras = byId.filter((b) => {
    const id = String(b?.limitId ?? b?.limitName ?? '');
    if (!id || id === String(primary?.limitId ?? '') || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const convert = (raw: any): UsageWindow | undefined => {
    if (!raw || !Number.isFinite(Number(raw.usedPercent))) return undefined;
    const resetSeconds = Number(raw.resetsAt);
    const resetAt = Number.isFinite(resetSeconds) && resetSeconds > 0
      ? (resetSeconds < 10_000_000_000 ? resetSeconds * 1000 : resetSeconds)
      : undefined;
    return {
      pct: Math.max(0, Math.min(100, Number(raw.usedPercent))),
      // Codex gives an absolute instant, so let the browser localize it rather
      // than baking the gateway host's timezone into a text label.
      resetLabel: '',
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  };
  const rawWindows = (bucket: any) => [bucket?.primary, bucket?.secondary]
    .filter((w) => w && Number.isFinite(Number(w.usedPercent)));
  const main = rawWindows(primary).sort((a, b) =>
    Number(a.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - Number(b.windowDurationMins ?? Number.MAX_SAFE_INTEGER));

  let session: UsageWindow | undefined;
  let week: UsageWindow | undefined;
  if (main.length >= 2) {
    session = convert(main[0]);
    week = convert(main[main.length - 1]);
  } else if (main.length === 1) {
    const duration = Number(main[0].windowDurationMins);
    // Codex plans do not always expose both windows. A multi-day sole window is
    // weekly; a shorter/unknown sole window is the rolling session limit.
    if (Number.isFinite(duration) && duration >= 3 * 24 * 60) week = convert(main[0]);
    else session = convert(main[0]);
  }

  const models: NonNullable<UsageSnapshot['models']> = [];
  for (const bucket of extras) {
    const wins = rawWindows(bucket);
    const base = String(bucket.limitName ?? bucket.limitId ?? 'model');
    for (const raw of wins) {
      const win = convert(raw);
      if (!win) continue;
      const duration = Number(raw.windowDurationMins);
      const suffix = wins.length > 1 && Number.isFinite(duration)
        ? duration >= 3 * 24 * 60 ? ' (week)' : ` (${Math.round(duration / 60)}h)`
        : '';
      models.push({ name: `${base}${suffix}`, pct: win.pct, resetLabel: win.resetLabel, resetAt: win.resetAt });
    }
  }

  if (!session && !week && models.length === 0) {
    return { ok: false, at: now, reason: 'no-rate-limits' };
  }
  return {
    ok: true,
    at: now,
    ...(session ? { session } : {}),
    ...(week ? { week } : {}),
    ...(models.length ? { models } : {}),
  };
}

// ── Staleness ──────────────────────────────────────────────────────────────────

/** Snapshots older than this are re-probed before being trusted (display state only). */
export const USAGE_TTL_MS = 15 * 60_000;

/**
 * A cached snapshot is stale when any window it reports has already reset (its %
 * refers to a window that no longer exists — showing it as current is a lie), or
 * when the probe itself is older than the TTL. A *fresh* failed probe is NOT stale
 * (don't hammer a failing CLI); it becomes stale again once the TTL passes.
 */
export function isUsageStale(snap: UsageResult | undefined, now: number, ttlMs = USAGE_TTL_MS): boolean {
  if (!snap) return true; // pollable but never probed
  if (now - snap.at > ttlMs) return true;
  if (!snap.ok) return false;
  const wins = [snap.session, snap.week, ...(snap.models ?? [])].filter((w): w is UsageWindow => !!w);
  return wins.some((w) => w.resetAt !== undefined && w.resetAt < now);
}

/** A native quota probe authenticates through the same provider login used for
 * turns. When every reported main window is below 100%, it is positive evidence
 * that an earlier auth/billing quarantine is stale and can be cleared. Model-only
 * buckets are intentionally excluded: they do not describe general turn capacity. */
export function usageProvesAvailable(snap: UsageResult): boolean {
  if (!snap.ok) return false;
  const main = [snap.session, snap.week].filter((w): w is UsageWindow => !!w);
  return main.length > 0 && main.every((w) => w.pct < 100);
}

// ── Best-effort reset-instant math (display always uses the raw label) ─────────
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Jul 5, 2:19am" (+ IANA tz) → epoch ms, or undefined if unparseable. */
export function labelToEpoch(label: string, tz: string | undefined, now: number): number | undefined {
  const m = label.match(/([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return undefined;
  const mon = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
  if (mon === undefined) return undefined;
  const day = parseInt(m[2]!, 10);
  let hour = parseInt(m[3]!, 10) % 12;
  if (/pm/i.test(m[5]!)) hour += 12;
  const minute = m[4] ? parseInt(m[4], 10) : 0;
  const year = new Date(now).getUTCFullYear();
  let epoch = wallTimeToEpoch(year, mon, day, hour, minute, tz);
  // Year rollover: a reset shown as far in the past is really next year (Dec→Jan).
  if (epoch < now - 2 * 86_400_000) epoch = wallTimeToEpoch(year + 1, mon, day, hour, minute, tz);
  return epoch;
}

/** Instant whose wall-clock in `tz` equals the given components (DST-correct via 2-pass offset). */
function wallTimeToEpoch(year: number, mon: number, day: number, hour: number, minute: number, tz?: string): number {
  const guess = Date.UTC(year, mon, day, hour, minute);
  if (!tz) return guess;
  let epoch = guess - tzOffsetMs(guess, tz);
  epoch = guess - tzOffsetMs(epoch, tz); // second pass settles DST boundaries
  return epoch;
}

/** The tz's UTC offset (ms) at `instant`: how far ahead of UTC the zone's wall clock is. */
function tzOffsetMs(instant: number, tz: string): number {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(instant);
    const g = (t: string) => parseInt(p.find((x) => x.type === t)!.value, 10);
    const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
    return asUTC - instant;
  } catch {
    return 0; // unknown tz → treat label as UTC-ish; display still uses the raw label
  }
}

// ── Probe ──────────────────────────────────────────────────────────────────────

/** Path to the full-login credential for a home (or ambient ~/.claude). */
function claudeCredentialPath(configHome?: string): string {
  return path.join(configHome ?? path.join(os.homedir(), '.claude'), '.credentials.json');
}

function codexCredentialPath(configHome?: string): string {
  return path.join(configHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json');
}

/**
 * Probe a Claude login's usage. `configHome` = a managed login's home (undefined =
 * the ambient ~/.claude login). Returns real numbers only for full-login creds.
 */
export async function probeClaudeUsage(
  opts: { configHome?: string; now?: number; timeoutMs?: number; run?: UsageRunner } = {},
): Promise<UsageResult> {
  const now = opts.now ?? Date.now();
  if (opts.configHome) await modelLoginsFor(opts.configHome)?.sync(opts.configHome);
  const cred = claudeCredentialPath(opts.configHome);
  // Only a full-login `.credentials.json` yields usage. setup-token homes (only
  // karmax-oauth.json) or logged-out homes are reported unavailable, not probed.
  if (!hasClaudeNativeCredential(path.dirname(cred))) {
    return { ok: false, at: now, reason: opts.configHome ? 'setup-token' : 'logged-out' };
  }
  // Isolate: the probe gets the current access token and account metadata, but no
  // refresh authority. A successful refresh commonly rotates the refresh token;
  // doing that in a directory we delete would silently invalidate the real home.
  const tmp = path.join(os.tmpdir(), `karmax-usage-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const source = JSON.parse(fs.readFileSync(cred, 'utf8'));
    const oauth = source?.claudeAiOauth;
    if (oauth && typeof oauth === 'object') {
      delete oauth.refreshToken;
      delete oauth.refreshTokenExpiresAt;
      delete oauth.refresh_token;
      delete oauth.refresh_token_expires_at;
    }
    fs.writeFileSync(path.join(tmp, '.credentials.json'), JSON.stringify(source), { mode: 0o600 });
    const text = opts.run ? await opts.run(tmp) : await runUsageCli(tmp, opts.timeoutMs ?? 30_000);
    return parseUsagePanel(text, now);
  } catch (e) {
    return { ok: false, at: now, reason: `probe-failed: ${String((e as Error).message ?? e)}` };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Probe a Codex ChatGPT login through app-server. This is an account metadata
 * request only: it does not create a thread or spend a model turn. */
export async function probeCodexUsage(
  opts: { configHome?: string; now?: number; timeoutMs?: number; run?: CodexUsageRunner } = {},
): Promise<UsageResult> {
  const now = opts.now ?? Date.now();
  if (!fs.existsSync(codexCredentialPath(opts.configHome))) {
    return { ok: false, at: now, reason: opts.configHome ? 'setup-token' : 'logged-out' };
  }
  try {
    const payload = await refreshCodexLogin({
      configHome: opts.configHome,
      timeoutMs: opts.timeoutMs,
      run: opts.run,
    });
    return parseCodexRateLimits(payload, now);
  } catch (e) {
    if (e instanceof ProviderFailure && e.metadata.kind === 'credential') return { ok: false, at: now, reason: 'logged-out' };
    return { ok: false, at: now, reason: `probe-failed: ${String((e as Error).message ?? e)}` };
  }
}

/** Spawn `claude -p '/usage'` against a config dir; return combined stdout+stderr. */
function runUsageCli(configDir: string, timeoutMs: number): Promise<string> {
  const cmd = process.env.KARMAX_CLAUDE_USAGE_CMD ?? localProviderCli('claude');
  const env = scrubbedEnv({ provider: 'claude', configHome: configDir });
  return new Promise((resolve, reject) => {
    let out = '';
    let done = false;
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const child = spawn(cmd, ['-p', '/usage'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) {
      // Task-manager registry (dashboard Processes panel) — short-lived, but a
      // hung probe eating a core should be visible and killable like anything else.
      const untrack = trackProcess({ pid: child.pid, kind: 'probe', label: 'claude usage probe', startedAt: Date.now() });
      child.once('exit', untrack);
    }
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      err ? reject(err) : resolve(out);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      forceKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1_000);
      forceKill.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (b) => (out += b.toString()));
    child.stderr?.on('data', (b) => (out += b.toString()));
    child.once('error', (e) => finish(e as Error));
    child.once('exit', (code, signal) => finish(timedOut ? new Error('usage probe timed out') : code === 0 ? undefined
      : new Error(`Claude usage/login refresh process failed (${signal ?? code ?? 'unknown exit'})`)));
  });
}

/** Refresh the ONE canonical Claude login and return its current access token.
 * Remote turns call this before projection and after terminal OAuth expiry;
 * their sandboxes never receive the rotating refresh token. Concurrent calls
 * share one provider process so a refresh-token family has one writer; a
 * managed login (in the vault, data epoch 6) refreshes under its database
 * lease on a private copy, so that holds across processes and hosts too, and
 * a caller that waited takes the refresh another one completed.
 *
 * Claude Code refreshes only inside the last five minutes of an access token,
 * so a still-valid token may come back unchanged; callers must accept it. A
 * login whose tokens are gone afterwards was signed out by the provider (its
 * refresh token expired about a month after sign-in, or was revoked): that is
 * a hard credential failure a person resolves by signing in again. */
export async function refreshClaudeAccessToken(
  opts: { configHome: string; timeoutMs?: number; run?: UsageRunner; logins?: ModelLogins },
): Promise<string> {
  const key = path.resolve(opts.configHome);
  const existing = claudeRefreshes.get(key);
  if (existing) return existing;
  const logins = modelLoginsFor(key, opts.logins);
  const cli = async (home: string) => {
    if (opts.run) await opts.run(home);
    else await runUsageCli(home, opts.timeoutMs ?? 30_000).catch((error) => {
      // A signed-out login makes the CLI exit non-zero; judge the credential file.
      if (claudeAccessToken(home)) throw error;
    });
  };
  const created = (async () => {
    await logins?.sync(key);
    // The sign-in's own deadline is the real one: past it a refresh only gets
    // the login signed out (Claude Code blanks its tokens), so none is
    // attempted, and an access token that is still valid stays usable.
    const signIn = claudeSignIn(key);
    if (!signIn || signIn.signedOut || signIn.expiresAt > Date.now()) {
      if (logins) await logins.refresh(key, cli, { skipIfChanged: true });
      else await cli(key);
    }
    const token = claudeAccessToken(key);
    const expiresAt = claudeAccessTokenExpiresAt(key);
    if (!token || (expiresAt !== undefined && expiresAt <= Date.now())) throw claudeSignedOut(key);
    return token;
  })().finally(() => {
    if (claudeRefreshes.get(key) === created) claudeRefreshes.delete(key);
  });
  claudeRefreshes.set(key, created);
  return created;
}

function claudeSignedOut(configHome: string) {
  const account = path.basename(configHome).replace(/^claude-/, '');
  const message = `Claude login claude:${account} was signed out by Anthropic (its sign-in expired or was revoked); sign in again in Settings → Codex/Claude`;
  return providerFailure(message, {
    kind: 'credential',
    permanence: 'hard',
    provider: 'claude',
    diagnostic: { message, operation: 'oauth refresh' },
  });
}

/** A remote Claude home intentionally has no refresh token. Ensure the canonical
 * host access token is usable before copying that access-only projection into the
 * sandbox; otherwise Claude can reject the initial request before asking the SDK
 * for a replacement token. Returns whether a refresh was attempted. A token the
 * CLI declined to refresh still has more than Claude Code's own five-minute
 * margin, and mid-turn expiry is recovered by the adapter. */
export async function ensureClaudeAccessTokenFresh(
  opts: {
    configHome: string;
    now?: number;
    minValidityMs?: number;
    timeoutMs?: number;
    run?: UsageRunner;
    onRefresh?: () => void;
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const minValidityMs = opts.minValidityMs ?? CLAUDE_REMOTE_ACCESS_TOKEN_SAFETY_MS;
  await modelLoginsFor(opts.configHome)?.sync(opts.configHome);
  const accessToken = claudeAccessToken(opts.configHome);
  const expiresAt = claudeAccessTokenExpiresAt(opts.configHome);
  if (accessToken && expiresAt !== undefined && expiresAt - now >= minValidityMs) return false;

  opts.onRefresh?.();
  await refreshClaudeAccessToken({
    configHome: opts.configHome,
    timeoutMs: opts.timeoutMs,
    run: opts.run,
  });
  return true;
}

/** Refresh the ONE canonical Codex login and return current limits. Concurrent
 * callers share a process because OAuth refresh-token rotation is single-writer:
 * two app-servers refreshing the same token family can revoke each other's result.
 * A managed login (data epoch 6) runs its app-server on a private copy under the
 * login's database lease, so that holds across processes; a forced refresh
 * someone else completed meanwhile is taken instead (then no limits are read). */
export async function refreshCodexLogin(
  opts: { configHome?: string; timeoutMs?: number; run?: CodexUsageRunner; force?: boolean; logins?: ModelLogins } = {},
): Promise<unknown> {
  const key = path.resolve(opts.configHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const existing = codexRefreshes.get(key);
  if (existing) {
    // A passive usage read may join an already-forced refresh. A forced recovery
    // must not join a passive read that did not rotate the stale remote token;
    // serialize behind it and then perform the requested refresh.
    if (!opts.force || existing.force) return existing.promise;
    await existing.promise.catch(() => undefined);
    return refreshCodexLogin(opts);
  }
  const logins = modelLoginsFor(key, opts.logins);
  const call = (home: string | undefined) => opts.run ? opts.run(home)
    : runCodexUsageCli(home, opts.timeoutMs ?? 30_000, !!opts.force, opts.configHome);
  const created = (logins ? logins.refresh(key, call, { skipIfChanged: !!opts.force }).then(({ result }) => result) : call(opts.configHome))
    .finally(() => {
      if (codexRefreshes.get(key)?.promise === created) codexRefreshes.delete(key);
    });
  codexRefreshes.set(key, { promise: created, force: !!opts.force });
  return created;
}

/** A remote Codex projection has no usable refresh credential, so renew the one
 * canonical host login before projecting it once its access token nears expiry;
 * the sandbox still never receives refresh authority. A failed early refresh
 * keeps a still-usable token. Returns whether the token was renewed. */
export async function ensureCodexLoginFresh(
  opts: {
    configHome?: string;
    now?: number;
    refreshAheadMs?: number;
    minValidityMs?: number;
    timeoutMs?: number;
    run?: CodexUsageRunner;
    onRefresh?: () => void;
  } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const refreshAheadMs = opts.refreshAheadMs ?? CODEX_REMOTE_ACCESS_TOKEN_REFRESH_AHEAD_MS;
  const minValidityMs = opts.minValidityMs ?? CODEX_REMOTE_ACCESS_TOKEN_SAFETY_MS;
  const usable = (expiresAt: number | undefined) => expiresAt !== undefined && expiresAt - now >= minValidityMs;
  if (opts.configHome) await modelLoginsFor(opts.configHome)?.sync(opts.configHome);
  const expiresAt = codexAccessTokenExpiresAt(opts.configHome);
  if (expiresAt !== undefined && expiresAt - now >= refreshAheadMs) return false;
  opts.onRefresh?.();
  let refreshError: unknown;
  try {
    await refreshCodexLogin({
      configHome: opts.configHome,
      timeoutMs: opts.timeoutMs,
      run: opts.run,
      force: true,
    });
  } catch (error) {
    // A login the provider signed out cannot launch, however long its token lasts.
    if (error instanceof ProviderFailure) throw error;
    refreshError = error;
  }
  const refreshedExpiry = codexAccessTokenExpiresAt(opts.configHome);
  if (usable(refreshedExpiry)) return refreshedExpiry! > (expiresAt ?? -Infinity);
  // `account/read` swallows refresh errors, so a stale token after it means the
  // provider's sign-in service failed (2026-10-01: an OpenAI login outage).
  throw new ProviderOutage(`OpenAI did not renew the Codex login before this remote turn; ${BRAND} will keep retrying.`,
    { cause: refreshError });
}

/** When the sandbox's Codex will consider the access token expired: its JWT
 * `exp`, else Codex's eight-day refresh interval from `last_refresh`. */
function codexAccessTokenExpiresAt(configHome?: string): number | undefined {
  try {
    const auth = JSON.parse(fs.readFileSync(codexCredentialPath(configHome), 'utf8'));
    const token = auth?.tokens?.access_token ?? auth?.tokens?.accessToken;
    if (typeof token !== 'string') return undefined;
    try {
      const exp = Number(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))?.exp);
      if (Number.isFinite(exp) && exp > 0) return exp * 1000;
    } catch { /* an opaque token: fall back to Codex's refresh interval */ }
    const lastRefresh = Date.parse(auth?.last_refresh);
    return Number.isFinite(lastRefresh) ? lastRefresh + CODEX_TOKEN_REFRESH_INTERVAL_MS : undefined;
  } catch {
    return undefined;
  }
}

function codexSignedOut(configHome?: string) {
  const account = path.basename(path.resolve(configHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')))
    .replace(/^codex-/, '');
  const message = `Codex login codex:${account} was signed out by OpenAI (its sign-in expired or was revoked); sign in again in Settings → Codex/Claude`;
  return providerFailure(message, {
    kind: 'credential',
    permanence: 'hard',
    provider: 'codex',
    diagnostic: { message, operation: 'oauth refresh' },
  });
}

/** `login`: the login's own home, for messages, when `configHome` is a private copy of it. */
async function runCodexUsageCli(configHome: string | undefined, timeoutMs: number, force: boolean, login = configHome): Promise<unknown> {
  const cmd = process.env.KARMAX_CODEX_USAGE_CMD ?? process.env.KARMAX_CODEX_EXEC_CMD ?? localProviderCli('codex');
  const env = scrubbedEnv({ provider: 'codex', configHome });
  const custody = createCustodyEnv(env);
  const child = spawn(cmd, ['app-server'], {
    env: custody.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  });
  const client = new CodexAppServerClient(child.stdin!, child.stdout!);
  let untrack = () => {};
  if (child.pid) {
    untrack = trackProcess({ pid: child.pid, kind: 'probe', label: 'codex usage probe', startedAt: Date.now() });
  }
  child.once('error', () => client.close());
  child.once('exit', untrack);
  try {
    await withTimeout(client.request('initialize', {
      clientInfo: { name: `${BRAND}-usage-probe`, title: BRAND, version: '1.0.0' },
      capabilities: null,
    }), timeoutMs);
    client.notify('initialized');
    // A dashboard/staleness probe is read-only while the current access token is
    // healthy. Previously every dashboard view forced OAuth rotation, which could
    // invalidate access-only projections already running in remote task worlds.
    if (!force) {
      try {
        return await withTimeout(client.request('account/rateLimits/read'), timeoutMs);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).toLowerCase();
        if (!(/\b401\b|unauthorized|access denied|not logged in|authentication required|\btoken\b.*\bexpired\b|\bexpired\b.*\btoken\b/.test(message))) {
          // A timeout, transport break, or provider 5xx says nothing about the
          // credential. Report the probe failure without rotating OAuth.
          throw error;
        }
      }
    }
    // This host home is the sole owner of the rotating refresh credential;
    // remote task projections never receive it.
    // app-server reports no refresh error; a permanent one leaves no account.
    const account = await withTimeout(client.request('account/read', { refreshToken: true }), timeoutMs) as
      { account?: unknown } | undefined;
    if (account?.account === null) throw codexSignedOut(login);
    return await withTimeout(client.request('account/rateLimits/read'), timeoutMs);
  } finally {
    client.close();
    if (child.pid) await killAgent(child.pid, 2500, custody.custodyId);
    else if (!child.killed) child.kill();
  }
}

/** A subscription credential is usage-pollable iff it has the provider's full
 * native login. API keys have billing rather than subscription quota windows. */
export function isUsagePollable(cred: { provider?: string; kind?: string; configHome?: string }): boolean {
  if (cred.kind === 'key') return false;
  const home = cred.kind === 'ambient' ? undefined : cred.configHome;
  if (cred.provider === 'claude') return fs.existsSync(claudeCredentialPath(home));
  if (cred.provider === 'codex') return fs.existsSync(codexCredentialPath(home));
  return false;
}
