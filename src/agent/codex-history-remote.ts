import crypto from 'node:crypto';
import path from 'node:path';
import type { World } from '../world/types.js';
import { CodexHistoryError, type CodexHistoryFile, validCodexSessionId } from './codex-history.js';

// Comparison and publication must happen in the destination filesystem under
// one lock, not across several host ↔ sandbox requests. Staging is undiscoverable.
export const REMOTE_CODEX_PUBLISH = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [home, staged, session, name] = process.argv.slice(1);
const lock = path.join(home, '.karmax-history.lock'), deadline = Date.now() + 15000;
for (;;) {
  try { fs.mkdirSync(lock, {mode: 448}); break; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
      try { process.kill(pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') { fs.rmSync(lock, {recursive:true}); continue; } }
    } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) { fs.rmSync(lock, {recursive:true, force:true}); continue; } }
      catch {}
    }
    if (Date.now() >= deadline) throw Error('history publication lock timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
try {
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  const copies = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile() && e.name.endsWith(session + '.jsonl')) copies.push({file, content:fs.readFileSync(file)});
    }
  }
  walk(path.join(home, 'sessions')); walk(path.join(home, 'archived_sessions'));
  copies.sort((a,b) => b.content.length-a.content.length || a.file.localeCompare(b.file));
  const incoming = {file:staged, content:fs.readFileSync(staged)};
  const all = [...copies, incoming].sort((a,b) => b.content.length-a.content.length || a.file.localeCompare(b.file));
  const kept = all[0];
  for (const other of all.slice(1)) if (!kept.content.subarray(0, other.content.length).equals(other.content))
    throw Error('conflicting Codex copies for ' + session + ': histories diverge; preserving both');
  let indexed, uncertain = false;
  for (const database of fs.readdirSync(home).filter(n => /^state_\d+\.sqlite$/.test(n)).sort().reverse()) {
    let db;
    try {
      db = new (require('node:sqlite').DatabaseSync)(path.join(home, database), {readOnly:true});
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(session);
      if (row) {
        const file = path.resolve(row.rollout_path);
        if ((file.startsWith(path.join(path.resolve(home), 'sessions') + path.sep)
          || file.startsWith(path.join(path.resolve(home), 'archived_sessions') + path.sep))
          && path.basename(file).endsWith(session + '.jsonl')) { indexed = file; break; }
        uncertain = true;
      }
    } catch { uncertain = true; }
    finally { if (db) db.close(); }
  }
  const destination = indexed || copies[0]?.file || path.join(home, 'sessions', 'forked', name);
  fs.mkdirSync(path.dirname(destination), {recursive:true, mode:448});
  if (!copies.find(c => c.file === destination)?.content.equals(kept.content)) {
    const temp = staged + '.publish';
    fs.writeFileSync(temp, kept.content, {mode:384});
    fs.renameSync(temp, destination);
  }
  for (const other of copies) if (other.file !== destination) {
    const hash = crypto.createHash('sha256').update(other.content).digest('hex');
    const backup = path.join(home, '.karmax-history-backups', hash, path.basename(other.file));
    fs.mkdirSync(path.dirname(backup), {recursive:true, mode:448});
    fs.writeFileSync(backup, other.content, {mode:384});
    if (uncertain && !indexed) {
      const temp = staged + '.alias'; fs.writeFileSync(temp, kept.content, {mode:384}); fs.renameSync(temp, other.file);
    } else fs.unlinkSync(other.file);
  }
  fs.unlinkSync(staged);
} finally { fs.rmSync(lock, {recursive:true, force:true}); }
`;

export async function publishRemoteCodexHistory(world: World, home: { relative: string; absolute: string },
  incoming: CodexHistoryFile, session: string): Promise<void> {
  if (!validCodexSessionId(session)) throw new CodexHistoryError('invalid session identity');
  if (!world.writeFileBuffer) throw new CodexHistoryError('sandbox cannot receive native history');
  const staged = `${home.relative}/.karmax-history-staging/${crypto.randomUUID()}`;
  await world.writeFileBuffer(staged, incoming.content);
  const result = await world.exec('node', ['-e', REMOTE_CODEX_PUBLISH, home.absolute,
    path.posix.join(world.handle.root, staged), session, path.posix.basename(incoming.file)]);
  if (result.code !== 0) throw new CodexHistoryError(`could not publish ${session}: ${result.stderr || result.stdout}`);
}
