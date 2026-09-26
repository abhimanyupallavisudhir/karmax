import { describe, expect, it } from 'vitest';
import { liveEnabled } from './helpers/live-gate.js';

describe('paid live suite gate', () => {
  it('requires explicit opt-in even when provider credentials exist', () => {
    expect(liveEnabled({ OPENAI_API_KEY: 'key', E2B_API_KEY: 'key' })).toBe(false);
    expect(liveEnabled({ KARMAX_RUN_LIVE: '1', OPENAI_API_KEY: 'key' })).toBe(true);
    expect(liveEnabled({ KARMAX_RUN_LIVE: 'true', OPENAI_API_KEY: 'key' })).toBe(false);
  });
});
