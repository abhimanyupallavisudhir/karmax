import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { VaultItems } from '../src/autonomy/vault-items.js';

it('retains both vault metadata updates when independent requests save concurrently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-async-concurrency-'));
  const store = await Store.create();
  try {
    const service = new VaultItems(store, new CredentialBroker(new Vault(path.join(dir, 'vault'))), path.join(dir, 'state'));
    const created = await Promise.all([
      service.save({ type: 'note', label: 'First concurrent item' }),
      service.save({ type: 'note', label: 'Second concurrent item' }),
    ]);
    expect((await service.list()).map(item => item.id).sort()).toEqual(created.map(item => item.id).sort());
  } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
