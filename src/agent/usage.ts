import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { scrubbedEnv } from '../autonomy/config-homes.js';

/**
 * Proactive quota (RESOLVE-PLAN §2 / #6). `claude -p '/usage'` prints a parseable
 * subscription panel — session %, weekly %, per-model %, each with a reset instant
 * and timezone. We shell it out per login and surface real numbers on the dashboard,
 * so the user isn't blind to quota until an agent hits a wall (the reactive path).
 *
 * IMPORTANT feasibility facts (verified 2026-07-04, Claude Code 2.1.201):
 *  - The panel renders ONLY for a login with a full interactive-login
 *    `.credentials.json` (broad OAuth scopes). A `claude setup-token` credential
 *    authenticates inference but its usage query returns nothing (header only) — so
 *    setup-token logins report `unavailable` here and fall back to reactive tracking.
 *  - Codex has NO usage command at all → never pollable (reactive only).
 * The probe runs in a throwaway config dir holding only a COPY of the login's
 * `.credentials.json`, so it never races or mutates a home an agent may be leasing.
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
  /** Why no numbers — 'setup-token' | 'logged-out' | 'not-subscription' | 'probe-failed' | 'not-pollable'. */
  reason: string;
}

export type UsageResult = UsageSnapshot | UsageUnavailable;

/** Injectable runner (tests): given the probe args, return combined stdout+stderr. */
export type UsageRunner = (configDir: string) => Promise<string>;

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
function credentialPath(configHome?: string): string {
  return path.join(configHome ?? path.join(os.homedir(), '.claude'), '.credentials.json');
}

/**
 * Probe a Claude login's usage. `configHome` = a managed login's home (undefined =
 * the ambient ~/.claude login). Returns real numbers only for full-login creds.
 */
export async function probeClaudeUsage(
  opts: { configHome?: string; now?: number; timeoutMs?: number; run?: UsageRunner } = {},
): Promise<UsageResult> {
  const now = opts.now ?? Date.now();
  const cred = credentialPath(opts.configHome);
  // Only a full-login `.credentials.json` yields usage. setup-token homes (only
  // karmax-oauth.json) or logged-out homes are reported unavailable, not probed.
  if (!fs.existsSync(cred)) {
    return { ok: false, at: now, reason: opts.configHome ? 'setup-token' : 'logged-out' };
  }
  // Isolate: run against a throwaway dir holding only a copy of the credential, so
  // we never race or mutate a home an agent may be leasing.
  const tmp = path.join(os.tmpdir(), `karmax-usage-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    fs.copyFileSync(cred, path.join(tmp, '.credentials.json'));
    const text = opts.run ? await opts.run(tmp) : await runUsageCli(tmp, opts.timeoutMs ?? 30_000);
    return parseUsagePanel(text, now);
  } catch (e) {
    return { ok: false, at: now, reason: `probe-failed: ${String((e as Error).message ?? e)}` };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Spawn `claude -p '/usage'` against a config dir; return combined stdout+stderr. */
function runUsageCli(configDir: string, timeoutMs: number): Promise<string> {
  const cmd = process.env.KARMAX_CLAUDE_USAGE_CMD ?? 'claude';
  const env = scrubbedEnv({ provider: 'claude', configHome: configDir });
  return new Promise((resolve, reject) => {
    let out = '';
    let done = false;
    const child = spawn(cmd, ['-p', '/usage'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(out);
    };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } finish(new Error('usage probe timed out')); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (b) => (out += b.toString()));
    child.stderr?.on('data', (b) => (out += b.toString()));
    child.once('error', (e) => finish(e as Error));
    child.once('exit', () => finish());
  });
}

/** A credential is Claude-usage-pollable iff it has a full-login `.credentials.json`. */
export function isUsagePollable(cred: { provider?: string; kind?: string; configHome?: string }): boolean {
  if (cred.provider !== 'claude') return false; // codex/keys have no /usage
  if (cred.kind === 'key') return false;
  return fs.existsSync(credentialPath(cred.kind === 'ambient' ? undefined : cred.configHome));
}
