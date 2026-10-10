import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';

describe('credential broker audit retention', () => {
  it('keeps the newest 1000 attempts in order', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-broker-audit-'));
    try {
      const broker = new CredentialBroker(new Vault(path.join(directory, 'vault')));
      for (let i = 0; i < 1005; i++) {
        try { await broker.resolve(`missing-${i}`, { caps: [] }); } catch { /* expected denial */ }
      }
      const entries = broker.audit_log();
      expect(entries).toHaveLength(1000);
      expect(entries[0]?.handle).toBe('missing-5');
      expect(entries.at(-1)?.handle).toBe('missing-1004');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
