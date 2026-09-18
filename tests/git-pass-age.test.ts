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
