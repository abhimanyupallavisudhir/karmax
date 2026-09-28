import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { createBackup, restoreBackup, verifyBackup } from '../src/ops/backup.js';
import { Vault } from '../src/autonomy/vault.js';

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
        await vault.put(handle, secret);
      } finally { await store.close(); }

      const { directory } = await createBackup({ home: original, destination: path.join(root, 'snapshot'),
        externalTemporal: true });
      // Prove recovery uses the snapshot, not the source's current state.
      await vault.put(handle, 'changed-after-backup');
      await restoreBackup(directory, { home: recovered });
      const restored = await Store.create(path.join(recovered, 'state', 'karmax.db'));
      try {
        const restoredHandle = await restored.kvGet('recovery-handle');
        expect(restoredHandle).toBe(handle);
        expect(new Vault(path.join(recovered, 'vault')).reveal(restoredHandle!)).toBe(secret);
        expect(vault.reveal(handle)).toBe('changed-after-backup');
        expect(fs.readFileSync(path.join(recovered, 'vault', 'secrets.json'), 'utf8')).not.toContain(secret);
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

    const withSecrets = await createBackup({ home, destination: path.join(root, 'a'), externalTemporal: true });
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
    await expect(restoreBackup(path.join(root, 'b'), { home: fresh })).resolves.toBeTruthy();
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
    await createBackup({ home, destination, externalTemporal: true });

    // Age the manifest back to what a pre-`secretsIncluded` karmax wrote: same
    // version, same file list (the manifest itself is not hashed), field absent.
    const manifestFile = path.join(destination, 'manifest.json');
    const aged = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    delete aged.secretsIncluded;
    fs.writeFileSync(manifestFile, `${JSON.stringify(aged, null, 2)}\n`);

    // A different host, with its own established (and different) key material.
    const target = path.join(root, 'target');
    fs.mkdirSync(path.join(target, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(target, 'state'), { recursive: true });
    fs.writeFileSync(path.join(target, 'vault', 'vault.key'), 'TARGET-KEY');
    fs.writeFileSync(path.join(target, 'state', 'auth.db.secret'), 'TARGET-AUTH');
    await restoreBackup(destination, { home: target });

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
    await restoreBackup(path.join(root, 'snapshot'), { home: target });
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
    ['a file that is missing', (m: any) => { m.files.push({ path: 'vault/gone', bytes: 0, sha256: '' }); }, /ENOENT/],
  ])('will not restore a manifest with %s', async (_name, edit, error) => {
    const { root, home } = makeHome('karmax-backup-manifest-');
    write(home, 'vault/value', 'original');
    const destination = path.join(root, 'snapshot');
    await createBackup({ home, destination, externalTemporal: true });
    const manifestFile = path.join(destination, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    edit(manifest);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    write(home, 'vault/value', 'live');
    expect(() => verifyBackup(destination)).toThrow(error);
    await expect(restoreBackup(destination, { home })).rejects.toThrow(error);
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
