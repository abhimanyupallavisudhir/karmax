import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');

describe('fork-source task picker', () => {
  // Selection behavior is exercised by web/agent-picker.test.cjs, which
  // web-regressions.test.ts runs in CI. It covers delayed single-agent
  // selection, attempts, sub-tasks and stale responses without relying on
  // local variable names or the source formatting of activate().
  it('describes the direct and multiple-agent selection paths', () => {
    expect(app).toContain('click a task to fork its agent, or choose one when it has multiple agents.');
  });
});
