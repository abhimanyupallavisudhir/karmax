import fs from 'node:fs';
import { paths } from '../config/paths.js';

/**
 * Wipe Temporal's durable state + karmax local state. Use when the dev server
 * wedges after editing workflow code (running singletons replay old history
 * against new code → non-determinism). Worlds/worktrees are preserved.
 */
const p = paths();
for (const dir of [p.temporal, p.state]) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('wiped', dir);
  }
}
console.log('reset complete. start with: npm start');
