import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { VaultItems, VaultItemStore } from '../src/autonomy/vault-items.js';
import {
  Connectors,
  defaultConnectors,
  BitwardenConnector,
  OnePasswordConnector,
  OnePasswordSdkConnector,
  PassConnector,
  GitPassConnector,
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
    const { items } = await c.pull(['bw1']);
    expect(items).toHaveLength(1);
    expect(items[0]!.secrets).toEqual({ password: 'p@ss', totp: 'SEED234' });
  });

  it('only saves a session key after Bitwarden confirms it is usable', async () => {
    const { items, broker, store } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(new BitwardenConnector(() => connectors.secretFor('bitwarden'), exec));

    await expect(connectors.connect('bitwarden', '')).rejects.toThrow(/session key/i);
    expect(connectors.secretFor('bitwarden')).toBeUndefined();

    await expect(connectors.connect('bitwarden', 'sess')).resolves.toMatchObject({ available: true });
    expect(connectors.secretFor('bitwarden')).toBe('sess');
  });

  it('does not replace a working connection when validation fails', async () => {
    const { items, broker, store } = makeVault();
    const connectorExec: Exec = async (_cmd, _args, opts) => {
      if (opts?.env?.BW_SESSION === 'working') return JSON.stringify({ status: 'unlocked' });
      return JSON.stringify({ status: 'unauthenticated' });
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(new BitwardenConnector(() => connectors.secretFor('bitwarden'), connectorExec));

    await connectors.connect('bitwarden', 'working');
    await expect(connectors.connect('bitwarden', 'wrong')).rejects.toThrow(/invalid|expired/i);
    expect(connectors.secretFor('bitwarden')).toBe('working');
  });

  it('does not connect when the bw CLI is unavailable', async () => {
    const { items, broker, store } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(new BitwardenConnector(() => connectors.secretFor('bitwarden'), async () => {
      throw new Error('ENOENT');
    }));
    await expect(connectors.connect('bitwarden', 'sess')).rejects.toThrow(/bw.*CLI/i);
    expect(connectors.secretFor('bitwarden')).toBeUndefined();
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
    const [pulled] = (await c.pull(['op1'])).items;
    expect(pulled!.username).toBe('octo');
    expect(pulled!.secrets).toEqual({ password: 'sw0rd', totp: '123456' });
  });

  it('does not connect without a service-account token', async () => {
    const { items, broker, store } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(new OnePasswordConnector(() => connectors.secretFor('1password'), exec));
    await expect(connectors.connect('1password', '   ')).rejects.toThrow(/service-account token/i);
    expect(connectors.secretFor('1password')).toBeUndefined();
  });

  it('does not connect when the op CLI is unavailable', async () => {
    const { items, broker, store } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(new OnePasswordConnector(() => connectors.secretFor('1password'), async () => {
      throw new Error('ENOENT');
    }));
    await expect(connectors.connect('1password', 'ops_token')).rejects.toThrow(/op.*CLI/i);
    expect(connectors.secretFor('1password')).toBeUndefined();
  });
});

