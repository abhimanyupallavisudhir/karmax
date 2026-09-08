import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../config/paths.js';

/**
 * Fork a prior agent's session (SPEC §10.5) — branch a NEW conversation from the
 * source's REAL history, never mutating the source, so any number of tasks can fork
 * the same source. This replaces the old "replay the transcript into the prompt"
 * hack (which stuffed the whole prior conversation into the new session's first
 * user message — see RESOLVE-PLAN / the fork-bug diagnosis).
 *
 * Providers key sessions differently, so "make the source session visible to THIS
 * turn" differs by provider:
 *  - Claude: `<home>/projects/<cwd-slug>/<id>.jsonl`, resolved by (config-home × cwd).
 *    A fork runs in a NEW world (cwd), so we copy the source `.jsonl` into this turn's
 *    (home × world) project dir; the adapter then runs `--resume <id> --fork-session`
 *    (new session id, source untouched). Works across logins — a `.jsonl` is pure
 *    conversation history, no auth. Survives world cleanup (the file lives in the home).
 *  - Codex: a rollout under `<CODEX_HOME>/sessions/<date>/rollout-…-<id>.jsonl`, resolved
 *    by id regardless of cwd. We copy it and its history_base ancestors from the
 *    source task's recorded home, or (only with host-local admission) from another
 *    installation config home. The adapter then resumes/forks it.
 *
 * Used for task-to-task forks. A host-local install may explicitly opt into an
 * installation search for a pasted provider id; remote/hosted callers never do.
 *
 * Returns true if the source session was found and made resumable here; false lets
 * the task-fork caller fall back to its stored visible transcript.
 */
export function materializeFork(opts: {
  provider: string;
  session: string;
  forkHome: string;
  worldPath: string;
  srcHome?: string;
  searchInstallation?: boolean;
}): boolean {
  try {
    if (!validNativeSessionId(opts.session)) return false;
    if (opts.provider === 'codex') return materializeCodex(opts);
    return materializeClaude(opts); // claude (and any subscription-CLI provider)
  } catch {
    return false; // any fs hiccup → caller replays
  }
}

const validNativeSessionId = (value: string): boolean => /^[a-zA-Z0-9_-]{8,160}$/.test(value);

// ── Claude ─────────────────────────────────────────────────────────────────────
/** Claude's cwd-slug: the world path with every non-alphanumeric char turned to '-'. */
export const claudeCwdSlug = (worldPath: string) => worldPath.replace(/[^a-zA-Z0-9]/g, '-');

function claudeHomeCandidates(srcHome?: string, forkHome?: string, searchInstallation = false): string[] {
  const homes: string[] = [];
  const add = (h?: string) => { if (h && !homes.includes(h)) homes.push(h); };
  add(srcHome);
  add(forkHome); // the destination home — so an already-in-place session resolves too
  if (searchInstallation) {
    const base = paths().configHomes;
    try { for (const d of fs.readdirSync(base)) add(path.join(base, d)); } catch { /* none */ }
    add(path.join(os.homedir(), '.claude')); // ambient login
  }
  return homes;
}

