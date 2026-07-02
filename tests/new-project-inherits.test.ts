import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for the branch-inheritance bug: new projects were created
 * with a hardcoded `defaultBase/defaultTarget: 'main'`, which bakes a
 * project-scope override that shadows the global default (e.g. "master").
 *
 * The fix is client-side (web/app.js `newProject`) and in the first-run seed
 * (src/main.ts), neither of which is reachable from the server end-to-end tests,
 * so we assert on the source directly: project creation must NOT inject a branch
 * default — it must pass an empty config so branches inherit from global settings.
 */
describe('new projects inherit branch defaults (no baked "main")', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('the New Project UI creates a project with an empty config', () => {
    const app = read('../web/app.js');
    const m = app.match(/async function newProject\(\)[\s\S]*?\n}/);
    expect(m, 'newProject() should exist').toBeTruthy();
    const fn = m![0];
    // It must POST an empty config, never a hardcoded branch default assignment.
    expect(fn).toMatch(/config:\s*\{\s*\}/);
    expect(fn).not.toMatch(/defaultBase\s*:/);
    expect(fn).not.toMatch(/defaultTarget\s*:/);
  });

  it('the first-run seed project is created with an empty config', () => {
    const main = read('../src/main.ts');
    const m = main.match(/createProject\('My project',[^)]*\)/);
    expect(m, "seed createProject('My project', ...) should exist").toBeTruthy();
    const call = m![0];
    expect(call).toMatch(/createProject\('My project',\s*\{\s*\}\s*\)/);
    expect(call).not.toMatch(/defaultBase\s*:/);
    expect(call).not.toMatch(/defaultTarget\s*:/);
  });
});
