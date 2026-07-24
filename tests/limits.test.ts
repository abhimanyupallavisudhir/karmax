import { describe, it, expect } from 'vitest';
import {
  ProviderFailure,
  classifyLimitError,
  isTransportError,
  isResourceKill,
  providerErrorFromMessage,
  providerFailure,
  resetAtFromHint,
} from '../src/agent/limits.js';

describe('classifyLimitError', () => {
  it('classifies a Claude session-limit string + extracts the reset hint', () => {
    const c = classifyLimitError("You've hit your session limit · resets 3:45pm");
    expect(c.limited).toBe(true);
    expect(c.window).toBe('5h');
    expect(c.resetHint).toBe('3:45pm');
  });

  it('classifies a weekly-limit string', () => {
    const c = classifyLimitError("You've hit your weekly limit · resets Mon 12:00am");
    expect(c.limited).toBe(true);
    expect(c.window).toBe('weekly');
    expect(c.resetHint?.toLowerCase()).toContain('mon');
  });

  it('captures a Codex machine-readable resets-in-seconds hint', () => {
    const c = classifyLimitError('Codex usage limit reached · resets in 1800s');
    expect(c.limited).toBe(true);
    expect(c.resetHint).toContain('1800');
  });

  it('classifies a model-specific (Opus) limit', () => {
    const c = classifyLimitError("You've hit your Opus limit · resets 3:45pm");
    expect(c.limited).toBe(true);
    expect(c.window).toBe('model');
    expect(c.note).toBe('opus');
  });

  it('treats a raw 429 / rate-limit as limited (default 5h)', () => {
    expect(classifyLimitError('Anthropic API 429: too many requests').limited).toBe(true);
    expect(classifyLimitError('OpenAI Responses API 429: rate limit exceeded').window).toBe('5h');
  });

  it('flags a HARD billing/quota-exhaustion error (needs a human, not a refresh)', () => {
    const c = classifyLimitError('OpenAI Responses API 429: {"error":{"type":"insufficient_quota","message":"You exceeded your current quota, check your plan and billing"}}');
    expect(c.limited).toBe(true);
    expect(c.hard).toBe(true);
  });

  it('flags Claude Code usage-credit exhaustion as a HARD limit (task #151)', () => {
    const c = classifyLimitError(
      "Claude Code returned an error result: You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
    );
    expect(c.limited).toBe(true);
    expect(c.hard).toBe(true);
  });

  it('generalizes novel provider wording by nearby state+noun phrase families', () => {
    const hard = classifyLimitError('Your prepaid balance has now been fully consumed.', { providerOrigin: true });
    expect(hard).toMatchObject({ limited: true, hard: true, kind: 'quota' });

    const transient = classifyLimitError('Your monthly allowance is exhausted; resets tomorrow.', { providerOrigin: true });
    expect(transient).toMatchObject({ limited: true, kind: 'quota' });
    expect(transient.hard).toBeFalsy();
  });

  it('keeps semantic matching scoped to provider-originated failures', () => {
    expect(classifyLimitError('tests failed: expected the credit balance depleted banner')).toEqual({ limited: false });
    expect(classifyLimitError('git hook quota calculation failed')).toEqual({ limited: false });
  });

  it('preserves typed provider metadata and distinguishes structured signals from prose', () => {
    const inferred = providerErrorFromMessage('claude', 'No credits remaining for this account.');
    expect(inferred).toBeInstanceOf(ProviderFailure);
    expect((inferred as ProviderFailure).metadata).toMatchObject({
      kind: 'quota', permanence: 'hard', provider: 'claude', source: 'message',
    });

    const structured = providerFailure('provider event: UsageLimitReached', {
      kind: 'quota', permanence: 'transient', provider: 'codex', resetHint: 'in 90s',
    });
    expect(structured.metadata).toMatchObject({
      kind: 'quota', permanence: 'transient', provider: 'codex', source: 'structured', resetHint: 'in 90s',
    });
  });

  it('a plain rate-limit is transient, not hard', () => {
    const c = classifyLimitError('Anthropic API 429: rate limit exceeded, retry after 30s');
    expect(c.limited).toBe(true);
    expect(c.hard).toBeFalsy();
  });

  it('does not flag unrelated errors', () => {
    expect(classifyLimitError('ENOENT: no such file').limited).toBe(false);
    expect(classifyLimitError('git merge conflict in foo.ts').limited).toBe(false);
  });
});

