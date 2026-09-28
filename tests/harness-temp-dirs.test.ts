import fs from 'node:fs';
import os from 'node:os';
import { expect, it } from 'vitest';
import { bootHarness } from './helpers/harness.js';

// The dev server's orphan records share one fixed directory across boots.
const tempEntries = () => new Set(fs.readdirSync(os.tmpdir())
  .filter((name) => name.startsWith('karmax-') && name !== 'karmax-temporal-ephemeral'));

// Every integration file boots this harness, so whatever it leaves in the
// temp directory accumulates once per file on every run (CI-19).
it('removes every temp directory it created when it stops', async () => {
  const before = tempEntries();
  const h = await bootHarness('mock');
  try {
    await h.makeRepo('cleanup');
    await h.startGateway();
  } finally {
    await h.stop();
  }
  expect([...tempEntries()].filter((name) => !before.has(name))).toEqual([]);
}, 120_000);
