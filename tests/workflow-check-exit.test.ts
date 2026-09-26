import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';

let store: Store;
afterEach(async () => { vi.restoreAllMocks(); await store?.close(); });
async function fixture() {
  store = await Store.create(':memory:');
  const worlds = new WorldRegistry();
  const world = await worlds.create('memory', { taskId: 'bounds', base: 'main' });
  vi.spyOn(worlds, 'open').mockResolvedValue(world);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  return { core, world };
}

it('RT-8 preserves the failing test exit code through tail', async () => {
  const { core, world } = await fixture();
  vi.spyOn(world, 'exec').mockImplementation(async (_command, args) => {
    if (!args?.join(' ').includes('npm test')) return { code: 0, stdout: 'yes', stderr: '' };
    const command = args.at(-1)!.replace('npm test --silent', "bash -c 'echo failing-fixture; exit 7'");
    try { const r = await promisify(execFile)('bash', ['-lc', command]); return { ...r, code: 0 }; }
    catch (e: any) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  });
  expect(await core.runWorkflowChecks({ taskId: 'bounds', worldHandle: world.handle }))
    .toEqual({ passed: false, detail: 'failing-fixture\n' });
});

