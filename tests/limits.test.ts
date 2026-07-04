import { describe, it, expect } from 'vitest';
import { classifyLimitError, resetAtFromHint } from '../src/agent/limits.js';

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

  it('parses a weekday hint to that upcoming day', () => {
    const at = resetAtFromHint('Mon 12:00am', 'weekly', now);
    expect(at).toBeGreaterThan(now);
    expect(at).toBeLessThanOrEqual(now + 8 * 24 * 3_600_000);
    const d = new Date(at);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(0);
  });
});
