import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseRevision } from '../config/revision.js';

/**
 * The commits the running revision is made of, newest first, full or
 * abbreviated (12 hex digits). An image has no `.git`, and a release image is
 * built once and run everywhere, so whoever starts it names them:
 * `deploy/karmax` passes its checkout's as `KARMAX_REVISION_HISTORY`. A
 * checkout (a self-host from source, a test) asks git. Unknown is an empty
 * list: a deploy is then reported without the commits it shipped.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMIT = /^[0-9a-f]{7,40}$/;
/** As many as `deploy/karmax` names: one deploy rarely ships more. */
export const HISTORY_COMMITS = 500;

export function buildHistory(env: NodeJS.ProcessEnv = process.env, root = ROOT): string[] {
  let names = (env.KARMAX_REVISION_HISTORY ?? '').split(/[\s,]+/);
  if (!names.some(Boolean)) {
    try {
      if (fs.existsSync(path.join(root, '.git')))
        names = execFileSync('git', ['-C', root, 'log', '-n', String(HISTORY_COMMITS), '--format=%H'],
          { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
    } catch { names = []; }
  }
  return names.map((name) => name.trim().toLowerCase()).filter((name) => COMMIT.test(name)).slice(0, HISTORY_COMMITS);
}

/** Whether `name`, full or abbreviated, is the commit `revision`. */
export function namesCommit(name: string, revision: string): boolean {
  return name.length >= 7 && (revision.startsWith(name) || name.startsWith(revision));
}

/**
 * The running revision: the release image's own (config/revision.ts), else
 * what the environment names, else the checkout's.
 */
export function buildRevision(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return releaseRevision(env)
    ?? [env.KARMAX_BUILD_REVISION, env.GITHUB_SHA, env.SOURCE_VERSION].map((value) => value?.trim()).find(Boolean)
    ?? buildHistory(env).find((name) => name.length === 40);
}
