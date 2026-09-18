import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitPassConnector, Connectors } from '../src/autonomy/connectors.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const run = (cmd: string, args: string[], cwd?: string, input?: string) => execFileSync(cmd, args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-age-test-'));
  roots.push(root);
  const identity = path.join(root, 'identity');
  run('age-keygen', ['-o', identity]);
  const recipient = run('age-keygen', ['-y', identity]).trim();
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  run('git', ['init', '--bare', '--initial-branch=main', remote]);
  run('git', ['init', '--initial-branch=main', seed]);
  run('git', ['config', 'user.name', 'Test'], seed);
  run('git', ['config', 'user.email', 'test@example.invalid'], seed);
  fs.writeFileSync(path.join(seed, '.age-recipients'), recipient+'\n');
  run('age', ['-r', recipient, '-o', path.join(seed, 'example.age')], undefined, 'pw\notpauth://totp/example?secret=JBSWY3DPEHPK3PXP\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '-m', 'seed'], seed);
  run('git', ['remote', 'add', 'origin', remote], seed);
  run('git', ['push', '-u', 'origin', 'main'], seed);
  const config = { repositoryUrl: remote, crypto: 'age', ageIdentity: fs.readFileSync(identity, 'utf8') };
  return { root, remote, seed, identity, config };
}
const connector = (config: object, root: string) => new GitPassConnector(() => JSON.stringify(config), 'org_test', () => ({}), path.join(root, 'state'), { allowLocalRepository: true });
describe('age and mounted Git password stores', () => {
  it('reads and writes real age ciphertext through Git', async () => {
    const f = fixture();
    const c = connector(f.config, f.root);
    expect((await c.list()).map((x) => x.externalId)).toEqual(['example']);
    expect((await c.pull(['example'])).items[0]?.secrets.password).toBe('pw');
    await c.updateSecret('example', 'password', 'rotated');
    const created = await c.push({
      type: 'login',
      externalId: '',
      label: 'otp',
      fields: ['totp'],
      secrets: { totp: 'JBSWY3DPEHPK3PXP' },
    });
    run('git', ['pull', '--ff-only'], f.seed);
    expect(run('age', ['-d', '-i', f.identity, path.join(f.seed, 'example.age')])).toContain(
      'rotated\notpauth://totp/',
    );
    expect(run('age', ['-d', '-i', f.identity, path.join(f.seed, created.externalId + '.age')])).toMatch(
      /^otpauth:\/\/totp\//,
    );
    expect(fs.readdirSync(path.join(f.root, 'state')).some((x) => x.startsWith('.key-'))).toBe(false);
  });
  it('lists, pulls and rotates mounted entries in the correct remote', async () => {
    const f = fixture();
    const mount = fixture();
    const c = connector({ ...f.config, mounts: [{ ...mount.config, name: 'work' }] }, f.root);
    expect((await c.list()).map((x) => x.externalId).sort()).toEqual(['example', 'work/example']);
    const pulled = await c.pull(['example', 'work/example']);
    expect(pulled.items.map((x) => x.externalId).sort()).toEqual(['example', 'work/example']);
    await c.updateSecret('work/example', 'password', 'work-only');
    expect((await c.pull(['example'])).items[0]?.secrets.password).toBe('pw');
    run('git', ['pull', '--ff-only'], mount.seed);
    expect(run('age', ['-d', '-i', mount.identity, path.join(mount.seed, 'example.age')])).toContain('work-only\n');
  });
  it('rejects overlapping mounts and unsafe age identities', async () => {
    const f = fixture();
    await expect(connector({ ...f.config, mounts: [{ ...f.config, name: '../bad' }] }, f.root).list()).rejects.toThrow(
      /mount/i,
    );
    await expect(
      connector(
        {
          ...f.config,
          mounts: [
            { ...f.config, name: 'work' },
            { ...f.config, name: 'work/team' },
          ],
        },
        f.root,
      ).list(),
    ).rejects.toThrow(/mount/i);
    await expect(connector({ ...f.config, ageIdentity: 'AGE-PLUGIN-TEST-123' }, f.root).list()).rejects.toThrow(
      /identity/i,
    );
  });
  it('never follows an export-folder symlink outside the checkout', async () => {
    const f = fixture();
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.seed, 'karmax'));
    run('git', ['add', 'karmax'], f.seed);
    run('git', ['commit', '-m', 'symlink fixture'], f.seed);
    run('git', ['push'], f.seed);
    const c = connector(f.config, f.root);
    await expect(
      c.push({
        type: 'login',
        externalId: '',
        label: 'secret',
        fields: ['password'],
        secrets: { password: 'private' },
      }),
    ).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('reports wrong keys per entry and removes temporary identities', async () => {
    const f = fixture();
    const wrong = fixture();
    const c = connector({ ...f.config, ageIdentity: wrong.config.ageIdentity }, f.root);
    const result = await c.pull(['example']);
    expect(result.items).toEqual([]);
    expect(result.failures).toEqual([{ externalId: 'example', error: expect.stringMatching(/decrypt/) }]);
    expect(fs.readdirSync(path.join(f.root, 'state')).some((name) => name.startsWith('.key-'))).toBe(false);
    await expect(c.updateSecret('example', 'password', 'new')).rejects.toThrow(/age identity/);
    expect(fs.readdirSync(path.join(f.root, 'state')).some((name) => name.startsWith('.key-'))).toBe(false);
  });

  it('recovers from a rejected push without losing source notes', async () => {
    const f = fixture();
    const c = connector(f.config, f.root);
    const hook = path.join(f.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await expect(c.updateSecret('example', 'password', 'rejected')).rejects.toThrow(/pushed/);
    fs.rmSync(hook);
    expect((await c.pull(['example'])).items[0]?.secrets.password).toBe('pw');
    await c.updateSecret('example', 'password', 'accepted');
    const result = (await c.pull(['example'])).items[0]!;
    expect(result.secrets.password).toBe('accepted');
    expect(result.secrets.totp).toContain('JBSWY3DPEHPK3PXP');
  });

  it('serializes concurrent field changes against one repository', async () => {
    const f = fixture();
    const c = connector(f.config, f.root);
    await Promise.all([
      c.updateSecret('example', 'password', 'concurrent'),
      c.updateSecret('example', 'totp', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'),
    ]);
    const result = (await c.pull(['example'])).items[0]!;
    expect(result.secrets.password).toBe('concurrent');
    expect(result.secrets.totp).toContain('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('verifies the repository and key before replacing a working connection', async () => {
    const f = fixture();
    const kv = new Map<string, string>();
    const db = {
      kvGet: (k: string) => kv.get(k),
      kvSet: (k: string, v: string) => {
        kv.set(k, v);
      },
      appendAudit: () => 0,
    };
    const broker = new CredentialBroker(new Vault(path.join(f.root, 'vault')));
    const service = new Connectors(db, new VaultItems(db, broker, path.join(f.root, 'vault-state')), broker);
    service.register(
      new GitPassConnector(
        () => service.secretFor('pass-git'),
        'org_personal',
        () => ({}),
        path.join(f.root, 'state'),
        { allowLocalRepository: true },
      ),
    );
    await service.connect('pass-git', JSON.stringify(f.config));
    await expect(
      service.connect('pass-git', JSON.stringify({ ...f.config, ageIdentity: 'AGE-SECRET-KEY-1' + 'A'.repeat(58) })),
    ).rejects.toThrow();
    expect(service.secretFor('pass-git')).toBe(JSON.stringify(f.config));
    await expect(
      service.connect('pass-git', JSON.stringify({ ...f.config, repositoryUrl: path.join(f.root, 'missing.git') })),
    ).rejects.toThrow();
    expect((await service.get('pass-git')!.pull(['example'])).items).toHaveLength(1);
  });

  it('round-trips every non-login type and retries the same export without duplicates', async () => {
    const f = fixture();
    const c = connector(f.config, f.root);
    for (const [type, field, value] of [
      ['api-key', 'secret', 'synthetic-api-key'],
      ['note', 'note', 'line one\nline two\r\n'],
      ['ssh-key', 'privateKey', 'PRIVATE\nKEY\n'],
      ['env', 'env', 'A=one\nB=two\n'],
      ['passkey', 'passkey', '{"credentialId":"id","privateKey":"key"}'],
    ] as const) {
      const item = {
        externalId: `karmax/stable-${type}`,
        type,
        label: 'Duplicate label',
        username: 'alice',
        domains: ['example.com'],
        fields: [field],
        secrets: { [field]: value },
      };
      const result = await c.push(item);
      expect(await c.push(item)).toEqual(result);
      const fresh = connector(f.config, f.root);
      expect((await fresh.pull([result.externalId])).items[0]).toMatchObject(item);
      await fresh.updateSecret(result.externalId, field, value + '!');
      expect((await fresh.pull([result.externalId])).items[0]?.secrets[field]).toBe(value + '!');
      // A lost acknowledgement may replay an already-applied typed rotation.
      await expect(fresh.updateSecrets(result.externalId, { [field]: value + '!' }, 'old-revision')).resolves.toBeUndefined();
      await expect(fresh.updateSecrets(result.externalId, { [field]: 'conflicting' }, 'old-revision')).rejects.toThrow(/Remote entry changed/);
      await expect(c.push(item)).rejects.toThrow(/not overwritten/);
    }
    expect(await c.list()).toHaveLength(6);
  });

  it('recovers a lost push response across restart and applies a newer vault rotation', async () => {
    const f = fixture();
    const c = connector(f.config, f.root);
    const kv = new Map<string, string>();
    const db = {
      kvGet: (key: string) => kv.get(key),
      kvSet: (key: string, value: string) => {
        kv.set(key, value);
      },
      appendAudit: () => 0,
    };
    const broker = new CredentialBroker(new Vault(path.join(f.root, 'vault')));
    const items = new VaultItems(db, broker, path.join(f.root, 'items'));
    const service = new Connectors(db, items, broker);
    let loseResponse = true;
    const push = c.push.bind(c);
    c.push = async (item) => {
      const result = await push(item);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('response lost');
      }
      return result;
    };
    service.register(c);
    service.setConfig('pass-git', { writeBack: true });
    const item = items.save({ type: 'api-key', label: 'original label', secrets: { secret: 'original-secret' } });
    expect((await service.writeBackCreated(item.id))[0]?.error).toBeTruthy();
    const snapshot = service.pendingWrites()[0]!.snapshotHandle!;
    items.save({ id: item.id, type: 'api-key', label: 'renamed', secrets: { secret: 'rotated-secret' } });
    const freshBroker = new CredentialBroker(new Vault(path.join(f.root, 'vault')));
    const fresh = new Connectors(db, new VaultItems(db, freshBroker, path.join(f.root, 'items')), freshBroker);
    fresh.register(connector(f.config, f.root));
    expect((await fresh.retryWrites())[0]?.error).toBeUndefined();
    expect(fresh.pendingWrites()).toEqual([]);
    expect(freshBroker.hasHandle(snapshot)).toBe(false);
    const externalId = items.get(item.id)!.provenance.externalIds!['pass-git']!;
    expect((await c.pull([externalId])).items[0]?.secrets.secret).toBe('rotated-secret');
    expect(await c.list()).toHaveLength(2);
  });
});

it('verifies actual entry decryption and distinguishes transport from encryption readiness', async () => {
  const f = fixture(); const wrong = fixture(); const c = connector(f.config, f.root);
  expect((await c.validateSecret(JSON.stringify(f.config))).checks).toEqual([
    { store: 'root', entry: 'example', read: 'verified', encryption: true, push: true },
  ]);
  await expect(c.validateSecret(JSON.stringify({ ...f.config, ageIdentity: wrong.config.ageIdentity }))).rejects.toThrow(/verification/);
  await expect(c.validateSecret(JSON.stringify({ ...f.config, validationEntry: 'missing' }))).rejects.toThrow(/verification/);
  fs.writeFileSync(path.join(f.seed, '.age-recipients'), 'invalid-recipient\n');
  run('git', ['add', '.'], f.seed); run('git', ['commit', '-m', 'unusable encryption recipients'], f.seed); run('git', ['push'], f.seed);
  expect((await c.validateSecret(JSON.stringify(f.config))).checks?.[0]).toMatchObject({ read: 'verified', encryption: false });
});

it('keeps healthy mounts available when another repository disappears', async () => {
  const f = fixture(); const mount = fixture();
  const config = { ...f.config, mounts: [{ ...mount.config, name: 'work' }] };
  const c = connector(config, f.root);
  const kv = new Map<string, string>();
  const db = { kvGet: (key: string) => kv.get(key), kvSet: (key: string, value: string) => { kv.set(key, value); }, appendAudit: () => 0 };
  const broker = new CredentialBroker(new Vault(path.join(f.root, 'vault')));
  const items = new VaultItems(db, broker, path.join(f.root, 'vault-state'));
  const service = new Connectors(db, items, broker); service.register(c);
  await service.connect('pass-git', JSON.stringify(config));
  service.setAutoSync('pass-git', { keepUpdated: true, importNew: true, externalIds: [] });
  await c.list(); fs.rmSync(mount.remote, { recursive: true });
  const catalog = await c.catalog();
  expect(catalog.items.map(item => item.externalId)).toEqual(['example']);
  expect(catalog.failures).toEqual([{ store: 'work/', error: expect.any(String) }]);
  const pulled = await c.pull(['example', 'work/example']);
  expect(pulled.items.map(item => item.externalId)).toEqual(['example']);
  expect(pulled.failures[0]?.externalId).toBe('work/example');
  const automatic = await service.autoSync('pass-git', 'backstop');
  expect(automatic?.count).toBe(1);
  expect(automatic?.failures).toEqual([{ externalId: 'work/', error: expect.any(String) }]);
});

it('persists failed write-back, blocks remote conflicts and imports an explicitly accepted remote value', async () => {
  const f = fixture();
  const kv = new Map<string, string>();
  const db = { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: string) => { kv.set(k, v); }, appendAudit: () => 0 };
  const broker = new CredentialBroker(new Vault(path.join(f.root, 'vault')));
  const items = new VaultItems(db, broker, path.join(f.root, 'vault-state'));
  const makeService = () => {
    const service = new Connectors(db, items, broker);
    service.register(new GitPassConnector(() => service.secretFor('pass-git'), 'org_personal', () => ({}), path.join(f.root, 'state'), { allowLocalRepository: true }));
    return service;
  };
  let service = makeService();
  await service.connect('pass-git', JSON.stringify(f.config));
  const synced = await service.sync('pass-git', ['example'], { writeBack: true });
  const id = synced.itemIds[0]!;
  items.save({ id, type: 'login', secrets: { password: 'local-new' } });
  const hook = path.join(f.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  expect((await service.propagate(id, ['password']))?.error).toContain('pending retry');
  expect(JSON.stringify([...kv])).not.toContain('local-new');
  service = makeService();
  expect((await service.describe())[0]?.pendingWrites).toEqual([{ itemId: id, label: expect.any(String) }]);
  fs.rmSync(hook);
  run('age', ['-r', run('age-keygen', ['-y', f.identity]).trim(), '-o', path.join(f.seed, 'new.age')], undefined, 'remote-new\nkeep remote note\n');
  fs.renameSync(path.join(f.seed, 'new.age'), path.join(f.seed, 'example.age'));
  run('git', ['add', '.'], f.seed); run('git', ['commit', '-m', 'concurrent remote edit'], f.seed); run('git', ['push'], f.seed);
  await expect(service.retryWriteBack(id)).rejects.toThrow(/Remote entry changed/);
  expect((await service.retryWrites())[0]?.error).toContain('review the remote value');
  const blocked = await service.sync('pass-git', ['example']);
  expect(blocked.failures).toHaveLength(1);
  expect(items.readSecret(items.get(id)!, 'password')).toBe('local-new');
  await service.acceptRemote(id);
  expect(items.readSecret(items.get(id)!, 'password')).toBe('remote-new');
  expect((await service.describe())[0]?.pendingWrites).toEqual([]);
  items.save({ id, type: 'login', secrets: { password: 'retry-new', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } });
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  expect((await service.propagate(id, ['password', 'totp']))?.error).toContain('pending retry');
  service.setConfig('pass-git', { writeBack: false });
  expect(await service.retryWrites()).toEqual([]);
  expect(await service.retryWriteBack(id)).toBeUndefined();
  service.setConfig('pass-git', { writeBack: true });
  fs.rmSync(hook);
  expect(await makeService().retryWrites()).toEqual([{ connector: 'pass-git', itemId: id }]);
  expect((await connector(f.config, f.root).pull(['example'])).items[0]?.secrets.password).toBe('retry-new');
  expect((await connector(f.config, f.root).pull(['example'])).items[0]?.secrets.totp).toContain('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  // A sync that decrypted an older value must not overwrite a rotation that
  // completed while it was pulling from Git.
  const active = service.get('pass-git')!;
  const originalPull = active.pull.bind(active);
  active.pull = async ids => {
    const stale = await originalPull(ids);
    items.save({ id, type: 'login', secrets: { password: 'concurrent-local' } });
    await service.propagate(id, ['password']);
    return stale;
  };
  const raced = await service.sync('pass-git', ['example']);
  expect(raced.failures[0]?.error).toContain('changed during import');
  expect(items.readSecret(items.get(id)!, 'password')).toBe('concurrent-local');

  expect((await service.describe())[0]?.pendingWrites).toEqual([]);
  active.pull = originalPull;
  items.save({ id, type: 'login', secrets: { password: 'dismiss-local' } });
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  expect((await service.propagate(id, ['password']))?.error).toBeTruthy();
  expect(service.discardWrites('pass-git')).toBe(1);
  expect((await service.describe())[0]?.pendingWrites).toEqual([]);
  expect(items.readSecret(items.get(id)!, 'password')).toBe('dismiss-local');
  expect((await service.propagate(id, ['password']))?.error).toBeTruthy();
  service.setConfig('pass-git', { writeBack: false });
  items.delete(id);
  expect(JSON.parse(kv.get(`pass-writeback:org_personal:${id}`)!).fields).toEqual({});
});

it('accepts encrypted age identities, rejects wrong passphrases and cleans temporary plaintext', async () => {
  const f = fixture();
  const { encryptIdentity } = await import('./helpers/age-encrypted-identity.js');
  const encrypted = path.join(f.root, 'identity.age');
  await encryptIdentity(f.identity, encrypted, 'test-only-passphrase');
  const config = { ...f.config, ageIdentity: undefined, ageIdentityEncrypted: fs.readFileSync(encrypted).toString('base64'), agePassphrase: 'test-only-passphrase' };
  const c = connector(config, f.root);
  expect((await c.validateSecret(JSON.stringify(config))).checks?.[0]?.read).toBe('verified');
  expect((await c.pull(['example'])).items[0]?.secrets.password).toBe('pw');
  await c.updateSecret('example', 'password', 'encrypted-identity-rotation');
  expect((await c.pull(['example'])).items[0]?.secrets.password).toBe('encrypted-identity-rotation');
  await expect(c.validateSecret(JSON.stringify({ ...config, agePassphrase: 'wrong' }))).rejects.toThrow(/verification/);
  expect(fs.readdirSync(path.join(f.root, 'state')).filter(name => name.startsWith('.key-'))).toEqual([]);
}, 60_000);
