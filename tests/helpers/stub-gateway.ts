import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway, type GatewayDeps } from '../../src/gateway/server.js';
import { Store } from '../../src/store/db.js';
import { TokenAuthority } from '../../src/platform/tokens.js';
import { KarmaxBus } from '../../src/contrib/bus.js';
import { ContributionRegistry } from '../../src/contrib/registry.js';
import { Overlays } from '../../src/store/overlays.js';
import { WorldRegistry } from '../../src/world/registry.js';

let nextPort = 48300;

/** Real HTTP boundary, with no Temporal or paid providers. */
export async function stubGateway(overrides: Partial<GatewayDeps> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-gateway-regression-'));
  const store = overrides.store ?? await Store.create(':memory:');
  const tokens = overrides.tokens ?? new TokenAuthority(store);
  const gateway = await Gateway.create({ store, tokens, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(),
    client: {} as any, api: {} as any, taskQueue: 'test', staticDir: home,
    agentInfo: { provider: 'mock', reason: 'regression test' }, worlds: new WorldRegistry(),
    ...overrides });
  const running = await gateway.listen(nextPort++);
  return { gateway, store, tokens, base: running.internalUrl, async close() {
    await running.close(); await store.close(); fs.rmSync(home, { recursive: true, force: true });
  } };
}
