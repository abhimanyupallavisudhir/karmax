import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Every file shares one module graph (vitest.config.ts: isolate: false), where
// vi.mock only reaches modules evaluated after it. Run the suite's own process
// model over three files in a fixed order: a file loads a module chain for
// real, the next mocks the chain's leaf, the last expects the real one again.
it('keeps module mocks from depending on which files ran before or after', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-module-mocks-')), 'report.json');
  const { FORCE_COLOR: _color, ...env } = process.env;
  await promisify(execFile)(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', 'tests/fixtures/module-mocks/vitest.config.ts', '--reporter=json', `--outputFile=${report}`],
  { cwd: root, env: { ...env, NO_COLOR: '1' }, timeout: 120_000 }).catch(() => undefined);
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  expect({ passed: result.numPassedTests, failed: result.numFailedTests }).toEqual({ passed: 3, failed: 0 });
  fs.rmSync(path.dirname(report), { recursive: true, force: true });
}, 150_000);
