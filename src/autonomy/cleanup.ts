import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from './broker.js';
import { VaultItems } from './vault-items.js';
import { organizationScope } from './vault-keys.js';
import { paths } from '../config/paths.js';

export async function deleteAgentMail(store: Store, broker: CredentialBroker | undefined, organizationId: string): Promise<void> {
  const address = await store.kvGet(`agent-mail:address:${organizationId}`);
  for (const handle of broker?.listHandles() ?? []) {
    if (handle.startsWith('mailbox:') && handle.endsWith(`:${organizationId}:auth`)) await broker!.deleteHandle(handle);
  }
  await store.transaction(async () => {
    for (const { key, value } of await store.kvEntries('agent-mail:')) {
      if (key.endsWith(`:${organizationId}`)
        || ((key.startsWith('agent-mail:owner:') || key.startsWith('agent-mail:owner-address:') || key.startsWith('agent-mail:secret-owner:')) && value === organizationId)
        || (address && key === `agent-mail:am-cursor:${address}`)) await store.kvDelete(key);
    }
  });
}

/** Run before metadata deletion so every encrypted handle remains discoverable
 * until its destructive cleanup succeeds. All steps are safe to retry. */
export async function deleteOrganizationAutonomy(store: Store, broker: CredentialBroker | undefined,
  organizationId: string, home = paths().state): Promise<void> {
  const vault = new VaultItems(store, broker, home, organizationId);
  const items = await vault.list();
  const cards = await store.listOrganizationCards(organizationId);
  if (!broker && (items.length || cards.length
    || (await store.kvEntries(`vault:connector:${organizationId}:`)).length
    || await store.kvGet(`agent-mail:provider:${organizationId}`)))
    throw new Error('credential broker is required for organization secret cleanup');
  for (const item of items) await vault.delete(item.id);
  for (const card of cards) for (const handle of [`payment:card:${card.id}`, `payment:card:${card.id}:cvc`]) await broker!.deleteHandle(handle);
  for (const handle of broker?.listHandles() ?? []) {
    if (handle.startsWith(`connector:${organizationId}:`) || handle.startsWith(`connector-export:${organizationId}:`)) await broker!.deleteHandle(handle);
  }
  await deleteAgentMail(store, broker, organizationId);
  for (const prefix of [`vault:connector:${organizationId}:`, `vault:usage:${organizationId}:`, `pass-writeback:${organizationId}:`]) {
    for (const { key } of await store.kvEntries(prefix)) await store.kvDelete(key);
  }
  for (const key of [`vault:items:${organizationId}`, `vault:requests:${organizationId}`, `vault:write-outbox:${organizationId}`]) await store.kvDelete(key);
  fs.rmSync(path.join(home, 'connectors', 'pass-git', organizationId.replace(/[^a-zA-Z0-9._-]/g, '_')), { recursive: true, force: true });
  // Last, after every cleanup that needed a credential: crypto-shred whatever
  // the organization still owns in the vault, revisions and quarantine included (SS-1).
  await broker?.destroyScope(organizationScope(organizationId));
}
