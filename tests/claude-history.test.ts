import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverClaudeToolInputs } from '../src/agent/claude-history.js';
import { importWithPanagent, stableImportSessionId } from '../src/agent/panagent.js';
import { claudeCwdSlug } from '../src/agent/fork.js';
const codex = (input: unknown) => [
  { type: 'session_meta', payload: { id: '11111111-1111-4111-8111-111111111111', cwd: '/tmp/source' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Remember BLUEBIRD.' }] } },
  { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call1', name: 'exec', input } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call1', output: 'BLUEBIRD' } },
].map(r => JSON.stringify(r)).join('\n') + '\n';
const records = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const call = (rs: any[]) => rs.flatMap(r => Array.isArray(r.message?.content) ? r.message.content : []).find(b => b.type === 'tool_use');

describe('Claude imported tool history', () => {
  it.each(["text(await tools.exec_command({cmd: 'pwd'}));", null, [1, 2], 0, false, { command: 'pwd' }])('imports Codex tool input %j', async input => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-'));
    try {
      const result = await importWithPanagent({ source: { data: Buffer.from(codex(input)) },
        provider: 'claude', forkHome: home, worldPath: '/tmp/world', mode: 'transcript', native: true });
      if (result.kind !== 'native') throw new Error('expected native');
      const rs = records(path.join(home, 'projects', claudeCwdSlug('/tmp/world'), `${result.sessionId}.jsonl`));
      expect(call(rs)).toMatchObject({ id: 'call1', input: input && typeof input === 'object' && !Array.isArray(input) ? input : { input } });
      expect(JSON.stringify(rs)).toContain('BLUEBIRD');
      expect(JSON.stringify(rs)).toContain('"tool_use_id":"call1"');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  // legibench3#18: every failed attempt converted the 44 MB Codex source again
  // under a new random id, leaving fifteen 19 MB copies in a shared login home.
  it('replaces its own copy when one task\'s import of a source is retried', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-retry-'));
    try {
      const sessionId = stableImportSessionId('task_a', 'do', 'claude', 'task:task_src:do:codex:source');
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(stableImportSessionId('task_a', 'do', 'claude', 'task:task_src:do:codex:source')).toBe(sessionId);
      expect(stableImportSessionId('task_b', 'do', 'claude', 'task:task_src:do:codex:source')).not.toBe(sessionId);
      const options = { source: { data: Buffer.from(codex({ command: 'pwd' })) }, provider: 'claude' as const,
        forkHome: home, worldPath: '/tmp/world', mode: 'transcript' as const, native: true, sessionId };
      for (let attempt = 0; attempt < 3; attempt++)
        expect(await importWithPanagent(options)).toMatchObject({ kind: 'native', sessionId });
      expect(fs.readdirSync(path.join(home, 'projects', claudeCwdSlug('/tmp/world')))).toEqual([`${sessionId}.jsonl`]);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  it.each([false, true])('recovers malformed history without changing its source (remote=%s)', async remote => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-recovery-'));
    const root = '/tmp/world';
    try {
      const result = await importWithPanagent({ source: { data: Buffer.from(codex('raw input')) },
        provider: 'claude', forkHome: home, worldPath: root, mode: 'transcript', native: true });
      if (result.kind !== 'native') throw new Error('expected native');
      const dir = path.join(home, 'projects', claudeCwdSlug(root));
      const file = path.join(dir, `${result.sessionId}.jsonl`);
      const rs = records(file);
      call(rs).input = 'raw input';
      rs[1].message.content.unshift({ type: 'thinking', thinking: 'Preserved native reasoning', signature: 'opaque-signature' });
      const broken = rs.map(r => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(file, broken);
      const world: any = { handle: { root, ...(remote ? { version: 2, sealedProviderRef: 'test' } : {}) },
        exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
        readFileBuffer: vi.fn(async () => Buffer.from(broken.replaceAll('BLUEBIRD', 'REMOTE-LATEST'))) };
      const repaired = await recoverClaudeToolInputs({ configHome: home, session: result.sessionId, world });
      expect(repaired).toBeTruthy();
      expect(repaired).not.toBe(result.sessionId);
      expect(fs.readFileSync(file, 'utf8')).toBe(broken);
      const fixedFile = path.join(dir, `${repaired}.jsonl`);
      expect(call(records(fixedFile)).input).toEqual({ input: 'raw input' });
      const expected = JSON.parse(broken.replaceAll(result.sessionId, repaired!).split('\n')[1]!);
      expected.message.content.find((b: any) => b.type === 'tool_use').input = { input: 'raw input' };
      if (remote) expected.message.content = JSON.parse(JSON.stringify(expected.message.content).replaceAll('BLUEBIRD', 'REMOTE-LATEST'));
      expect(records(fixedFile)[1]).toEqual(expected);
      if (remote) {
        expect(world.readFileBuffer).toHaveBeenCalledOnce();
        expect(fs.readFileSync(fixedFile, 'utf8')).toContain('REMOTE-LATEST');
        world.exec.mockResolvedValue({ code: 1, stdout: '', stderr: '' });
      }
      expect(await recoverClaudeToolInputs({ configHome: home, session: repaired!, world })).toBeUndefined();
      expect(fs.statSync(fixedFile).mode & 0o077).toBe(0);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  it('does not fall back to stale local history when the remote read fails', async () => {
    const world: any = { handle: { root: '/tmp/world', version: 2, sealedProviderRef: 'test' },
      exec: async () => ({ code: 0 }), readFileBuffer: async () => { throw new Error('remote transport failed'); } };
    await expect(recoverClaudeToolInputs({ session: '11111111-1111-4111-8111-111111111111',
      configHome: '/tmp/unused-claude-recovery-home', world })).rejects.toThrow('remote transport failed');
  });
});
