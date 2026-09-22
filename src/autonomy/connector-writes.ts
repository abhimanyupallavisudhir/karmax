import { randomUUID } from 'node:crypto';
import type { CredentialBroker } from './broker.js';
import type { VaultFieldName } from './vault-items.js';

/** Routing metadata only. Creation payloads remain encrypted in the vault. */
export interface PendingConnectorWrite {
  id: string;
  connector: string;
  itemId: string;
  externalId: string;
  field?: VaultFieldName;
  target: string;
  snapshotHandle?: string;
  attempts: number;
  nextAttemptAt: number;
  error?: string;
}

interface OutboxStore {
  kvGet(key: string): (string | undefined) | Promise<string | undefined>;
  kvSet(key: string, value: string): (void) | Promise<void>;
}

export const connectorOutboxKey = (organizationId: string): string => `vault:write-outbox:${organizationId}`;

export async function readConnectorWrites(store: OutboxStore, organizationId: string): Promise<PendingConnectorWrite[]> {
  return JSON.parse((await store.kvGet(connectorOutboxKey(organizationId))) ?? '[]');
}

/** Deleting a credential also deletes encrypted copies waiting for export,
 * including when write-back is disabled and the retry worker is suspended. */
export async function deleteItemConnectorWrites(store: OutboxStore, broker: CredentialBroker | undefined,
  organizationId: string, itemId: string): Promise<void> {
  (await store.kvSet(`pass-writeback:${organizationId}:${itemId}`, JSON.stringify({ fields: {}, generation: randomUUID() })));
  const entries = (await readConnectorWrites(store, organizationId));
  const removed = entries.filter(entry => entry.itemId === itemId);
  if (!removed.length) return;
  const remaining = entries.filter(entry => entry.itemId !== itemId);
  (await store.kvSet(connectorOutboxKey(organizationId), JSON.stringify(remaining)));
  for (const entry of removed) {
    if (entry.snapshotHandle && !remaining.some(other => other.snapshotHandle === entry.snapshotHandle))
      (await broker?.deleteHandle(entry.snapshotHandle));
  }
}
