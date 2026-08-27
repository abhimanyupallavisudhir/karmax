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
 *    by id regardless of cwd. If the rollout isn't already in this turn's home, we copy
 *    it from the source task's recorded home, or (only with host-local admission) from
 *    another installation config home. The adapter then resumes/forks it.
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

/** Find a Codex rollout file by session id under a home's sessions tree. */
function findCodexRollout(session: string, home: string): string | undefined {
  const root = path.join(home, 'sessions');
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.includes(session) && e.name.endsWith('.jsonl')) return p;
    }
  }
  return undefined;
}

function materializeCodex(opts: { session: string; forkHome: string; srcHome?: string;
  searchInstallation?: boolean }): boolean {
  // Already resolvable in this turn's home? (codex resumes by id, cwd-independent.)
  if (findCodexRollout(opts.session, opts.forkHome)) return true;
  // Otherwise copy it from the source task's recorded home, or from the local
  // installation only when the caller has explicitly admitted host search.
  const src = findProviderSession({ provider: 'codex', session: opts.session, srcHome: opts.srcHome,
    forkHome: opts.forkHome, searchInstallation: opts.searchInstallation });
  if (!src) return false;
  const destDir = path.join(opts.forkHome, 'sessions', 'forked');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  return true;
}
