import { expect, it, vi } from 'vitest';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { stubGateway } from './helpers/stub-gateway.js';

it('binds the console while wiki provisioning is still pending (PS-7)', async () => {
  const store = await Store.create(':memory:');
  await store.createProject('Pending wiki');
  let unblock!: () => void; let started!: () => void;
  const pending = new Promise<void>(resolve => { unblock = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const spy = vi.spyOn(Gateway.prototype as any, 'ensureProjectWiki').mockImplementation(() => { started(); return pending; });
  let bound = false;
  const startup = stubGateway({ store }).then(value => { bound = true; return value; });
  try {
    await entered;
    await expect.poll(() => bound, { timeout: 300 }).toBe(true);
    expect((await fetch(`${(await startup).base}/api/health/live`)).status).toBe(200);
  } finally { unblock(); await (await startup).close(); spy.mockRestore(); }
});
