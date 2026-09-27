import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Every file shares one module graph (vitest.config.ts: isolate: false), where
// vi.mock only reaches modules evaluated after it. Run the suite's own process
// model over three files in a fixed order: a file loads a module chain for
// real, the next mocks the chain's leaf, the last expects the real one again.
it('keeps module mocks from depending on which files ran before or after', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const result = await promisify(execFile)(process.execPath,
    [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'tests/fixtures/module-mocks/vitest.config.ts'],
    { cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, timeout: 120_000 },
  ).catch((error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
  expect(`${result.stdout}\n${result.stderr}`).toMatch(/Tests\s+3 passed \(3\)/);
}, 150_000);
