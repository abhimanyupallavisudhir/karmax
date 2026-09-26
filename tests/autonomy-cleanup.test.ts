import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { VaultItems, itemHandle } from '../src/autonomy/vault-items.js';
import { AgentMail, ingestSecret, ingestScope } from '../src/autonomy/agent-mail.js';

it('deletes organization secrets, inbox routes and key files without touching peers (AU-15, AU-1)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-cleanup-'));
  const store = await Store.create(':memory:');
  try {
    const { deleteOrganizationAutonomy } = await import('../src/autonomy/cleanup.js');
    const org = await store.createOrganization({ name: 'Deleted' });
    const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    const vault = new VaultItems(store, broker, home, org.id);
    const item = await vault.save({ type: 'ssh-key', label: 'Key', envVar: 'APP_KEY', secrets: { privateKey: 'key' } });
    const env = await vault.envFor('task', ['use-credential:*']);
    const mail = new AgentMail(store);
    const address = await mail.address(org.id);
    const secret = await ingestSecret(store, org.id);
    await mail.ingest({ to: address, from: 'a@example.com', text: 'code 123456' });
    const handles = [`connector:${org.id}:test:auth`, `mailbox:imap:${org.id}:auth`, 'other:secret'];
    for (const handle of handles) await broker.registerHandle(handle, 'private');
    await store.createCard({ id: 'cleanup-card', provider: 'vault-card', scope: 'organization', scopeId: org.id, label: 'Card', cap: 100, available: 100, createdAt: Date.now() });
    await broker.registerHandle('payment:card:cleanup-card', 'PAN');
    await deleteOrganizationAutonomy(store, broker, org.id, home);
    await deleteOrganizationAutonomy(store, broker, org.id, home);
    expect(broker.hasHandle(itemHandle(item.id, 'privateKey'))).toBe(false);
    expect(broker.hasHandle('payment:card:cleanup-card')).toBe(false);
    expect(broker.hasHandle(handles[0]!)).toBe(false);
    expect(broker.hasHandle(handles[1]!)).toBe(false);
    expect(broker.hasHandle('other:secret')).toBe(true);
    expect(fs.existsSync(env.APP_KEY!)).toBe(false);
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
    expect(broker.hasHandle(itemHandle(item.id, 'password'))).toBe(true);
  } finally { await store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
