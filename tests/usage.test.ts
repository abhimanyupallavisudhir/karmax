import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseUsagePanel,
  parseCodexRateLimits,
  labelToEpoch,
  probeClaudeUsage,
  probeCodexUsage,
  isUsagePollable,
  isUsageStale,
  USAGE_TTL_MS,
} from '../src/agent/usage.js';

/**
 * Hermetic verification of the proactive-quota parser + probe (#6). The panel text
 * is a captured `claude -p '/usage'` fixture (middle-dot `·` separator, real dates),
 * so this burns ZERO quota and needs no CLI. The probe path is driven by an injected
 * runner over a temp credential file.
 */

// Real `claude -p '/usage'` output (subscription, full-login credential).
const FULL_PANEL = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 3% used · resets Jul 5, 2:19am (Europe/London)',
  'Current week (all models): 1% used · resets Jul 9, 12:59pm (Europe/London)',
  'Current week (Fable): 0% used · resets Jul 9, 12:59pm (Europe/London)',
  '',
  "What's contributing to your limits usage?",
  'Last 24h · 688 requests · 8 sessions',
  '  90% of your usage was at >150k context',
].join('\n');

// A setup-token login: the header renders but the usage query returns no numbers.
const HEADER_ONLY = 'You are currently using your subscription to power your Claude Code usage';

// A logged-out home: `/usage` falls through to the print-mode stats footer.
const STATS_FOOTER = [
  'Total cost:            $0.0000',
  'Total duration (API):  0s',
  'Usage:                 0 input, 0 output, 0 cache read, 0 cache write',
].join('\n');

const NOW = Date.UTC(2026, 6, 4, 18, 0, 0); // Jul 4 2026, 18:00 UTC

const CODEX_LIMITS = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor((NOW + 2 * 60 * 60_000) / 1000) },
    secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: Math.floor((NOW + 5 * 86_400_000) / 1000) },
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor((NOW + 2 * 60 * 60_000) / 1000) },
      secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: Math.floor((NOW + 5 * 86_400_000) / 1000) },
    },
    codex_spark: {
      limitId: 'codex_spark',
      limitName: 'GPT Spark',
      primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: Math.floor((NOW + 6 * 86_400_000) / 1000) },
      secondary: null,
    },
  },
};

describe('parseUsagePanel', () => {
  it('parses session %, weekly %, per-model %, resets + timezone', () => {
    const r = parseUsagePanel(FULL_PANEL, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session).toMatchObject({ pct: 3, resetLabel: 'Jul 5, 2:19am', tz: 'Europe/London' });
    expect(r.week).toMatchObject({ pct: 1, resetLabel: 'Jul 9, 12:59pm', tz: 'Europe/London' });
    // The (all models) row is the `week` field, NOT a per-model row.
    expect(r.models).toEqual([
      expect.objectContaining({ name: 'Fable', pct: 0, resetLabel: 'Jul 9, 12:59pm', tz: 'Europe/London' }),
    ]);
    // Reset instants are in the future and same-day-ish for the session.
    expect(r.session!.resetAt!).toBeGreaterThan(NOW);
    expect(r.session!.resetAt!).toBeLessThan(NOW + 2 * 86_400_000);
  });

  it('flags a setup-token login (header, no numbers) as unavailable/setup-token', () => {
    const r = parseUsagePanel(HEADER_ONLY, NOW);
    expect(r).toEqual({ ok: false, at: NOW, reason: 'setup-token' });
  });

  it('flags a logged-out home (stats footer) as unavailable/not-subscription', () => {
    const r = parseUsagePanel(STATS_FOOTER, NOW);
    expect(r).toEqual({ ok: false, at: NOW, reason: 'not-subscription' });
  });

  it('clamps out-of-range percentages', () => {
    const r = parseUsagePanel('Current session: 250% used · resets Jul 5, 2:19am (Europe/London)', NOW);
    expect(r.ok && r.session?.pct).toBe(100);
  });
});

