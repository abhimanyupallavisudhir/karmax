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
  parsePassFiles,
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
  const root = path.join(os.tmpdir(), 'password-store');
  const found = (...ids: string[]) => ids.map((id) => path.join(root, `${id}.gpg`)).join('\0') + '\0';

  it('turns only .gpg files into flat store paths', () => {
    const files = [
      path.join(root, 'email.com.gpg'),
      path.join(root, 'alts', 'stackexchange.com.gpg'),
      path.join(root, 'alts', 'ANON_POSTS.md'),
    ].join('\0') + '\0';
    expect(parsePassFiles(files, root)).toEqual(['alts/stackexchange.com', 'email.com']);
  });
  it('treats ONLY the first line as the password; notes never become the credential (V)', async () => {
    const exec = scriptedExec({
      'find -L': found('github.com'),
      'pass show github.com': 'hunter2\nusername: alice\nsome random note\notpauth://totp/x?secret=SEED\nmore notes',
    });
    const c = new PassConnector(exec, root);
    const [pulled] = await c.pull(['github.com']);
    expect(pulled!.secrets.password).toBe('hunter2');
    expect(pulled!.secrets.totp).toContain('otpauth://');
    // the notes/username lines are NOT stored as any secret field
    expect(JSON.stringify(pulled!.secrets)).not.toContain('random note');
    expect(JSON.stringify(pulled!.secrets)).not.toContain('username');
  });
  it('surfaces a clear unlock hint when GPG is locked', async () => {
    const exec: Exec = async (cmd) => {
      if (cmd === 'find') return found('x');
      throw new Error('gpg: decryption failed: No secret key');
    };
    await expect(new PassConnector(exec, root).pull(['x'])).rejects.toThrow(/GPG key is locked/);
  });
  it('exposes folder + basename label for grouping in the import UI', async () => {
    const files = [path.join(root, 'alts', 'stackexchange.com.gpg'), path.join(root, 'email.com.gpg')].join('\0') + '\0';
    const exec = scriptedExec({ 'find -L': files });
    const list = await new PassConnector(exec, root).list();
    const se = list.find((i) => i.externalId === 'alts/stackexchange.com')!;
    expect(se.folder).toBe('alts');
    expect(se.label).toBe('stackexchange.com');
    expect(list.find((i) => i.externalId === 'email.com')!.folder).toBe('');
  });
  it('ignores non-GPG files in both the import view and pull commands', async () => {
    const files = [
      path.join(root, 'alts', 'real.md.gpg'),
      path.join(root, 'alts', 'ANON_POSTS.md'),
    ].join('\0') + '\0';
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      if (cmd === 'find') return files;
      if (key === 'pass show alts/real.md') return 'hunter2\n';
      throw new Error(`unexpected command: ${key}`);
    };
    const connector = new PassConnector(exec, root);

    expect((await connector.list()).map((item) => item.externalId)).toEqual(['alts/real.md']);
    const pulled = await connector.pull(['alts/ANON_POSTS.md', 'alts/real.md']);
    expect(pulled.map((item) => item.externalId)).toEqual(['alts/real.md']);
    expect(calls).not.toContain('pass show alts/ANON_POSTS.md');
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

  it('import options apply the chosen policy + write-back to NEW items only', async () => {
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(new BitwardenConnector(() => 'sess', exec));
    const { itemIds } = await connectors.sync('bitwarden', ['bw1'], { policy: { use: 'ask', reveal: 'never' }, writeBack: true });
    const vi = items.get(itemIds[0]!)!;
    expect(vi.policy).toEqual({ use: 'ask', reveal: 'never' });
    expect(connectors.config('bitwarden').writeBack).toBe(true);
    // the user later relaxes the policy; a re-sync must NOT clobber it back
    items.setPolicy(vi.id, { use: 'auto' });
    await connectors.sync('bitwarden', ['bw1'], { policy: { use: 'ask', reveal: 'never' } });
    expect(items.get(vi.id)!.policy.use).toBe('auto');
  });

  it('updateSecret is field-level: pass rewrites only line 1, keeping notes', async () => {
    const inserted: string[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      const key = [cmd, ...args].join(' ');
      if (key.startsWith('pass show')) return 'oldpw\nusername: alice\nnote line\notpauth://totp/x?secret=OLD\n';
      if (key.startsWith('pass insert')) { inserted.push(opts!.input!); return ''; }
      throw new Error(`unexpected: ${key}`);
    };
    const c = new PassConnector(exec);
    await c.updateSecret('github.com', 'password', 'newpw');
    expect(inserted[0]).toBe('newpw\nusername: alice\nnote line\notpauth://totp/x?secret=OLD\n');
    await c.updateSecret('github.com', 'totp', 'otpauth://totp/x?secret=NEW');
    expect(inserted[1]).toContain('secret=NEW');
    expect(inserted[1]).toContain('note line'); // notes survive both edits
  });

  it('updateSecret for Bitwarden edits one field of the fetched item', async () => {
    const edits: any[] = [];
    const exec: Exec = async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      if (key.startsWith('bw get item bw1')) return JSON.stringify({ id: 'bw1', type: 1, name: 'GH', notes: 'keep me', login: { username: 'octo', password: 'old' } });
      if (key.startsWith('bw edit item bw1')) { edits.push(JSON.parse(Buffer.from(args[3]!, 'base64').toString())); return '{}'; }
      throw new Error(`unexpected: ${key}`);
    };
    const c = new BitwardenConnector(() => 'sess', exec);
    await c.updateSecret('bw1', 'password', 'new');
    expect(edits[0].login.password).toBe('new');
    expect(edits[0].notes).toBe('keep me');
    expect(edits[0].login.username).toBe('octo');
  });

  it('propagate pushes rotated fields of a mirrored item to its source (write-back gated)', async () => {
    const { items, store, broker } = makeVault();
    const updates: any[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      const key = [cmd, ...args].join(' ');
      if (key.startsWith('bw status')) return JSON.stringify({ status: 'unlocked' });
      if (key.startsWith('bw list items')) return JSON.stringify([{ id: 'bw1', type: 1, name: 'GH', login: { password: 'old', uris: [{ uri: 'https://gh.com' }] } }]);
      if (key.startsWith('bw get item bw1')) return JSON.stringify({ id: 'bw1', type: 1, name: 'GH', login: { password: 'old' } });
      if (key.startsWith('bw edit item bw1')) { updates.push(JSON.parse(Buffer.from(args[3]!, 'base64').toString())); return '{}'; }
      throw new Error(`unexpected: ${key}${opts ? '' : ''}`);
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(new BitwardenConnector(() => 'sess', exec));
    const { itemIds } = await connectors.sync('bitwarden', ['bw1']);
    // rotate the vault secret, then propagate
    items.save({ id: itemIds[0], type: 'login', secrets: { password: 'rotated' } });
    // write-back off → no push
    expect(await connectors.propagate(itemIds[0]!, ['password'])).toBeUndefined();
    connectors.setConfig('bitwarden', { writeBack: true });
    const result = await connectors.propagate(itemIds[0]!, ['password']);
    expect(result).toEqual({ connector: 'bitwarden', fields: ['password'] });
    expect(updates[0].login.password).toBe('rotated');
    // agent-created (non-connector) items are not propagate's business
    const own = items.save({ type: 'login', label: 'mine', secrets: { password: 'x' } });
    expect(await connectors.propagate(own.id, ['password'])).toBeUndefined();
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
