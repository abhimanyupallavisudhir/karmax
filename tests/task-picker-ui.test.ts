import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');

describe('fork-source task picker', () => {
  it('selects a task immediately when it has exactly one agent session', () => {
    const activate = app.match(/  const activate = async \(el\) => \{[\s\S]*?\n  \};/)?.[0];
    expect(activate, 'task-picker activate() handler should exist').toBeTruthy();
    expect(activate).toMatch(/const roles = Object\.keys\(sourceSessions\)/);
    expect(activate).toMatch(/if \(roles\.length === 1\) \{[\s\S]*?onPick\(\{ task, role, session: sourceSessions\[role\] \}\);[\s\S]*?return close\(\)/);
  });

  it('describes the direct and multiple-agent selection paths', () => {
    expect(app).toContain('click a task to fork its agent, or choose one when it has multiple agents.');
  });
});
