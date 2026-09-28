import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { karmaxHome } from '../config/paths.js';
import { acquireFileLock } from '../util/file-lock.js';
import { validGitBranch } from '../util/git-ref.js';
import { git } from './git.js';
import { canonicalRepositoryIdentity } from './repository-identity.js';

/**
 * Bounded host cache of bare repository mirrors for the trusted Git broker
 * (WD-17, LT-10). A publish, merge or refresh used to clone its repository from
 * origin afresh. Now each operation asks origin only which tips it has, fetches
 * the objects the mirror lacks, and makes its scratch checkout a `--shared`
 * local clone of the mirror, which costs no network and no object copying.
 *
 * Only origin's objects ever enter a mirror. A scratch clone writes world
 * bundles, merges and anything else into its own object directory, so nothing
 * an untrusted world produced can reach another operation. The mirror holds no
 * credential, and every operation first proves with its own credential that it
 * can read the repository (ls-remote) before any mirrored object is used.
 *
 * The API server and the worker both run the broker, so coordination uses
 * host file locks: `<id>.lock` is held exclusively while the mirror is
 * fetched into or cloned from, and `<id>.use` is held shared for as long as a
 * scratch clone borrows the mirror's objects. Garbage collection and eviction
 * need `<id>.use` exclusively and are skipped while any clone is alive, so
 * they can never drop an object a clone still reads. Least recently used idle
 * mirrors are removed once the cache exceeds KARMAX_GIT_MIRROR_MAX_BYTES
 * (default 2 GiB) or 32 repositories. `0` keeps no cache: each operation's
 * mirror then lives only in its own temporary directory.
 */

const MAX_MIRRORS = 32;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const LOCK_WAIT_MS = 15 * 60_000;
/** Recorded after every fetch so eviction need not walk every mirror. */
const SIZE_FILE = 'karmax-bytes';
/** Scratch checkouts and mirrors must never start background maintenance: it
 * can still be writing objects while the directory is removed. Mirrors run
 * `gc --auto` in the foreground instead, while no clone uses them. */
const QUIET_REPOSITORY = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

export interface MirroredClone {
  /** Local scratch checkout whose `origin` points at the real remote. */
  clone: string;
  /** Stop borrowing the mirror. Call after the scratch clone is removed. */
  release: () => Promise<void>;
}

/** Make `clone` a scratch checkout of `branch` (origin's default branch when
 * omitted) with `refs/remotes/origin/<b>` for every other branch in `also`
 * that origin has. `branch` must exist on origin, as with `git clone --branch`. */
