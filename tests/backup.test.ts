import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { createBackup, restoreBackup, verifyBackup, recordRestores, signChecksums, verifyDeploymentBackup } from '../src/ops/backup.js';
import { localSigningFingerprint } from '../src/ops/backup-signing.js';
import crypto from 'node:crypto';
import { Vault } from '../src/autonomy/vault.js';
import { organizationScope } from '../src/autonomy/vault-keys.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('control-plane backup', () => {
  it('recovers records and decrypts a real vault in a separate offline home', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-recovery-drill-'));
    roots.push(root);
    const original = path.join(root, 'original');
    const recovered = path.join(root, 'recovered');
    vi.stubEnv('KARMAX_VAULT_KEY', undefined);
    try {
      fs.mkdirSync(path.join(original, 'state'), { recursive: true });
      const store = await Store.create(path.join(original, 'state', 'karmax.db'));
      const vault = new Vault(path.join(original, 'vault'));
      const handle = 'recovery-fixture';
      const secret = 'synthetic-recovery-fixture-not-a-provider-credential';
      try {
        await store.kvSet('recovery-handle', handle);
        await vault.put(handle, secret, organizationScope('org_personal'));
      } finally { await store.close(); }

      const { directory, signedBy } = await createBackup({ home: original, destination: path.join(root, 'snapshot'),
        externalTemporal: true });
      // Prove recovery uses the snapshot, not the source's current state.
      await vault.put(handle, 'changed-after-backup', organizationScope('org_personal'));
      // Another host trusts the signing key by the fingerprint kept off-host,
      // and is given the vault key kept off-host: backups never carry it (SS-2).
      const keptKey = path.join(root, 'kept-vault.key');
      fs.copyFileSync(path.join(original, 'vault', 'vault.key'), keptKey);
      await restoreBackup(directory, { home: recovered, trustKeys: [signedBy], vaultKeyFile: keptKey });
      const restored = await Store.create(path.join(recovered, 'state', 'karmax.db'));
      try {
        const restoredHandle = await restored.kvGet('recovery-handle');
        expect(restoredHandle).toBe(handle);
        expect(new Vault(path.join(recovered, 'vault')).reveal(restoredHandle!)).toBe(secret);
        expect(vault.reveal(handle)).toBe('changed-after-backup');
        for (const file of fs.readdirSync(path.join(recovered, 'vault'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()))
          expect(fs.readFileSync(path.join(file.parentPath, file.name), 'utf8')).not.toContain(secret);
      } finally { await restored.close(); }
    } finally { vi.unstubAllEnvs(); }
  });

  it('uses consistent SQLite snapshots, excludes worlds, verifies, and restores', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.mkdirSync(path.join(home, 'worlds', 'secret-world'), { recursive: true });
    fs.writeFileSync(path.join(home, 'worlds', 'secret-world', 'not-backed-up'), 'work');
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'vault.json'), 'encrypted');
    const store = (await Store.create(path.join(home, 'state', 'karmax.db')));
    (await store.kvSet('proof', 'before'));

    const destination = path.join(root, 'snapshot');
    const result = await createBackup({ home, destination, externalTemporal: true });
    expect(result.manifest.worldsIncluded).toBe(false);
    expect(fs.existsSync(path.join(destination, 'payload', 'worlds'))).toBe(false);
    (await store.kvSet('proof', 'after'));
    (await store.close());

    await restoreBackup(destination, { home });
    const restored = (await Store.create(path.join(home, 'state', 'karmax.db')));
    expect((await restored.kvGet('proof'))).toBe('before');
    expect(fs.readFileSync(path.join(home, 'vault', 'vault.json'), 'utf8')).toBe('encrypted');
    (await restored.close());
  });

  /**
   * "Verify every byte before replacing anything" only covered `manifest.files`,
   * while staging copied whole component trees — so any payload file NOT in the
   * manifest (an added file, or a symlink, which is rejected only at backup time)
   * was restored unverified straight into $KARMAX_HOME, vault/ and state/
   * included.
   */
  it('rejects a payload carrying files the manifest never verified', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-extra-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'value'), 'original');
    const destination = path.join(root, 'snapshot');
    await createBackup({ home, destination, externalTemporal: true });
    fs.writeFileSync(path.join(destination, 'payload', 'vault', 'smuggled'), 'unverified');
    await expect(restoreBackup(destination, { home })).rejects.toThrow(/not listed in the manifest|integrity/i);
    expect(fs.existsSync(path.join(home, 'vault', 'smuggled'))).toBe(false);
  });

  it('never restores a symlink from the payload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-link-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'value'), 'original');
    const destination = path.join(root, 'snapshot');
    await createBackup({ home, destination, externalTemporal: true });
    fs.symlinkSync('/etc/passwd', path.join(destination, 'payload', 'vault', 'link'));
    await expect(restoreBackup(destination, { home })).rejects.toThrow();
    expect(fs.existsSync(path.join(home, 'vault', 'link'))).toBe(false);
  });

  it('excludes organization-scoped Git-backed pass checkout caches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-pass-git-cache-'));
    const home = path.join(root, 'home');
    roots.push(root);
    const state = path.join(home, 'state');
    const checkout = path.join(state, 'connectors', 'pass-git', 'org_personal', 'repository-hash', 'repo');
    fs.mkdirSync(path.join(checkout, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(state, 'durable-state'), 'keep me');
    fs.writeFileSync(path.join(checkout, '.gpg-id'), 'remote repository cache');
    fs.symlinkSync('/app/provider/codex', path.join(checkout, 'bin', 'codex-monitor'));

    const destination = path.join(root, 'snapshot');
    const result = await createBackup({ home, destination, externalTemporal: true });

    expect(fs.readFileSync(path.join(destination, 'payload', 'state', 'durable-state'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(destination, 'payload', 'state', 'connectors', 'pass-git'))).toBe(false);
    expect(result.manifest.files.some((entry) => entry.path.startsWith('state/connectors/pass-git/'))).toBe(false);
  });

  it('excludes Codex runtime temp symlinks but still rejects symlinks in durable config-home data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-codex-tmp-'));
    const home = path.join(root, 'home');
    roots.push(root);
    const codex = path.join(home, 'config-homes', 'codex-personal');
    fs.mkdirSync(path.join(codex, 'tmp', 'arg0', 'codex-arg0abc'), { recursive: true });
    fs.mkdirSync(path.join(codex, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(codex, 'auth.json'), '{"token":"durable"}');
    fs.writeFileSync(path.join(codex, 'sessions', 'rollout.jsonl'), '{}\n');
    fs.symlinkSync('/app/provider/codex', path.join(codex, 'tmp', 'arg0', 'codex-arg0abc', 'apply_patch'));

    const destination = path.join(root, 'snapshot');
    await createBackup({ home, destination, externalTemporal: true });
    expect(fs.existsSync(path.join(destination, 'payload', 'config-homes', 'codex-personal', 'tmp'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'payload', 'config-homes', 'codex-personal', 'auth.json'), 'utf8'))
      .toContain('durable');
    expect(fs.readFileSync(path.join(destination, 'payload', 'config-homes', 'codex-personal', 'sessions', 'rollout.jsonl'), 'utf8'))
      .toBe('{}\n');

    fs.symlinkSync('/etc/passwd', path.join(codex, 'sessions', 'escape'));
    await expect(createBackup({ home, destination: path.join(root, 'unsafe'), externalTemporal: true }))
      .rejects.toThrow(/symbolic link/i);
  });

  it('online-snapshots provider SQLite databases without copying WAL sidecars', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-provider-db-'));
    const home = path.join(root, 'home');
    roots.push(root);
    const codex = path.join(home, 'config-homes', 'organizations', 'org-1', 'codex-personal');
    fs.mkdirSync(codex, { recursive: true });
    const source = (await Store.create(path.join(codex, 'state.sqlite')));
    (await source.kvSet('proof', 'provider-state'));
    const destination = path.join(root, 'snapshot');
    await createBackup({ home, destination, externalTemporal: true });
    (await source.close());

    const copied = path.join(destination, 'payload', 'config-homes', 'organizations', 'org-1', 'codex-personal', 'state.sqlite');
    const restored = (await Store.create(copied));
    expect((await restored.kvGet('proof'))).toBe('provider-state');
    (await restored.close());
    expect(fs.existsSync(`${copied}-wal`)).toBe(false);
    expect(fs.existsSync(`${copied}-shm`)).toBe(false);
  });

  it('refuses to snapshot a home with a live app unless allowed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-live-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'state', 'instances'), { recursive: true });
    // Another live app registered against this home (our parent is alive).
    fs.writeFileSync(path.join(home, 'state', 'instances', `${process.ppid}.pid`), JSON.stringify({ pid: process.ppid, home }));
    // A backup taken while karmax is running is not point-in-time consistent:
    // its components are snapshotted at different instants.
    await expect(createBackup({ home, destination: path.join(root, 's1'), externalTemporal: true })).rejects.toThrow(/running|live app/i);
    await expect(createBackup({ home, destination: path.join(root, 's2'), externalTemporal: true, allowRunning: true })).resolves.toBeTruthy();
  });

  /**
   * The refusal above has to name a remedy the operator can actually carry out.
   * It used to say "pass allowRunning" — an API option that `npm run backup` had
   * no flag for, so the only documented way out of the error did not exist from
   * where the person reading it was standing. Pin both halves: the message names
   * a real command, and that command really parses the flag it advertises.
   */
  it('points the operator at a command that exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-remedy-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'state', 'instances'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'instances', `${process.ppid}.pid`), JSON.stringify({ pid: process.ppid, home }));

    await expect(createBackup({ home, destination: path.join(root, 's'), externalTemporal: true }))
      .rejects.toThrow(/npm run backup -- --allow-running/);

    // Run that command: it takes the backup and says what it traded away.
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/backup.ts', ...args],
      { encoding: 'utf8', env: { ...process.env, KARMAX_HOME: home, KARMAX_TEMPORAL_ADDRESS: 'temporal.invalid:7233' } });
    const taken = cli('--allow-running', path.join(root, 'cli'));
    expect(taken.status, taken.stderr).toBe(0);
    expect(taken.stdout).toContain(`backup complete: ${path.join(root, 'cli')}`);
    expect(taken.stdout).toMatch(/not point-in-time consistent/);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'cli', 'manifest.json'), 'utf8'))).toMatchObject({ temporal: 'external', secretsIncluded: true });
    const refused = cli('--allow-runing', path.join(root, 'typo'));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('unknown option --allow-runing');
    expect(fs.existsSync(path.join(root, 'typo'))).toBe(false);
  });

  it('rejects a backup whose payload changed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-tamper-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'value'), 'original');
    const destination = path.join(root, 'snapshot');
    await createBackup({ home, destination, externalTemporal: true });
    fs.writeFileSync(path.join(destination, 'payload', 'vault', 'value'), 'tampered');
    await expect(restoreBackup(destination, { home })).rejects.toThrow('integrity check failed');
  });

  it('flags — and can exclude — the key material that decrypts the payload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-secrets-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    // `vault.key` sits next to the ciphertext it opens, and `auth.db.secret`
    // beside the auth database — so a default backup directory is a
    // plaintext-equivalent credential bundle, not merely "portable".
    fs.writeFileSync(path.join(home, 'vault', 'vault.key'), 'KEY');
    fs.writeFileSync(path.join(home, 'vault', 'vault.key.123.fixture.tmp'), 'CRASHED-KEY');
    fs.writeFileSync(path.join(home, 'vault', 'vault.json'), 'ciphertext');
    fs.writeFileSync(path.join(home, 'state', 'auth.db.secret'), 'AUTH');

    // Since SS-2 the vault key travels only when asked for.
    expect(fs.existsSync(path.join((await createBackup({ home, destination: path.join(root, 'default'), externalTemporal: true })).directory,
      'payload', 'vault', 'vault.key'))).toBe(false);
    const withSecrets = await createBackup({ home, destination: path.join(root, 'a'), externalTemporal: true, includeVaultKey: true });
    expect(withSecrets.manifest.secretsIncluded).toBe(true);
    expect(fs.existsSync(path.join(root, 'a', 'payload', 'vault', 'vault.key'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'a', 'payload', 'vault', 'vault.key.123.fixture.tmp'))).toBe(false);

    const without = await createBackup({ home, destination: path.join(root, 'b'), externalTemporal: true, excludeSecrets: true });
    expect(without.manifest.secretsIncluded).toBe(false);
    expect(fs.existsSync(path.join(root, 'b', 'payload', 'vault', 'vault.key'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'b', 'payload', 'vault', 'vault.key.123.fixture.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'b', 'payload', 'state', 'auth.db.secret'))).toBe(false);
    // The ciphertext is still there, and the manifest still verifies.
    expect(without.manifest.files.map((f) => f.path)).toContain('vault/ciphertext'.replace('ciphertext', 'vault.json'));
    await expect(restoreBackup(path.join(root, 'b'), { home })).resolves.toBeTruthy();
    // …and the restore KEPT the live key rather than swapping in the keyless
    // payload directory. This assertion used to be missing, and the restore
    // silently destroyed the key: the whole vault became undecryptable, forever.
    expect(fs.readFileSync(path.join(home, 'vault', 'vault.key'), 'utf8')).toBe('KEY');
    expect(fs.readFileSync(path.join(home, 'state', 'auth.db.secret'), 'utf8')).toBe('AUTH');
    // The ciphertext from the backup did land — this is a real restore, not a skip.
    expect(fs.readFileSync(path.join(home, 'vault', 'vault.json'), 'utf8')).toBe('ciphertext');
  });

  it('restores a secrets-excluded backup onto a fresh home, ciphertext intact', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-backup-nokey-'));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'vault.key'), 'KEY');
    fs.writeFileSync(path.join(home, 'vault', 'vault.json'), 'ciphertext');
    fs.writeFileSync(path.join(home, 'state', 'auth.db.secret'), 'AUTH');
    const without = await createBackup({ home, destination: path.join(root, 'b'), externalTemporal: true, excludeSecrets: true });
    expect(without.manifest.secretsIncluded).toBe(false);

    // A different machine — the off-site case `excludeSecrets` exists for. There is
    // no key here to carry across, and that is fine: the restore cannot destroy a
    // key that was never here. It must SUCCEED and leave the ciphertext intact so
    // the operator can deliver the key separately. Refusing here would break the
    // only workflow excludeSecrets is for.
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh, { recursive: true });
    await expect(restoreBackup(path.join(root, 'b'), { home: fresh, trustKeys: [without.signedBy] })).resolves.toBeTruthy();
    expect(fs.readFileSync(path.join(fresh, 'vault', 'vault.json'), 'utf8')).toBe('ciphertext');
    expect(fs.existsSync(path.join(fresh, 'vault', 'vault.key'))).toBe(false);
  });

  it('treats a legacy manifest with no secretsIncluded field as carrying its secrets', async () => {
    // `secretsIncluded` was added to a manifest whose `version` stayed `1`, so every
    // backup taken before it exists still validates — and reads back `undefined`.
    // A falsiness test (`!manifest.secretsIncluded`) then took the preserve-live-secrets
    // path for a payload that DOES contain key material, writing the target host's key
    // over the one just restored. On the documented "restore onto a new host" path that
    // pairs the backup's ciphertext with a foreign key: undecryptable forever.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-backup-legacy-'));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'vault.key'), 'SOURCE-KEY');
    fs.writeFileSync(path.join(home, 'vault', 'vault.json'), 'source-ciphertext');
    fs.writeFileSync(path.join(home, 'state', 'auth.db.secret'), 'SOURCE-AUTH');
    const destination = path.join(root, 'snapshot');
    await createBackup({ home, destination, externalTemporal: true, includeVaultKey: true });

    // Age the manifest back to what a pre-`secretsIncluded` karmax wrote: an
    // unsigned version 1, same file list, field absent.
    const manifestFile = path.join(destination, 'manifest.json');
    const aged = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    delete aged.secretsIncluded;
    delete aged.vaultKeyIncluded;
    delete aged.vaultKeyIds;
    aged.version = 1;
    fs.writeFileSync(manifestFile, `${JSON.stringify(aged, null, 2)}\n`);
    fs.rmSync(path.join(destination, 'manifest.sig'));

    // A different host, with its own established (and different) key material.
    const target = path.join(root, 'target');
    fs.mkdirSync(path.join(target, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(target, 'state'), { recursive: true });
    fs.writeFileSync(path.join(target, 'vault', 'vault.key'), 'TARGET-KEY');
    fs.writeFileSync(path.join(target, 'state', 'auth.db.secret'), 'TARGET-AUTH');
    await restoreBackup(destination, { home: target, acceptUnsignedV1: true });

    // The payload's own key must survive the restore, matched to its own ciphertext.
    expect(fs.readFileSync(path.join(target, 'vault', 'vault.json'), 'utf8')).toBe('source-ciphertext');
    expect(fs.readFileSync(path.join(target, 'vault', 'vault.key'), 'utf8')).toBe('SOURCE-KEY');
    expect(fs.readFileSync(path.join(target, 'state', 'auth.db.secret'), 'utf8')).toBe('SOURCE-AUTH');
  });

  it('reports secretsIncluded from the operator intent, not from what the payload happens to hold', async () => {
    // An install keyed by KARMAX_VAULT_KEY has no `vault/vault.key` on disk and may
    // have no `auth.db.secret` either. Deriving the flag from payload contents made
    // such a backup claim `secretsIncluded: false` although nothing was withheld —
    // which silently armed the preserve-live-secrets path on restore and pinned a
    // foreign host's key next to this payload's ciphertext.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-backup-envkey-'));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'vault.json'), 'env-keyed-ciphertext');
    const made = await createBackup({ home, destination: path.join(root, 'snapshot'), externalTemporal: true });
    expect(made.manifest.secretsIncluded).toBe(true);

    // …and the restore must not resurrect the target's unrelated key material.
    const target = path.join(root, 'target');
    fs.mkdirSync(path.join(target, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(target, 'state'), { recursive: true });
    fs.writeFileSync(path.join(target, 'vault', 'vault.key'), 'TARGET-KEY');
    fs.writeFileSync(path.join(target, 'state', 'auth.db.secret'), 'TARGET-AUTH');
    await restoreBackup(path.join(root, 'snapshot'), { home: target, trustKeys: [made.signedBy] });
    expect(fs.readFileSync(path.join(target, 'vault', 'vault.json'), 'utf8')).toBe('env-keyed-ciphertext');
    expect(fs.existsSync(path.join(target, 'vault', 'vault.key'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'state', 'auth.db.secret'))).toBe(false);
  });

  it('creates the default backups/ parent directory', async () => {
    // `npm run backup` with no explicit destination writes to `<home>/backups/...`,
    // and nothing else ever creates that directory — so this failed with ENOENT on
    // every install that had never been backed up by hand. Every other test passes
    // an explicit destination, which is exactly why this went unnoticed.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-backup-default-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'auth.db.secret'), 'AUTH');
    expect(fs.existsSync(path.join(home, 'backups'))).toBe(false);
    const made = await createBackup({ home, externalTemporal: true });
    expect(made.directory.startsWith(path.join(home, 'backups'))).toBe(true);
    expect(fs.existsSync(path.join(made.directory, 'manifest.json'))).toBe(true);
  });

  it('also withholds the plaintext secrets that live outside the vault', async () => {
    const { root, home } = makeHome('karmax-backup-plaintext-');
    write(home, 'state/git-profiles/work/id_ed25519', 'PRIVATE KEY');
    write(home, 'state/vault-items/items.json', '{"token":"plain"}');
    write(home, 'config-homes/claude-personal/.credentials.json', '{"oauth":"token"}');
    write(home, 'state/settings.json', '{"theme":"dark"}');
    const { manifest } = await createBackup({ home, destination: path.join(root, 'b'), externalTemporal: true, excludeSecrets: true });
    expect(manifest.files.map((file) => file.path)).toEqual(['state/settings.json']);
  });

  it('embeds Temporal and local objects unless they are external', async () => {
    const { root, home } = makeHome('karmax-backup-components-');
    const temporal = await Store.create(path.join(home, 'temporal', 'temporal.db'));
    await temporal.kvSet('history', 'embedded');
    await temporal.close();
    write(home, 'objects/checkpoints/a.bin', 'checkpoint');

    const embedded = await createBackup({ home, destination: path.join(root, 'embedded') });
    expect(embedded.manifest).toMatchObject({ temporal: 'embedded', objectStore: 'local' });
    expect(embedded.manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining(['objects/checkpoints/a.bin', 'temporal/temporal.db']));
    const copy = await Store.create(path.join(root, 'embedded', 'payload', 'temporal', 'temporal.db'));
    expect(await copy.kvGet('history')).toBe('embedded');
    await copy.close();

    const external = await createBackup({ home, destination: path.join(root, 'external'), externalTemporal: true, externalObjectStore: true });
    expect(external.manifest).toMatchObject({ temporal: 'external', objectStore: 'external' });
    expect(fs.existsSync(path.join(root, 'external', 'payload', 'temporal'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'external', 'payload', 'objects'))).toBe(false);
    // Restoring it leaves this home's own Temporal and objects in place.
    write(home, 'objects/checkpoints/b.bin', 'newer');
    await restoreBackup(path.join(root, 'external'), { home });
    expect(fs.readFileSync(path.join(home, 'objects', 'checkpoints', 'b.bin'), 'utf8')).toBe('newer');
    expect(fs.existsSync(path.join(home, 'temporal', 'temporal.db'))).toBe(true);
  });

  it('refuses a destination that would replace the home or sit in a task world', async () => {
    const { home } = makeHome('karmax-backup-destination-');
    fs.mkdirSync(path.join(home, 'worlds', 'task-1'), { recursive: true });
    for (const destination of [home, `${home}/`, path.join(home, 'worlds', 'task-1', 'backup')])
      await expect(createBackup({ home, destination, externalTemporal: true })).rejects.toThrow(/must not replace KARMAX_HOME or live inside a task world/);
    expect(fs.readdirSync(path.join(home, 'worlds', 'task-1'))).toEqual([]);
    // An existing directory is never reused: two backups would interleave.
    fs.mkdirSync(path.join(home, 'taken'));
    await expect(createBackup({ home, destination: path.join(home, 'taken'), externalTemporal: true })).rejects.toThrow(/EEXIST/);
  });

  it.each([
    ['another format', (m: any) => { m.format = 'tarball'; }, 'unsupported or invalid tavya backup manifest'],
    ['a newer version', (m: any) => { m.version = 2; }, 'unsupported or invalid tavya backup manifest'],
    ['no file list', (m: any) => { delete m.files; }, 'unsupported or invalid tavya backup manifest'],
    ['a path escaping the payload', (m: any) => { m.files[0].path = '../manifest.json'; }, 'backup path escapes payload: ../manifest.json'],
    ['an absolute path', (m: any) => { m.files[0].path = '/etc/passwd'; }, 'invalid backup path: /etc/passwd'],
    ['a backslash path', (m: any) => { m.files[0].path = 'vault\\\\value'; }, 'invalid backup path'],
    ['a wrong size', (m: any) => { m.files[0].bytes += 1; }, 'backup integrity check failed: vault/value'],
    ['a file that is missing', (m: any) => { m.files.push({ path: 'vault/gone', bytes: 0, sha256: '' }); }, 'backup integrity check failed: vault/gone'],
  ])('will not restore a manifest with %s', async (_name, edit, error) => {
    const { root, home } = makeHome('karmax-backup-manifest-');
    write(home, 'vault/value', 'original');
    const destination = path.join(root, 'snapshot');
    await createBackup({ home, destination, externalTemporal: true });
    const manifestFile = path.join(destination, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    edit(manifest);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    // An edited manifest no longer matches its signature; accepted unsigned,
    // it is still checked for everything below.
    fs.rmSync(path.join(destination, 'manifest.sig'));
    write(home, 'vault/value', 'live');
    expect(() => verifyBackup(destination, { home, acceptUnsignedV1: true })).toThrow(error);
    await expect(restoreBackup(destination, { home, acceptUnsignedV1: true })).rejects.toThrow(error);
    expect(fs.readFileSync(path.join(home, 'vault', 'value'), 'utf8')).toBe('live');
  });

  it('refuses to restore under a live app, and offers no way to force it', async () => {
    const { root, home } = makeHome('karmax-restore-live-');
    write(home, 'vault/value', 'backed-up');
    await createBackup({ home, destination: path.join(root, 'snapshot'), externalTemporal: true });
    write(home, 'vault/value', 'live');
    write(home, `state/instances/${process.ppid}.pid`, JSON.stringify({ pid: process.ppid, home }));
    const error = await restoreBackup(path.join(root, 'snapshot'), { home }).catch((e: Error) => e);
    expect((error as Error).message).toBe(`stop tavya before restore (live app pids: ${process.ppid})`);
    expect(fs.readFileSync(path.join(home, 'vault', 'value'), 'utf8')).toBe('live');
  });

  it('puts every component back when the swap fails partway', async () => {
    const { root, home } = makeHome('karmax-restore-rollback-');
    write(home, 'vault/value', 'backed-up vault');
    write(home, 'content/page.md', 'backed-up content');
    write(home, 'objects/blob', 'backed-up object');
    await createBackup({ home, destination: path.join(root, 'snapshot'), externalTemporal: true });
    write(home, 'vault/value', 'live vault');
    write(home, 'content/page.md', 'live content');
    write(home, 'objects/blob', 'live object');
    const rename = fs.renameSync;
    // vault and content have been swapped in by the time objects fails.
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(home, 'objects') && String(from).includes('.restore-stage-')) throw new Error('EXDEV: simulated');
      return rename(from, to);
    });
    try {
      await expect(restoreBackup(path.join(root, 'snapshot'), { home })).rejects.toThrow('EXDEV: simulated');
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(home, 'vault', 'value'), 'utf8')).toBe('live vault');
    expect(fs.readFileSync(path.join(home, 'content', 'page.md'), 'utf8')).toBe('live content');
    expect(fs.readFileSync(path.join(home, 'objects', 'blob'), 'utf8')).toBe('live object');
    expect(fs.readdirSync(home).filter((name) => name.startsWith('.restore-'))).toEqual([]);
  });

  it.runIf(fs.existsSync('/proc/self/cmdline'))('stops the embedded Temporal server first, but never a stranger with its recycled pid', async () => {
    const { root, home } = makeHome('karmax-restore-temporal-');
    write(home, 'vault/value', 'backed-up');
    await createBackup({ home, destination: path.join(root, 'snapshot') });
    const idle = (...argv: string[]) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...argv], { stdio: 'ignore' });
    const exited = (child: ChildProcess) => new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    const temporal = idle('temporal', 'server', 'start-dev');
    const stranger = idle('an-unrelated-process');
    try {
      const temporalExit = exited(temporal);
      write(home, 'temporal/dev-server.json', JSON.stringify({ pid: temporal.pid }));
      await restoreBackup(path.join(root, 'snapshot'), { home });
      expect(await temporalExit).toBe('SIGTERM');

      write(home, 'temporal/dev-server.json', JSON.stringify({ pid: stranger.pid }));
      await restoreBackup(path.join(root, 'snapshot'), { home });
      expect(stranger.exitCode).toBeNull();
      expect(stranger.signalCode).toBeNull();
      expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
    } finally {
      temporal.kill('SIGKILL');
      stranger.kill('SIGKILL');
    }
  });
});

