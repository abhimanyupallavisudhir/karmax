import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.js';
import { stopRecordedDevServer, type ServerRecord } from '../temporal/dev-server.js';

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
let server: ServerRecord | undefined;
try { server = JSON.parse(fs.readFileSync(rec, 'utf8')); }
catch { /* no record — nothing to stop */ }
if (server) {
  if (!await stopRecordedDevServer(server, path.join(p.temporal, 'temporal.db')))
    throw new Error('Cannot verify the recorded Temporal process; stop it before resetting');
  console.log('stopped Temporal dev server (pid', server.pid + ')');
}

for (const dir of [p.temporal, p.state]) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('wiped', dir);
  }
}
console.log('reset complete. start with: npm start');
