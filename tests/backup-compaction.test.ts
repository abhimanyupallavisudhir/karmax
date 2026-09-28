import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../deploy/compact-backups.sh', import.meta.url));
const available = spawnSync('hardlink', ['--version']).status === 0;

it.skipIf(!available)('compacts identical immutable payload files while preserving backup integrity and isolation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-compaction-'));
  const backups = path.join(root, 'backups');
  const bytes = Buffer.alloc(1024 * 1024 + 1, 42);
  const transcript = Buffer.alloc(1024 * 1024 + 7, 44);
  const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const snapshot = (name: string, complete = true) => {
    const dir = path.join(backups, name);
    const objects = path.join(dir, 'control-plane/payload/objects');
    fs.mkdirSync(objects, { recursive: true });
    fs.writeFileSync(path.join(dir, 'control-plane/manifest.json'), '{}');
    if (complete) for (const dump of ['temporal.dump', 'temporal-visibility.dump']) fs.writeFileSync(path.join(dir, dump), 'dump');
    const file = path.join(objects, 'checkpoint');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    // A finished agent session's transcript is identical in every later snapshot.
    const sessions = path.join(dir, 'control-plane/payload/config-homes/codex/sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), transcript, { mode: 0o600 });
    return file;
  };
  const session = (name: string) => path.join(backups, name, 'control-plane/payload/config-homes/codex/sessions/rollout.jsonl');
  try {
    const a = snapshot('first');
    const b = snapshot('second');
    const changed = snapshot('changed');
    fs.writeFileSync(changed, Buffer.alloc(bytes.length, 43));
    const privateFile = snapshot('different-mode');
    fs.chmodSync(privateFile, 0o400);
    const incomplete = snapshot('incomplete', false);
    // A snapshot still being written is not immutable yet.
    const staging = snapshot('20260928T000000Z.partial.123');
    const live = path.join(root, 'live');
    fs.mkdirSync(live);
    const liveFile = path.join(live, 'checkpoint');
    fs.writeFileSync(liveFile, bytes, { mode: 0o600 });
    snapshot('symlink');
    const linkedRoot = path.join(backups, 'symlink/control-plane/payload/objects');
    fs.rmSync(linkedRoot, { recursive: true });
    fs.symlinkSync(live, linkedRoot);
    snapshot('symlinked-payload');
    const linkedPayload = path.join(backups, 'symlinked-payload/control-plane/payload');
    fs.rmSync(linkedPayload, { recursive: true });
    fs.symlinkSync(live, linkedPayload);
    const independent = [changed, privateFile, incomplete, staging, session('20260928T000000Z.partial.123'), liveFile];
    const original = independent.map(file => ({ inode: fs.statSync(file).ino, hash: hash(file) }));
    const expectedHash = hash(a);
    fs.utimesSync(a, new Date(0), new Date(0));
    const run = () => {
      const result = spawnSync('sh', [script, backups], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    run();
    expect(fs.statSync(a).ino).toBe(fs.statSync(b).ino);
    expect(fs.statSync(session('first')).ino).toBe(fs.statSync(session('second')).ino);
    expect(hash(session('second'))).toBe(crypto.createHash('sha256').update(transcript).digest('hex'));
    expect(hash(a)).toBe(expectedHash);
    expect(hash(b)).toBe(expectedHash);
    independent.forEach((file, i) => {
      expect(fs.statSync(file).ino).toBe(original[i]!.inode);
      expect(hash(file)).toBe(original[i]!.hash);
    });
    run(); // idempotent; deleting one restore point leaves the other intact
    fs.rmSync(path.join(backups, 'first'), { recursive: true });
    expect(hash(b)).toBe(expectedHash);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
