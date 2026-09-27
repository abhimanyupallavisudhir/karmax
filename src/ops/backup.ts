import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { Vault } from '../autonomy/vault.js';
import { paths } from '../config/paths.js';
import { scanInstances } from '../util/instance.js';

const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const COMPONENTS = ['state', 'temporal', 'vault', 'workflows', 'config-homes', 'content',
  'overlays', 'attachments', 'objects'] as const;
type Component = typeof COMPONENTS[number];

export interface BackupManifest {
  format: 'karmax-backup';
  version: 2;
  createdAt: string;
  sourceHome: string;
  temporal: 'embedded' | 'external';
  objectStore: 'local' | 'external';
  worldsIncluded: false;
  /** Whether plaintext credentials and auth secrets were requested. The vault
   * signing key is always excluded and must be retained independently. */
  secretsIncluded: boolean;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

/** Key material that decrypts the rest of the payload, relative to `payload/`. */
const SECRET_FILES = ['vault/vault.key', 'state/auth.db.secret'] as const;
/** Plaintext secrets that live outside the encrypted vault: keys materialized
 *  for git/ssh, and provider config homes holding OAuth tokens. `--exclude-secrets`
 *  promises a payload safe to hand off, so these leave with the key files. */
const PLAINTEXT_SECRET_DIRS = ['state/git-profiles', 'state/vault-items', 'config-homes'] as const;

/**
 * Create a consistent, portable control-plane backup. Mutable SQLite files use
 * SQLite's online backup API; copying a WAL-backed database as an ordinary file
 * can silently produce an unusable snapshot. Task worktrees are deliberately
 * excluded: their durable representation is Git plus encrypted checkpoints.
 */
export async function createBackup(options: {
  home?: string;
  destination?: string;
  externalTemporal?: boolean;
  externalObjectStore?: boolean;
  /** Snapshot anyway while an app is live — see the guard below. */
  allowRunning?: boolean;
  /**
   * Leave the vault key and the auth secret OUT of the payload (see
   * `BackupManifest.secretsIncluded`). The resulting directory is genuinely
   * portable: it can be stored somewhere less trusted than the install, and
   * restoring it needs the key material supplied separately. Default `false`
   * includes other plaintext credentials; the vault key is always excluded.
   */
  excludeSecrets?: boolean;
} = {}): Promise<{ directory: string; manifest: BackupManifest }> {
  const home = path.resolve(options.home ?? paths().home);
  const p = paths(home);
  const signingKey = backupKey(home, undefined, true);
  // Components are snapshotted at different instants, so a backup taken while an
  // app is writing is NOT point-in-time consistent (the SQLite snapshots are each
  // internally consistent, but they can disagree with one another and with the
  // content/vault trees). `restoreBackup` already refused to run against a live
  // install; refuse to *produce* a torn snapshot for the same reason.
  const live = scanInstances(path.join(p.state, 'instances'), process.pid);
  if (live.length && !options.allowRunning)
    // Name a remedy the operator can actually carry out. "pass allowRunning"
    // described an API option that the `npm run backup` CLI had no flag for, so
    // the only way out of this error did not exist from where they were standing.
    throw new Error(`stop Krmax before taking a backup (live app pids: ${live.join(', ')}), `
      + 'or re-run with `npm run backup -- --allow-running` to accept a snapshot '
      + 'that is not point-in-time consistent');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.resolve(options.destination ?? path.join(p.backups, `${stamp}-${crypto.randomBytes(3).toString('hex')}`));
  if (destination === home || isInside(destination, path.join(home, 'worlds')))
    throw new Error('backup destination must not replace KARMAX_HOME or live inside a task world');
  // The destination itself is created non-recursively on purpose: reusing an
  // existing directory would interleave two backups. Its PARENT still has to be
  // made, though — the default destination is `<home>/backups/<stamp>-<hex>` and
  // nothing else ever creates `<home>/backups`, so `npm run backup` failed with
  // ENOENT on every install that had not been backed up by hand first.
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  const payload = path.join(destination, 'payload');
  fs.mkdirSync(payload, { mode: 0o700 });

  try {
    for (const component of COMPONENTS) {
      if (component === 'temporal' || component === 'objects' || component === 'state') continue;
      if (component === 'config-homes')
        await copyConfigHomes(path.join(home, component), path.join(payload, component));
      else if (component === 'vault')
        // A crash during atomic key publication may leave a private temporary
        // key. Never export it, including when excludeSecrets is requested.
        copyTree(path.join(home, component), path.join(payload, component),
          file => !/^vault\.key\..*\.tmp$/.test(path.basename(file)));
      else copyTree(path.join(home, component), path.join(payload, component));
    }

    // Copy non-database state such as the local auth secret, but never transient
    // live-instance records, the Git-backed pass checkout cache, or SQLite
    // WAL/SHM files. The pass repository is authoritative remotely and every
    // successful write is pushed before returning; backing up its local clone is
    // redundant, and repository-owned symlinks are incompatible with the backup
    // format's deliberate no-symlink invariant.
    const passGitCache = path.join('connectors', 'pass-git');
    copyTree(p.state, path.join(payload, 'state'), (file) => {
      const relative = path.relative(p.state, file);
      return relative !== 'instances' && !relative.startsWith(`instances${path.sep}`)
        && relative !== passGitCache && !relative.startsWith(`${passGitCache}${path.sep}`)
        && !/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(relative);
    });
    await backupSqlite(path.join(p.state, 'karmax.db'), path.join(payload, 'state', 'karmax.db'));
    await backupSqlite(path.join(p.state, 'auth.db'), path.join(payload, 'state', 'auth.db'));

    if (!options.externalTemporal)
      await backupSqlite(path.join(p.temporal, 'temporal.db'), path.join(payload, 'temporal', 'temporal.db'));
    if (!options.externalObjectStore) copyTree(p.objects, path.join(payload, 'objects'));

    // A MAC is meaningless if its signing key travels in the same untrusted archive.
    fs.rmSync(path.join(payload, 'vault', 'vault.key'), { force: true });
    if (options.excludeSecrets) {
      for (const relative of SECRET_FILES) fs.rmSync(path.join(payload, relative), { force: true });
      for (const relative of PLAINTEXT_SECRET_DIRS) fs.rmSync(path.join(payload, relative), { recursive: true, force: true });
    }

    const manifest: BackupManifest = {
      format: 'karmax-backup', version: 2, createdAt: new Date().toISOString(), sourceHome: home,
      temporal: options.externalTemporal ? 'external' : 'embedded',
      objectStore: options.externalObjectStore ? 'external' : 'local', worldsIncluded: false,
      // Intent, NOT payload contents: `fs.existsSync` over SECRET_FILES reports
      // `false` for an install that keeps its key in `KARMAX_VAULT_KEY` and has no
      // auth secret, even though the operator excluded nothing — and restore reads
      // this flag to decide whether to overwrite the restored key material with the
      // target host's own. See `BackupManifest.secretsIncluded`.
      secretsIncluded: !options.excludeSecrets,
      files: listFiles(payload).map((file) => ({ path: slash(path.relative(payload, file)), bytes: fs.statSync(file).size, sha256: hashFile(file) })),
    };
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    writeAtomic(path.join(destination, 'manifest.json'), manifestBytes, 0o600);
    writeAtomic(path.join(destination, 'manifest.hmac'), manifestMac(manifestBytes, signingKey), 0o600);
    return { directory: destination, manifest };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Verify every byte before replacing anything, then restore each component via
 * same-filesystem rename. A failed verification leaves the installation intact. */
export function verifyBackup(source: string, options: { home?: string; keyFile?: string } = {}): BackupManifest {
  const directory = path.resolve(source);
  const bytes = fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8');
  let signature: string;
  try { signature = fs.readFileSync(path.join(directory, 'manifest.hmac'), 'utf8'); }
  catch { throw new Error('backup manifest authentication is missing; unsigned backups cannot be restored'); }
  const expected = manifestMac(bytes, backupKey(options.home ?? paths().home, options.keyFile));
  if (!/^[a-f0-9]{64}$/.test(signature) || !crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')))
    throw new Error('backup manifest authentication failed');
  const manifest = JSON.parse(bytes) as BackupManifest;
  if (manifest.format !== 'karmax-backup' || manifest.version !== 2 || !Array.isArray(manifest.files))
    throw new Error('unsupported or invalid Krmax backup manifest');
  const payload = path.join(directory, 'payload');
  for (const entry of manifest.files) {
    const file = safeJoin(payload, entry.path);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== entry.bytes || hashFile(file) !== entry.sha256)
      throw new Error(`backup integrity check failed: ${entry.path}`);
  }
  // "Verify every byte before replacing anything" has to mean every byte in the
  // PAYLOAD, not every byte the manifest happens to mention. Checking only
  // `manifest.files` left the reverse direction open: anything ADDED to the
  // payload after the backup was taken — an extra file, or a symlink (which is
  // rejected at backup time but was never re-checked at restore time) — was
  // copied into the live home unverified. `listFiles` throws on a symlink; the
  // set comparison catches the rest.
  const declared = new Set(manifest.files.map((entry) => entry.path));
  for (const file of listFiles(payload)) {
    const relative = slash(path.relative(payload, file));
    if (!declared.has(relative)) throw new Error(`backup payload file is not listed in the manifest: ${relative}`);
  }

  return manifest;
}

export async function restoreBackup(source: string, options: { home?: string; allowRunning?: boolean; keyFile?: string } = {}): Promise<BackupManifest> {
  const directory = path.resolve(source);
  const manifest = verifyBackup(directory, options);
  const payload = path.join(directory, 'payload');

  const home = path.resolve(options.home ?? paths().home);
  const p = paths(home);
  const running = scanInstances(path.join(p.state, 'instances'), process.pid);
  if (running.length && !options.allowRunning)
    // No `--allow-running` escape offered here on purpose: restoring swaps state
    // components under a live process, which corrupts rather than merely tears.
    // "Krmax" not "karmax": this is operator-facing output, which carries the
    // brand (see the naming note in the SPEC, and tests/brand.test.ts).
    throw new Error(`stop Krmax before restore (live app pids: ${running.join(', ')})`);
  if (manifest.temporal === 'embedded') await stopEmbeddedTemporal(p.temporal);

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const nonce = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const stageRoot = path.join(home, `.restore-stage-${nonce}`);
  const previousRoot = path.join(home, `.restore-previous-${nonce}`);
  fs.mkdirSync(stageRoot, { mode: 0o700 });
  fs.mkdirSync(previousRoot, { mode: 0o700 });
  const present = COMPONENTS.filter((component) => fs.existsSync(path.join(payload, component)));

  const preserved = new Map<string, Buffer>();
  // The signing key never travels in the payload. Preserve the trusted local key,
  // or install the separately supplied original key when restoring on a new host.
  if (present.includes('vault') && (options.keyFile || (!process.env.KARMAX_VAULT_KEY && !process.env.KARMAX_VAULT_KEY_FILE)))
    preserved.set('vault/vault.key', backupKey(home, options.keyFile));
  if (manifest.secretsIncluded === false) {
    const authSecret = path.join(home, 'state', 'auth.db.secret');
    if (present.includes('state') && fs.existsSync(authSecret))
      preserved.set('state/auth.db.secret', fs.readFileSync(authSecret));
  }

  try {
    for (const component of present) copyTree(path.join(payload, component), path.join(stageRoot, component));
    for (const component of present) {
      const target = path.join(home, component);
      if (fs.existsSync(target)) fs.renameSync(target, path.join(previousRoot, component));
      fs.renameSync(path.join(stageRoot, component), target);
    }
    for (const [relative, bytes] of preserved) {
      const target = path.join(home, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeAtomic(target, bytes, 0o600);
    }
    fs.rmSync(previousRoot, { recursive: true, force: true });
    fs.rmSync(stageRoot, { recursive: true, force: true });
    return manifest;
  } catch (error) {
    for (const component of present.slice().reverse()) {
      const target = path.join(home, component);
      const previous = path.join(previousRoot, component);
      if (fs.existsSync(previous)) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(previous, target);
      }
    }
    fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.rmSync(previousRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Never authenticate with a key found in the untrusted backup payload. */
function backupKey(home: string, keyFile?: string, create = false): Buffer {
  if (keyFile) return fs.readFileSync(keyFile);
  const supplied = process.env.KARMAX_VAULT_KEY || (process.env.KARMAX_VAULT_KEY_FILE
    ? fs.readFileSync(process.env.KARMAX_VAULT_KEY_FILE, 'utf8').trim() : undefined);
  if (supplied) return crypto.createHash('sha256').update(supplied).digest();
  const file = path.join(home, 'vault', 'vault.key');
  if (!fs.existsSync(file) && create) new Vault(path.join(home, 'vault'));
  if (!fs.existsSync(file)) throw new Error('backup authentication needs the original vault key; supply KARMAX_VAULT_KEY or --key-file');
  return fs.readFileSync(file);
}

function manifestMac(bytes: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update('karmax-backup-manifest-v2\0').update(bytes).digest('hex');
}

async function backupSqlite(source: string, destination: string): Promise<void> {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const db: DatabaseSyncType = new sqlite.DatabaseSync(source, { readOnly: true });
  try { await sqlite.backup(db, destination); } finally { db.close(); }
  fs.chmodSync(destination, 0o600);
}

/**
 * Provider config homes contain both durable identity/session state and runtime
 * scratch space. Codex in particular creates executable helper symlinks below
 * `<CODEX_HOME>/tmp/arg0` while starting a process. Copying that subtree is both
 * useless (the absolute targets belong to one particular application image) and
 * incompatible with the backup format's deliberate no-symlink invariant.
 *
 * Match the stable boundary we own — a managed Codex home's root `tmp/` — never
 * the provider's random `codex-arg0XXXXXX` implementation detail. Symlinks in
 * every durable subtree remain a hard error through `listFiles(payload)`.
 *
 * Config homes also contain provider-owned WAL-mode SQLite databases. Copying a
 * live database plus its WAL as ordinary files can produce a torn snapshot, so
 * discover real SQLite files, omit their sidecars from the tree copy, and use
 * the same online backup API as Karmax's own databases.
 */
async function copyConfigHomes(source: string, destination: string): Promise<void> {
  if (!fs.existsSync(source)) return;
  const databases = discoverConfigHomeSqlite(source);
  const omitted = new Set(databases.flatMap((file) => [file, `${file}-wal`, `${file}-shm`]));
  copyTree(source, destination, (file) => {
    const relative = path.relative(source, file);
    return !isManagedCodexTemp(relative) && !omitted.has(file);
  });
  for (const database of databases)
    await backupSqlite(database, path.join(destination, path.relative(source, database)));
}

function discoverConfigHomeSqlite(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file);
      if (isManagedCodexTemp(relative)) continue;
      if (entry.isSymbolicLink()) continue; // copied, then rejected by listFiles(payload)
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:db|sqlite)$/i.test(entry.name) && isSqliteDatabase(file)) out.push(file);
    }
  };
  visit(root);
  return out;
}

function isManagedCodexTemp(relative: string): boolean {
  const parts = relative.split(path.sep).filter(Boolean);
  // Personal homes: `codex-account/tmp/...`
  // Organization homes: `organizations/<org>/codex-account/tmp/...`
  const home = parts[0] === 'organizations' ? 2 : 0;
  return parts[home]?.startsWith('codex-') === true && parts[home + 1] === 'tmp';
}

function isSqliteDatabase(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(16);
      return fs.readSync(fd, header, 0, header.length, 0) === header.length
        && header.equals(Buffer.from('SQLite format 3\0'));
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

function copyTree(source: string, destination: string, filter: (file: string) => boolean = () => true): void {
  if (!fs.existsSync(source) || !filter(source)) return;
  fs.cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true,
    filter: (file) => filter(file) });
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`backup contains a symbolic link: ${path.relative(root, file)}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) out.push(file);
    }
  };
  visit(root);
  return out.sort();
}

/**
 * SHA-256 of a file, read incrementally.
 *
 * `readFileSync` materializes the whole file in one Buffer, which throws
 * `ERR_FS_FILE_TOO_LARGE` past Node's ~2 GiB buffer ceiling — and an object store
 * or a Temporal database that big is exactly the install whose backup matters
 * most. Streaming in fixed chunks makes the hash independent of file size.
 */
function hashFile(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}
function slash(value: string): string { return value.split(path.sep).join('/'); }
function isInside(value: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(value));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function safeJoin(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\')) throw new Error(`invalid backup path: ${relative}`);
  const file = path.resolve(root, relative);
  if (!isInside(file, root)) throw new Error(`backup path escapes payload: ${relative}`);
  return file;
}
function writeAtomic(file: string, value: string | Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, value, { mode });
  fs.renameSync(temp, file);
}
/**
 * Stop the embedded Temporal dev server recorded in `dev-server.json`.
 *
 * The recorded pid is checked against the live process's command line before any
 * signal is sent. A pidfile outlives its process, pids are recycled, and this
 * function SIGTERMs whatever it names — so a stale record could take out an
 * unrelated user process during a restore. (Same class of bug as the process
 * registry in src/util/processes.ts and the custody owner guard.) If the identity
 * cannot be established (non-Linux, unreadable procfs), the signal is skipped
 * rather than sent blind: failing to stop Temporal is loud and recoverable,
 * killing a stranger is neither.
 */
async function stopEmbeddedTemporal(temporalDir: string): Promise<void> {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(temporalDir, 'dev-server.json'), 'utf8')) as { pid?: number };
    if (!record.pid) return;
    if (!looksLikeTemporalServer(record.pid)) return;
    try { process.kill(record.pid, 'SIGTERM'); } catch { return; }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { process.kill(record.pid, 0); } catch { return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`embedded Temporal process ${record.pid} did not stop; stop it before restore`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/** Is `pid` actually a Temporal dev server, or a stranger that inherited its
 *  number? Unverifiable (no procfs) ⇒ false, i.e. do not signal. */
function looksLikeTemporalServer(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    return /temporal/i.test(cmdline);
  } catch {
    return false;
  }
}
