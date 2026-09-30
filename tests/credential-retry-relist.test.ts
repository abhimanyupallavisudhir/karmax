import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { retryCredentials } from '../src/agent/credential-health.js';
import { SIG_RELIST_ACCOUNT_LEASES } from '../src/coordinators/names.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

// A turn whose credential policy could not be read parks on an allow-list no
// credential matches, so resetting credentials alone never frees it. Retry has
// to make parked turns read their policy again (WF-35).
it('asks parked turns to read their credential policy again on Retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-retry-relist-')); dirs.push(dir);
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Retry');
    const task = await store.createTask({ projectId: project.id, title: 'Parked', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } });
    const signals: string[] = [];
    const client = { workflow: { getHandle: () => ({
      signal: async (name: string) => { signals.push(name); },
      executeUpdate: async () => undefined,
    }) } } as any;
    await retryCredentials({ store, client, taskQueue: 'test', configHomes: new ConfigHomeManager(dir) }, task, 'claude');
    expect(signals).toContain(SIG_RELIST_ACCOUNT_LEASES);
  } finally { await store.close(); }
});
