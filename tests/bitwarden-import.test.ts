import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { importBitwardenExport, parseBitwardenExport } from '../src/autonomy/bitwarden-import.js';
import { Vault } from '../src/autonomy/vault.js';
import { VaultItems, VaultItemStore } from '../src/autonomy/vault-items.js';

describe('Bitwarden JSON export import', () => {
  const exported = {
    encrypted: false,
    folders: [{ id: 'folder-1', name: 'Work' }],
    items: [
      {
        id: 'login-1',
        folderId: 'folder-1',
        type: 1,
        name: 'GitHub',
        notes: 'recovery information',
        login: {
          username: 'octo',
          password: 'hunter2',
          totp: 'otpauth://totp/GitHub?secret=SEED',
          uris: [{ uri: 'https://github.com/login' }, { uri: 'androidapp://com.github.android' }],
        },
      },
      { id: 'note-1', type: 2, name: 'Recovery codes', notes: 'one\ntwo' },
      {
        id: 'ssh-1',
        type: 5,
        name: 'Deploy key',
        sshKey: {
          privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret',
          publicKey: 'ssh-ed25519 public',
          keyFingerprint: 'SHA256:example',
        },
      },
      { id: 'card-1', type: 3, name: 'Card', card: { number: '4111111111111111' } },
    ],
  };

  it('normalizes supported secrets and reports unsupported entries', () => {
    const result = parseBitwardenExport(exported);

    expect(result.items).toEqual([
      {
        externalId: 'login-1',
        type: 'login',
        label: 'GitHub',
        username: 'octo',
        domains: ['github.com'],
        folder: 'Work',
        secrets: {
          password: 'hunter2',
          totp: 'otpauth://totp/GitHub?secret=SEED',
        },
      },
      {
        externalId: 'note-1',
        type: 'note',
        label: 'Recovery codes',
        domains: [],
        folder: '',
        secrets: { note: 'one\ntwo' },
      },
      {
        externalId: 'ssh-1',
        type: 'ssh-key',
        label: 'Deploy key',
        domains: [],
        folder: '',
        secrets: { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret' },
      },
    ]);
    expect(result.skipped).toEqual([
      { externalId: 'card-1', label: 'Card', reason: 'unsupported Bitwarden item type 3' },
    ]);
  });

  it('rejects encrypted and malformed exports before importing anything', () => {
    expect(() => parseBitwardenExport({ encrypted: true, data: 'ciphertext' })).toThrow(
      /encrypted Bitwarden exports are not supported.*plaintext JSON/i,
    );
    expect(() => parseBitwardenExport({ folders: [] })).toThrow(/items array/i);
    expect(() => parseBitwardenExport('not an export')).toThrow(/JSON export object/i);
  });

  it('skips entries without a stable export id or a usable secret', () => {
    const result = parseBitwardenExport({
      encrypted: false,
      items: [
        { type: 1, name: 'No id', login: { password: 'secret' } },
        { id: 'empty', type: 1, name: 'No password', login: { username: 'alice' } },
      ],
    });
    expect(result.items).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual([
      'item has no stable Bitwarden id',
      'item contains no supported secret',
    ]);
  });

  it('imports into encrypted vault storage and re-imports by Bitwarden id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-bw-import-'));
    const kv = new Map<string, string>();
    const store: VaultItemStore = {
      kvGet: (key) => kv.get(key),
      kvSet: (key, value) => void kv.set(key, value),
      appendAudit: () => 0,
    };
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const vault = new VaultItems(store, broker, path.join(dir, 'state'));

    const first = (await importBitwardenExport(vault, exported, { use: 'ask', reveal: 'never' }));
    expect(first).toMatchObject({ count: 3, created: 3, updated: 0 });
    expect((await vault.list())).toHaveLength(3);
    expect((await vault.findByExternal('import:bitwarden', 'login-1'))).toMatchObject({
      label: 'GitHub',
      tags: ['Bitwarden/Work'],
      policy: { use: 'ask', reveal: 'never' },
    });

    const changed = structuredClone(exported);
    changed.items[0]!.login!.password = 'rotated';
    const second = (await importBitwardenExport(vault, changed));
    expect(second).toMatchObject({ count: 3, created: 0, updated: 3 });
    expect((await vault.list())).toHaveLength(3);
    const login = (await vault.findByExternal('import:bitwarden', 'login-1'))!;
    expect((await vault.resolveField(login, 'password', { mode: 'reveal' }))).toBe('rotated');
    // Re-import updates secrets without resetting a policy the user selected.
    expect(login.policy).toEqual({ use: 'ask', reveal: 'never' });
  });
});
