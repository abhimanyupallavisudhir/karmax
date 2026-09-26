import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const previous = process.env.KARMAX_HOME;
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vitest-'));
process.env.KARMAX_HOME = isolated;

afterAll(() => {
  if (previous === undefined) delete process.env.KARMAX_HOME;
  else process.env.KARMAX_HOME = previous;
  fs.rmSync(isolated, { recursive: true, force: true });
});
