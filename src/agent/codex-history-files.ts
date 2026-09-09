import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  const lock = path.join(home, '.karmax-history.lock');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        try { process.kill(owner, 0); }
        catch (probe: any) { if (probe.code === 'ESRCH') { fs.rmSync(lock, { recursive: true }); continue; } }
      } catch {
        // A process can die between mkdir and writing its pid. A live publisher
        // installs that record synchronously, so an old ownerless lock is stale.
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } }
        catch { /* another publisher released it */ }
      }
      if (Date.now() >= deadline) throw new CodexHistoryError('timed out waiting for history publication');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); return action(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

/** Retain the existing discoverable path (Codex may have indexed it), extend it
 * only with a proven prefix, and preserve obsolete aliases outside discovery.
 */
export function publishLocalCodexHistory(home: string, incoming: CodexHistoryFile, session: string): string {
  return withHistoryLock(home, () => {
    const copies = localCodexCopies(home, session);
    const kept = selectCodexHistoryCopy([...copies, incoming], session);
    const destination = copies.find((copy) => copy.file === kept.file)?.file
      ?? copies[0]?.file ?? path.join(home, 'sessions', 'forked', path.basename(incoming.file));
    const prior = copies.find((copy) => copy.file === destination);
    if (!prior?.content.equals(kept.content)) atomicPrivateWrite(destination, kept.content);
    for (const other of copies) {
      if (other.file === destination) continue;
      const digest = crypto.createHash('sha256').update(other.content).digest('hex');
      const backup = path.join(home, '.karmax-history-backups', digest, path.basename(other.file));
      if (!fs.existsSync(backup)) atomicPrivateWrite(backup, other.content);
      fs.unlinkSync(other.file);
    }
    return destination;
  });
}

export function installLocalCodexSnapshot(home: string, original: string, snapshot: CodexHistorySnapshot): string {
  const file = publishLocalCodexHistory(home, { file: snapshot.filename, content: snapshot.content }, snapshot.session);
  const { content: _, ...manifest } = snapshot;
  atomicPrivateWrite(path.join(home, '.karmax-history-recovery', original, `${snapshot.session}.json`),
    Buffer.from(JSON.stringify({ ...manifest, original, file: path.relative(home, file) })));
  return snapshot.session;
}
