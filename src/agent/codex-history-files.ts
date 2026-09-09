import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CodexHistoryError, type CodexHistoryFile, type CodexHistorySnapshot,
  selectCodexHistoryCopy, validCodexSessionId } from './codex-history.js';

export function localCodexFiles(home: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  };
  walk(path.join(home, 'sessions'));
  walk(path.join(home, 'archived_sessions'));
  return files;
}

export function localCodexCopies(home: string, session: string): CodexHistoryFile[] {
  if (!validCodexSessionId(session)) throw new CodexHistoryError('invalid session identity');
  return localCodexFiles(home).filter((file) => path.basename(file).endsWith(`${session}.jsonl`))
    .map((file) => ({ file, content: fs.readFileSync(file) }));
}

export const readLocalCodexHistory = (home: string, session: string): CodexHistoryFile =>
  selectCodexHistoryCopy(localCodexCopies(home, session), session);

export function atomicPrivateWrite(file: string, content: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.karmax-tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** The critical section is synchronous: no network read can race another host
 * publish between comparison and rename. A file lock also covers other workers.
 */
function withHistoryLock<T>(home: string, action: () => T): T {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, '.karmax-history-publish.sqlite');
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  let acquired = false;
  try {
    // SQLite owns the OS lock and releases it on process death, including after
    // container restarts/PID reuse. No stale-lock cleanup can race a new owner.
    db.exec('PRAGMA busy_timeout = 15000');
    try { db.exec('BEGIN IMMEDIATE'); acquired = true; }
    catch { throw new CodexHistoryError('timed out waiting for history publication'); }
    return action();
  } finally { if (acquired) db.exec('ROLLBACK'); db.close(); }
}

/** Retain the existing discoverable path (Codex may have indexed it), extend it
 * only with a proven prefix, and preserve obsolete aliases outside discovery.
 */
export function publishLocalCodexHistory(home: string, incoming: CodexHistoryFile, session: string): string {
  return withHistoryLock(home, () => {
    const copies = localCodexCopies(home, session);
    const kept = selectCodexHistoryCopy([...copies, incoming], session);
    const indexed = indexedRollout(home, session);
    const destination = indexed.file ?? copies.find((copy) => copy.file === kept.file)?.file
      ?? copies[0]?.file ?? path.join(home, 'sessions', 'forked', path.basename(incoming.file));
    const prior = copies.find((copy) => copy.file === destination);
    if (!prior?.content.equals(kept.content)) atomicPrivateWrite(destination, kept.content);
    for (const other of copies) {
      if (other.file === destination) continue;
      const digest = crypto.createHash('sha256').update(other.content).digest('hex');
      const backup = path.join(home, '.karmax-history-backups', digest, path.basename(other.file));
      if (!fs.existsSync(backup)) atomicPrivateWrite(backup, other.content);
      if (indexed.uncertain) atomicPrivateWrite(other.file, kept.content);
      else fs.unlinkSync(other.file);
    }
    return destination;
  });
}

/** Read the pinned CLI's derived index without modifying it. A moved alias can
 * otherwise leave thread/fork pointing at a deleted source. With an unreadable
 * or unknown index, retain synchronized aliases instead of guessing its path. */
function indexedRollout(home: string, session: string): { file?: string; uncertain: boolean } {
  let uncertain = false;
  for (const name of fs.readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort().reverse()) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path.join(home, name), { readOnly: true });
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(session) as { rollout_path: string } | undefined;
      if (row) {
        const file = path.resolve(row.rollout_path);
        if ((file.startsWith(path.join(path.resolve(home), 'sessions') + path.sep)
          || file.startsWith(path.join(path.resolve(home), 'archived_sessions') + path.sep))
          && path.basename(file).endsWith(`${session}.jsonl`)) return { file, uncertain: false };
        uncertain = true;
      }
    } catch { uncertain = true; }
    finally { db?.close(); }
  }
  return { uncertain };
}

export function installLocalCodexSnapshot(home: string, original: string, snapshot: CodexHistorySnapshot): string {
  const file = publishLocalCodexHistory(home, { file: snapshot.filename, content: snapshot.content }, snapshot.session);
  const { content: _, ...manifest } = snapshot;
  atomicPrivateWrite(path.join(home, '.karmax-history-recovery', original, `${snapshot.session}.json`),
    Buffer.from(JSON.stringify({ ...manifest, original, file: path.relative(home, file) })));
  return snapshot.session;
}