// DB-10: anyone who can write a backup could rewrite its payload and its
// hashes together. Manifests are signed by a key that never leaves the
// installation, trusted elsewhere only by its fingerprint, and a backup from
// before signing is restored only on the operator's explicit, audited word.
describe('signed backups (DB-10)', () => {
  async function signedBackup(label: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `kx-backup-${label}-`));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'vault.json'), 'ciphertext');
    fs.writeFileSync(path.join(home, 'state', 'auth.db.secret'), 'AUTH');
    const made = await createBackup({ home, destination: path.join(root, 'snapshot'), externalTemporal: true });
    return { root, home, ...made };
  }
  const rewrite = (directory: string, change: (manifest: any) => void) => {
    const file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    change(manifest);
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  /** Add a payload file and list it, as someone who can write the backup could. */
  const plant = (directory: string, relative: string, value: string) => {
    const file = path.join(directory, 'payload', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    rewrite(directory, (m) => { m.files.push({ path: relative, bytes: value.length, sha256: sha256(file) }); });
    fs.rmSync(path.join(directory, 'manifest.sig'));
  };

  it('signs a version-1 manifest with a key kept outside everything backed up', async () => {
    const b = await signedBackup('signed');
    // The previous release's restore reads version 1; the signature sits beside it.
    expect(b.manifest.version).toBe(1);
    expect(fs.existsSync(path.join(b.directory, 'manifest.sig'))).toBe(true);
    expect(b.signedBy).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(localSigningFingerprint(b.home)).toBe(b.signedBy);
    expect(fs.statSync(path.join(b.home, 'backup-signing.key')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(b.home, 'state', 'backup-signing.key'))).toBe(false);
    expect(b.manifest.files.map((f) => f.path).some((f) => f.includes('backup-signing'))).toBe(false);
    await restoreBackup(b.directory, { home: b.home });
    expect(localSigningFingerprint(b.home)).toBe(b.signedBy);
    expect((await createBackup({ home: b.home, destination: path.join(b.root, 'again'), externalTemporal: true })).signedBy).toBe(b.signedBy);
  });

  it('refuses a rehashed payload, a stripped signature and an untrusted signer', async () => {
    const b = await signedBackup('tamper');
    const fresh = path.join(b.root, 'fresh');
    // Changing a file and its hash together is what signing is for.
    const value = path.join(b.directory, 'payload', 'vault', 'vault.json');
    fs.writeFileSync(value, 'attacker');
    rewrite(b.directory, (m) => { const entry = m.files.find((f: any) => f.path === 'vault/vault.json'); entry.sha256 = sha256(value); entry.bytes = 8; });
    await expect(restoreBackup(b.directory, { home: b.home })).rejects.toThrow(/does not match its contents/);
    // …or re-signing it with another key.
    const attacker = await signedBackup('attacker');
    fs.copyFileSync(path.join(attacker.directory, 'manifest.sig'), path.join(b.directory, 'manifest.sig'));
    await expect(restoreBackup(b.directory, { home: b.home })).rejects.toThrow(/does not match its contents/);
    // Stripping the signature leaves an unsigned backup, which needs the operator's word.
    fs.rmSync(path.join(b.directory, 'manifest.sig'));
    await expect(restoreBackup(b.directory, { home: b.home })).rejects.toThrow(/unsigned.*--accept-unsigned-v1/);
    expect(fs.readFileSync(path.join(b.home, 'vault', 'vault.json'), 'utf8')).toBe('ciphertext');

    // A genuine backup on a host without the key: trusted only by fingerprint.
    const genuine = await signedBackup('genuine');
    expect(() => verifyBackup(genuine.directory, { home: fresh })).toThrow(new RegExp(`signed by ${genuine.signedBy.replace(/[+/]/g, '\\$&')}.*--trust-key`));
    expect(() => verifyBackup(genuine.directory, { home: fresh, trustKeys: [attacker.signedBy] })).toThrow(/does not trust/);
    expect(verifyBackup(genuine.directory, { home: fresh, trustKeys: [genuine.signedBy] }).version).toBe(1);
    vi.stubEnv('KARMAX_BACKUP_TRUSTED_KEYS', `${attacker.signedBy}, ${genuine.signedBy}`);
    try { expect(verifyBackup(genuine.directory, { home: fresh }).version).toBe(1); } finally { vi.unstubAllEnvs(); }
  });

  it('trusts a named key even when this host\'s own key is unreadable', async () => {
    const genuine = await signedBackup('named');
    const other = await signedBackup('broken-key');
    fs.writeFileSync(path.join(other.home, 'backup-signing.key'), 'not a key');
    expect(verifyBackup(genuine.directory, { home: other.home, trustKeys: [genuine.signedBy] }).version).toBe(1);
  });

  it('restores a backup from before signing only when explicitly accepted, and audits every restore', async () => {
    const b = await signedBackup('legacy');
    fs.rmSync(path.join(b.directory, 'manifest.sig'));
    fs.writeFileSync(path.join(b.home, 'vault', 'vault.json'), 'newer');
    await expect(restoreBackup(b.directory, { home: b.home })).rejects.toThrow(/unsigned.*--accept-unsigned-v1/);
    expect(fs.readFileSync(path.join(b.home, 'vault', 'vault.json'), 'utf8')).toBe('newer');
    await restoreBackup(b.directory, { home: b.home, acceptUnsignedV1: true });
    expect(fs.readFileSync(path.join(b.home, 'vault', 'vault.json'), 'utf8')).toBe('ciphertext');

    const signed = await signedBackup('audited');
    await restoreBackup(signed.directory, { home: b.home, trustKeys: [signed.signedBy] });
    const audit: any[] = [];
    await recordRestores({ appendAudit: (entry) => { audit.push(entry); } }, b.home);
    expect(audit).toEqual([
      expect.objectContaining({ principalId: 'system:restore', action: 'backup.restored.unsigned',
        detail: expect.objectContaining({ manifestVersion: 1, signedBy: null, acceptedUnsigned: true, backupCreatedAt: b.manifest.createdAt }) }),
      expect.objectContaining({ action: 'backup.restored', detail: expect.objectContaining({ signedBy: signed.signedBy, acceptedUnsigned: false }) }),
    ]);
    // Recorded once: the next boot appends nothing more.
    await recordRestores({ appendAudit: (entry) => { audit.push(entry); } }, b.home);
    expect(audit).toHaveLength(2);
  });

  it('refuses a backup that carries a signing key or restore records', async () => {
    // Accepted unsigned, a backup must still not install its own trust anchor
    // on a fresh host, nor forge entries for the next boot's audit log.
    for (const planted of ['state/backup-signing.key', 'state/restore-audit/forged.json']) {
      const b = await signedBackup('anchor');
      plant(b.directory, planted, 'planted');
      const fresh = path.join(b.root, 'fresh');
      await expect(restoreBackup(b.directory, { home: fresh, acceptUnsignedV1: true })).rejects.toThrow(/never carries/);
      expect(fs.existsSync(path.join(fresh, 'backup-signing.key'))).toBe(false);
      expect(fs.existsSync(path.join(fresh, 'state'))).toBe(false);
    }
  });

  it('restores only the bytes it verified', async () => {
    for (const swap of ['replace', 'symlink'] as const) {
      const b = await signedBackup(`toctou-${swap}`);
      const value = path.join(b.directory, 'payload', 'vault', 'vault.json');
      fs.writeFileSync(path.join(b.home, 'vault', 'vault.json'), 'live');
      // Change the payload the moment the restore starts copying it, after
      // the signature was checked.
      const copy = fs.cpSync;
      const spy = vi.spyOn(fs, 'cpSync').mockImplementation((...args: Parameters<typeof fs.cpSync>) => {
        spy.mockRestore();
        fs.rmSync(value);
        if (swap === 'replace') fs.writeFileSync(value, 'attacker');
        else fs.symlinkSync('/etc/hostname', value);
        return copy(...args);
      });
      try {
        await expect(restoreBackup(b.directory, { home: b.home })).rejects.toThrow(/integrity check failed|symbolic link/);
      } finally { spy.mockRestore(); }
      expect(fs.readFileSync(path.join(b.home, 'vault', 'vault.json'), 'utf8')).toBe('live');
      expect(fs.readdirSync(b.home).filter((name) => name.startsWith('.restore-'))).toEqual([]);
    }
  });

  it('publishes signatures under an unpredictable temporary name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-backup-temp-'));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    const writes = vi.spyOn(fs, 'writeFileSync');
    await createBackup({ home, destination: path.join(root, 'snapshot'), externalTemporal: true });
    const temporaries = writes.mock.calls.map(([file]) => String(file)).filter((file) => file.endsWith('.tmp'));
    expect(temporaries.length).toBeGreaterThan(0);
    for (const file of temporaries) expect(file).not.toMatch(new RegExp(`\\.${process.pid}\\.tmp$`));
  });
});

