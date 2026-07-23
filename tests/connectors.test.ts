import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { VaultItems, VaultItemStore } from '../src/autonomy/vault-items.js';
import {
  Connectors,
  BitwardenConnector,
  OnePasswordConnector,
  PassConnector,
  parsePassTree,
  type Exec,
} from '../src/autonomy/connectors.js';

function memStore(): VaultItemStore & { kv: Map<string, string> } {
  const kv = new Map<string, string>();
  return { kvGet: (k) => kv.get(k), kvSet: (k, v) => void kv.set(k, v), appendAudit: () => 0, kv };
}
function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-conn-'));
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const store = memStore();
  const items = new VaultItems(store, broker, path.join(dir, 'state'));
  return { items, broker, store };
}

// A scripted exec: maps `cmd arg0 arg1…` prefixes to canned stdout.
function scriptedExec(script: Record<string, string>): Exec {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    for (const prefix of Object.keys(script)) if (key.startsWith(prefix)) return script[prefix]!;
    throw new Error(`no scripted output for: ${key}`);
  };
}

describe('Bitwarden connector', () => {
  const bwItems = JSON.stringify([
    { id: 'bw1', type: 1, name: 'GitHub', login: { username: 'octo', password: 'p@ss', totp: 'SEED234', uris: [{ uri: 'https://github.com/login' }] } },
    { id: 'bw2', type: 2, name: 'Recovery codes', notes: 'abc-def' },
    { id: 'bw3', type: 3, name: 'A card' },
  ]);
  const exec = scriptedExec({ 'bw status': JSON.stringify({ status: 'unlocked' }), 'bw list items': bwItems });

  it('normalizes logins + notes and skips unsupported types', async () => {
    const c = new BitwardenConnector(() => 'sess', exec);
    expect((await c.describe()).available).toBe(true);
    const list = await c.list();
    expect(list.map((i) => i.externalId)).toEqual(['bw1', 'bw2']);
    const login = list.find((i) => i.externalId === 'bw1')!;
    expect(login.type).toBe('login');
    expect(login.domains).toEqual(['github.com']);
    expect(login.fields.sort()).toEqual(['password', 'totp']);
  });

  it('pulls secrets for selected items only', async () => {
    const c = new BitwardenConnector(() => 'sess', exec);
    const pulled = await c.pull(['bw1']);
    expect(pulled).toHaveLength(1);
    expect(pulled[0]!.secrets).toEqual({ password: 'p@ss', totp: 'SEED234' });
  });
});

describe('1Password connector', () => {
  const exec = scriptedExec({
    'op whoami': '{"user_uuid":"x"}',
    'op item list': JSON.stringify([{ id: 'op1', title: 'GH', category: 'LOGIN', urls: [{ href: 'https://github.com' }] }]),
    'op item get op1': JSON.stringify({ id: 'op1', title: 'GH', category: 'LOGIN', urls: [{ href: 'https://github.com' }],
      fields: [{ id: 'username', value: 'octo' }, { id: 'password', value: 'sw0rd' }, { id: 'otp', type: 'OTP', totp: '123456' }] }),
  });
  it('lists and pulls a login with its OTP', async () => {
    const c = new OnePasswordConnector(() => 'tok', exec);
    expect((await c.describe()).available).toBe(true);
    expect((await c.list())[0]!.type).toBe('login');
    const [pulled] = await c.pull(['op1']);
    expect(pulled!.username).toBe('octo');
    expect(pulled!.secrets).toEqual({ password: 'sw0rd', totp: '123456' });
  });
});

describe('pass connector', () => {
  it('parses the tree into flat store paths', () => {
    const tree = `Password Store\n├── github.com\n│   └── alice\n└── email.com`;
    expect(parsePassTree(tree)).toEqual(['github.com/alice', 'email.com']);
  });
  it('pulls the password (line 1) and an otpauth line', async () => {
    const exec = scriptedExec({ 'pass ls': 'Password Store\n└── github.com', 'pass show github.com': 'hunter2\notpauth://totp/x?secret=SEED' });
    const c = new PassConnector(exec);
    const [pulled] = await c.pull(['github.com']);
    expect(pulled!.secrets.password).toBe('hunter2');
    expect(pulled!.secrets.totp).toContain('otpauth://');
  });
});

describe('Connectors sync into the vault (§9)', () => {
  const exec = scriptedExec({
    'bw status': JSON.stringify({ status: 'unlocked' }),
    'bw list items': JSON.stringify([{ id: 'bw1', type: 1, name: 'GitHub', login: { username: 'octo', password: 'p1', uris: [{ uri: 'https://github.com' }] } }]),
  });

  it('mirrors selected items and re-syncs onto the same item (no duplicate)', async () => {
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(new BitwardenConnector(() => 'sess', exec));

    const first = await connectors.sync('bitwarden', ['bw1']);
    expect(first.count).toBe(1);
    const vi = items.get(first.itemIds[0]!)!;
    expect(vi.type).toBe('login');
    expect(vi.provenance.source).toBe('connector:bitwarden');
    expect(vi.provenance.externalId).toBe('bw1');
    expect(items.resolveField(vi, 'password', { mode: 'reveal' })).toBe('p1');
    expect(connectors.config('bitwarden').lastSync?.count).toBe(1);

    const second = await connectors.sync('bitwarden', ['bw1']);
    expect(second.itemIds).toEqual(first.itemIds); // same item id, updated in place
    expect(items.list().filter((i) => i.provenance.externalId === 'bw1')).toHaveLength(1);
  });

  it('write-back is opt-in and round-trips via the connector push', async () => {
    const { items, store, broker } = makeVault();
    const pushed: any[] = [];
    const c = new PassConnector(scriptedExec({ 'pass insert': '' }));
    // stub push to capture (PassConnector.push shells out; capture the secrets)
    (c as any).push = async (item: any) => { pushed.push(item); return { externalId: 'karmax/new' }; };
    const connectors = new Connectors(store, items, broker);
    connectors.register(c);
    const created = items.save({ type: 'login', label: 'made by agent', secrets: { password: 'genpw' }, provenance: { source: 'task:t1', taskId: 't1' } });

    // disabled by default → skipped
    expect(await connectors.writeBack('pass', created.id)).toBeUndefined();
    connectors.setConfig('pass', { writeBack: true });
    const result = await connectors.writeBack('pass', created.id);
    expect(result?.externalId).toBe('karmax/new');
    expect(pushed[0].secrets.password).toBe('genpw');
    expect(items.get(created.id)!.provenance.externalId).toBe('karmax/new');
  });
});
