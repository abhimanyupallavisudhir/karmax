import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { materializeFork, claudeCwdSlug, findProviderSession } from '../src/agent/fork.js';

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

  it('repairs an already-copied leaf with nested and archived history dependencies', () => {
    const srcHome = tmp('karmax-lineage-src-'), forkHome = tmp('karmax-lineage-dst-');
    const root = sid(), parent = sid(), session = sid(), unrelated = sid();
    const rollout = (id: string, base?: string) => JSON.stringify({ type: 'session_meta',
      payload: { id, history_mode: 'paginated', ...(base ? { history_base: {
        thread_id: base, end_ordinal_exclusive: 2, end_byte_offset: 300,
      } } : {}) } }) + '\n';
    try {
      fs.mkdirSync(path.join(srcHome, 'archived_sessions'));
      fs.mkdirSync(path.join(srcHome, 'sessions'));
      fs.mkdirSync(path.join(forkHome, 'sessions'));
      fs.writeFileSync(path.join(srcHome, 'archived_sessions', `rollout-${root}.jsonl`), rollout(root));
      fs.writeFileSync(path.join(srcHome, 'sessions', `rollout-${parent}.jsonl`), rollout(parent, root));
      fs.writeFileSync(path.join(srcHome, 'sessions', `rollout-${unrelated}.jsonl`), rollout(unrelated));
      fs.writeFileSync(path.join(forkHome, 'sessions', `rollout-${session}.jsonl`), rollout(session, parent));
      const opts = { provider: 'codex', session, srcHome, forkHome, worldPath: '/tmp/w' };
      expect(materializeFork(opts)).toBe(true);
      expect(fs.readdirSync(path.join(forkHome, 'sessions', 'forked')).sort())
        .toEqual([`rollout-${root}.jsonl`, `rollout-${parent}.jsonl`].sort());
      expect(fs.readFileSync(path.join(forkHome, 'sessions', 'forked', `rollout-${root}.jsonl`), 'utf8'))
        .toBe(rollout(root));
    } finally {
      fs.rmSync(srcHome, { recursive: true, force: true });
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'cycle'])('rejects a %s ancestor before copying the leaf', (kind) => {
    const srcHome = tmp('karmax-lineage-src-'), forkHome = tmp('karmax-lineage-dst-');
    const session = sid();
    try {
      fs.mkdirSync(path.join(srcHome, 'sessions'));
      fs.writeFileSync(path.join(srcHome, 'sessions', `rollout-${session}.jsonl`), JSON.stringify({
        type: 'session_meta', payload: { history_base: { thread_id: kind === 'cycle' ? session : sid() } },
      }));
      expect(() => materializeFork({ provider: 'codex', session, srcHome, forkHome, worldPath: '/tmp/w' })).toThrow(/missing ancestor|cyclic lineage/);
      expect(fs.readdirSync(forkHome)).toEqual([]);
    } finally {
      fs.rmSync(srcHome, { recursive: true, force: true });
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });

  it('searches other Codex config homes only with host-local admission', () => {
    const dataHome = tmp('karmax-forkhome-');
    const priorHome = process.env.KARMAX_HOME;
    process.env.KARMAX_HOME = dataHome;
    const configHomes = path.join(dataHome, 'config-homes');
    fs.mkdirSync(configHomes, { recursive: true });
    const owner = fs.mkdtempSync(path.join(configHomes, 'codex-test-owner-'));
    const forkHome = tmp('karmax-cxfork3-');
    const session = sid();
    try {
      const day = path.join(owner, 'sessions', '2026', '07', '05');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, `rollout-2026-07-05T00-00-00-${session}.jsonl`), '{}\n');
      expect(materializeFork({ provider: 'codex', session, forkHome, worldPath: '/tmp/w' })).toBe(false);
      expect(fs.existsSync(path.join(forkHome, 'sessions', 'forked', `rollout-2026-07-05T00-00-00-${session}.jsonl`))).toBe(false);
      expect(materializeFork({ provider: 'codex', session, forkHome, worldPath: '/tmp/w', searchInstallation: true })).toBe(true);
      expect(fs.existsSync(path.join(forkHome, 'sessions', 'forked', `rollout-2026-07-05T00-00-00-${session}.jsonl`))).toBe(true);
    } finally {
      if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
      fs.rmSync(dataHome, { recursive: true, force: true });
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });

  it('searches other Claude config homes only with host-local admission', () => {
    const dataHome = tmp('karmax-forkhome-cl-');
    const priorHome = process.env.KARMAX_HOME;
    process.env.KARMAX_HOME = dataHome;
    const owner = path.join(dataHome, 'config-homes', 'claude-test-owner');
    const forkHome = tmp('karmax-clfork-');
    const session = sid();
    try {
      const projects = path.join(owner, 'projects', '-tmp-old-world');
      fs.mkdirSync(projects, { recursive: true });
      fs.writeFileSync(path.join(projects, `${session}.jsonl`), '{}\n');
      expect(materializeFork({ provider: 'claude', session, forkHome, worldPath: '/tmp/w' })).toBe(false);
      expect(fs.existsSync(path.join(forkHome, 'projects', claudeCwdSlug('/tmp/w'), `${session}.jsonl`))).toBe(false);
      expect(materializeFork({ provider: 'claude', session, forkHome, worldPath: '/tmp/w', searchInstallation: true })).toBe(true);
      expect(fs.existsSync(path.join(forkHome, 'projects', claudeCwdSlug('/tmp/w'), `${session}.jsonl`))).toBe(true);
    } finally {
      if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
      fs.rmSync(dataHome, { recursive: true, force: true });
      fs.rmSync(forkHome, { recursive: true, force: true });
    }
  });

  it('exposes native source files for panagent without accepting path-like ids', () => {
    const sourceHome = tmp('karmax-panagent-source-');
    const session = sid();
    try {
      const file = path.join(sourceHome, 'projects', '-tmp-source', `${session}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}\n');
      expect(findProviderSession({ provider: 'claude', session, srcHome: sourceHome })).toBe(file);
      expect(findProviderSession({ provider: 'claude', session: '../../etc/passwd', srcHome: sourceHome })).toBeUndefined();
      expect(findProviderSession({ provider: 'codex', session: '.', srcHome: sourceHome })).toBeUndefined();
      expect(findProviderSession({ provider: 'codex', session: 'abc', srcHome: sourceHome })).toBeUndefined();
      expect(findProviderSession({ provider: 'opencode', session, srcHome: sourceHome })).toBeUndefined();
    } finally {
      fs.rmSync(sourceHome, { recursive: true, force: true });
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
