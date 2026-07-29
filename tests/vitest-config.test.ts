import { describe, expect, it } from 'vitest';

describe('test runner configuration', () => {
  it('keeps mock-agent workflows independent of live host pressure', () => {
    expect(process.env.KARMAX_AGENT_MIN_FREE_MB).toBe('0');
    expect(process.env.KARMAX_AGENT_MAX_LOAD_FACTOR).toBe('0');
  });
});
