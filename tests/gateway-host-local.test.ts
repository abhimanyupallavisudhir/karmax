import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

/**
 * Server-side mirror of `web/host-local.test.cjs`.
 *
 * The console gates every host-machine affordance on `hostLocal()`, and that
 * file asserts it. The gateway gated three host-FILESYSTEM endpoints on `hosted`
 * instead — and `hosted` and `hostLocal` are orthogonal (`src/config/deployment.ts`):
 * a self-host served on a public URL is `hosted:false, hostLocal:false`. The
 * buttons were hidden while the endpoints still worked, so a remote caller
 * holding `project:settings:write` could `importDirectory('/etc')` (or `~/.ssh`)
 * and download it back as a resource revision.
 *
 * Boots a real Gateway with stub deps — no Temporal, no worker.
 */
describe('host-filesystem endpoints follow hostLocal, not hosted', () => {
  let home: string;
  let store: Store;
  let projectId: string;
  let base: string;
  let token: string;
  let close: () => Promise<void>;
  /** Written into the "host" so a successful import would be visible. */
  let hostSecrets: string;

  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-hostlocal-'));
    hostSecrets = path.join(home, 'private');
    fs.mkdirSync(hostSecrets);
    fs.writeFileSync(path.join(hostSecrets, 'id_rsa'), 'PRIVATE-KEY-BYTES');

    store = (await Store.create(':memory:'));
    projectId = (await store.createProject('Acme', { repos: [home] } as any)).id;
    // A resource the import routes can target.
    (await store.createResourceAttachment({ id: 'res_1', organizationId: 'org_personal', projectId,
      name: 'Secrets', driver: 'volume@1', target: { kind: 'path', path: '.secrets' } as any,
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [], publish: 'discard' } as any));

    const imported: string[] = [];
    const gateway = (await Gateway.create({
      store,
      bus: new KarmaxBus(),
      tokens: new TokenAuthority(),
      contributions: new ContributionRegistry(),
      overlays: new Overlays(),
      client: {} as any,
      api: {} as any,
      taskQueue: 'test',
      staticDir: home,
      agentInfo: { provider: 'mock', reason: 'host-local test' },
      worlds: new WorldRegistry(),
      // NOT hosted — the exact deployment shape the old `hosted` gate missed.
      hosted: false,
      hostLocal: false,
      resources: {
        storageLocationFor: () => undefined,
        importDirectory: async (_id: string, dir: string) => { imported.push(dir); return { id: 'rev_1', files: [] }; },
        importFiles: async () => ({ id: 'rev_2', files: [] }),
      } as any,
    } as any));
    (globalThis as any).__imported = imported;
    const running = await gateway.listen(await findFreePortFrom(48_300));
    base = running.url;
    close = running.close;
    token = (await (await fetch(`${base}/api/session`)).json() as any).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refuses a host directory import when karmax is not on the caller’s machine', async () => {
    const created = await fetch(`${base}/api/projects/${projectId}/resources`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'Steal', driver: 'volume@1', target: '.stolen', sourcePath: hostSecrets }),
    });
    expect(created.status).toBe(400);
    expect((await created.json() as any).error).toMatch(/upload|your machine/i);

    const imported = await fetch(`${base}/api/projects/${projectId}/resources/res_1/import`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ sourcePath: hostSecrets }),
    });
    expect(imported.status).toBe(400);
    expect((await imported.json() as any).error).toMatch(/upload|your machine/i);

    // The decisive assertion: the host filesystem was never read.
    expect((globalThis as any).__imported).toEqual([]);
  });

  it('does not scan the host checkout for a caller that is not the host', async () => {
    const scanned = await fetch(`${base}/api/projects/${projectId}/resources/scan`, { headers: auth() });
    expect(scanned.status).toBe(200);
    const body = await scanned.json() as any;
    expect(body.proposals).toEqual([]);
    expect(body.note).toMatch(/not running on your machine/i);
  });

  it('does not migrate copyGlobs off the host checkout for a caller that is not the host', async () => {
    // The fourth host-filesystem route, missed when the other three were fixed:
    // migrateCopyGlobs readdirs the project's repo roots on the HOST and turns the
    // matches into resources that materialize into the task world, where the caller
    // reads them straight out of a terminal. It was gated on `hosted`, which is
    // false here — so this returned 200 and handed over the host's files.
    const migrated = await fetch(`${base}/api/projects/${projectId}/resources/import-copyglobs`, {
      method: 'POST', headers: auth(), body: JSON.stringify({}),
    });
    expect(migrated.status).toBe(400);
    expect((await migrated.json() as any).error).toMatch(/local or managed checkout/i);
  });

  it('withdraws host remote-access control (tailscale/pkexec) off-machine', async () => {
    const status = await fetch(`${base}/api/remote-access`, { headers: auth() });
    expect(status.status).toBe(503);
    const enabled = await fetch(`${base}/api/remote-access`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ action: 'enable' }),
    });
    expect(enabled.status).toBe(503);
  });
});
