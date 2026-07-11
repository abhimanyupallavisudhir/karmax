import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { materializeFork, claudeCwdSlug } from '../src/agent/fork.js';

/**
 * Hermetic verification of fork materialization (SPEC §10.5 / the fork-bug fix):
 * making a source agent's session file visible to a NEW turn's (home × world) so the
 * adapter can natively fork it — instead of stuffing the transcript into a prompt.
 */

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sid = () => crypto.randomUUID();

describe('materializeFork — Claude (per config-home × cwd)', () => {
  it("copies the source session .jsonl into the fork's (home × world) project dir", () => {
    const srcHome = tmp('karmax-src-'), forkHome = tmp('karmax-fork-');
    const world = '/tmp/karmax-worlds/task-NEW';
    const session = sid();
    try {
      // A source session living under some OTHER world's slug in the source home.
      const srcDir = path.join(srcHome, 'projects', claudeCwdSlug('/tmp/karmax-worlds/task-OLD'));
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, `${session}.jsonl`), '{"type":"user","text":"hello"}\n');

      const ok = materializeFork({ provider: 'claude', session, forkHome, worldPath: world, srcHome });
      expect(ok).toBe(true);
      // It lands where `claude --resume` from the NEW world (in forkHome) will look.
      const dest = path.join(forkHome, 'projects', claudeCwdSlug(world), `${session}.jsonl`);
      expect(fs.existsSync(dest)).toBe(true);
      // Source is untouched (read-only copy).
      expect(fs.existsSync(path.join(srcDir, `${session}.jsonl`))).toBe(true);
    } finally {
      fs.rmSync(srcHome, { recursive: true, force: true });
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });

  it('returns false when the source session is nowhere to be found (→ caller replays)', () => {
    const forkHome = tmp('karmax-fork2-');
    try {
      expect(materializeFork({ provider: 'claude', session: sid(), forkHome, worldPath: '/tmp/w', srcHome: tmp('karmax-empty-') })).toBe(false);
    } finally {
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });

  it("cwd-slug matches Claude's rule (every non-alphanumeric → '-')", () => {
    expect(claudeCwdSlug('/home/manyu/.karmax/worlds/task-abc')).toBe('-home-manyu--karmax-worlds-task-abc');
  });
});

describe('materializeFork — Codex (by id in the home)', () => {
  it('is satisfied when the rollout already lives in the fork home (id-resolved, cwd-free)', () => {
    const forkHome = tmp('karmax-cxfork-');
    const session = sid();
    try {
      const day = path.join(forkHome, 'sessions', '2026', '07', '05');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, `rollout-2026-07-05T00-00-00-${session}.jsonl`), '{}\n');
      expect(materializeFork({ provider: 'codex', session, forkHome, worldPath: '/tmp/w' })).toBe(true);
    } finally {
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });

  it("copies the source rollout into the fork home when it's elsewhere", () => {
    const srcHome = tmp('karmax-cxsrc-'), forkHome = tmp('karmax-cxfork2-');
    const session = sid();
    try {
      const day = path.join(srcHome, 'sessions', '2026', '07', '05');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, `rollout-2026-07-05T00-00-00-${session}.jsonl`), '{}\n');
      expect(materializeFork({ provider: 'codex', session, forkHome, worldPath: '/tmp/w', srcHome })).toBe(true);
      // Now resolvable in the fork home.
      expect(materializeFork({ provider: 'codex', session, forkHome, worldPath: '/tmp/w' })).toBe(true);
    } finally {
      fs.rmSync(srcHome, { recursive: true, force: true });
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });

  it('finds a rollout by id in ANY config-home when no srcHome is given (raw pasted id)', () => {
    // Simulates a raw pasted session id: the caller has no idea which home minted it,
    // so materialize must sweep ~/.karmax/config-homes to resolve it.
    const configHomes = path.join(os.homedir(), '.karmax', 'config-homes');
    const owner = fs.mkdtempSync(path.join(configHomes, 'codex-test-owner-'));
    const forkHome = tmp('karmax-cxfork3-');
    const session = sid();
    try {
      const day = path.join(owner, 'sessions', '2026', '07', '05');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, `rollout-2026-07-05T00-00-00-${session}.jsonl`), '{}\n');
      // No srcHome passed — the sweep over config-homes must still find it.
      expect(materializeFork({ provider: 'codex', session, forkHome, worldPath: '/tmp/w' })).toBe(true);
      expect(fs.existsSync(path.join(forkHome, 'sessions', 'forked', `rollout-2026-07-05T00-00-00-${session}.jsonl`))).toBe(true);
    } finally {
      fs.rmSync(owner, { recursive: true, force: true });
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });

  it('returns false when the rollout is in no home at all', () => {
    const forkHome = tmp('karmax-cxfork4-');
    try {
      expect(materializeFork({ provider: 'codex', session: sid(), forkHome, worldPath: '/tmp/w' })).toBe(false);
    } finally {
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });
});
