import os from 'node:os';
import path from 'node:path';

/**
 * Expand a user-entered filesystem path: leading `~`, and `$HOME`/`${HOME}`.
 * git (run via execFile, no shell) does NOT expand these, so a repo path like
 * "~/code/app" would silently not resolve. Expand at the point of consumption.
 */
export function expandPath(p: string): string {
  if (!p) return p;
  let out = p.trim();
  if (out === '~') out = os.homedir();
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(os.homedir(), out.slice(2));
  out = out.replace(/\$\{HOME\}/g, os.homedir()).replace(/\$HOME(?![A-Za-z0-9_])/g, os.homedir());
  return out;
}
