import fs from 'node:fs';
import { afterAll, expect, vi } from 'vitest';

// Every test file runs in one process with one module graph (vitest.config.ts:
// isolate: false), and vi.mock only reaches modules evaluated after it. So a
// file that mocks a module an earlier file already loaded silently tests the
// real one, and the file after it inherits modules bound to its mock: CI failed
// or passed depending on how the shards happened to order files. A file that
// mocks modules therefore starts on a fresh graph and leaves a fresh one behind.
const testPath = expect.getState().testPath;
if (testPath && /\bvi\.(?:mock|doMock)\(/.test(fs.readFileSync(testPath, 'utf8'))) {
  vi.resetModules();
  afterAll(() => { vi.resetModules(); });
}