/** Find a Claude session `.jsonl` only in the explicitly selected homes. */
function findClaudeSession(session: string, srcHome?: string, forkHome?: string,
  searchInstallation = false): string | undefined {
  for (const home of claudeHomeCandidates(srcHome, forkHome, searchInstallation)) {
    const projects = path.join(home, 'projects');
    let dirs: string[];
    try { dirs = fs.readdirSync(projects); } catch { continue; }
    for (const d of dirs) {
      const f = path.join(projects, d, `${session}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  }
  return undefined;
}

/** Resolve a native Codex/Claude session. Search is limited to explicit homes
 * unless a host-local caller deliberately sets `searchInstallation`. */
export function findProviderSession(opts: {
  provider: string;
  session: string;
  srcHome?: string;
  forkHome?: string;
  searchInstallation?: boolean;
}): string | undefined {
  // Provider ids are opaque, but current Claude/Codex ids are UUID-like. A
  // minimum length prevents a vague substring (for example `.` or `abc`) from
  // selecting the first unrelated Codex rollout whose filename happens to match.
  if (!validNativeSessionId(opts.session)) return undefined;
  if (opts.provider === 'claude')
    return findClaudeSession(opts.session, opts.srcHome, opts.forkHome, opts.searchInstallation);
  if (opts.provider === 'codex') {
    if (opts.forkHome) {
      const local = findCodexRollout(opts.session, opts.forkHome);
      if (local) return local;
    }
    if (opts.srcHome) {
      const source = findCodexRollout(opts.session, opts.srcHome);
      if (source) return source;
    }
    if (opts.searchInstallation) {
      for (const home of codexInstallationHomes()) {
        if (home === opts.srcHome || home === opts.forkHome) continue;
        const source = findCodexRollout(opts.session, home);
        if (source) return source;
      }
    }
    return undefined;
  }
  return undefined;
}

function materializeClaude(opts: { session: string; forkHome: string; worldPath: string; srcHome?: string;
  searchInstallation?: boolean }): boolean {
  const src = findClaudeSession(opts.session, opts.srcHome, opts.forkHome, opts.searchInstallation);
  if (!src) return false;
  const destDir = path.join(opts.forkHome, 'projects', claudeCwdSlug(opts.worldPath));
  const dest = path.join(destDir, `${opts.session}.jsonl`);
  if (path.resolve(src) !== path.resolve(dest)) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest); // READ-only on the source → non-mutating
  }
  return true;
}

// ── Codex ────────────────────────────────────────────────────────────────────
function codexInstallationHomes(): string[] {
  const homes: string[] = [];
  const add = (home?: string) => { if (home && !homes.includes(home)) homes.push(home); };
  const base = paths().configHomes;
  try { for (const d of fs.readdirSync(base)) add(path.join(base, d)); } catch { /* none */ }
  add(path.join(os.homedir(), '.codex'));
  return homes;
}

/** Find an active or archived Codex rollout by its filename identity. */
function findCodexRollout(session: string, home: string): string | undefined {
  const root = path.join(home, 'sessions');
  const stack = [path.join(home, 'archived_sessions'), root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(`${session}.jsonl`)) return p;
    }
  }
  return undefined;
}

/** Physical history dependency, distinct from the informational forked_from_id.
 * Keep rollout bytes intact: history_base also contains byte offsets into it. */
export function codexHistoryBase(content: Buffer): string | undefined {
  const first = content.toString('utf8').split('\n', 1)[0] ?? '';
  let record: any;
  try { record = JSON.parse(first); } catch { return undefined; }
  const base = record?.type === 'session_meta' ? record.payload?.history_base : undefined;
  if (base == null) return undefined;
  if (typeof base.thread_id !== 'string' || !validNativeSessionId(base.thread_id))
    throw new Error('Invalid Codex history_base thread_id');
  return base.thread_id;
}

/** Resolve the entire physical lineage before copying anything. Also checks
 * ancestors when the selected rollout is already present after a partial copy. */
export function codexSessionFiles(opts: { session: string; forkHome?: string; srcHome?: string;
  searchInstallation?: boolean }): string[] | undefined {
  const files: string[] = [];
  const seen = new Set<string>();
  let session: string | undefined = opts.session;
  while (session) {
    if (seen.has(session)) return undefined;
    seen.add(session);
    const file = findProviderSession({ ...opts, provider: 'codex', session });
    if (!file) return undefined;
    files.push(file);
    session = codexHistoryBase(fs.readFileSync(file));
  }
  return files.reverse();
}

function materializeCodex(opts: { session: string; forkHome: string; srcHome?: string;
  searchInstallation?: boolean }): boolean {
  const files = codexSessionFiles(opts);
  if (!files) return false;
  const destDir = path.join(opts.forkHome, 'sessions', 'forked');
  for (const src of files) {
    if (path.resolve(src).startsWith(`${path.resolve(opts.forkHome)}${path.sep}`)) continue;
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  }
  return true;
}
