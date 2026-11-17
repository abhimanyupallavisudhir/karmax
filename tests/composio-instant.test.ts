// Composio Instant (wiki features/service-connections § Paid tools): with the
// operator's switch on, a paid tool nobody in the organization has an account
// for is usable at once; each call holds a bound on the organization's credit
// and is booked at what Composio says it charged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ServiceConnections, type ConnectionBackend } from '../src/integrations/service-connections.js';
import { computeCredit, startComputeTrial } from '../src/world/managed-compute.js';

describe('paid tools through Composio Instant', () => {
  let home: string, store: Store, broker: CredentialBroker, service: ServiceConnections, backend: ConnectionBackend;
  let org: string, project: string;
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'composio-instant-'));
    store = await Store.create(':memory:', { hosted: true });
    broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    org = (await store.createOrganization({ name: 'Team', ownerUserId: 'alice' })).id;
    project = (await store.createProject('Project', {}, org)).id;
    await startComputeTrial(store, org, 'alice', Date.now() - 1000);
    backend = { catalog: vi.fn(async () => []), authorize: vi.fn(async () => ({ id: 'ca_1', url: 'https://connect.composio.dev/link/x' })),
      active: vi.fn(async () => true), session: vi.fn(async () => 'session-own'),
      tools: vi.fn(async () => [{ slug: 'EXA_SEARCH', name: 'Search' }]),
      execute: vi.fn(async () => ({ result_type: 'completed', data: { results: [] }, error: null, log_id: 'log_1',
        instant_charge: { amount: '0.0125', currency: 'USD', charged_by: 'composio' } })),
      disconnect: vi.fn(async () => {}),
      instantSupported: vi.fn(async (toolkit: string) => toolkit === 'exa'),
      instantSession: vi.fn(async () => 'session-instant') };
    service = new ServiceConnections(store, broker, () => backend);
    await service.configure('project-key');
  });
  afterEach(async () => { await store.close(); fs.rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('is off until the operator switches it on, and needs the Composio key', async () => {
    expect(await service.instantEnabled()).toBe(false);
    expect((await service.request(org, 'exa', 'task_a', 'do', 'Search the web')).status).toBe('requested');
    const bare = new ServiceConnections(store, broker, () => backend);
    await store.kvDelete('service-connections:composio:api-key').catch(() => undefined);
    await broker.deleteHandle('service-connections:composio:api-key');
    await expect(bare.setInstant(true)).rejects.toThrow(/Composio key first/);
  });

  it('makes a supported tool usable at once, with no request for anyone to answer', async () => {
    await service.setInstant(true);
    const c = await service.request(org, 'exa', 'task_a', 'do', 'Search the web');
    expect(c).toMatchObject({ status: 'active', instant: true, toolkit: 'exa', taskId: 'task_a' });
    expect((await store.eventsSince('task_a', 0)).map((event) => event.type)).not.toContain('connection.requested');
    // An app Instant cannot pay for is still requested from a person.
    expect((await service.request(org, 'gmail', 'task_a', 'do', 'Read mail')).status).toBe('requested');
  });

  it('prefers an account someone in the organization connected', async () => {
    const request = await service.request(org, 'exa', 'task_own', 'do', 'Search');
    expect(request.instant).toBeUndefined();
    await service.connect(org, 'alice', { id: request.id });
    await service.refresh(org, request.id);
    await service.setInstant(true);
    expect((await service.request(org, 'exa', 'task_b', 'do', 'Search')).instant).toBeUndefined();
  });

  it('holds a bound on the credit for each call and books what Composio charged', async () => {
    await service.setInstant(true);
    const c = await service.request(org, 'exa', 'task_a', 'do', 'Search the web');
    let heldDuringCall = 0;
    vi.mocked(backend.execute).mockImplementationOnce(async () => {
      heldDuringCall = (await computeCredit(store, org)).heldMicros;
      return { result_type: 'completed', data: {}, error: null, log_id: 'log_1', instant_charge: { amount: '0.0125', currency: 'USD', charged_by: 'composio' } };
    });
    await service.execute(org, c.id, 'task_a', project, 'EXA_SEARCH', { query: 'agents' });
    expect(backend.instantSession).toHaveBeenCalledWith(expect.stringMatching(/^karmax_[0-9a-f]{64}$/), 'exa');
    expect(backend.execute).toHaveBeenCalledWith('session-instant', 'EXA_SEARCH', { query: 'agents' });
    expect(heldDuringCall).toBe(1_000_000); // $0.50 at Composio's prices × the compute multiplier
    const credit = await computeCredit(store, org);
    expect(credit).toMatchObject({ heldMicros: 0, byProvider: [{ provider: 'composio', usedMicros: 25_000, seconds: 0 }] });
    // The session is made once.
    await service.execute(org, c.id, 'task_a', project, 'EXA_SEARCH', {});
    expect(backend.instantSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a call the credit cannot cover, and says when the operator\'s wallet is empty', async () => {
    await service.setInstant(true);
    const c = await service.request(org, 'exa', 'task_a', 'do', 'Search');
    vi.mocked(backend.execute).mockRejectedValueOnce(Object.assign(new Error('Metering_WalletBalanceExhausted'), { status: 402 }));
    await expect(service.execute(org, c.id, 'task_a', project, 'EXA_SEARCH', {})).rejects.toThrow(/paid-tools balance at Composio has run out, not your credit/);
    expect((await computeCredit(store, org)).heldMicros).toBe(0);
    const broke = (await store.createOrganization({ name: 'Broke', ownerUserId: 'bob' })).id;
    const other = await service.request(broke, 'exa', 'task_b', 'do', 'Search');
    await expect(service.execute(broke, other.id, 'task_b', project, 'EXA_SEARCH', {})).rejects.toMatchObject({ status: 402 });
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('stops paid calls when the operator switches it off', async () => {
    await service.setInstant(true);
    const c = await service.request(org, 'exa', 'task_a', 'do', 'Search');
    await service.setInstant(false);
    await expect(service.execute(org, c.id, 'task_a', project, 'EXA_SEARCH', {})).rejects.toThrow(/switched off/);
  });
});