// deploy/karmax backups: SHA256SUMS covers the PostgreSQL dumps, the
// deployment secrets and the control-plane manifest, so the two signatures
// vouch for one backup, not two that were paired afterwards.
describe('signed deployment backups (DB-10)', () => {
  async function deploymentBackup(label: string, home?: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `kx-deploy-backup-${label}-`));
    roots.push(root);
    home ??= path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'auth.db.secret'), 'AUTH');
    const directory = path.join(root, 'backup');
    const made = await createBackup({ home, destination: path.join(directory, 'control-plane'), externalTemporal: true });
    fs.writeFileSync(path.join(directory, 'karmax.dump'), `dump-${label}`);
    const sums = ['karmax.dump', 'control-plane/manifest.json'].map((file) =>
      `${crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex')}  ${file}`).join('\n') + '\n';
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), sums);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.sig'), signChecksums(Buffer.from(sums), home));
    return { root, home, directory, signedBy: made.signedBy };
  }

  it('verifies both signatures and every listed file', async () => {
    const b = await deploymentBackup('whole');
    expect(verifyDeploymentBackup(b.directory, { home: b.home }).signedBy).toBe(b.signedBy);
    fs.appendFileSync(path.join(b.directory, 'karmax.dump'), 'tampered');
    expect(() => verifyDeploymentBackup(b.directory, { home: b.home })).toThrow(/checksum.*karmax\.dump/);
  });

  it('refuses dumps paired with another backup\'s control plane', async () => {
    const a = await deploymentBackup('a');
    const b = await deploymentBackup('b', a.home);
    fs.rmSync(path.join(a.directory, 'control-plane'), { recursive: true });
    fs.cpSync(path.join(b.directory, 'control-plane'), path.join(a.directory, 'control-plane'), { recursive: true });
    expect(() => verifyDeploymentBackup(a.directory, { home: a.home })).toThrow(/checksum.*control-plane\/manifest\.json/);
  });

  it('requires the checksums to cover the manifest', async () => {
    const b = await deploymentBackup('uncovered');
    const sums = fs.readFileSync(path.join(b.directory, 'SHA256SUMS'), 'utf8').split('\n').filter((line) => !line.includes('manifest.json')).join('\n');
    fs.writeFileSync(path.join(b.directory, 'SHA256SUMS'), sums);
    fs.writeFileSync(path.join(b.directory, 'SHA256SUMS.sig'), signChecksums(Buffer.from(sums), b.home));
    expect(() => verifyDeploymentBackup(b.directory, { home: b.home })).toThrow(/do not cover control-plane\/manifest\.json/);
  });

  it('accepts unsigned checksums only beside an unsigned manifest', async () => {
    const b = await deploymentBackup('unsigned');
    fs.rmSync(path.join(b.directory, 'SHA256SUMS.sig'));
    expect(() => verifyDeploymentBackup(b.directory, { home: b.home, acceptUnsignedV1: true })).toThrow(/manifest is signed/);
    fs.rmSync(path.join(b.directory, 'control-plane', 'manifest.sig'));
    expect(() => verifyDeploymentBackup(b.directory, { home: b.home })).toThrow(/unsigned.*--accept-unsigned-v1/);
    expect(verifyDeploymentBackup(b.directory, { home: b.home, acceptUnsignedV1: true }).signedBy).toBeUndefined();
  });

  // Every snapshot the previous release's updater took has neither checksums
  // nor signatures; after the upgrade they must still restore on the
  // operator's word, or no pre-upgrade restore point is usable.
  it('restores a backup from before checksums only on the operator\'s word', async () => {
    const b = await deploymentBackup('legacy');
    for (const file of ['SHA256SUMS', 'SHA256SUMS.sig', 'control-plane/manifest.sig']) fs.rmSync(path.join(b.directory, file));
    expect(() => verifyDeploymentBackup(b.directory, { home: b.home })).toThrow(/no checksums.*--accept-unsigned-v1/);
    expect(verifyDeploymentBackup(b.directory, { home: b.home, acceptUnsignedV1: true }).signedBy).toBeUndefined();
    // Its control plane is still checked against its own manifest.
    fs.appendFileSync(path.join(b.directory, 'control-plane', 'manifest.json'), ' ');
    const manifest = JSON.parse(fs.readFileSync(path.join(b.directory, 'control-plane', 'manifest.json'), 'utf8'));
    const file = path.join(b.directory, 'control-plane', 'payload', manifest.files[0].path);
    fs.appendFileSync(file, 'tampered');
    expect(() => verifyDeploymentBackup(b.directory, { home: b.home, acceptUnsignedV1: true })).toThrow(/integrity check failed/);
  });
});