describe('parseCodexRateLimits', () => {
  it('maps Codex rolling + weekly windows and per-model buckets to dashboard usage', () => {
    const r = parseCodexRateLimits(CODEX_LIMITS, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session).toMatchObject({ pct: 12, resetLabel: '', resetAt: NOW + 2 * 60 * 60_000 });
    expect(r.week).toMatchObject({ pct: 34, resetLabel: '', resetAt: NOW + 5 * 86_400_000 });
    expect(r.models).toEqual([
      expect.objectContaining({ name: 'GPT Spark', pct: 7, resetAt: NOW + 6 * 86_400_000 }),
    ]);
  });

  it('labels a sole multi-day window as weekly and accepts the legacy single-bucket view', () => {
    const r = parseCodexRateLimits({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: Math.floor((NOW + 86_400_000) / 1000) },
      },
    }, NOW);
    expect(r.ok && r.session).toBeUndefined();
    expect(r.ok && r.week).toMatchObject({ pct: 3, resetAt: NOW + 86_400_000 });
  });

  it('reports an unavailable snapshot when the server returns no quota windows', () => {
    expect(parseCodexRateLimits({ rateLimits: {} }, NOW)).toEqual({ ok: false, at: NOW, reason: 'no-rate-limits' });
  });
});

describe('labelToEpoch', () => {
  it('resolves a clock label in its timezone to a future instant', () => {
    const at = labelToEpoch('Jul 5, 2:19am', 'Europe/London', NOW);
    expect(at).toBeGreaterThan(NOW);
    const d = new Date(at!);
    // Europe/London is UTC+1 in July → 2:19am local = 01:19 UTC.
    expect(d.getUTCHours()).toBe(1);
    expect(d.getUTCMinutes()).toBe(19);
  });

  it('rolls a past-looking month into next year (Dec→Jan boundary)', () => {
    const dec = Date.UTC(2026, 11, 31, 12, 0, 0); // Dec 31 2026
    const at = labelToEpoch('Jan 2, 10am', 'Europe/London', dec);
    expect(at).toBeGreaterThan(dec);
    expect(new Date(at!).getUTCFullYear()).toBe(2027);
  });

  it('returns undefined for an unparseable label', () => {
    expect(labelToEpoch('soon-ish', 'Europe/London', NOW)).toBeUndefined();
  });
});

describe('isUsageStale', () => {
  const fresh = () => {
    const r = parseUsagePanel(FULL_PANEL, NOW);
    if (!r.ok) throw new Error('fixture must parse');
    return r;
  };

  it('a never-probed login is stale', () => {
    expect(isUsageStale(undefined, NOW)).toBe(true);
  });

  it('a fresh snapshot with future resets is not stale', () => {
    expect(isUsageStale(fresh(), NOW + 60_000)).toBe(false);
  });

  it('outliving the TTL makes it stale even with future resets', () => {
    expect(isUsageStale(fresh(), NOW + USAGE_TTL_MS + 1)).toBe(true);
  });

  it('a window that already reset makes it stale within the TTL', () => {
    // Session resets Jul 5 2:19am London (01:19 UTC); probe at NOW (Jul 4 18:00 UTC),
    // look again just past the reset — well inside the TTL relative to nothing, but
    // the % now describes a window that no longer exists.
    const snap = { ...fresh(), at: NOW };
    const justPastReset = snap.session!.resetAt! + 1;
    // Re-stamp `at` so only the reset (not the TTL) can trip staleness.
    snap.at = justPastReset - 60_000;
    expect(isUsageStale(snap, justPastReset)).toBe(true);
  });

  it('a fresh failed probe is not stale (no hammering); an old one is', () => {
    const fail = { ok: false as const, at: NOW, reason: 'probe-failed: boom' };
    expect(isUsageStale(fail, NOW + 60_000)).toBe(false);
    expect(isUsageStale(fail, NOW + USAGE_TTL_MS + 1)).toBe(true);
  });
});

