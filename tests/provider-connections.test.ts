import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldProviderConnectionService } from '../src/world/connections.js';

describe('organization cloud provider connections', () => {
  it('keeps keys write-only, supports safe rotation, and removes vault material on disconnect', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-provider-vault-'));
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const service = new WorldProviderConnectionService(store, broker);
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });

    const saved = service.save({ organizationId: organization.id, provider: 'e2b', apiKey: 'e2b-secret-one',
      config: { template: 'node-22' } });
    expect(saved).toMatchObject({ provider: 'e2b', credentialConfigured: true, config: { template: 'node-22' } });
    expect(JSON.stringify(service.list(organization.id))).not.toContain('e2b-secret-one');
    expect(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toContain('e2b-secret-one');
    expect(service.resolve(organization.id, 'e2b').apiKey).toBe('e2b-secret-one');

    // Omitting both key and template preserves them; sending a new key rotates
    // the same opaque handle instead of leaving an orphan secret behind.
    service.save({ organizationId: organization.id, provider: 'e2b', name: 'Production' });
    expect(service.resolve(organization.id, 'e2b').config.template).toBe('node-22');
    service.save({ organizationId: organization.id, provider: 'e2b', apiKey: 'e2b-secret-two' });
    expect(service.resolve(organization.id, 'e2b').apiKey).toBe('e2b-secret-two');

    const handle = saved.credentialHandle;
    service.delete(organization.id, 'e2b');
    expect(broker.hasHandle(handle)).toBe(false);
    expect(service.list(organization.id)).toEqual([]);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not silently use a machine-wide fallback when an organization connection is disabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-provider-disabled-'));
    const store = new Store(':memory:');
    const service = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(dir)));
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const prior = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = 'machine-fallback';
    try {
      service.save({ organizationId: organization.id, provider: 'e2b', apiKey: 'tenant-key', enabled: false });
      expect(() => service.resolve(organization.id, 'e2b')).toThrow(/disabled/);
    } finally {
      if (prior === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = prior;
      store.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps credentials out of provider metadata URLs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-provider-url-'));
    const store = new Store(':memory:');
    const service = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(dir)));
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    expect(() => service.save({ organizationId: organization.id, provider: 'daytona', apiKey: 'secret',
      config: { apiUrl: 'https://user:password@daytona.example/api' } })).toThrow(/must not contain credentials/);
    expect(service.list(organization.id)).toEqual([]);
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
