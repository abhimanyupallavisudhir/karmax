import { expect, it } from 'vitest';
import { sourceTextAssertions, testFiles } from './helpers/source-text-assertions.js';

/**
 * Tests that assert on the text of src/ or web/ pass while the behaviour is
 * broken and fail when the code is reworded (CI-15). These files still do,
 * with at most this many such assertions each. The list may only shrink: a
 * new file must test behaviour instead (render UI with
 * tests/helpers/console-page.ts, or run the extracted function), and a file
 * that converts leaves the list. Lower a number when you remove assertions.
 */
const REMAINING: Record<string, number> = {
  'tests/account-diagnostics-ui.test.ts': 5,
  'tests/gateway-safe-mode.test.ts': 1,
  'tests/google-signin.test.ts': 2,
  'tests/memory-guard.test.ts': 1,
  'tests/provider-connections-ui.test.ts': 9,
  'tests/task-picker-ui.test.ts': 1,
  'tests/ui-agent-settings.test.ts': 5,
  'tests/ui-deverbosification.test.ts': 9,
  'tests/user-git-settings-ui.test.ts': 22,
  'tests/vault-import.test.ts': 25,
  'tests/web-confirmer.test.ts': 10,
};

it('adds no assertions on source text, and lists only files that still have them', () => {
  const found = Object.fromEntries(testFiles().map((file) => [file, sourceTextAssertions(file)] as const)
    .filter(([, count]) => count > 0));
  const grown = Object.entries(found).filter(([file, count]) => count > (REMAINING[file] ?? 0))
    .map(([file, count]) => `${file}: ${count} (allowed ${REMAINING[file] ?? 0})`);
  expect(grown, 'these assert on source text; test the behaviour instead').toEqual([]);
  const stale = Object.entries(REMAINING).filter(([file, count]) => (found[file] ?? 0) < count)
    .map(([file, count]) => `${file}: ${found[file] ?? 0} (listed ${count})`);
  expect(stale, 'lower these numbers (or drop the file) so the list keeps shrinking').toEqual([]);
});

it('recognises an assertion on source text but not on behaviour', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-ratchet-'));
  const file = path.join(dir, 'sample.test.ts');
  // Interpolated, so this file's own text is not a source read.
  const [web, src] = ['web', 'src'];
  fs.writeFileSync(file, `
    const app = fs.readFileSync(path.resolve('${web}/app.js'), 'utf8');
    const section = app.slice(app.indexOf('function a('), app.indexOf('function b('));
    const run = new Function('esc', section + '; return a;');
    expect(section).toContain('literal');
    expect(app).not.toMatch(/old/);
    expect(fs.readFileSync('${src}/main.ts', 'utf8')).toContain('x');
    expect(run(String)('input')).toContain('rendered');
    expect(await page.locator('main').innerText()).toContain('visible');
  `);
  try { expect(sourceTextAssertions(file)).toBe(3); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