describe('probeClaudeUsage', () => {
  const mkHome = (withCred: boolean) => {
    const home = path.join(os.tmpdir(), `karmax-usage-test-${crypto.randomBytes(5).toString('hex')}`);
    fs.mkdirSync(home, { recursive: true });
    if (withCred) fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
    return home;
  };

  it('probes a full-login home via the injected runner and parses the panel', async () => {
    const home = mkHome(true);
    try {
      const r = await probeClaudeUsage({ configHome: home, now: NOW, run: async () => FULL_PANEL });
      expect(r.ok).toBe(true);
      expect(r.ok && r.session?.pct).toBe(3);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports setup-token (no .credentials.json) without running the CLI', async () => {
    const home = mkHome(false);
    let ran = false;
    try {
      const r = await probeClaudeUsage({ configHome: home, now: NOW, run: async () => { ran = true; return FULL_PANEL; } });
      expect(r).toEqual({ ok: false, at: NOW, reason: 'setup-token' });
      expect(ran).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('surfaces a probe failure as unavailable/probe-failed', async () => {
    const home = mkHome(true);
    try {
      const r = await probeClaudeUsage({ configHome: home, now: NOW, run: async () => { throw new Error('boom'); } });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toContain('probe-failed');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('probeCodexUsage', () => {
  const mkHome = (withCred: boolean) => {
    const home = path.join(os.tmpdir(), `karmax-codex-usage-test-${crypto.randomBytes(5).toString('hex')}`);
    fs.mkdirSync(home, { recursive: true });
    if (withCred) fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    return home;
  };

  it('reads rate limits through the injected app-server request without a model turn', async () => {
    const home = mkHome(true);
    try {
      const r = await probeCodexUsage({ configHome: home, now: NOW, run: async () => CODEX_LIMITS });
      expect(r.ok).toBe(true);
      expect(r.ok && r.session?.pct).toBe(12);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('performs the initialize + account/rateLimits/read app-server handshake', async () => {
    const home = mkHome(true);
    const stub = path.join(home, 'codex-usage-stub.cjs');
    const oldCmd = process.env.KARMAX_CODEX_USAGE_CMD;
    const oldExpected = process.env.STUB_EXPECTED_CODEX_HOME;
    fs.writeFileSync(stub, `#!/usr/bin/env node
const readline = require('readline');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let initialized = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    initialized = true;
    send({ id: msg.id, result: {} });
  } else if (msg.method === 'account/rateLimits/read') {
    if (!initialized || process.env.CODEX_HOME !== process.env.STUB_EXPECTED_CODEX_HOME) {
      send({ id: msg.id, error: { code: -1, message: 'bad probe environment' } });
    } else {
      send({ id: msg.id, result: ${JSON.stringify(CODEX_LIMITS)} });
    }
  }
});
`);
    fs.chmodSync(stub, 0o755);
    process.env.KARMAX_CODEX_USAGE_CMD = stub;
    process.env.STUB_EXPECTED_CODEX_HOME = home;
    try {
      const r = await probeCodexUsage({ configHome: home, now: NOW, timeoutMs: 2_000 });
      expect(r.ok && r.week?.pct).toBe(34);
    } finally {
      if (oldCmd === undefined) delete process.env.KARMAX_CODEX_USAGE_CMD;
      else process.env.KARMAX_CODEX_USAGE_CMD = oldCmd;
      if (oldExpected === undefined) delete process.env.STUB_EXPECTED_CODEX_HOME;
      else process.env.STUB_EXPECTED_CODEX_HOME = oldExpected;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('requires a native auth.json and does not launch app-server without one', async () => {
    const home = mkHome(false);
    let ran = false;
    try {
      const r = await probeCodexUsage({ configHome: home, now: NOW, run: async () => { ran = true; return CODEX_LIMITS; } });
      expect(r).toEqual({ ok: false, at: NOW, reason: 'setup-token' });
      expect(ran).toBe(false);
      expect(isUsagePollable({ provider: 'codex', kind: 'login', configHome: home })).toBe(false);
      fs.writeFileSync(path.join(home, 'auth.json'), '{}');
      expect(isUsagePollable({ provider: 'codex', kind: 'login', configHome: home })).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
