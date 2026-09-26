import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWebRegression } from './helpers/run-web-regression.js';

const webDir = path.join(process.cwd(), 'web');
const regressions = fs.readdirSync(webDir)
  .filter((name) => name.endsWith('.test.cjs'))
  .sort();

describe('browser regression suite', () => {
  for (const file of regressions) {
    it(file, () => {
      runWebRegression(path.join(webDir, file));
    });
  }
});

it('terminates a browser regression that never exits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-web-hang-'));
  try {
    const script = path.join(dir, 'hang.cjs');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    expect(() => runWebRegression(script, 100)).toThrow();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
