import { expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { VaultItems, itemHandle } from '../src/autonomy/vault-items.js';
import { AgentMail, ingestSecret, ingestScope } from '../src/autonomy/agent-mail.js';
import { INSTALLATION_SCOPE, organizationScope } from '../src/autonomy/vault-keys.js';

it('deletes organization secrets, inbox routes and key files without touching peers (AU-15, AU-1)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-cleanup-'));
  const store = await Store.create(':memory:');
  try {
    const { deleteOrganizationAutonomy } = await import('../src/autonomy/cleanup.js');
    const org = await store.createOrganization({ name: 'Deleted' });
    const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    const vault = new VaultItems(store, broker, home, org.id);
    const item = await vault.save({ type: 'ssh-key', label: 'Key', envVar: 'APP_KEY', secrets: { privateKey: 'key' } });
    // A host copy of the key, as versions before AU-33 kept one.
    const legacyKey = path.join(home, 'vault-items', item.id, 'key');
    fs.mkdirSync(path.dirname(legacyKey), { recursive: true });
    fs.writeFileSync(legacyKey, 'key');
    const mail = new AgentMail(store);
    const address = await mail.address(org.id);
    const secret = await ingestSecret(store, org.id);
    await mail.ingest({ to: address, from: 'a@example.com', text: 'code 123456' });
    const handles = [`connector:${org.id}:test:auth`, `mailbox:imap:${org.id}:auth`];
    for (const handle of handles) await broker.registerHandle(handle, 'private', organizationScope(org.id));
    await broker.registerHandle('other:secret', 'private', INSTALLATION_SCOPE);
    // A peer organization's secret, and one of this organization's that no cleanup step names.
    const peer = await store.createOrganization({ name: 'Peer' });
    await broker.registerHandle(`world-provider:${peer.id}:e2b:api-key`, 'peer', organizationScope(peer.id));
    await broker.registerHandle(`world-provider:${org.id}:e2b:api-key`, 'forgotten', organizationScope(org.id));
    await broker.registerHandle(`world-provider:${org.id}:e2b:api-key`, 'forgotten-2', organizationScope(org.id));
    await store.createCard({ id: 'cleanup-card', provider: 'vault-card', scope: 'organization', scopeId: org.id, label: 'Card', cap: 100, available: 100, createdAt: Date.now() });
    await broker.registerHandle('payment:card:cleanup-card', 'PAN', organizationScope(org.id));
    const keyring = (id: string) => path.join(home, 'vault', 'keys', `${crypto.createHash('sha256').update(`organization:${id}`).digest('hex')}.json`);
    expect(fs.existsSync(keyring(org.id))).toBe(true);
    await deleteOrganizationAutonomy(store, broker, org.id, home);
    await deleteOrganizationAutonomy(store, broker, org.id, home);
    expect(await broker.hasHandle(itemHandle(item.id, 'privateKey'))).toBe(false);
    expect(await broker.hasHandle('payment:card:cleanup-card')).toBe(false);
    expect(await broker.hasHandle(handles[0]!)).toBe(false);
    expect(await broker.hasHandle(handles[1]!)).toBe(false);
    expect(await broker.hasHandle('other:secret')).toBe(true);
    // SS-1: crypto-shredded: the organization's data key is gone with everything under it.
    expect(await broker.hasHandle(`world-provider:${org.id}:e2b:api-key`)).toBe(false);
    expect(fs.existsSync(keyring(org.id))).toBe(false);
    expect(await broker.resolve(`world-provider:${peer.id}:e2b:api-key`, { caps: ['use-credential:*'] })).toBe('peer');
    expect(fs.existsSync(legacyKey)).toBe(false);
    expect(await mail.ownerOf(address)).toBeUndefined();
    expect(await ingestScope(store, secret)).toBeUndefined();
    expect(await mail.recent(org.id)).toEqual([]);
  } finally { await store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('allows an empty organization without a broker but retains metadata if secret cleanup is unavailable (AU-15)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-cleanup-empty-'));
  const store = await Store.create(':memory:');
  try {
    const { deleteOrganizationAutonomy } = await import('../src/autonomy/cleanup.js');
    const org = await store.createOrganization({ name: 'Empty' });
    await expect(deleteOrganizationAutonomy(store, undefined, org.id, home)).resolves.toBeUndefined();
    const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    const vault = new VaultItems(store, broker, home, org.id);
    const item = await vault.save({ type: 'login', label: 'Retained', secrets: { password: 'retained-secret' } });
    await expect(deleteOrganizationAutonomy(store, undefined, org.id, home)).rejects.toThrow(/broker/);
    expect(await vault.get(item.id)).toBeDefined();
    expect(await broker.hasHandle(itemHandle(item.id, 'password'))).toBe(true);
  } finally { await store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
