import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitPassConnector } from '../src/autonomy/connectors.js';

const run = (cmd: string, args: string[], options: { cwd?: string; input?: string } = {}) =>
  execFileSync(cmd, args, { cwd: options.cwd, input: options.input, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });

function encryptedRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-pass-'));
  const gpgHome = path.join(root, 'source-gpg');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(gpgHome, { mode: 0o700 });
  const passphrase = 'test key passphrase';
  run('gpg', ['--homedir', gpgHome, '--batch', '--pinentry-mode', 'loopback', '--passphrase', passphrase,
    '--quick-generate-key', 'Karmax Pass Test <pass-test@karmax.invalid>', 'rsa2048', 'encr', '0']);
  const listing = run('gpg', ['--homedir', gpgHome, '--batch', '--with-colons', '--list-secret-keys']);
  const fingerprint = listing.split('\n').find((line) => line.startsWith('fpr:'))?.split(':')[9];
  if (!fingerprint) throw new Error('test GPG key has no fingerprint');
  const privateKey = run('gpg', ['--homedir', gpgHome, '--batch', '--armor', '--pinentry-mode', 'loopback',
    '--passphrase', passphrase, '--export-secret-keys', fingerprint]);

  run('git', ['init', '--bare', remote]);
  run('git', ['init', seed]);
  run('git', ['config', 'user.name', 'Karmax Test'], { cwd: seed });
  run('git', ['config', 'user.email', 'test@karmax.invalid'], { cwd: seed });
  run('git', ['checkout', '-b', 'main'], { cwd: seed });
  const store = path.join(seed, '.password-store');
  fs.mkdirSync(path.join(store, 'sites'), { recursive: true });
  fs.writeFileSync(path.join(store, '.gpg-id'), `${fingerprint}\n`);
  run('gpg', ['--homedir', gpgHome, '--batch', '--yes', '--trust-model', 'always', '--recipient', fingerprint,
    '--output', path.join(store, 'sites', 'example.com.gpg'), '--encrypt'],
  { input: 'old-password\nusername: alice\nkeep this note\notpauth://totp/example?secret=OLDSEED\n' });
  run('git', ['add', '.'], { cwd: seed });
  run('git', ['commit', '-m', 'seed pass store'], { cwd: seed });
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: seed });
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remote });

  const secret = JSON.stringify({ repositoryUrl: remote, storePath: '.password-store', gpgPrivateKey: privateKey, gpgPassphrase: passphrase });
  const decrypt = (file: string) => run('gpg', ['--homedir', gpgHome, '--batch', '--yes', '--pinentry-mode', 'loopback',
    '--passphrase-fd', '0', '--decrypt', file], { input: `${passphrase}\n` });
  return { root, remote, secret, decrypt };
}

describe('Git-backed unix pass connector', () => {
  it('clones, decrypts, updates, commits and pushes a password store', async () => {
    const fixture = encryptedRemote();
    const connector = new GitPassConnector(() => fixture.secret, 'org_test', () => ({}),
      path.join(fixture.root, 'connector-state'), { allowLocalRepository: true });

    expect(await connector.describe()).toMatchObject({ available: true, canPush: true });
    expect((await connector.list()).map((item) => item.externalId)).toEqual(['sites/example.com']);
    const first = (await connector.pull(['sites/example.com'])).items[0]!;
    expect(first.secrets).toEqual({ password: 'old-password', totp: 'otpauth://totp/example?secret=OLDSEED' });

    await connector.updateSecret('sites/example.com', 'password', 'rotated-password');
    await connector.push({ externalId: '', type: 'login', label: 'Created account', username: 'new-user',
      domains: ['created.example'], folder: '', fields: ['password'], secrets: { password: 'generated-password' } });

    const audit = path.join(fixture.root, 'audit');
    run('git', ['clone', fixture.remote, audit]);
    const updated = fixture.decrypt(path.join(audit, '.password-store', 'sites', 'example.com.gpg'));
    expect(updated).toContain('rotated-password\nusername: alice\nkeep this note');
    expect(updated).toContain('secret=OLDSEED');
    const created = fs.readdirSync(path.join(audit, '.password-store', 'karmax')).filter((file) => file.endsWith('.gpg'));
    expect(created).toHaveLength(1);
    expect(fixture.decrypt(path.join(audit, '.password-store', 'karmax', created[0]!)))
      .toContain('generated-password\nusername: new-user');
    expect(Number(run('git', ['rev-list', '--count', 'HEAD'], { cwd: audit }).trim())).toBe(3);

    fs.rmSync(fixture.root, { recursive: true, force: true });
  }, 30_000);

  it('refuses host filesystem repositories outside explicit test mode', async () => {
    const connector = new GitPassConnector(() => JSON.stringify({
      repositoryUrl: '/etc', gpgPrivateKey: 'not-a-key',
    }), 'org_test', () => ({}), fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-pass-state-')));
    await expect(connector.list()).rejects.toThrow(/HTTPS or SSH repository URL/i);
  });
});
