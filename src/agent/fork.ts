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
 *    by id regardless of cwd. If the rollout isn't already in this turn's home, we sweep
 *    every config-home (a raw pasted id carries no source home) and copy it in; the
 *    adapter runs `codex exec resume <id>` with `-C <world>`.
 *
 * Used by both resume paths in the turn activity: forking a source task's agent (branches
 * a NEW id via the adapter) and resuming a raw pasted session id (keeps the SAME id — this
 * copy is what lets a home/world-mismatched id resolve at all).
 *
 * Returns true if the source session was found and made resumable here; false → the
 * caller falls back to transcript replay (fork) or best-effort pass-through (raw id).
 */
export function materializeFork(opts: {
  provider: string;
  session: string;
  forkHome: string;
  worldPath: string;
  srcHome?: string;
}): boolean {
  try {
    if (opts.provider === 'codex') return materializeCodex(opts);
    return materializeClaude(opts); // claude (and any subscription-CLI provider)
  } catch {
    return false; // any fs hiccup → caller replays
  }
}

// ── Claude ─────────────────────────────────────────────────────────────────────
/** Claude's cwd-slug: the world path with every non-alphanumeric char turned to '-'. */
export const claudeCwdSlug = (worldPath: string) => worldPath.replace(/[^a-zA-Z0-9]/g, '-');

function claudeHomeCandidates(srcHome?: string, forkHome?: string): string[] {
  const homes: string[] = [];
  const add = (h?: string) => { if (h && !homes.includes(h)) homes.push(h); };
  add(srcHome);
  add(forkHome); // the destination home — so an already-in-place session resolves too
  const base = paths().configHomes;
  try { for (const d of fs.readdirSync(base)) add(path.join(base, d)); } catch { /* none */ }
  add(path.join(os.homedir(), '.claude')); // ambient login
  return homes;
}

/** Find a Claude session `.jsonl` by id, searching srcHome/forkHome first, then all homes. */
function findClaudeSession(session: string, srcHome?: string, forkHome?: string): string | undefined {
  for (const home of claudeHomeCandidates(srcHome, forkHome)) {
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

function materializeClaude(opts: { session: string; forkHome: string; worldPath: string; srcHome?: string }): boolean {
  const src = findClaudeSession(opts.session, opts.srcHome, opts.forkHome);
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
function codexHomeCandidates(srcHome?: string): string[] {
  const homes: string[] = [];
  const add = (h?: string) => { if (h && !homes.includes(h)) homes.push(h); };
  add(srcHome);
  const base = paths().configHomes;
  try { for (const d of fs.readdirSync(base)) add(path.join(base, d)); } catch { /* none */ }
  add(path.join(os.homedir(), '.codex')); // ambient login
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

/** Find a Codex rollout by id, searching srcHome first, then all config-homes.
 *  A raw pasted id carries no source home, so we must sweep every home (mirrors
 *  Claude's `findClaudeSession`) rather than only trusting a provided `srcHome`. */
function findCodexRolloutAnywhere(session: string, srcHome?: string): string | undefined {
  for (const home of codexHomeCandidates(srcHome)) {
    const hit = findCodexRollout(session, home);
    if (hit) return hit;
  }
  return undefined;
}

function materializeCodex(opts: { session: string; forkHome: string; srcHome?: string }): boolean {
  // Already resolvable in this turn's home? (codex resumes by id, cwd-independent.)
  if (findCodexRollout(opts.session, opts.forkHome)) return true;
  // Otherwise locate the source rollout in ANY home and copy it into this one so
  // `codex exec resume <id>` finds it. Non-mutating (read-only on the source).
  const src = findCodexRolloutAnywhere(opts.session, opts.srcHome);
  if (!src) return false;
  const destDir = path.join(opts.forkHome, 'sessions', 'forked');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  return true;
}
