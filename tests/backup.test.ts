import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { createBackup, restoreBackup } from '../src/ops/backup.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('control-plane backup', () => {
  it('uses consistent SQLite snapshots, excludes worlds, verifies, and restores', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.mkdirSync(path.join(home, 'worlds', 'secret-world'), { recursive: true });
    fs.writeFileSync(path.join(home, 'worlds', 'secret-world', 'not-backed-up'), 'work');
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'vault.json'), 'encrypted');
    const store = new Store(path.join(home, 'state', 'karmax.db'));
    store.kvSet('proof', 'before');

    const destination = path.join(root, 'snapshot');
    const result = await createBackup({ home, destination, externalTemporal: true });
    expect(result.manifest.worldsIncluded).toBe(false);
    expect(fs.existsSync(path.join(destination, 'payload', 'worlds'))).toBe(false);
    store.kvSet('proof', 'after');
    store.close();

    await restoreBackup(destination, { home });
    const restored = new Store(path.join(home, 'state', 'karmax.db'));
    expect(restored.kvGet('proof')).toBe('before');
    expect(fs.readFileSync(path.join(home, 'vault', 'vault.json'), 'utf8')).toBe('encrypted');
    restored.close();
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
    fs.writeFileSync(path.join(home, 'vault', 'vault.json'), 'ciphertext');
    fs.writeFileSync(path.join(home, 'state', 'auth.db.secret'), 'AUTH');

    const withSecrets = await createBackup({ home, destination: path.join(root, 'a'), externalTemporal: true });
    expect(withSecrets.manifest.secretsIncluded).toBe(true);
    expect(fs.existsSync(path.join(root, 'a', 'payload', 'vault', 'vault.key'))).toBe(true);

    const without = await createBackup({ home, destination: path.join(root, 'b'), externalTemporal: true, excludeSecrets: true });
    expect(without.manifest.secretsIncluded).toBe(false);
    expect(fs.existsSync(path.join(root, 'b', 'payload', 'vault', 'vault.key'))).toBe(false);
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
});