export async function mirroredClone(source: string, clone: string, env: Record<string, string>,
  options: { branch?: string; also?: string[]; scratch: string }): Promise<MirroredClone> {
  const named = [options.branch, ...(options.also ?? [])].filter((name): name is string => name !== undefined);
  for (const name of named) if (!validGitBranch(name)) throw new Error(`Git broker rejected invalid branch "${name}"`);
  const listed = await git(path.dirname(clone), ['ls-remote', '--symref', source, 'HEAD', ...named.map((name) => `refs/heads/${name}`)],
    { env, timeoutMs: 2 * 60_000 });
  if (listed.code !== 0) throw new Error(listed.stderr || listed.stdout || 'git ls-remote failed');
  const advertised = parseAdvertisement(listed.stdout);
  if (options.branch && !advertised.tips[options.branch])
    throw new Error(`Remote branch ${options.branch} not found in upstream origin`);
  const branch = options.branch ?? advertised.head;
  const wanted = [...new Set([branch, ...(options.also ?? [])])]
    .filter((name): name is string => Boolean(name && advertised.tips[name]));

  const persistent = maxBytes() > 0;
  const mirror = persistent
    ? path.join(mirrorRoot(), `${crypto.createHash('sha256').update(canonicalRepositoryIdentity(source)).digest('hex').slice(0, 32)}.git`)
    : path.join(options.scratch, 'mirror.git');
  if (persistent) fs.mkdirSync(mirrorRoot(), { recursive: true });
  const releaseUpdate = persistent ? await acquireFileLock(lockFile(mirror, 'lock'), { waitMs: LOCK_WAIT_MS }) : undefined;
  let releaseUse: (() => void) | undefined;
  try {
    await ensureMirror(mirror);
    const stale: string[] = [];
    for (const name of wanted) {
      const local = await git(mirror, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]);
      if (local.code !== 0 || local.stdout.trim() !== advertised.tips[name]) stale.push(name);
    }
    if (stale.length) {
      const fetched = await git(mirror, [...QUIET_REPOSITORY, 'fetch', '--no-tags', '--no-write-fetch-head', source,
        ...stale.map((name) => `+refs/heads/${name}:refs/heads/${name}`)], { env, timeoutMs: 10 * 60_000 });
      if (fetched.code !== 0) throw new Error(fetched.stderr || fetched.stdout || 'git fetch failed');
      if (persistent) await collectGarbage(mirror);
    }
    // Nobody holds `.use` exclusively without also holding `.lock`, so this
    // never waits.
    if (persistent) releaseUse = await acquireFileLock(lockFile(mirror, 'use'), { shared: true, waitMs: LOCK_WAIT_MS });
    // A branch may have moved since ls-remote; the mirror's tip is what was
    // fetched and is what every ref in the clone must name.
    const cloned = await git(path.dirname(clone), ['clone', ...QUIET_REPOSITORY, '-q', '--no-checkout', '--shared',
      '--single-branch', ...(branch && wanted.includes(branch) ? ['--branch', branch] : []), mirror, clone]);
    if (cloned.code !== 0) throw new Error(cloned.stderr || cloned.stdout || 'git clone failed');
    const origin = await git(clone, ['remote', 'set-url', 'origin', source]);
    if (origin.code !== 0) throw new Error(origin.stderr || origin.stdout);
    for (const name of wanted) {
      if (name === branch) continue;
      const tip = await git(mirror, ['rev-parse', '--verify', `refs/heads/${name}^{commit}`]);
      const tracked = tip.code === 0 ? await git(clone, ['update-ref', `refs/remotes/origin/${name}`, tip.stdout.trim()]) : tip;
      if (tracked.code !== 0) throw new Error(tracked.stderr || tracked.stdout);
    }
  } catch (error) {
    releaseUse?.();
    throw error;
  } finally {
    releaseUpdate?.();
  }
  let released = false;
  return { clone, release: async () => {
    if (released) return;
    released = true;
    if (!persistent) return;
    // The mirror directory's mtime orders mirrors for eviction.
    const now = new Date();
    try { fs.utimesSync(mirror, now, now); } catch { /* evicted or unreadable: eviction copes */ }
    releaseUse?.();
    await evictMirrors();
  } };
}

/** `ls-remote --symref` names the default branch and gives its tip only as
 * HEAD's, so a HEAD line counts as a tip of that branch. */
function parseAdvertisement(output: string): { head?: string; tips: Record<string, string> } {
  let head: string | undefined;
  let headTip: string | undefined;
  const tips: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const symref = line.match(/^ref: refs\/heads\/(\S+)\tHEAD$/);
    if (symref) { head = symref[1]; continue; }
    const tip = line.match(/^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(HEAD|refs\/heads\/(\S+))$/);
    if (tip?.[3]) tips[tip[3]] = tip[1]!;
    else if (tip) headTip = tip[1];
  }
  if (head && headTip) tips[head] ??= headTip;
  return { head, tips };
}

