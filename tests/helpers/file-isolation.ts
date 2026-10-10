import fs from 'node:fs';
import { afterAll, expect, vi } from 'vitest';

// Every test file runs in one process with one module graph (vitest.config.ts:
// isolate: false), so whatever a file leaves behind reaches every later file.
// CI shards order files by measured duration, so such a leak stays hidden until
// a new file reshuffles the shards (it did, twice).

// vi.mock only reaches modules evaluated after it: a file that mocks a module an
// earlier file already loaded silently tests the real one, and the file after
// it inherits modules bound to its mock. Such a file starts on a fresh graph and
// leaves a fresh one behind.
const testPath = expect.getState().testPath;
if (testPath && /\bvi\.(?:mock|doMock)\(/.test(fs.readFileSync(testPath, 'utf8'))) {
  vi.resetModules();
  afterAll(() => { vi.resetModules(); });
}

// Environment variables and globals (assigned directly or stubbed) return to
// what this file started with. The file's own afterAll hooks run first.
// vi.stubEnv writes through a proxy whose deletes reach the process.env object
// Vitest started with, so a file that replaces it (`process.env = {...}`) would
// leave every later vi.unstubAllEnvs() unable to remove a stub (CI #1650:
// git-transfer's size limit outlived its test). Put that object back first.
const originalEnvironment: NodeJS.ProcessEnv = ((globalThis as Record<symbol, unknown>)[Symbol.for('karmax.test.processEnv')] ??= process.env) as NodeJS.ProcessEnv;
const environment = { ...process.env };
afterAll(() => {
  if (process.env !== originalEnvironment) process.env = originalEnvironment;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
});
