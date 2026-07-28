import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { paths } from '../config/paths.js';
import { scanInstances } from '../util/instance.js';

const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const COMPONENTS = ['state', 'temporal', 'vault', 'workflows', 'config-homes', 'content',
  'overlays', 'attachments', 'objects'] as const;
type Component = typeof COMPONENTS[number];

export interface BackupManifest {
  format: 'karmax-backup';
  version: 1;
  createdAt: string;
  sourceHome: string;
  temporal: 'embedded' | 'external';
  objectStore: 'local' | 'external';
  worldsIncluded: false;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

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
} = {}): Promise<{ directory: string; manifest: BackupManifest }> {
  const home = path.resolve(options.home ?? paths().home);
  const p = paths(home);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.resolve(options.destination ?? path.join(p.backups, `${stamp}-${crypto.randomBytes(3).toString('hex')}`));
  if (destination === home || isInside(destination, path.join(home, 'worlds')))
    throw new Error('backup destination must not replace KARMAX_HOME or live inside a task world');
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  const payload = path.join(destination, 'payload');
  fs.mkdirSync(payload, { mode: 0o700 });

  try {
    for (const component of COMPONENTS) {
      if (component === 'temporal' || component === 'objects' || component === 'state') continue;
      copyTree(path.join(home, component), path.join(payload, component));
    }

    // Copy non-database state such as the local auth secret, but never transient
    // live-instance records or SQLite WAL/SHM files.
    copyTree(p.state, path.join(payload, 'state'), (file) => {
      const relative = path.relative(p.state, file);
      return relative !== 'instances' && !relative.startsWith(`instances${path.sep}`)
        && !/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(relative);
    });
    await backupSqlite(path.join(p.state, 'karmax.db'), path.join(payload, 'state', 'karmax.db'));
    await backupSqlite(path.join(p.state, 'auth.db'), path.join(payload, 'state', 'auth.db'));

    if (!options.externalTemporal)
      await backupSqlite(path.join(p.temporal, 'temporal.db'), path.join(payload, 'temporal', 'temporal.db'));
    if (!options.externalObjectStore) copyTree(p.objects, path.join(payload, 'objects'));

    const manifest: BackupManifest = {
      format: 'karmax-backup', version: 1, createdAt: new Date().toISOString(), sourceHome: home,
      temporal: options.externalTemporal ? 'external' : 'embedded',
      objectStore: options.externalObjectStore ? 'external' : 'local', worldsIncluded: false,
      files: listFiles(payload).map((file) => ({ path: slash(path.relative(payload, file)), bytes: fs.statSync(file).size, sha256: hashFile(file) })),
    };
    writeAtomic(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    return { directory: destination, manifest };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Verify every byte before replacing anything, then restore each component via
 * same-filesystem rename. A failed verification leaves the installation intact. */
export async function restoreBackup(source: string, options: { home?: string; allowRunning?: boolean } = {}): Promise<BackupManifest> {
  const directory = path.resolve(source);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
  if (manifest.format !== 'karmax-backup' || manifest.version !== 1 || !Array.isArray(manifest.files))
    throw new Error('unsupported or invalid Krmax backup manifest');
  const payload = path.join(directory, 'payload');
  for (const entry of manifest.files) {
    const file = safeJoin(payload, entry.path);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== entry.bytes || hashFile(file) !== entry.sha256)
      throw new Error(`backup integrity check failed: ${entry.path}`);
  }

  const home = path.resolve(options.home ?? paths().home);
  const p = paths(home);
  const running = scanInstances(path.join(p.state, 'instances'), process.pid);
  if (running.length && !options.allowRunning)
    throw new Error(`stop Krmax before restore (live app pids: ${running.join(', ')})`);
  if (manifest.temporal === 'embedded') await stopEmbeddedTemporal(p.temporal);

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const nonce = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const stageRoot = path.join(home, `.restore-stage-${nonce}`);
  const previousRoot = path.join(home, `.restore-previous-${nonce}`);
  fs.mkdirSync(stageRoot, { mode: 0o700 });
  fs.mkdirSync(previousRoot, { mode: 0o700 });
  const present = COMPONENTS.filter((component) => fs.existsSync(path.join(payload, component)));
  try {
    for (const component of present) copyTree(path.join(payload, component), path.join(stageRoot, component));
    for (const component of present) {
      const target = path.join(home, component);
      if (fs.existsSync(target)) fs.renameSync(target, path.join(previousRoot, component));
      fs.renameSync(path.join(stageRoot, component), target);
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

async function backupSqlite(source: string, destination: string): Promise<void> {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const db: DatabaseSyncType = new sqlite.DatabaseSync(source, { readOnly: true });
  try { await sqlite.backup(db, destination); } finally { db.close(); }
  fs.chmodSync(destination, 0o600);
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

function hashFile(file: string): string { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
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
function writeAtomic(file: string, value: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, value, { mode });
  fs.renameSync(temp, file);
}
async function stopEmbeddedTemporal(temporalDir: string): Promise<void> {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(temporalDir, 'dev-server.json'), 'utf8')) as { pid?: number };
    if (!record.pid) return;
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
