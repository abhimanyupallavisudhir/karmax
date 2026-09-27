import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.js';
import { stopRecordedDevServer, type ServerRecord } from '../temporal/dev-server.js';
import { claimWorkerOwnership, duplicateInstanceMessage, registerAppInstance } from '../util/instance.js';

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
const registration = registerAppInstance();
if (registration.others.length) {
  registration.release();
  throw new Error(duplicateInstanceMessage(p.home, registration.others));
}
let releaseWorker: (() => void) | undefined;
try {
  releaseWorker = await claimWorkerOwnership(p.home);

  // Stop the persistent dev server first (recorded by startDevServer). Refuse
  // an unverifiable or recycled pid rather than wipe live state (WF-21).
  const rec = path.join(p.temporal, 'dev-server.json');
  let server: ServerRecord | undefined;
  try { server = JSON.parse(fs.readFileSync(rec, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (server !== undefined) {
    if (!server || !await stopRecordedDevServer(server, path.join(p.temporal, 'temporal.db')))
      throw new Error('Cannot verify the recorded Temporal process; stop it before resetting');
    console.log('stopped Temporal dev server (pid', server.pid + ')');
  }

  if (fs.existsSync(p.temporal)) {
    fs.rmSync(p.temporal, { recursive: true, force: true });
    console.log('wiped', p.temporal);
  }
  // Keep the lock inodes stable until ownership is released; a newly started app
  // must contend on these same files throughout the reset.
  for (const name of fs.readdirSync(p.state)) {
    if (name === 'instances') continue;
    fs.rmSync(path.join(p.state, name), { recursive: true, force: true });
  }
  console.log('wiped', p.state);
  console.log('reset complete. start with: npm start');
} finally {
  releaseWorker?.();
  registration.release();
}