// SS-2: a backup never carries the key encryption key unless asked to; its
// manifest names the key the vault needs, and restore refuses any other key
// before it changes anything.
describe('backups without the vault key (SS-2)', () => {
  async function vaultHome(label: string, secret = 'tenant-secret') {
    const { root, home } = makeHome(`kx-backup-kek-${label}-`);
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    const vault = new Vault(path.join(home, 'vault'));
    await vault.put('item:1:password', secret, organizationScope('org_a'));
    return { root, home, kek: vault.keyStatus().kek };
  }
  afterEach(() => vi.unstubAllEnvs());

  it('excludes vault/vault.key by default and records the key id', async () => {
    vi.stubEnv('KARMAX_VAULT_KEY', '');
    const { root, home, kek } = await vaultHome('default');
    const made = await createBackup({ home, destination: path.join(root, 'snapshot'), externalTemporal: true });
    expect(fs.existsSync(path.join(root, 'snapshot', 'payload', 'vault', 'vault.key'))).toBe(false);
    expect(made.manifest.files.map((file) => file.path)).not.toContain('vault/vault.key');
    expect(made.manifest).toMatchObject({ vaultKeyIncluded: false, vaultKeyIds: [kek] });
    // The keyrings travel; they are useless without the key.
    expect(made.manifest.files.some((file) => file.path.startsWith('vault/keys/'))).toBe(true);
    const opted = await createBackup({ home, destination: path.join(root, 'opted'), externalTemporal: true, includeVaultKey: true });
    expect(opted.manifest).toMatchObject({ vaultKeyIncluded: true, vaultKeyIds: [kek] });
    expect(fs.existsSync(path.join(root, 'opted', 'payload', 'vault', 'vault.key'))).toBe(true);
  });

  it('records the id of a KARMAX_VAULT_KEY, and restores with it', async () => {
    vi.stubEnv('KARMAX_VAULT_KEY', 'hosted-deployment-key-material-0123456789');
    const { root, home, kek } = await vaultHome('env');
    const made = await createBackup({ home, destination: path.join(root, 'snapshot'), externalTemporal: true });
    expect(made.manifest.vaultKeyIds).toEqual([kek]);
    const target = path.join(root, 'target');
    await restoreBackup(made.directory, { home: target, trustKeys: [made.signedBy] });
    expect(new Vault(path.join(target, 'vault')).reveal('item:1:password')).toBe('tenant-secret');
  });

  it('refuses to restore under a different key before changing anything, and restores with the supplied one', async () => {
    vi.stubEnv('KARMAX_VAULT_KEY', '');
    const source = await vaultHome('source', 'source-secret');
    const made = await createBackup({ home: source.home, destination: path.join(source.root, 'snapshot'), externalTemporal: true });
    const target = await vaultHome('target', 'target-secret');
    await expect(restoreBackup(made.directory, { home: target.home, trustKeys: [made.signedBy] }))
      .rejects.toThrow(new RegExp(`vault is encrypted under ${source.kek}.*the vault key here is ${target.kek}`));
    expect(new Vault(path.join(target.home, 'vault')).reveal('item:1:password')).toBe('target-secret');
    // A wrong KARMAX_VAULT_KEY is refused the same way.
    vi.stubEnv('KARMAX_VAULT_KEY', 'some-other-deployment-key-material-000000');
    await expect(restoreBackup(made.directory, { home: target.home, trustKeys: [made.signedBy] })).rejects.toThrow(/vault key here is vk-/);
    vi.stubEnv('KARMAX_VAULT_KEY', '');
    // No key at all: refused, with the way out named.
    const fresh = path.join(target.root, 'fresh');
    await expect(restoreBackup(made.directory, { home: fresh, trustKeys: [made.signedBy] })).rejects.toThrow(/--vault-key-file/);
    expect(fs.existsSync(path.join(fresh, 'vault'))).toBe(false);
    // The key kept off-host opens it.
    const kept = path.join(source.root, 'kept-vault.key');
    fs.copyFileSync(path.join(source.home, 'vault', 'vault.key'), kept);
    await restoreBackup(made.directory, { home: target.home, trustKeys: [made.signedBy], vaultKeyFile: kept });
    expect(new Vault(path.join(target.home, 'vault')).reveal('item:1:password')).toBe('source-secret');
    // And onto the home it came from, the live key is kept.
    await restoreBackup(made.directory, { home: source.home });
    expect(new Vault(path.join(source.home, 'vault')).reveal('item:1:password')).toBe('source-secret');
  });

  it('checks the key when verifying, through npm run restore', async () => {
    vi.stubEnv('KARMAX_VAULT_KEY', 'hosted-deployment-key-material-0123456789');
    const { root, home } = await vaultHome('cli');
    const made = await createBackup({ home, destination: path.join(root, 'snapshot'), externalTemporal: true });
    const keyFile = path.join(root, 'vault_key');
    const run = (material: string) => {
      fs.writeFileSync(keyFile, `${material}\n`);
      return spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/restore.ts', '--verify', '--check-vault-key',
        '--trust-key', made.signedBy, made.directory], { encoding: 'utf8',
        env: { ...process.env, KARMAX_VAULT_KEY: '', KARMAX_VAULT_KEY_FILE: keyFile, KARMAX_HOME: path.join(root, 'elsewhere') } });
    };
    const good = run('hosted-deployment-key-material-0123456789');
    expect(good.status, good.stderr).toBe(0);
    const bad = run('a-different-deployment-key-material-99999');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/vault key here is vk-/);
  });
});

function makeHome(prefix: string): { root: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}

function write(home: string, relative: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
  fs.writeFileSync(path.join(home, relative), contents);
}