describe('resetAtFromHint', () => {
  const now = Date.UTC(2026, 6, 3, 10, 0, 0); // fixed reference instant

  it('falls back conservatively when the hint is missing', () => {
    expect(resetAtFromHint(undefined, '5h', now)).toBe(now + 5 * 3_600_000);
    expect(resetAtFromHint(undefined, 'weekly', now)).toBe(now + 7 * 24 * 3_600_000);
  });

  it('falls back on an unparseable hint', () => {
    expect(resetAtFromHint('soon-ish', '5h', now)).toBe(now + 5 * 3_600_000);
  });

  it('parses a clock time to a future instant at that local time', () => {
    const at = resetAtFromHint('3:45pm', '5h', now);
    expect(at).toBeGreaterThan(now);
    expect(at).toBeLessThanOrEqual(now + 24 * 3_600_000);
    const d = new Date(at);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(45);
  });

  it('parses relative "in Ns / N minutes / N hours" hints (Codex resets_in_seconds)', () => {
    expect(resetAtFromHint('in 3600s', '5h', now)).toBe(now + 3600 * 1000);
    expect(resetAtFromHint('in 90 minutes', 'weekly', now)).toBe(now + 90 * 60_000);
    expect(resetAtFromHint('in 3 hours', '5h', now)).toBe(now + 3 * 3_600_000);
  });

  it('parses a weekday hint to that upcoming day', () => {
    const at = resetAtFromHint('Mon 12:00am', 'weekly', now);
    expect(at).toBeGreaterThan(now);
    expect(at).toBeLessThanOrEqual(now + 8 * 24 * 3_600_000);
    const d = new Date(at);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(0);
  });
});

describe('isTransportError', () => {
  it('recognizes the suspend/stream failures seen in production', () => {
    expect(isTransportError('Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete.')).toBe(true);
    expect(isTransportError('fetch failed')).toBe(true);
    expect(isTransportError('read ECONNRESET')).toBe(true);
    expect(isTransportError('connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
    expect(isTransportError('Anthropic API 529: {"error":{"type":"overloaded_error"}}')).toBe(true);
    expect(isTransportError('Anthropic API 503: upstream connect error')).toBe(true);
  });

  it('recognizes provider reconnects, DNS/TLS failures, and temporary host pressure', () => {
    // Exact terminal error from task #225 (the remaining text was provider logs).
    expect(isTransportError('codex app-server turn failed: Reconnecting... 1/5 · failed to refresh available models: timeout waiting for child process to exit')).toBe(true);
    expect(isTransportError('Temporary failure in name resolution')).toBe(true);
    expect(isTransportError('TLS handshake timeout')).toBe(true);
    expect(isTransportError('upstream service unavailable (HTTP 503)')).toBe(true);
    expect(isTransportError('Claude provider server_error: temporarily unavailable')).toBe(true);
    expect(isTransportError('spawn EAGAIN')).toBe(true);
    expect(isTransportError('EMFILE: too many open files')).toBe(true);
  });

  it('does NOT swallow agent/semantic errors into the retry path', () => {
    expect(isTransportError('boom goes the agent')).toBe(false);
    expect(isTransportError('mock failure')).toBe(false);
    expect(isTransportError('tests failed: 3 assertion errors in merge.test.ts')).toBe(false);
    expect(isTransportError('no agent adapter for provider "codex"')).toBe(false);
    expect(isTransportError('ENOSPC: no space left on device')).toBe(false);
    expect(isTransportError('EACCES: permission denied')).toBe(false);
  });

  it('leaves quota signals to the limit classifier (429 is not transport)', () => {
    expect(isTransportError('Anthropic API 429: too many requests')).toBe(false);
  });
});

describe('isResourceKill (OOM / signal-9 predicate — karmax#4)', () => {
  it('classifies the opaque SDK SIGKILL string the OOM killer produced', () => {
    // The exact string the July-5 activity failed with.
    expect(isResourceKill('Claude Code process terminated by signal SIGKILL')).toBe(true);
  });

  it('recognizes signal-9 and explicit out-of-memory signatures', () => {
    expect(isResourceKill('process terminated by signal 9')).toBe(true);
    expect(isResourceKill('Killed by signal 9')).toBe(true);
    expect(isResourceKill('spawn ENOMEM')).toBe(true);
    expect(isResourceKill('fork failed: Cannot allocate memory')).toBe(true);
    expect(isResourceKill('the host is out of memory')).toBe(true);
    expect(isResourceKill('oom-killed by systemd-oomd')).toBe(true);
  });

  it('does NOT classify ordinary agent/semantic failures as resource kills', () => {
    expect(isResourceKill('boom goes the agent')).toBe(false);
    expect(isResourceKill('tests failed: 3 assertion errors')).toBe(false);
    expect(isResourceKill("You've hit your session limit · resets 3:45pm")).toBe(false);
    expect(isResourceKill('Anthropic API 429: too many requests')).toBe(false);
    // A graceful SIGTERM (cancellation) is not an OOM kill.
    expect(isResourceKill('process terminated by signal SIGTERM')).toBe(false);
  });
});