async function ensureMirror(mirror: string): Promise<void> {
  const bare = fs.existsSync(mirror) ? await git(mirror, ['rev-parse', '--is-bare-repository']).catch(() => undefined) : undefined;
  if (bare?.code === 0 && bare.stdout.trim() === 'true') return;
  // An interrupted initialization leaves an unusable directory; start over.
  fs.rmSync(mirror, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  const created = await git(path.dirname(mirror), ['init', '-q', '--bare', mirror]);
  if (created.code !== 0) throw new Error(created.stderr || created.stdout || 'could not create Git mirror');
  // Keep received packs as they are: exploding a small fetch of large blobs
  // into loose objects recompresses every byte.
  for (const [key, value] of [['maintenance.auto', 'false'], ['gc.autoDetach', 'false'], ['core.logAllRefUpdates', 'false'],
    ['fetch.unpackLimit', '1']]) {
    const configured = await git(mirror, ['config', key!, value!]);
    if (configured.code !== 0) throw new Error(configured.stderr || configured.stdout);
  }
}

/** Repack (and prune) only while no scratch clone borrows the mirror: a live
 * clone may need an object a force-pushed branch just left unreachable. Called
 * under the update lock; the size is recorded either way. */
async function collectGarbage(mirror: string): Promise<void> {
  const exclusive = await acquireFileLock(lockFile(mirror, 'use'), { waitMs: 0 });
  try {
    if (exclusive) await git(mirror, ['-c', 'gc.autoDetach=false', '-c', 'maintenance.auto=false', 'gc', '--auto', '--quiet'], { timeoutMs: 10 * 60_000 });
  } finally { exclusive?.(); }
  fs.writeFileSync(path.join(mirror, SIZE_FILE), `${directoryBytes(mirror)}\n`);
}

/** Remove least recently used idle mirrors until the cache fits its bounds. */
async function evictMirrors(): Promise<void> {
  const root = mirrorRoot();
  let names: string[];
  try { names = fs.readdirSync(root).filter((name) => name.endsWith('.git')); }
  catch { return; }
  const mirrors = names.flatMap((name) => {
    const mirror = path.join(root, name);
    const stat = fs.statSync(mirror, { throwIfNoEntry: false });
    if (!stat) return [];
    let recorded = NaN;
    try { recorded = Number(fs.readFileSync(path.join(mirror, SIZE_FILE), 'utf8').trim()); } catch { /* not fetched into yet */ }
    return [{ mirror, usedAt: stat.mtimeMs, bytes: Number.isFinite(recorded) ? recorded : directoryBytes(mirror) }];
  }).sort((a, b) => a.usedAt - b.usedAt);
  let total = mirrors.reduce((sum, entry) => sum + entry.bytes, 0);
  let count = mirrors.length;
  for (const { mirror, bytes } of mirrors) {
    if (total <= maxBytes() && count <= MAX_MIRRORS) break;
    // Mirrors being updated or borrowed are skipped, never waited for.
    const update = await acquireFileLock(lockFile(mirror, 'lock'), { waitMs: 0 });
    if (!update) continue;
    try {
      const exclusive = await acquireFileLock(lockFile(mirror, 'use'), { waitMs: 0 });
      if (!exclusive) continue;
      try { fs.rmSync(mirror, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
      finally { exclusive(); }
      total -= bytes;
      count--;
    } finally { update(); }
  }
}

/** Lock files live beside their mirror and are never removed: a contender may
 * still hold one open (see acquireFileLock). */
function lockFile(mirror: string, kind: 'lock' | 'use'): string {
  return `${mirror.slice(0, -'.git'.length)}.${kind}`;
}

function directoryBytes(directory: string): number {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) total += fs.statSync(child, { throwIfNoEntry: false })?.size ?? 0;
    }
  }
  return total;
}

function mirrorRoot(): string { return path.join(karmaxHome(), 'cache', 'git-mirrors'); }

function maxBytes(): number {
  const configured = Number(process.env.KARMAX_GIT_MIRROR_MAX_BYTES);
  return process.env.KARMAX_GIT_MIRROR_MAX_BYTES !== undefined && Number.isFinite(configured) && configured >= 0
    ? configured : DEFAULT_MAX_BYTES;
}
