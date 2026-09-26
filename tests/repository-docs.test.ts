import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('repository guidance', () => {
  it('keeps one authoritative agent guide', () => {
    expect(read('AGENTS.md').trim()).toBe('See [CLAUDE.md](CLAUDE.md) for the repository guidance.');
    expect(read('CLAUDE.md')).toContain('Coordinators have no version pin');
  });

  it('documents that paid suites require an explicit opt-in', () => {
    expect(read('TESTING.md')).toContain('KARMAX_RUN_LIVE=1');
    expect(read('CLAUDE.md')).toContain('KARMAX_RUN_LIVE=1');
  });
});
