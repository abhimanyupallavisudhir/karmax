import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The revision this process runs and the commits before it, newest first.
 * An image has no `.git`, so `deploy/karmax` writes them to
 * `src/build-revision.txt` before it builds; a checkout (a self-host from
 * source, a test) asks git. Unknown is an empty list: callers then only know
 * less (an error report without its revision, no deploy event).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = /^[0-9a-f]{40}$/;
let cached: string[] | undefined;

export function buildHistory(root = ROOT): string[] {
  if (root === ROOT && cached) return cached;
  let lines: string[] = [];
  try { lines = fs.readFileSync(path.join(root, 'src', 'build-revision.txt'), 'utf8').split('\n'); }
  catch {
    try {
      if (fs.existsSync(path.join(root, '.git')))
        lines = execFileSync('git', ['-C', root, 'log', '-n', '2000', '--format=%H'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
    } catch { lines = []; }
  }
  const history = lines.map((line) => line.trim()).filter((line) => SHA.test(line));
  if (root === ROOT) cached = history;
  return history;
}

/** The running revision: what the environment names, else the build's own. */
export function buildRevision(): string | undefined {
  return [process.env.KARMAX_BUILD_REVISION, process.env.GITHUB_SHA, process.env.SOURCE_VERSION].map((value) => value?.trim()).find(Boolean)
    ?? buildHistory()[0];
}
