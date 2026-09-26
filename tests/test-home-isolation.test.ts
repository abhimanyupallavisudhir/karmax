import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { paths } from '../src/config/paths.js';

it('pins the implicit Karmax home to a disposable per-file directory', () => {
  const home = process.env.KARMAX_HOME;
  expect(home).toBeDefined();
  expect(home!.startsWith(path.join(os.tmpdir(), 'karmax-vitest-'))).toBe(true);
  expect(fs.statSync(home!).isDirectory()).toBe(true);
  expect(paths().home).toBe(path.resolve(home!));
  expect(home).not.toBe(path.join(os.homedir(), '.karmax'));
});
