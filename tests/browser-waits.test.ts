import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Playwright's waitForFunction treats the predicate's return value as the
// condition. An async predicate returns a Promise, which is always truthy, so
// the "wait" ends on its first poll. A browser test that waited for its own
// save that way raced the save and failed master CI #955.
describe('browser test waits', () => {
  it('never give waitForFunction an async predicate', () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') scan(file);
          continue;
        }
        if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/waitForFunction\(\s*async\b/g))
          offenders.push(`${path.relative(process.cwd(), file)}:${source.slice(0, match.index).split('\n').length}`);
      }
    };
    for (const dir of ['tests', 'web', 'scripts', 'benchmarks']) scan(path.resolve(dir));
    expect(offenders).toEqual([]);
  });
});