describe('hosted 1Password connector', () => {
  const full = {
    id: 'op1',
    vaultId: 'vault1',
    title: 'GH',
    category: 'Login',
    websites: [{ url: 'https://github.com/login' }],
    fields: [
      { id: 'username', value: 'octo', fieldType: 'Text' },
      { id: 'password', value: 'sw0rd', fieldType: 'Concealed' },
      { id: 'otp', value: 'otpauth://totp/GH?secret=SEED', fieldType: 'Totp' },
    ],
  };
  const puts: any[] = [];
  const client = {
    vaults: { list: async () => [{ id: 'vault1', title: 'Engineering' }] },
    items: {
      list: async (vaultId: string) => {
        expect(vaultId).toBe('vault1');
        return [{ ...full, fields: undefined }];
      },
      get: async (vaultId: string, itemId: string) => {
        expect([vaultId, itemId]).toEqual(['vault1', 'op1']);
        return structuredClone(full);
      },
      put: async (item: any) => { puts.push(item); return item; },
    },
  };

  it('uses the service-account SDK without host CLI state', async () => {
    const tokens: string[] = [];
    const c = new OnePasswordSdkConnector(() => 'ops_token', async (token) => {
      tokens.push(token);
      return client;
    });

    expect((await c.describe()).available).toBe(true);
    expect(tokens).toEqual(['ops_token']);
    expect(await c.list()).toEqual([
      expect.objectContaining({
        externalId: 'op1',
        folder: 'Engineering',
        domains: ['github.com'],
      }),
    ]);
    const [pulled] = (await c.pull(['op1'])).items;
    expect(pulled).toMatchObject({
      username: 'octo',
      secrets: {
        password: 'sw0rd',
        totp: 'otpauth://totp/GH?secret=SEED',
      },
    });
  });

  it('updates one SDK field and preserves the rest of the item', async () => {
    puts.length = 0;
    const c = new OnePasswordSdkConnector(() => 'ops_token', async () => client);
    await c.updateSecret('op1', 'password', 'rotated');

    expect(puts).toHaveLength(1);
    expect(puts[0].fields.find((f: any) => f.id === 'password').value).toBe('rotated');
    expect(puts[0].fields.find((f: any) => f.id === 'username').value).toBe('octo');
    expect(puts[0].websites).toEqual(full.websites);
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
    const [pulled] = (await c.pull(['github.com'])).items;
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
    const { items, failures } = await new PassConnector(exec, root).pull(['x']);
    expect(items).toEqual([]);
    expect(failures).toEqual([{ externalId: 'x', error: expect.stringMatching(/GPG key is locked/) }]);
  });
  it('reports the entry that would not decrypt and keeps the rest of the batch (V)', async () => {
    const exec: Exec = async (cmd, args) => {
      if (cmd === 'find') return found('a.com', 'broken', 'b.com');
      if (args[1] === 'broken') throw new Error('gpg: public key decryption failed: Operation cancelled');
      return `pw-${args[1]}\n`;
    };
    const { items, failures } = await new PassConnector(exec, root).pull(['a.com', 'broken', 'b.com']);
    expect(items.map((i) => i.externalId)).toEqual(['a.com', 'b.com']);
    expect(items.map((i) => i.secrets.password)).toEqual(['pw-a.com', 'pw-b.com']);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.externalId).toBe('broken');
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
  it('extracts the actual site and username from a foldered pass path', async () => {
    const exec = scriptedExec({
      'find -L': found(
        'software/www.overleaf.com/alice@example.com',
        'srajma/.archived/forum.obsidian.md/srajma',
        'secrets/GITHUB_ACCESS_TOKENS',
      ),
      'pass show software/www.overleaf.com/alice@example.com': 'pw\n',
    });
    const connector = new PassConnector(exec, root);
    const listed = await connector.list();
    expect(listed.find((i) => i.externalId.includes('overleaf'))).toMatchObject({
      domains: ['www.overleaf.com'],
      username: 'alice@example.com',
    });
    expect(listed.find((i) => i.externalId.includes('obsidian'))).toMatchObject({
      domains: ['forum.obsidian.md'],
      username: 'srajma',
    });
    expect(listed.find((i) => i.externalId.includes('GITHUB_ACCESS'))).toMatchObject({
      domains: [],
    });
    expect((await connector.pull(['software/www.overleaf.com/alice@example.com'])).items).toEqual([
      expect.objectContaining({
        domains: ['www.overleaf.com'],
        username: 'alice@example.com',
      }),
    ]);
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
    const { items: pulled } = await connector.pull(['alts/ANON_POSTS.md', 'alts/real.md']);
    expect(pulled.map((item) => item.externalId)).toEqual(['alts/real.md']);
    expect(calls).not.toContain('pass show alts/ANON_POSTS.md');
  });
});

describe('the default registry follows where karmax is served', () => {
  it('offers the host password store only to the machine that runs karmax', async () => {
    const { items, broker, store } = makeVault();
    const names = async (opts?: { hostLocal?: boolean; hosted?: boolean }) =>
      (await defaultConnectors(store, items, broker, 'org_personal', opts).describe()).map((c) => c.name);

    expect(await names({ hostLocal: true })).toContain('pass');
    // Served to anyone but the operator, `pass` would read the *host's* store —
    // secrets nobody on the other end of the browser owns.
    expect(await names({ hostLocal: false })).not.toContain('pass');
    // A public self-host may use 1Password's stateless service-account token,
    // but must not expose the operator's local Bitwarden CLI profile.
    expect(await names({ hostLocal: false })).toEqual(['1password', 'pass-git']);
    // A managed cell has no tenant-owned CLI profile. 1Password uses its
    // service-account SDK there; Bitwarden's session key only unlocks local
    // CLI state, so advertising it would be both broken and cross-tenant-prone.
    expect(await names({ hostLocal: false, hosted: true })).toEqual(['1password', 'pass-git']);
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

  /** A `pass` store on disk + an exec that "decrypts" by reading the file, so
   *  the mtime-based skip is exercised exactly as it runs against real GPG. */
  function passStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pass-'));
    fs.mkdirSync(path.join(dir, 'sites'));
    const shown: string[] = [];
    const undecryptable = new Set<string>();
    const write = (id: string, body: string, mtime?: number) => {
      fs.writeFileSync(path.join(dir, `${id}.gpg`), body);
      if (mtime) fs.utimesSync(path.join(dir, `${id}.gpg`), new Date(mtime), new Date(mtime));
    };
    const exec: Exec = async (cmd, args) => {
      if (cmd === 'find') return fs.readdirSync(path.join(dir, 'sites')).map((f) => path.join(dir, 'sites', f)).join('\0') + '\0';
      if (cmd === 'pass' && args[0] === 'show') {
        shown.push(args[1]!);
        if (undecryptable.has(args[1]!)) throw new Error('gpg: public key decryption failed: Operation cancelled');
        return fs.readFileSync(path.join(dir, `${args[1]}.gpg`), 'utf8');
      }
      throw new Error(`unexpected: ${[cmd, ...args].join(' ')}`);
    };
    return { dir, shown, write, undecryptable, connector: new PassConnector(exec, dir) };
  }

  it('re-importing a store re-reads only the entries that changed (V)', async () => {
    const { shown, write, connector, dir } = passStore();
    write('sites/a.com', 'pw-a');
    write('sites/b.com', 'pw-b');
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);

    const first = await connectors.sync('pass', ['sites/a.com', 'sites/b.com']);
    expect(first.count).toBe(2);
    expect(shown).toEqual(['sites/a.com', 'sites/b.com']);

    // The user adds one password and clicks "select all" again: decrypting the
    // whole store costs seconds per entry, so only the new one may be read.
    shown.length = 0;
    write('sites/c.com', 'pw-c');
    const second = await connectors.sync('pass', ['sites/a.com', 'sites/b.com', 'sites/c.com']);
    expect(shown).toEqual(['sites/c.com']);
    expect(second).toMatchObject({ count: 1, skipped: 2 });
    expect(items.list()).toHaveLength(3);
    expect(connectors.config('pass').lastSync?.count).toBe(3); // the running total, not this batch
    expect(items.resolveField(items.list().find((i) => i.provenance.externalId === 'sites/c.com')!, 'password', { mode: 'reveal' })).toBe('pw-c');

    // …but an entry edited in `pass` afterwards is pulled again.
    shown.length = 0;
    write('sites/a.com', 'pw-a2', Date.now() + 5_000);
    await connectors.sync('pass', ['sites/a.com', 'sites/b.com', 'sites/c.com']);
    expect(shown).toEqual(['sites/a.com']);
    expect(items.resolveField(items.list().find((i) => i.provenance.externalId === 'sites/a.com')!, 'password', { mode: 'reveal' })).toBe('pw-a2');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A file's mtime carries sub-millisecond precision; `Date.now()` does not. So
  // an entry written in the SAME millisecond the sync records its mirror clock
  // reads back as `mtimeMs = clock + 0.31…`, i.e. strictly greater — and the
  // entry is re-decrypted on every subsequent sync until something else touches
  // the clock. That is the exact cost this skip exists to avoid ("decrypting the
  // whole store costs seconds per entry"), and it made the suite flaky: whether
  // the write and the sync landed in the same millisecond decided the result.
  it('skips an entry whose mtime is the mirror clock plus a sub-millisecond fraction', async () => {
    const { shown, write, connector, dir } = passStore();
    write('sites/a.com', 'pw-a');
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);
    await connectors.sync('pass', ['sites/a.com']);

    // Reproduce that race deterministically rather than hoping for the timing:
    // put the file's mtime inside the very millisecond the mirror clock names.
    const syncedAt = items.list()[0]!.provenance.syncedAt!;
    const withinSameMs = (syncedAt + 0.5) / 1000;
    fs.utimesSync(path.join(dir, 'sites/a.com.gpg'), withinSameMs, withinSameMs);
    expect(fs.statSync(path.join(dir, 'sites/a.com.gpg')).mtimeMs).toBeGreaterThan(syncedAt);

    shown.length = 0;
    const again = await connectors.sync('pass', ['sites/a.com']);
    expect(shown).toEqual([]);
    expect(again).toMatchObject({ count: 0, skipped: 1 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a policy edit on a mirrored item does not make it look up to date', async () => {
    const { shown, write, connector } = passStore();
    write('sites/a.com', 'pw-a');
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);
    const { itemIds } = await connectors.sync('pass', ['sites/a.com']);
    write('sites/a.com', 'pw-a2', Date.now() + 5_000);
    items.setPolicy(itemIds[0]!, { use: 'ask' }); // bumps updatedAt, NOT the mirror clock
    shown.length = 0;
    await connectors.sync('pass', ['sites/a.com']);
    expect(shown).toEqual(['sites/a.com']);
    expect(items.resolveField(items.get(itemIds[0]!)!, 'password', { mode: 'reveal' })).toBe('pw-a2');
  });

  it('items mirrored before the mirror clock existed are not re-read either', async () => {
    const { shown, write, connector } = passStore();
    write('sites/a.com', 'pw-a', Date.now() - 60_000);
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);
    // A pre-upgrade import: provenance carries no syncedAt.
    items.save({ type: 'login', label: 'sites/a.com', secrets: { password: 'pw-a' },
      provenance: { source: 'connector:pass', externalId: 'sites/a.com' } });

    const result = await connectors.sync('pass', ['sites/a.com']);
    expect(shown).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('one undecryptable entry no longer discards the whole import (V)', async () => {
    const { write, connector, dir, undecryptable } = passStore();
    write('sites/a.com', 'pw-a');
    write('sites/b.com', 'pw-b');
    write('sites/c.com', 'pw-c');
    undecryptable.add('sites/b.com');
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);

    const result = await connectors.sync('pass', ['sites/a.com', 'sites/b.com', 'sites/c.com']);
    expect(result.count).toBe(2);
    expect(result.failures.map((f) => f.externalId)).toEqual(['sites/b.com']);
    expect(items.list().map((i) => i.provenance.externalId)).toEqual(['sites/a.com', 'sites/c.com']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still explains itself when nothing at all could be pulled', async () => {
    const exec: Exec = async (cmd) => {
      if (cmd === 'find') return `${path.join(os.tmpdir(), 'password-store', 'x.gpg')}\0`;
      throw new Error('gpg: decryption failed: No secret key');
    };
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(new PassConnector(exec, path.join(os.tmpdir(), 'password-store')));
    await expect(connectors.sync('pass', ['x'])).rejects.toThrow(/GPG key is locked/);
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
    expect(items.get(created.id)!.provenance.externalIds).toEqual({ pass: 'karmax/new' });
  });

  it('automatically applies enabled connector write-back and propagates later rotations', async () => {
    const { items, store, broker } = makeVault();
    const pushed: any[] = [];
    const updated: any[] = [];
    const connector = new PassConnector(scriptedExec({}));
    (connector as any).push = async (item: any) => {
      pushed.push(item);
      return { externalId: 'karmax/automatic' };
    };
    (connector as any).updateSecret = async (externalId: string, field: string, value: string) => {
      updated.push({ externalId, field, value });
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);
    connectors.setConfig('pass', { writeBack: true });
    const created = items.save({
      type: 'login', label: 'automatic', secrets: { password: 'generated' },
      provenance: { source: 'task:t1', taskId: 't1' },
    });

    expect(await connectors.writeBackCreated(created.id)).toEqual([
      { connector: 'pass', externalId: 'karmax/automatic' },
    ]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].secrets.password).toBe('generated');
    expect(items.get(created.id)!.provenance.externalIds).toEqual({ pass: 'karmax/automatic' });

    items.save({ id: created.id, type: 'login', secrets: { password: 'rotated' } });
    expect(await connectors.propagate(created.id, ['password'])).toEqual({
      connector: 'pass',
      fields: ['password'],
    });
    expect(updated).toEqual([
      { externalId: 'karmax/automatic', field: 'password', value: 'rotated' },
    ]);
  });

  it('keeps distinct write-back bindings when several connectors are enabled', async () => {
    const { items, store, broker } = makeVault();
    const updated: any[] = [];
    const fake = (name: string, externalId: string) => ({
      name,
      label: name,
      describe: async () => ({ name, label: name, available: true, canPush: true, detail: 'test' }),
      list: async () => [],
      pull: async () => [],
      push: async () => ({ externalId }),
      updateSecret: async (id: string, field: string, value: string) => {
        updated.push({ connector: name, externalId: id, field, value });
      },
    });
    const connectors = new Connectors(store, items, broker);
    connectors.register(fake('alpha', 'alpha/item') as any);
    connectors.register(fake('beta', 'beta/item') as any);
    connectors.setConfig('alpha', { writeBack: true });
    connectors.setConfig('beta', { writeBack: true });
    const created = items.save({
      type: 'login', label: 'multi', secrets: { password: 'generated' },
      provenance: { source: 'task:t1', taskId: 't1' },
    });

    expect(await connectors.writeBackCreated(created.id)).toEqual([
      { connector: 'alpha', externalId: 'alpha/item' },
      { connector: 'beta', externalId: 'beta/item' },
    ]);
    expect(items.get(created.id)!.provenance.externalIds).toEqual({
      alpha: 'alpha/item',
      beta: 'beta/item',
    });

    items.save({ id: created.id, type: 'login', secrets: { password: 'rotated' } });
    expect(await connectors.propagate(created.id, ['password'])).toEqual({
      connector: 'alpha, beta',
      fields: ['password'],
    });
    expect(updated).toEqual([
      { connector: 'alpha', externalId: 'alpha/item', field: 'password', value: 'rotated' },
      { connector: 'beta', externalId: 'beta/item', field: 'password', value: 'rotated' },
    ]);
  });

  it('uses a legacy unlabelled write-back id only when the target is unambiguous', async () => {
    const { items, store, broker } = makeVault();
    const updated: any[] = [];
    const fake = (name: string) => ({
      name,
      label: name,
      describe: async () => ({ name, label: name, available: true, canPush: true, detail: 'test' }),
      list: async () => [],
      pull: async () => [],
      updateSecret: async (externalId: string, field: string, value: string) => {
        updated.push({ connector: name, externalId, field, value });
      },
    });
    const connectors = new Connectors(store, items, broker);
    connectors.register(fake('alpha') as any);
    connectors.register(fake('beta') as any);
    const created = items.save({
      type: 'login', label: 'legacy', secrets: { password: 'rotated' },
      provenance: { source: 'task:t1', taskId: 't1' },
    });
    items.setExternalId(created.id, 'legacy/item');
    connectors.setConfig('alpha', { writeBack: true });

    expect(await connectors.propagate(created.id, ['password'])).toEqual({
      connector: 'alpha',
      fields: ['password'],
    });
    expect(updated).toEqual([
      { connector: 'alpha', externalId: 'legacy/item', field: 'password', value: 'rotated' },
    ]);

    connectors.setConfig('beta', { writeBack: true });
    await expect(connectors.propagate(created.id, ['password'])).rejects.toThrow(
      /legacy write-back binding is ambiguous across enabled connectors: alpha, beta/,
    );
  });

  it('never treats a one-way file import id as a connector write-back binding', async () => {
    const { items, store, broker } = makeVault();
    const updated: any[] = [];
    const connector = {
      name: 'alpha',
      label: 'alpha',
      describe: async () => ({ name: 'alpha', label: 'alpha', available: true, canPush: true, detail: 'test' }),
      list: async () => [],
      pull: async () => ({ items: [], failures: [] }),
      updateSecret: async (...args: any[]) => void updated.push(args),
      push: async () => ({ externalId: 'alpha/new' }),
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector as any);
    connectors.setConfig('alpha', { writeBack: true });
    const imported = items.save({
      type: 'login', label: 'from a file', secrets: { password: 'rotated' },
      provenance: { source: 'import:bitwarden', externalId: 'bitwarden-item-id' },
    });

    expect(await connectors.propagate(imported.id, ['password'])).toBeUndefined();
    await expect(connectors.writeBack('alpha', imported.id)).rejects.toThrow(/one-way file import/i);
    expect(updated).toEqual([]);
  });
});
