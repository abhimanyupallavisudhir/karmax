import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldProviderConnectionService } from '../src/world/connections.js';

describe('organization cloud provider connections', () => {
  it.each(['http://localhost:8080/api', 'https://127.0.0.1/api', 'https://private.example/api'])('rejects custom hosted control-plane endpoints (WD-15): %s', async apiUrl => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-provider-url-'));
    const store = await Store.create(':memory:');
    Object.defineProperty(store, 'hosted', { value: true });
    const service = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(dir)));
    try {
      await expect(service.save({ organizationId: 'org_personal', provider: 'daytona', apiKey: 'secret', config: { apiUrl } }))
        .rejects.toThrow('hosted Daytona');
    } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps keys write-only, supports safe rotation, and removes vault material on disconnect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-provider-vault-'));
    const store = (await Store.create(':memory:'));
    const broker = new CredentialBroker(new Vault(dir));
    const service = new WorldProviderConnectionService(store, broker);
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));

    const saved = (await service.save({ organizationId: organization.id, provider: 'e2b', apiKey: 'e2b-secret-one',
      config: { template: 'node-22' } }));
    expect(saved).toMatchObject({ provider: 'e2b', credentialConfigured: true, config: { template: 'node-22' } });
    expect(JSON.stringify((await service.list(organization.id)))).not.toContain('e2b-secret-one');
    for (const file of fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()))
      expect(fs.readFileSync(path.join(file.parentPath, file.name), 'utf8')).not.toContain('e2b-secret-one');
    expect((await service.resolve(organization.id, 'e2b')).apiKey).toBe('e2b-secret-one');

    // Omitting both key and template preserves them; sending a new key rotates
    // the same opaque handle instead of leaving an orphan secret behind.
    (await service.save({ organizationId: organization.id, provider: 'e2b', name: 'Production' }));
    expect((await service.resolve(organization.id, 'e2b')).config.template).toBe('node-22');
    (await service.save({ organizationId: organization.id, provider: 'e2b', apiKey: 'e2b-secret-two' }));
    expect((await service.resolve(organization.id, 'e2b')).apiKey).toBe('e2b-secret-two');

    const handle = saved.credentialHandle;
    (await service.delete(organization.id, 'e2b'));
    expect(broker.hasHandle(handle)).toBe(false);
    expect((await service.list(organization.id))).toEqual([]);
    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not silently use a machine-wide fallback when an organization connection is disabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-provider-disabled-'));
    const store = (await Store.create(':memory:'));
    const service = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(dir)));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const prior = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = 'machine-fallback';
    try {
      (await service.save({ organizationId: organization.id, provider: 'e2b', apiKey: 'tenant-key', enabled: false }));
      await expect((async () => (await service.resolve(organization.id, 'e2b')))()).rejects.toThrow(/disabled/);
    } finally {
      if (prior === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = prior;
      (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never uses an installation-wide provider key for an unconnected hosted organization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-provider-hosted-'));
    const store = (await Store.create(':memory:', { hosted: true }));
    const service = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(dir)));
    const organization = (await store.createOrganization({ name: 'Tenant', ownerUserId: 'owner' }));
    const previousDeployment = process.env.KARMAX_DEPLOYMENT;
    const previousKey = process.env.E2B_API_KEY;
    delete process.env.KARMAX_DEPLOYMENT;
    process.env.E2B_API_KEY = 'installation-secret';
    try {
      await expect((async () => (await service.resolve(organization.id, 'e2b')))()).rejects.toThrow(/not connected/);
      (await service.save({ organizationId: organization.id, provider: 'e2b', apiKey: 'tenant-secret' }));
      expect((await service.resolve(organization.id, 'e2b')).apiKey).toBe('tenant-secret');
    } finally {
      if (previousDeployment === undefined) delete process.env.KARMAX_DEPLOYMENT;
      else process.env.KARMAX_DEPLOYMENT = previousDeployment;
      if (previousKey === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = previousKey;
      (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps credentials out of provider metadata URLs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-provider-url-'));
    const store = (await Store.create(':memory:'));
    const service = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(dir)));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    await expect((async () => (await service.save({ organizationId: organization.id, provider: 'daytona', apiKey: 'secret',
      config: { apiUrl: 'https://user:password@daytona.example/api' } })))()).rejects.toThrow(/must not contain credentials/);
    expect((await service.list(organization.id))).toEqual([]);
    (await store.close()); fs.rmSync(dir, { recursive: true, force: true });
  });
});
