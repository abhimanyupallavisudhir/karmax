import { memoryTransaction } from './helpers/memory-transaction.js';
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
  attachedRepositoryCredential,
  parsePassFiles,
  passSecrets,
  type Exec,
} from '../src/autonomy/connectors.js';

function memStore(): VaultItemStore & { kv: Map<string, string> } {
  const kv = new Map<string, string>();
  return { transaction: memoryTransaction(kv), kvGet: (k) => kv.get(k), kvSet: (k, v) => void kv.set(k, v), appendAudit: () => 0, kv };
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

    await expect(connectors.connect('bitwarden', 'sess')).resolves.toMatchObject({ connector: { available: true }, newStore: true });
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
      fields: [{ id: 'username', value: 'octo' }, { id: 'password', value: 'sw0rd' }, { id: 'otp', type: 'OTP', value: 'JBSWY3DPEHPK3PXP', totp: '123456' }] }),
  });
  it('lists and pulls a login with its OTP', async () => {
    const c = new OnePasswordConnector(() => 'tok', exec);
    expect((await c.describe()).available).toBe(true);
    expect((await c.list())[0]!.type).toBe('login');
    const [pulled] = (await c.pull(['op1'])).items;
    expect(pulled!.username).toBe('octo');
    expect(pulled!.secrets).toEqual({ password: 'sw0rd', totp: 'JBSWY3DPEHPK3PXP' });
  });

  // AU-29: `op item edit` takes a new value only as an argv assignment, which
  // every local process can read from /proc; the write goes through the SDK.
  it('writes a rotated secret back without putting it in argv', async () => {
    const commands: string[][] = [];
    const cli = async (cmd: string, args: string[]) => {
      commands.push([cmd, ...args]);
      return args.slice(0, 2).join(' ') === 'item get' ? JSON.stringify({ id: 'op1', vault: { id: 'vault1' } }) : '{}';
    };
    const puts: any[] = [];
    const client: any = {
      vaults: { list: async () => { throw new Error('the item location comes from the CLI'); } },
      items: {
        list: async () => [],
        get: async (vaultId: string, itemId: string) => ({ id: itemId, vaultId, fields: [
          { id: 'username', value: 'octo', fieldType: 'Text' }, { id: 'password', value: 'sw0rd', fieldType: 'Concealed' }] }),
        put: async (item: any) => { puts.push(item); return item; },
      },
    };
    const c = new OnePasswordConnector(() => 'tok', cli, new OnePasswordSdkConnector(() => 'tok', async () => client));
    await c.updateSecret('op1', 'password', 'rotated-s3cret');
    expect(JSON.stringify(commands)).not.toContain('rotated-s3cret');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ id: 'op1', vaultId: 'vault1' });
    expect(puts[0].fields).toEqual([{ id: 'username', value: 'octo', fieldType: 'Text' }, { id: 'password', value: 'rotated-s3cret', fieldType: 'Concealed' }]);
  });

  // The CLI's `one-time password[otp]=` assignment created the field when an
  // item had none; the SDK path adds it the same way.
  it('adds a one-time password field to an item without one', async () => {
    const puts: any[] = [];
    const client: any = { vaults: { list: async () => [] }, items: {
      list: async () => [],
      get: async (vaultId: string, id: string) => ({ id, vaultId, category: 'Login', sections: [],
        fields: [{ id: 'password', title: 'password', value: 'sw0rd', fieldType: 'Concealed' }] }),
      put: async (item: any) => { puts.push(item); return item; } } };
    const c = new OnePasswordConnector(() => 'tok', async () => JSON.stringify({ id: 'op1', vault: { id: 'v' } }),
      new OnePasswordSdkConnector(() => 'tok', async () => client));
    await c.updateSecret('op1', 'totp', 'JBSWY3DPEHPK3PXP');
    expect(puts[0].fields).toContainEqual(expect.objectContaining({ fieldType: 'Totp', value: 'JBSWY3DPEHPK3PXP', sectionId: expect.any(String) }));
    expect(puts[0].sections.map((section: any) => section.id)).toContain(puts[0].fields.at(-1).sectionId);
    expect(puts[0].fields[0]).toEqual({ id: 'password', title: 'password', value: 'sw0rd', fieldType: 'Concealed' });
  });

  // The SDK models no passkeys, so its get-then-put could drop one. Items that
  // may hold one keep the CLI's in-place assignment (the pre-AU-29 path).
  it.each([
    ['the CLI shows a passkey', { fields: [{ id: 'passkey', type: 'PASSKEY', label: 'passkey' }] }, []],
    ['the SDK cannot model a field', {}, [{ id: 'x', title: 'passkey', value: '', fieldType: 'Unsupported' }]],
  ])('keeps the in-place CLI edit when %s', async (_case, cliExtra, sdkExtra) => {
    const commands: string[][] = [];
    const puts: any[] = [];
    const client: any = { vaults: { list: async () => [] }, items: {
      list: async () => [],
      get: async (vaultId: string, id: string) => ({ id, vaultId, category: 'Login', sections: [],
        fields: [{ id: 'password', title: 'password', value: 'old', fieldType: 'Concealed' }, ...sdkExtra] }),
      put: async (item: any) => { puts.push(item); return item; } } };
    const c = new OnePasswordConnector(() => 'tok', async (_cmd, args) => {
      commands.push(args);
      return args[1] === 'get' ? JSON.stringify({ id: 'op1', vault: { id: 'v' }, ...cliExtra }) : '{}';
    }, new OnePasswordSdkConnector(() => 'tok', async () => client));
    await c.updateSecret('op1', 'password', 'rotated');
    expect(puts).toHaveLength(0);
    expect(commands.at(-1)).toEqual(['item', 'edit', 'op1', 'password=rotated']);
  });

  it('refuses a hosted write-back that could drop a passkey', async () => {
    const client: any = { vaults: { list: async () => [] }, items: {
      list: async () => [],
      get: async (vaultId: string, id: string) => ({ id, vaultId, category: 'Login', sections: [],
        fields: [{ id: 'x', title: 'passkey', value: '', fieldType: 'Unsupported' }, { id: 'password', value: 'old', fieldType: 'Concealed' }] }),
      put: async () => { throw new Error('must not put'); } } };
    const c = new OnePasswordSdkConnector(() => 'tok', async () => client);
    await expect(c.updateSecretIn('v', 'op1', 'password', 'rotated')).rejects.toThrow(/cannot rewrite.*passkey/);
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
    expect(pulled!.secrets.note).toBe('username: alice\nsome random note\notpauth://totp/x?secret=SEED\nmore notes');
    expect(pulled!.username).toBeUndefined();
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

describe('Git-backed pass repository authentication', () => {
  it('uses only the exact organization repository attachment', async () => {
    const repository = { id: 'repo_attached', organizationId: 'org_a', provider: 'github',
      owner: 'acme', name: 'passwords', sshUrl: 'git@github.com:acme/passwords.git' } as any;
    const calls: string[] = [];
    const store = {
      ...memStore(),
      findRepositoryBySshUrl: (organizationId: string, sshUrl: string) =>
        organizationId === repository.organizationId && sshUrl === repository.sshUrl ? repository : undefined,
      listRepositories: (organizationId: string) => organizationId === repository.organizationId ? [repository] : [],
    };
    const githubApp = {
      brokerCredentials: async (matched: any) => {
        calls.push(matched.id);
        return { httpsToken: 'installation-token', env: { GH_TOKEN: 'installation-token' } };
      },
    };

    await expect(attachedRepositoryCredential(store, githubApp, 'org_a', repository.sshUrl))
      .resolves.toMatchObject({ httpsToken: 'installation-token' });
    await expect(attachedRepositoryCredential(store, githubApp, 'org_a', 'https://github.com/acme/passwords.git'))
      .resolves.toMatchObject({ httpsToken: 'installation-token' });
    await expect(attachedRepositoryCredential(store, githubApp, 'org_b', repository.sshUrl))
      .resolves.toBeUndefined();
    await expect(attachedRepositoryCredential(store, githubApp, 'org_a', 'git@github.com:other/passwords.git'))
      .resolves.toBeUndefined();
    expect(calls).toEqual(['repo_attached', 'repo_attached']);
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
    const vi = (await items.get(first.itemIds[0]!))!;
    expect(vi.type).toBe('login');
    expect(vi.provenance.source).toBe('connector:bitwarden');
    expect(vi.provenance.externalId).toBe('bw1');
    expect((await items.resolveField(vi, 'password', { mode: 'reveal' }))).toBe('p1');
    expect((await connectors.config('bitwarden')).lastSync?.count).toBe(1);

    const second = await connectors.sync('bitwarden', ['bw1']);
    expect(second.itemIds).toEqual(first.itemIds); // same item id, updated in place
    expect((await items.list()).filter((i) => i.provenance.externalId === 'bw1')).toHaveLength(1);
  });

  it('keeps a selective subscription and broadens import-new to the whole store', async () => {
    const { items, store, broker } = makeVault();
    let revision = 1;
    const records = new Map([
      ['one', { password: 'one-v1' }],
      ['two', { password: 'two-v1' }],
    ]);
    const pulled: string[][] = [];
    const connector = {
      name: 'test',
      describe: async () => ({ name: 'test', label: 'Test', available: true, canPush: false, detail: 'ready' }),
      list: async () => [...records].map(([externalId]) => ({ externalId, type: 'login' as const,
        label: externalId, fields: ['password' as const], changedAt: revision })),
      pull: async (externalIds: string[]) => {
        pulled.push(externalIds);
        return { items: externalIds.flatMap((externalId) => {
          const secrets = records.get(externalId);
          return secrets ? [{ externalId, type: 'login' as const, label: externalId,
            fields: ['password' as const], changedAt: revision, secrets }] : [];
        }), failures: [] };
      },
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);

    (await connectors.setAutoSync('test', { keepUpdated: true, externalIds: ['one'],
      policy: { use: 'ask', reveal: 'never' } }));
    await connectors.autoSync('test', 'backstop');
    expect(pulled).toEqual([['one']]);
    expect((await items.list()).map((item) => item.provenance.externalId)).toEqual(['one']);
    expect((await items.list())[0]!.policy).toEqual({ use: 'ask', reveal: 'never' });

    revision++;
    records.set('three', { password: 'three-v1' });
    (await connectors.setAutoSync('test', { importNew: true, externalIds: ['one'] }));
    expect((await connectors.config('test')).autoSync).toMatchObject({ enabled: true, importNew: true });
    await connectors.autoSync('test', 'github-push', 'commit-2');
    expect(new Set((await items.list()).map((item) => item.provenance.externalId))).toEqual(new Set(['one', 'two', 'three']));
    expect((await connectors.config('test')).autoSync?.externalIds).toEqual(['one', 'two', 'three']);
    expect((await connectors.config('test')).lastAutoSync).toMatchObject({ reason: 'github-push', revision: 'commit-2' });

    (await connectors.setAutoSync('test', { keepUpdated: false, importNew: false, externalIds: ['one'] }));
    expect((await connectors.config('test')).autoSync).toEqual({
      enabled: false, importNew: false, externalIds: ['one'],
    });
    pulled.length = 0;
    expect(await connectors.autoSync('test', 'backstop')).toBeUndefined();
    expect(pulled).toEqual([]);
  });

  it('migrates pre-subscription imports to selective automatic updates', async () => {
    const { items, store, broker } = makeVault();
    let password = 'old';
    let revision = Date.now();
    const pulled: string[][] = [];
    const connector = {
      name: 'test',
      describe: async () => ({ name: 'test', label: 'Test', available: true, canPush: false, detail: 'ready' }),
      list: async () => [{ externalId: 'existing', type: 'login' as const, label: 'Existing',
        fields: ['password' as const], changedAt: revision }],
      pull: async (externalIds: string[]) => {
        pulled.push(externalIds);
        return { items: externalIds.map((externalId) => ({ externalId, type: 'login' as const,
          label: 'Existing', fields: ['password' as const], changedAt: revision,
          secrets: { password } })), failures: [] };
      },
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);

    const imported = await connectors.sync('test', ['existing']);
    expect((await connectors.config('test')).autoSync).toBeUndefined();
    password = 'rotated';
    revision = Date.now() + 5_000;

    await connectors.autoSync('test', 'backstop');

    expect(pulled).toEqual([['existing'], ['existing']]);
    expect((await connectors.config('test')).autoSync).toEqual({
      enabled: true, importNew: false, externalIds: ['existing'],
    });
    expect((await items.resolveField((await items.get(imported.itemIds[0]!))!, 'password', { mode: 'reveal' })))
      .toBe('rotated');
  });

  it('does not import an agent-created item back as a duplicate after write-back', async () => {
    const { items, store, broker } = makeVault();
    const connector = {
      name: 'test',
      describe: async () => ({ name: 'test', label: 'Test', available: true, canPush: false, detail: 'ready' }),
      list: async () => [{ externalId: 'tavya/created', type: 'login' as const, label: 'Created',
        fields: ['password' as const], changedAt: 2 }],
      pull: async (externalIds: string[]) => ({ items: externalIds.map((externalId) => ({ externalId,
        type: 'login' as const, label: 'Created', fields: ['password' as const], changedAt: 2,
        secrets: { password: 'generated' } })), failures: [] }),
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);
    const created = (await items.save({ type: 'login', label: 'Created', secrets: { password: 'generated' },
      provenance: { source: 'task:signup', taskId: 'signup' } }));
    items.setExternalId(created.id, 'test', 'tavya/created');
    (await connectors.setAutoSync('test', { importNew: true }));

    const result = await connectors.autoSync('test', 'github-push');
    expect(result).toMatchObject({ count: 0, skipped: 1 });
    expect((await items.list())).toHaveLength(1);
    expect((await items.get(created.id))?.provenance.externalIds).toEqual({ test: 'tavya/created' });
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
    expect((await items.list())).toHaveLength(3);
    expect((await connectors.config('pass')).lastSync?.count).toBe(3); // the running total, not this batch
    expect((await items.resolveField((await items.list()).find((i) => i.provenance.externalId === 'sites/c.com')!, 'password', { mode: 'reveal' }))).toBe('pw-c');

    // …but an entry edited in `pass` afterwards is pulled again.
    shown.length = 0;
    write('sites/a.com', 'pw-a2', Date.now() + 5_000);
    await connectors.sync('pass', ['sites/a.com', 'sites/b.com', 'sites/c.com']);
    expect(shown).toEqual(['sites/a.com']);
    expect((await items.resolveField((await items.list()).find((i) => i.provenance.externalId === 'sites/a.com')!, 'password', { mode: 'reveal' }))).toBe('pw-a2');
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
    const syncedAt = (await items.list())[0]!.provenance.syncedAt!;
    const withinSameMs = (syncedAt + 0.5) / 1000;
    fs.utimesSync(path.join(dir, 'sites/a.com.gpg'), withinSameMs, withinSameMs);
    expect(fs.statSync(path.join(dir, 'sites/a.com.gpg')).mtimeMs).toBeGreaterThan(syncedAt);

    shown.length = 0;
    const again = await connectors.sync('pass', ['sites/a.com']);
    expect(shown).toEqual([]);
    expect(again).toMatchObject({ count: 0, skipped: 1 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('checks ciphertext across timestamp resets, restarts and a 500-entry re-import', async () => {
    const { shown, write, connector, dir } = passStore();
    const ids = Array.from({ length: 500 }, (_, i) => `sites/${i}.com`);
    for (const id of ids) write(id, `password-${id}`);
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);
    await connectors.sync('pass', ids);
    // A checkout/restore touches every file. Changed content can also carry
    // an older timestamp, so neither direction of clock comparison is safe.
    for (const id of ids) fs.utimesSync(path.join(dir, `${id}.gpg`), 2e9, 2e9);
    write(ids[0]!, 'updated-a', 1000);
    write(ids[1]!, 'updated-b', 1000);
    const added = ['sites/new-a.com', 'sites/new-b.com'];
    for (const id of added) write(id, 'new-password', 1000);
    shown.length = 0;
    const restarted = new Connectors(store, items, broker);
    restarted.register(connector);
    const result = await restarted.sync('pass', [...ids, ...added]);
    expect(result).toMatchObject({ count: 4, skipped: 498 });
    expect(shown).toEqual([ids[0], ids[1], ...added]);
    connector.pull = async () => { throw new Error('unchanged import must not open the secret store'); };
    shown.length = 0;
    expect(await restarted.sync('pass', [...ids, ...added])).toMatchObject({ count: 0, skipped: 502 });
    expect(shown).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refreshes legacy pass mirrors once to establish a source fingerprint', async () => {
    const { shown, write, connector, dir } = passStore();
    write('sites/a.com', 'pw-a', 1000);
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);
    const old = (await items.save({ type: 'login', label: 'Legacy', secrets: { password: 'old' },
      provenance: { source: 'connector:pass', externalId: 'sites/a.com', passNotesVersion: 1, syncedAt: Date.now() } }));
    expect(await connectors.sync('pass', ['sites/a.com'])).toMatchObject({ count: 1, skipped: 0 });
    expect((await items.get(old.id))!.provenance.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(await connectors.sync('pass', ['sites/a.com'])).toMatchObject({ count: 0, skipped: 1 });
    expect(shown).toEqual(['sites/a.com']);
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
    (await items.setPolicy(itemIds[0]!, { use: 'ask' })); // bumps updatedAt, NOT the mirror clock
    shown.length = 0;
    await connectors.sync('pass', ['sites/a.com']);
    expect(shown).toEqual(['sites/a.com']);
    expect((await items.resolveField((await items.get(itemIds[0]!))!, 'password', { mode: 'reveal' }))).toBe('pw-a2');
  });

  it('backfills notes for imports older than the mirror clock once', async () => {
    const { shown, write, connector } = passStore();
    write('sites/a.com', 'pw-a', Date.now() - 60_000);
    const { items, store, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);
    // A pre-upgrade import: provenance carries no syncedAt.
    (await items.save({ type: 'login', label: 'sites/a.com', secrets: { password: 'pw-a' },
      provenance: { source: 'connector:pass', externalId: 'sites/a.com' } }));

    const result = await connectors.sync('pass', ['sites/a.com']);
    expect(shown).toEqual(['sites/a.com']);
    expect(result.skipped).toBe(0);
    shown.length = 0;
    await connectors.sync('pass', ['sites/a.com']);
    expect(shown).toEqual([]);
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
    expect((await items.list()).map((i) => i.provenance.externalId)).toEqual(['sites/a.com', 'sites/c.com']);
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
    const vi = (await items.get(itemIds[0]!))!;
    expect(vi.policy).toEqual({ use: 'ask', reveal: 'never' });
    expect((await connectors.config('bitwarden')).writeBack).toBe(true);
    // the user later relaxes the policy; a re-sync must NOT clobber it back
    (await items.setPolicy(vi.id, { use: 'auto' }));
    await connectors.sync('bitwarden', ['bw1'], { policy: { use: 'ask', reveal: 'never' } });
    expect((await items.get(vi.id))!.policy.use).toBe('auto');
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
    const exec: Exec = async (cmd, args, opts) => {
      const key = [cmd, ...args].join(' ');
      if (key.startsWith('bw get item bw1')) return JSON.stringify({ id: 'bw1', type: 1, name: 'GH', notes: 'keep me', login: { username: 'octo', password: 'old' } });
      // The edited item (with the new secret) arrives on stdin, never in argv.
      if (key === 'bw edit item bw1') { edits.push(JSON.parse(Buffer.from(opts!.input!, 'base64').toString())); return '{}'; }
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
      if (key === 'bw edit item bw1') { updates.push(JSON.parse(Buffer.from(opts!.input!, 'base64').toString())); return '{}'; }
      throw new Error(`unexpected: ${key}`);
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(new BitwardenConnector(() => 'sess', exec));
    const { itemIds } = await connectors.sync('bitwarden', ['bw1']);
    // rotate the vault secret, then propagate
    (await items.save({ id: itemIds[0], type: 'login', secrets: { password: 'rotated' } }));
    // write-back off → no push
    expect(await connectors.propagate(itemIds[0]!, ['password'])).toBeUndefined();
    (await connectors.setConfig('bitwarden', { writeBack: true }));
    const result = await connectors.propagate(itemIds[0]!, ['password']);
    expect(result).toEqual({ connector: 'bitwarden', fields: ['password'] });
    expect(updates[0].login.password).toBe('rotated');
    // agent-created (non-connector) items are not propagate's business
    const own = (await items.save({ type: 'login', label: 'mine', secrets: { password: 'x' } }));
    expect(await connectors.propagate(own.id, ['password'])).toBeUndefined();
  });

  it('write-back is opt-in and round-trips via the connector push', async () => {
    const { items, store, broker } = makeVault();
    const pushed: any[] = [];
    const c = new PassConnector(scriptedExec({ 'pass insert': '' }));
    // stub push to capture (PassConnector.push shells out; capture the secrets)
    (c as any).push = async (item: any) => { pushed.push(item); return { externalId: 'tavya/new' }; };
    const connectors = new Connectors(store, items, broker);
    connectors.register(c);
    const created = (await items.save({ type: 'login', label: 'made by agent', secrets: { password: 'genpw' }, provenance: { source: 'task:t1', taskId: 't1' } }));

    // disabled by default → skipped
    expect(await connectors.writeBack('pass', created.id)).toBeUndefined();
    (await connectors.setConfig('pass', { writeBack: true }));
    const result = await connectors.writeBack('pass', created.id);
    expect(result?.externalId).toBe('tavya/new');
    expect(pushed[0].secrets.password).toBe('genpw');
    expect((await items.get(created.id))!.provenance.externalId).toBe('tavya/new');
    expect((await items.get(created.id))!.provenance.externalIds).toEqual({ pass: 'tavya/new' });
  });

  it('automatically applies enabled connector write-back and propagates later rotations', async () => {
    const { items, store, broker } = makeVault();
    const pushed: any[] = [];
    const updated: any[] = [];
    const connector = new PassConnector(scriptedExec({}));
    (connector as any).push = async (item: any) => {
      pushed.push(item);
      return { externalId: 'tavya/automatic' };
    };
    (connector as any).updateSecret = async (externalId: string, field: string, value: string) => {
      updated.push({ externalId, field, value });
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector);
    (await connectors.setConfig('pass', { writeBack: true }));
    const created = (await items.save({
      type: 'login', label: 'automatic', secrets: { password: 'generated' },
      provenance: { source: 'task:t1', taskId: 't1' },
    }));

    expect(await connectors.writeBackCreated(created.id)).toEqual([
      { connector: 'pass', externalId: 'tavya/automatic' },
    ]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].secrets.password).toBe('generated');
    expect((await items.get(created.id))!.provenance.externalIds).toEqual({ pass: 'tavya/automatic' });

    (await items.save({ id: created.id, type: 'login', secrets: { password: 'rotated' } }));
    expect(await connectors.propagate(created.id, ['password'])).toEqual({
      connector: 'pass',
      fields: ['password'],
    });
    expect(updated).toEqual([
      { externalId: 'tavya/automatic', field: 'password', value: 'rotated' },
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
    (await connectors.setConfig('alpha', { writeBack: true }));
    (await connectors.setConfig('beta', { writeBack: true }));
    const created = (await items.save({
      type: 'login', label: 'multi', secrets: { password: 'generated' },
      provenance: { source: 'task:t1', taskId: 't1' },
    }));

    expect(await connectors.writeBackCreated(created.id)).toEqual([
      { connector: 'alpha', externalId: 'alpha/item' },
      { connector: 'beta', externalId: 'beta/item' },
    ]);
    expect((await items.get(created.id))!.provenance.externalIds).toEqual({
      alpha: 'alpha/item',
      beta: 'beta/item',
    });

    (await items.save({ id: created.id, type: 'login', secrets: { password: 'rotated' } }));
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
    const created = (await items.save({
      type: 'login', label: 'legacy', secrets: { password: 'rotated' },
      provenance: { source: 'task:t1', taskId: 't1' },
    }));
    items.setExternalId(created.id, 'legacy/item');
    (await connectors.setConfig('alpha', { writeBack: true }));

    expect(await connectors.propagate(created.id, ['password'])).toEqual({
      connector: 'alpha',
      fields: ['password'],
    });
    expect(updated).toEqual([
      { connector: 'alpha', externalId: 'legacy/item', field: 'password', value: 'rotated' },
    ]);

    (await connectors.setConfig('beta', { writeBack: true }));
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
    (await connectors.setConfig('alpha', { writeBack: true }));
    const imported = (await items.save({
      type: 'login', label: 'from a file', secrets: { password: 'rotated' },
      provenance: { source: 'import:bitwarden', externalId: 'bitwarden-item-id' },
    }));

    expect(await connectors.propagate(imported.id, ['password'])).toBeUndefined();
    await expect(connectors.writeBack('alpha', imported.id)).rejects.toThrow(/one-way file import/i);
    expect(updated).toEqual([]);
  });
});

describe('pass notes preservation and migration', () => {
  it('writes notes back verbatim while keeping the password', async () => {
    const writes: string[] = [];
    const connector = new PassConnector(async (cmd, args, opts) => {
      if (args[0] === 'show') return 'pw\nold notes\n';
      writes.push(opts!.input!);
      if (args[0] === 'insert' && args[2] === 'export') fs.writeFileSync(path.join(opts!.env!.PASSWORD_STORE_DIR!, 'export.gpg'),'test ciphertext');
      return '';
    }, fs.mkdtempSync(path.join(os.tmpdir(),'pass-notes-')));
    const note = 'Username: administrator\r\n  extra  ';
    await connector.updateSecret('vps', 'note', note);
    await connector.push({ externalId: '', type: 'login', label: 'VPS', domains: [],
      fields: ['password', 'note'], secrets: { password: 'pw', note } });
    expect(writes).toEqual(['pw\n' + note, 'pw\n' + note]);
  });

  it('keeps arbitrary trailing content and CRLF verbatim without parsing Username', () => {
    expect(passSecrets('pw\r\nUsername: administrator\r\n\r\n  recovery text  \r\n'))
      .toEqual({ password: 'pw', note: 'Username: administrator\r\n\r\n  recovery text  \r\n' });
    expect(passSecrets('pw')).toEqual({ password: 'pw', note: '' });
  });

  it.each([false, true])('backfills unchanged entries once, including written-back=%s', async (writtenBack) => {
    const { items, store, broker } = makeVault();
    const item = (await items.save({ type: 'login', label: 'VPS', secrets: { password: 'pw' },
      policy: { reveal: 'never' }, provenance: writtenBack
        ? { source: 'task:signup', taskId: 'signup' }
        : { source: 'connector:pass-git', externalId: 'vps', syncedAt: Date.now() } }));
    if (writtenBack) items.setExternalId(item.id, 'pass-git', 'vps');
    let note = 'Username: administrator\n';
    let changedAt = 1;
    const pulls: string[][] = [];
    const connectors = new Connectors(store, items, broker);
    connectors.register({ name: 'pass-git',
      describe: async () => ({ name: 'pass-git', label: 'Pass', available: true, canPush: false, detail: '' }),
      list: async () => [{ externalId: 'vps', type: 'login', label: 'VPS', fields: ['password'], changedAt }],
      pull: async (ids) => {
        pulls.push(ids);
        return { items: ids.map((externalId) => ({ externalId, type: 'login' as const, label: 'VPS',
          fields: ['password' as const, 'note' as const], secrets: { password: 'pw', note } })), failures: [] };
      },
    });
    await connectors.sync('pass-git', ['vps']);
    expect((await items.list())).toHaveLength(1);
    expect(items.readSecret((await items.get(item.id))!, 'note')).toBe(note);
    expect((await items.get(item.id))!.policy.reveal).toBe('never');
    expect((await items.get(item.id))!.provenance.source).toBe(item.provenance.source);
    await connectors.sync('pass-git', ['vps']);
    expect(pulls).toEqual([['vps']]);
    note = '';
    changedAt = Date.now() + 10000;
    await connectors.sync('pass-git', ['vps']);
    expect(items.readSecret((await items.get(item.id))!, 'note')).toBe('');
  });
});

describe('pass TOTP import migration', () => {
  it('repairs an unchanged OTP-only mirror and removes its old password field', async () => {
    const { items, store, broker } = makeVault();
    const uri = 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP';
    const old = (await items.save({ type: 'login', label: 'OTP', secrets: { password: uri },
      provenance: { source: 'connector:pass-git', externalId: 'otp', sourceRevision: 'same', passNotesVersion: 1 } }));
    const connectors = new Connectors(store, items, broker);
    connectors.register({ name: 'pass-git',
      describe: async () => ({ name: 'pass-git', label: 'Pass', available: true, canPush: true, detail: '' }),
      list: async () => [{ externalId: 'otp', type: 'login', label: 'OTP', fields: ['password'], revision: 'same' }],
      pull: async () => ({ items: [{ externalId: 'otp', type: 'login', label: 'OTP', fields: ['totp', 'note'], revision: 'same', secrets: { totp: uri, note: '' } }], failures: [] }),
    });
    expect((await connectors.sync('pass-git', ['otp'])).count).toBe(1);
    const updated = (await items.get(old.id))!;
    expect(updated.fields).toEqual(['totp', 'note']);
    expect(items.readSecret(updated, 'password')).toBeUndefined();
    expect((await items.totp(updated, {}))).toMatch(/^\d{6}$/);
    expect((await connectors.sync('pass-git', ['otp'])).skipped).toBe(1);
  });
});

describe('Git password-store reconfiguration', () => {
  it('resets auto-sync and write-back when mount bindings change, but not when keys rotate', async () => {
    const { items, store, broker } = makeVault();
    const service = new Connectors(store, items, broker);
    const connector = new GitPassConnector(() => service.secretFor('pass-git'));
    // Binding/consent unit test; live verification is exercised with real remotes.
    connector.validateSecret = async () => ({ name: 'pass-git', label: 'Pass', available: true, canPush: true, detail: 'test' });
    connector.push = async () => { throw new Error('offline'); };
    service.register(connector);
    const config = { repositoryUrl: 'https://github.com/example/root.git', gpgPrivateKey: 'test-key',
      mounts: [{ name: 'work', repositoryUrl: 'https://github.com/example/work.git', gpgPrivateKey: 'test-key' }] };
    expect(await service.connect('pass-git', JSON.stringify(config))).toMatchObject({ newStore: true, droppedWrites: [] });
    (await service.setConfig('pass-git', { writeBack: true }));
    (await service.setAutoSync('pass-git', { keepUpdated: true, externalIds: ['work/otp'] }));
    const created = (await items.save({ type: 'login', label: 'deploy key', secrets: { password: 'generated' },
      provenance: { source: 'task:t1', taskId: 't1' } }));
    expect((await service.writeBackCreated(created.id))[0]?.error).toMatch(/pending retry/);
    const [queued] = await service.pendingWrites();
    expect(broker.hasHandle(queued!.snapshotHandle!)).toBe(true);
    expect(await service.connect('pass-git', JSON.stringify({ ...config, gpgPrivateKey: 'rotated-key' })))
      .toMatchObject({ connector: { available: true }, newStore: false, droppedWrites: [] });
    expect((await service.config('pass-git')).writeBack).toBe(true);
    expect(await service.pendingWrites()).toHaveLength(1);
    // A queued write can only ever reach the store it was queued for, so a
    // different store drops it (and its secret snapshot) and says so.
    expect(await service.connect('pass-git', JSON.stringify({ ...config, mounts: [{ ...config.mounts[0], repositoryUrl: 'https://github.com/example/other.git' }] })))
      .toMatchObject({ newStore: true, droppedWrites: ['deploy key'] });
    expect((await service.config('pass-git')).writeBack).toBeUndefined();
    expect((await service.config('pass-git')).autoSync).toEqual({ enabled: false, importNew: false, externalIds: [] });
    expect(await service.pendingWrites()).toEqual([]);
    expect(broker.hasHandle(queued!.snapshotHandle!)).toBe(false);
  });
});

it('keeps the active connector secret unchanged while a replacement is being validated', async () => {
  const { items, store, broker } = makeVault();
  const service = new Connectors(store, items, broker);
  const info = { name: 'candidate', label: 'Candidate', available: true, canPush: false, detail: '' };
  let rejectCandidate!: (error: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  service.register({ name: 'candidate', describe: async () => info, list: async () => [], pull: async () => ({ items: [], failures: [] }),
    validateSecret: async secret => {
      if (secret === 'working') return info;
      entered();
      return new Promise((_resolve, reject) => { rejectCandidate = reject; });
    },
  });
  await service.connect('candidate', 'working');
  const replacement = service.connect('candidate', 'unverified');
  const rejected = expect(replacement).rejects.toThrow('invalid candidate');
  await started;
  expect(service.secretFor('candidate')).toBe('working');
  rejectCandidate(new Error('invalid candidate'));
  await rejected;
  expect(service.secretFor('candidate')).toBe('working');
});


describe('connector export and propagation regressions', () => {
  it('exposes creation separately from field updates', async () => {
    const { store, items, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(new BitwardenConnector(() => undefined));
    connectors.register(new OnePasswordConnector(() => undefined));
    connectors.register(new OnePasswordSdkConnector(() => undefined));
    for (const info of await connectors.describe()) {
      expect(info.canPush).toBe(false);
      expect(info.canUpdate).toBe(true);
    }
  });
  it('reports unsupported creation instead of silently skipping an enabled connector', async () => {
    const { store, items, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    connectors.register(new BitwardenConnector(() => undefined));
    (await connectors.setConfig('bitwarden', { writeBack: true }));
    const item = (await items.save({ type: 'note', label: 'note', secrets: { note: 'synthetic' } }));
    expect(await connectors.writeBackCreated(item.id)).toEqual([
      expect.objectContaining({ connector: 'bitwarden', error: expect.any(String) }),
    ]);
  });
  it('imports 1Password CLI notes, SSH keys and source TOTP seeds', async () => {
    const c = new OnePasswordConnector(
      () => 'token',
      async (_cmd, args) =>
        JSON.stringify(
          args.includes('note')
            ? { category: 'SECURE_NOTE', fields: [{ id: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: 'note text' }] }
            : args.includes('ssh')
              ? { category: 'SSH_KEY', fields: [{ id: 'private_key', value: 'private key' }] }
              : {
                  category: 'LOGIN',
                  fields: [
                    { id: 'password', value: 'pw' },
                    { id: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: 'login note' },
                    { id: 'otp', type: 'OTP', value: 'otpauth://totp/example?secret=JBSWY3DPEHPK3PXP', totp: '123456' },
                  ],
                },
        ),
    );
    const result = await c.pull(['note', 'ssh', 'login']);
    expect(result.items.map((x) => x.secrets)).toEqual([
      { note: 'note text' },
      { privateKey: 'private key' },
      { password: 'pw', note: 'login note', totp: 'otpauth://totp/example?secret=JBSWY3DPEHPK3PXP' },
    ]);
  });
  it('attempts other fields and stores after a failed rotation, persists and retries only failed work', async () => {
    const { store, items, broker } = makeVault();
    const connectors = new Connectors(store, items, broker);
    const calls: string[] = [];
    let fail = true;
    for (const name of ['a', 'b']) {
      connectors.register({
        name,
        describe: async () => ({ name, label: name, available: true, detail: '', canPush: true }),
        list: async () => [],
        pull: async () => ({ items: [], failures: [] }),
        push: async () => ({ externalId: name }),
        updateSecret: async (_id, field) => {
          calls.push(name + ':' + field);
          if (name === 'a' && field === 'password' && fail) throw new Error('offline');
        },
      });
      (await connectors.setConfig(name, { writeBack: true }));
    }
    const item = (await items.save({ type: 'login', label: 'login', secrets: { password: 'pw', note: 'note' } }));
    await connectors.writeBackCreated(item.id);
    const result = await connectors.propagate(item.id, ['password', 'note']);
    expect(calls).toEqual(['a:password', 'a:note', 'b:password', 'b:note']);
    expect(result?.error).toBeTruthy();
    expect((await connectors.pendingWrites())).toHaveLength(1);
    const fresh = new Connectors(store, items, broker);
    for (const name of ['a', 'b']) fresh.register(connectors.get(name)!);
    fail = false;
    calls.length = 0;
    await fresh.retryWrites();
    expect(calls).toEqual(['a:password']);
    expect((await fresh.pendingWrites())).toEqual([]);
  });
});

describe('durable connector outbox', () => {
  it('protects a failed local rotation from stale imports and respects disabled write-back', async () => {
    const { store, items, broker } = makeVault();
    const service = new Connectors(store, items, broker);
    let fail = true;
    let value = 'old';
    service.register({
      name: 'source',
      describe: async () => ({ name: 'source', label: 'source', available: true, detail: '', canPush: false }),
      list: async () => [{ externalId: 'id', type: 'login', label: 'login', fields: ['password'] }],
      pull: async () => ({
        items: [
          { externalId: 'id', type: 'login', label: 'login', fields: ['password'], secrets: { password: value } },
        ],
        failures: [],
      }),
      updateSecret: async (_id, _field, next) => {
        if (fail) throw new Error('secret must never persist: ' + next);
        value = next;
      },
    });
    const imported = await service.sync('source', ['id'], { writeBack: true });
    const id = imported.itemIds[0]!;
    (await items.save({ id, type: 'login', secrets: { password: 'new-secret' } }));
    expect((await service.propagate(id, ['password']))?.error).toBeTruthy();
    expect(JSON.stringify((await service.pendingWrites()))).not.toContain('new-secret');
    expect((await service.sync('source', ['id'])).count).toBe(0);
    expect(items.readSecret((await items.get(id))!, 'password')).toBe('new-secret');
    (await service.setConfig('source', { writeBack: false }));
    fail = false;
    await service.retryWrites();
    expect(value).toBe('old');
    (await service.setConfig('source', { writeBack: true }));
    await service.retryWrites();
    expect(value).toBe('new-secret');
    expect((await service.pendingWrites())).toEqual([]);
  });
  it('does not lose a newer rotation while an older write is in flight', async () => {
    const { store, items, broker } = makeVault();
    const service = new Connectors(store, items, broker);
    let start!: () => void;
    const started = new Promise<void>((resolve) => (start = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const values: string[] = [];
    service.register({
      name: 'source',
      describe: async () => ({ name: 'source', label: 'source', available: true, detail: '', canPush: true }),
      list: async () => [],
      pull: async () => ({ items: [], failures: [] }),
      push: async () => ({ externalId: 'id' }),
      updateSecret: async (_id, _field, value) => {
        values.push(value);
        if (value === 'first') {
          start();
          await gate;
        }
      },
    });
    (await service.setConfig('source', { writeBack: true }));
    const item = (await items.save({ type: 'login', label: 'login', secrets: { password: 'first' } }));
    await service.writeBackCreated(item.id);
    const first = service.propagate(item.id, ['password']);
    await started;
    (await items.save({ id: item.id, type: 'login', secrets: { password: 'second' } }));
    const second = service.propagate(item.id, ['password']);
    release();
    await Promise.all([first, second]);
    expect(values).toEqual(['first', 'second']);
    expect((await service.pendingWrites())).toEqual([]);
  });
  it('cannot send queued writes to a replacement connection', async () => {
    const { store, items, broker } = makeVault();
    const service = new Connectors(store, items, broker);
    let writes = 0;
    service.register({
      name: 'source',
      describe: async () => ({ name: 'source', label: 'source', available: true, detail: '', canPush: true }),
      list: async () => [],
      pull: async () => ({ items: [], failures: [] }),
      push: async () => {
        writes++;
        throw new Error('offline');
      },
    });
    await service.connect('source', 'first-account');
    (await service.setConfig('source', { writeBack: true }));
    const item = (await items.save({ type: 'note', label: 'note', secrets: { note: 'sensitive' } }));
    await service.writeBackCreated(item.id);
    await service.connect('source', 'second-account');
    expect((await service.retryWrites())[0]?.error).toMatch(/store changed/);
    expect(writes).toBe(1);
  });
});

it('publishes local pass ciphertext exclusively when another writer wins the name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-exclusive-'));
  try {
    fs.writeFileSync(path.join(root, '.gpg-id'), 'test recipient');
    const c = new PassConnector(async (_cmd, args, opts) => {
      expect(args).toEqual(['insert', '-m', 'export']);
      fs.writeFileSync(path.join(opts!.env!.PASSWORD_STORE_DIR!, 'export.gpg'), 'our ciphertext');
      fs.writeFileSync(path.join(root, 'tavya', 'same.gpg'), 'other ciphertext');
      return '';
    }, root);
    await expect(
      c.push({ externalId: 'tavya/same', type: 'note', label: 'same', fields: ['note'], secrets: { note: 'ours' } }),
    ).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, 'tavya', 'same.gpg'), 'utf8')).toBe('other ciphertext');
    expect(fs.readdirSync(path.join(root, 'tavya'))).toEqual(['same.gpg']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('edits one 1Password field instead of replacing the item from a JSON template', async () => {
  const commands: string[][] = [];
  const puts: any[] = [];
  const fields = [{ id: 'public_key', value: 'ssh-ed25519 AAAA', fieldType: 'Text' }, { id: 'private_key', value: 'old', fieldType: 'SshKey' }];
  const client: any = { vaults: { list: async () => [] }, items: {
    list: async () => [], get: async (vaultId: string, id: string) => ({ id, vaultId, fields: structuredClone(fields) }),
    put: async (item: any) => { puts.push(item); return item; } } };
  const c = new OnePasswordConnector(() => 'token', async (_cmd, args) => {
    commands.push(args);
    return JSON.stringify({ id: 'id', vault: { id: 'v' } });
  }, new OnePasswordSdkConnector(() => 'token', async () => client));
  await c.updateSecret('id', 'privateKey', 'synthetic-key');
  expect(commands).toEqual([['item', 'get', 'id', '--format=json']]);
  expect(puts[0].fields).toEqual([fields[0], { ...fields[1], value: 'synthetic-key' }]);
});

it('does not let an in-flight stale import undo a completed rotation', async () => {
  const { store, items, broker } = makeVault();
  const service = new Connectors(store, items, broker);
  let value = 'old';
  let wait = false;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  service.register({
    name: 'source',
    describe: async () => ({ name: 'source', label: 'source', available: true, detail: '', canPush: false }),
    list: async () => [{ externalId: 'id', type: 'login', label: 'login', fields: ['password'] }],
    pull: async () => {
      const snapshot = value;
      if (wait) {
        started();
        await gate;
      }
      return {
        items: [
          { externalId: 'id', type: 'login', label: 'login', fields: ['password'], secrets: { password: snapshot } },
        ],
        failures: [],
      };
    },
    updateSecret: async (_id, _field, next) => {
      value = next;
    },
  });
  const imported = await service.sync('source', ['id'], { writeBack: true });
  const id = imported.itemIds[0]!;
  wait = true;
  const syncing = service.sync('source', ['id']);
  await reading;
  const oldVersion = (await items.get(id))!.updatedAt;
  (await items.save({ id, type: 'login', secrets: { password: 'new' } }));
  expect((await items.get(id))!.updatedAt).toBeGreaterThan(oldVersion);
  await service.propagate(id, ['password']);
  expect((await service.pendingWrites())).toEqual([]);
  release();
  expect((await syncing).skipped).toBe(1);
  expect(items.readSecret((await items.get(id))!, 'password')).toBe('new');
});

it('does not resurrect a dismissed write when an in-flight attempt fails', async () => {
  const { store, items, broker } = makeVault();
  const service = new Connectors(store, items, broker);
  let started!: () => void;
  const writing = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  service.register({
    name: 'source',
    describe: async () => ({ name: 'source', label: 'source', available: true, detail: '', canPush: true }),
    list: async () => [],
    pull: async () => ({ items: [], failures: [] }),
    push: async () => {
      started();
      await gate;
      throw new Error('offline');
    },
  });
  (await service.setConfig('source', { writeBack: true }));
  const item = (await items.save({ type: 'note', label: 'note', secrets: { note: 'secret' } }));
  const attempt = service.writeBackCreated(item.id);
  await writing;
  const handle = (await service.pendingWrites())[0]!.snapshotHandle!;
  expect((await service.discardWrites('source'))).toBe(1);
  release();
  await attempt;
  expect((await service.pendingWrites())).toEqual([]);
  expect(broker.hasHandle(handle)).toBe(false);
  expect(items.readSecret((await items.get(item.id))!, 'note')).toBe('secret');
});

it('deletes pending export snapshots with the vault item even while retries are disabled', async () => {
  const {store,items,broker}=makeVault();const service=new Connectors(store,items,broker);
  service.register({name:'source',describe:async()=>({name:'source',label:'source',available:true,detail:'',canPush:true}),list:async()=>[],pull:async()=>({items:[],failures:[]}),push:async()=>{throw new Error('offline');}});
  (await service.setConfig('source',{writeBack:true}));
  const item=(await items.save({type:'note',label:'note',secrets:{note:'secret'}}));
  await service.writeBackCreated(item.id);
  const handle=(await service.pendingWrites())[0]!.snapshotHandle!;
  expect(broker.hasHandle(handle)).toBe(true);
  const status=(await service.describe())[0]!.pendingWrites[0]!;
  expect(status).not.toHaveProperty('snapshotHandle');
  expect(status).not.toHaveProperty('target');
  (await service.setConfig('source',{writeBack:false}));
  (await items.delete(item.id));
  expect((await service.pendingWrites())).toEqual([]);
  expect(broker.hasHandle(handle)).toBe(false);
});

it('queues Git rotations before remote revision lookup and respects dismissal during lookup', async () => {
  const { items, store, broker } = makeVault();
  const service = new Connectors(store, items, broker);
  const connector = new GitPassConnector(() => service.secretFor('pass-git'));
  connector.validateSecret = async () => ({ name: 'pass-git', label: 'Pass', available: true, canPush: true, detail: 'test' });
  service.register(connector);
  await service.connect('pass-git', JSON.stringify({ repositoryUrl: 'https://github.com/example/root.git', gpgPrivateKey: 'test' }));
  (await service.setConfig('pass-git', { writeBack: true }));
  const item = (await items.save({ type: 'login', label: 'Entry', secrets: { password: 'local' },
    provenance: { source: 'connector:pass-git', externalId: 'entry' } }));
  connector.catalog = async () => { throw new Error('transport unavailable'); };
  expect((await service.propagate(item.id, ['password']))?.error).toBeTruthy();
  expect((await service.discardWrites('pass-git'))).toBe(1);
  let updates = 0;
  connector.updateSecrets = async () => { updates++; };
  connector.catalog = async () => {
    expect((await service.discardWrites('pass-git'))).toBe(1);
    return { items: [{ externalId: 'entry', type: 'login', label: 'Entry', fields: ['password'], revision: 'rev' }], failures: [] };
  };
  await service.propagate(item.id, ['password']);
  expect(updates).toBe(0);
  expect((await service.discardWrites('pass-git'))).toBe(0);
});

describe.each(['LOGIN', 'SECURE_NOTE'])('1Password CLI %s notes', (category) => {
  it.each([
    { name: 'legacy content', fields: [], legacy: 'legacy note', expected: 'legacy note' },
    { name: 'legacy empty note', fields: [], legacy: '', expected: '' },
    { name: 'CLI 2 takes precedence', fields: [{ id: 'notesPlain', value: 'current' }], legacy: 'old', expected: 'current' },
    { name: 'CLI 2 empty note takes precedence', fields: [{ id: 'notesPlain', value: '' }], legacy: 'old', expected: '' },
    { name: 'cleared CLI 2 field does not restore legacy content', fields: [{ id: 'notesPlain' }], legacy: 'old', expected: undefined },
    { name: 'absent note', fields: [], legacy: undefined, expected: undefined },
  ])('$name', async ({ fields, legacy, expected }) => {
    const connector = new OnePasswordConnector(() => 'token', async () => JSON.stringify({
      category, notesPlain: legacy,
      fields: fields.map(field => ({ type: 'STRING', purpose: 'NOTES', label: 'notesPlain', ...field })),
    }));
    const result = await connector.pull(['entry']);
    expect(result.failures).toEqual([]);
    expect(result.items[0]!.secrets).toEqual(expected === undefined ? {} : { note: expected });
    expect(result.items[0]!.fields).toEqual(expected === undefined ? [] : ['note']);
  });

  it('preserves and updates a mirrored note, including explicit empty and deleted source fields', async () => {
    const { store, items, broker } = makeVault();
    const service = new Connectors(store, items, broker);
    const type = category === 'LOGIN' ? 'login' : 'note';
    const password = type === 'login' ? { password: 'synthetic-password' } : {};
    const original = 'first line\r\nsecond line\n';
    const item = (await items.save({ type, label: 'Entry', secrets: { ...password, note: original },
      provenance: { source: 'connector:1password', externalId: 'entry' } }));
    let value: string | undefined = original;
    let present = true;
    service.register(new OnePasswordConnector(() => 'token', async (_command, args) => JSON.stringify(
      args[1] === 'list' ? [{ id: 'entry', title: 'Entry', category }] : {
        id: 'entry', title: 'Entry', category,
        fields: [
          ...(type === 'login' ? [{ id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: password.password }] : []),
          ...(present ? [{ id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain', value }] : []),
        ],
      },
    )));
    for (const next of [original, 'updated\n  note  ', '', undefined]) {
      value = next;
      const result = await service.sync('1password', ['entry']);
      expect(result).toMatchObject({ count: 1, itemIds: [item.id], failures: [] });
      const saved = (await items.get(item.id))!;
      expect(items.readSecret(saved, 'note')).toBe(next);
      expect(saved.fields.includes('note')).toBe(next !== undefined);
      if (type === 'login') expect(items.readSecret(saved, 'password')).toBe(password.password);
    }
    // Removing the source field entirely must also remove an existing mirror value.
    (await items.save({ id: item.id, type, secrets: { note: 'local old note' } }));
    present = false;
    expect((await service.sync('1password', ['entry'])).count).toBe(1);
    expect((await items.get(item.id))!.fields).not.toContain('note');
    expect(items.readSecret((await items.get(item.id))!, 'note')).toBeUndefined();
  });
});
