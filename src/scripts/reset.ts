import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.js';
import { isRecordedTemporalProcess } from './reset-process.js';

/**
 * Wipe Temporal's durable state + karmax local state. Use when the dev server
 * wedges after editing workflow code (running singletons replay old history
 * against new code → non-determinism). Worlds/worktrees are preserved.
 *
 * The Temporal dev server is now long-lived (reused across restarts — see
 * dev-server.ts), so it must be killed BEFORE we delete its DB, or it would keep
 * running against a deleted file. We read the pid it recorded and stop it.
 */
const p = paths();

// Stop the persistent dev server first (recorded by startDevServer).
const rec = path.join(p.temporal, 'dev-server.json');
try {
  const record = JSON.parse(fs.readFileSync(rec, 'utf8')) as { pid?: number; address?: string };
  const { pid } = record;
  if (pid) {
    try {
      process.kill(pid, 0);
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!isRecordedTemporalProcess(record, argv))
        throw new Error(`recorded pid ${pid} is not the Temporal dev server; refusing to wipe live state`);
      process.kill(pid, 'SIGKILL');
      console.log('stopped Temporal dev server (pid', pid + ')');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

for (const dir of [p.temporal, p.state]) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('wiped', dir);
  }
}
console.log('reset complete. start with: npm start');
