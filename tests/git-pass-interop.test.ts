import { memoryTransaction } from './helpers/memory-transaction.js';
/** Real CLI interoperability. Run with KARMAX_TEST_PASS_INTEROP=1; requires pass,
 * pass-otp, gopass, age and GnuPG. All keys, remotes and configs are ephemeral. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { GitPassConnector, PassConnector, Connectors } from '../src/autonomy/connectors.js';
import { VaultItems, totpCode } from '../src/autonomy/vault-items.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';

it.runIf(process.env.KARMAX_TEST_PASS_INTEROP === '1')('round-trips pass-otp and gopass through encrypted Git and the Karmax vault', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pass-interop-'));
  const gpgHome = path.join(root, 'gnupg');
  fs.mkdirSync(gpgHome, { mode: 0o700 });
  const env = { ...process.env, GNUPGHOME: gpgHome, GOPASS_HOMEDIR: path.join(root, 'gopass-home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    PASSWORD_STORE_DIR: path.join(root, 'store'), PASSWORD_STORE_ENABLE_EXTENSIONS: 'true', GOPASS_AGE_PASSWORD: 'test-only' };
  const run = (cmd: string, args: string[], input?: string, cwd?: string) => execFileSync(cmd === 'gopass' ? process.env.GOPASS_BIN || cmd : cmd, args,
    { env, input, cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    run('gpg', ['--batch', '--passphrase', '', '--quick-generate-key', 'Interop <interop@example.invalid>', 'rsa2048', 'encr', '0']);
    const fingerprint = run('gpg', ['--with-colons', '--list-secret-keys']).split('\n').find(l => l.startsWith('fpr:'))!.split(':')[9]!;
    const privateKey = run('gpg', ['--batch', '--armor', '--export-secret-keys', fingerprint]);
    run('pass', ['init', fingerprint]);
    run('pass', ['git', 'init']);
    const store = env.PASSWORD_STORE_DIR;
    const remote = path.join(root, 'remote.git');
    run('git', ['init', '--bare', remote]);
    run('git', ['remote', 'add', 'origin', remote], undefined, store);
    const branch = run('git', ['branch', '--show-current'], undefined, store).trim();
    run('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], undefined, remote);
    const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const uri = `otpauth://totp/example?secret=${seed}`;
    run('pass', ['otp', 'insert', '-e', 'standalone'], uri+'\n');
    run('pass', ['insert', '-m', 'appended'], 'password\nkeep note\n');
    run('pass', ['otp', 'append', '-e', 'appended'], uri+'\n');
    run('gopass', ['config', 'mounts.path', store]);
    run('gopass', ['config', 'core.autosync', 'false']);
    run('gopass', ['insert', '-m', '-f', 'yaml'], `password\n---\n# keep comment\nusername: alice\ntotp: ${seed}\n`);
    run('gopass', ['insert', '-m', '-f', 'kv'], `password\ntotp: ${seed}\nusername: alice\n`);
    run('gopass', ['insert', '-m', '-f', 'mixed-kv'], `password\ntotp: ${seed}\notpauth: otpauth://totp/mixed?secret=JBSWY3DPEHPK3PXP\n`);
    run('gopass', ['insert', '-m', '-f', 'mixed-bare'], `password\ntotp: ${seed}\notpauth://totp/mixed?secret=JBSWY3DPEHPK3PXP\n`);
    const variants = [
      ['sha256', `otpauth://totp/sha256?secret=${seed}&algorithm=SHA256&digits=8&period=45`],
      ['sha512', `otpauth://totp/sha512?secret=${seed}&algorithm=SHA512&digits=6&period=60`],
      ['custom', `otpauth://totp/custom?secret=${seed}&algorithm=SHA1&digits=8&period=15`],
    ];
    for (const [name, token] of variants) run('pass', ['otp', 'insert', '-e', name!], token+'\n');
    run('git', ['push', '-u', 'origin', branch], undefined, store);

    const config = { repositoryUrl: remote, gpgPrivateKey: privateKey };
    const connector = new GitPassConnector(() => JSON.stringify(config), 'org_personal', () => ({}), path.join(root, 'connector'), { allowLocalRepository: true });
    const kv = new Map<string, string>();
    const db = { transaction: memoryTransaction(kv), kvGet: (key: string) => kv.get(key), kvSet: (key: string, val: string) => { kv.set(key, val); }, appendAudit: () => 0 };
    const broker = new CredentialBroker(new Vault(path.join(root, 'vault')));
    const items = new VaultItems(db, broker, path.join(root, 'state'));
    const connectors = new Connectors(db, items, broker);
    connectors.register(connector);
    await connectors.connect('pass-git', JSON.stringify(config));
    const local = new PassConnector(
      async (cmd, args, opts) =>
        execFileSync(cmd, args, {
          env: { ...env, ...opts?.env },
          input: opts?.input,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      store,
    );
    for (const [type, field, value] of [
      ['api-key', 'secret', 'synthetic-key'],
      ['note', 'note', 'one\ntwo\n'],
      ['ssh-key', 'privateKey', 'private\nkey'],
      ['env', 'env', 'A=one\n'],
      ['passkey', 'passkey', '{"credentialId":"test"}'],
    ] as const) {
      const entry = {
        externalId: `karmax/local-${type}`,
        type,
        label: 'same label',
        fields: [field],
        secrets: { [field]: value },
      };
      const exported = await local.push(entry);
      {
        expect(await local.push(entry)).toEqual(exported);
        await expect(local.push({ ...entry, secrets: { [field]: 'different' } })).rejects.toThrow(/not overwritten/);
      }
      expect((await local.pull([exported.externalId])).items[0]?.secrets[field]).toBe(value);
      await local.updateSecret(exported.externalId, field, value + '!');
      expect((await local.pull([exported.externalId])).items[0]?.secrets[field]).toBe(value + '!');
    }
    const collisionA = await local.push({
      externalId: '',
      type: 'login',
      label: 'a b',
      fields: ['password'],
      secrets: { password: 'one' },
    });
    const collisionB = await local.push({
      externalId: '',
      type: 'login',
      label: 'a-b',
      fields: ['password'],
      secrets: { password: 'two' },
    });
    expect(collisionA.externalId).not.toBe(collisionB.externalId);
    expect((await local.pull([collisionA.externalId])).items[0]?.secrets.password).toBe('one');
    run('git', ['push'], undefined, store);
    const names = ['standalone', 'appended', 'yaml', 'kv', 'mixed-kv', 'mixed-bare', ...variants.map(([name]) => name!)];
    expect((await connectors.sync('pass-git', names)).count).toBe(names.length);
    const compareCodes = (name: string, secret: string) => {
      const before = Date.now();
      const code = run('gopass', ['otp', '-o', name]).trim();
      expect([totpCode(secret, before), totpCode(secret, Date.now())]).toContain(code);
      if (!['yaml', 'kv', 'mixed-kv'].includes(name)) {
        const beforePass = Date.now();
        const passCode = run('pass', ['otp', name]).trim();
        expect([totpCode(secret, beforePass), totpCode(secret, Date.now())]).toContain(passCode);
      }
    };
    for (const name of names) {
      const item = (await items.list()).find(i => i.provenance.externalId === name)!;
      if (name === 'standalone') expect(item.fields).not.toContain('password');
      const token = items.readSecret(item, 'totp')!;
      expect((await items.totp(item, {}))).toHaveLength(token.startsWith('otpauth://') ? Number(new URL(token).searchParams.get('digits') || 6) : 6);
      compareCodes(name, token);
    }
    const newSeed = 'JBSWY3DPEHPK3PXP';
    for (const name of names) await connector.updateSecret(name, 'totp', newSeed);
    run('git', ['pull', '--ff-only'], undefined, store);
    for (const name of names) compareCodes(name, newSeed);
    expect(run('gopass', ['show', '-n', 'yaml'])).toContain('# keep comment');
    expect((await connectors.sync('pass-git', names)).count).toBe(names.length);
    expect((await connectors.sync('pass-git', names)).skipped).toBe(names.length);

    const created = (await items.save({ type: 'login', label: 'new-otp', secrets: { totp: uri, note: 'retain me\n' }, provenance: { source: 'task:test' } }));
    (await connectors.setConfig('pass-git', { writeBack: true }));
    const written = await connectors.writeBack('pass-git', created.id);
    run('git', ['pull', '--ff-only'], undefined, store);
    compareCodes(written!.externalId, uri);
    expect(run('pass', ['show', written!.externalId])).toContain('retain me');

    // A real gopass age mount, with its own remote and key.
    const ageKeyFile = path.join(root, 'age-identity');
    run('age-keygen', ['-o', ageKeyFile]);
    const ageIdentity = fs.readFileSync(ageKeyFile, 'utf8');
    const ageRecipient = run('age-keygen', ['-y', ageKeyFile]).trim();
    run('gopass', ['config', 'age.agent-enabled', 'false']);
    run('gopass', ['age', 'identities', 'add', ageIdentity.split('\n').find(line => line.startsWith('AGE-SECRET-KEY-'))!]);
    const ageStore = path.join(root, 'age-store');
    run('gopass', ['--yes', 'init', '--store', 'work', '--crypto', 'age', '--path', ageStore, ageRecipient]);
    run('gopass', ['insert', '-m', '-f', 'work/otp'], uri+'\n');
    const ageRemote = path.join(root, 'age-remote.git');
    run('git', ['init', '--bare', ageRemote]);
    run('git', ['remote', 'add', 'origin', ageRemote], undefined, ageStore);
    const ageBranch = run('git', ['branch', '--show-current'], undefined, ageStore).trim();
    run('git', ['symbolic-ref', 'HEAD', `refs/heads/${ageBranch}`], undefined, ageRemote);
    run('git', ['push', '-u', 'origin', ageBranch], undefined, ageStore);
    const identityFile = fs.readdirSync(root, { recursive: true }).map(String).find(file => file.endsWith('age/identities'))!;
    expect(identityFile).toBeTruthy();
    const encryptedIdentity = fs.readFileSync(path.join(root, identityFile)).toString('base64');
    const mounted = new GitPassConnector(() => JSON.stringify({ ...config,
      mounts: [{ name: 'work', repositoryUrl: ageRemote, crypto: 'age',
        ageIdentityEncrypted: encryptedIdentity, agePassphrase: env.GOPASS_AGE_PASSWORD }] }),
      'org_personal', () => ({}), path.join(root, 'connector'), { allowLocalRepository: true });
    connectors.register(mounted);
    expect((await connectors.sync('pass-git', ['work/otp'])).count).toBe(1);
    const mountedItem = (await items.list()).find(item => item.provenance.externalId === 'work/otp')!;
    expect(items.readSecret(mountedItem, 'totp')).toBe(uri);
    await mounted.updateSecret('work/otp', 'totp', newSeed);
    run('git', ['pull', '--ff-only'], undefined, ageStore);
    const beforeAge = Date.now();
    const ageCode = run('gopass', ['otp', '-o', 'work/otp']).trim();
    expect([totpCode(newSeed, beforeAge), totpCode(newSeed, Date.now())]).toContain(ageCode);
    expect((await connectors.sync('pass-git', ['work/otp'])).count).toBe(1);
    expect(items.readSecret((await items.get(mountedItem.id))!, 'totp')).toContain(newSeed);
  } finally {
    run('gpgconf', ['--kill', 'gpg-agent']);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90000);
