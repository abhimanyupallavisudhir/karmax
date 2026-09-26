import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { liveEnabled } from './helpers/live-gate.js';

describe('paid live suite gate', () => {
  it('requires explicit opt-in even when provider credentials exist', () => {
    expect(liveEnabled({ OPENAI_API_KEY: 'key', E2B_API_KEY: 'key' })).toBe(false);
    expect(liveEnabled({ KARMAX_RUN_LIVE: '1', OPENAI_API_KEY: 'key' })).toBe(true);
    expect(liveEnabled({ KARMAX_RUN_LIVE: 'true', OPENAI_API_KEY: 'key' })).toBe(false);
  });
});

it('routes every paid provider suite through the explicit live gate', () => {
  for (const file of ['live-providers', 'claude-permission', 'daytona-live', 'daytona-environment-live']) {
    const source = fs.readFileSync(new URL(`./${file}.test.ts`, import.meta.url), 'utf8');
    expect(source, file).toContain('liveEnabled()');
    expect(source, file).not.toContain('KARMAX_SKIP_LIVE');
  }
});
