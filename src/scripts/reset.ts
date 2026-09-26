import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.js';
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

  // Stop the persistent dev server first (recorded by startDevServer).
  const rec = path.join(p.temporal, 'dev-server.json');
  try {
    const { pid } = JSON.parse(fs.readFileSync(rec, 'utf8')) as { pid?: number };
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log('stopped Temporal dev server (pid', pid + ')');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no record — nothing to stop */
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
