import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

const webDir = path.join(process.cwd(), 'web');
const regressions = fs.readdirSync(webDir)
  .filter((name) => name.endsWith('.test.cjs'))
  .sort();

describe('browser regression suite', () => {
  for (const file of regressions) {
    it(file, () => {
      execFileSync(process.execPath, [path.join(webDir, file)], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      });
    });
  }
});
