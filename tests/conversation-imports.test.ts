import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportConversationWithPanagent, importWithPanagent, publicConversationShare } from '../src/agent/panagent.js';
import {
  ConversationImportError,
  conversationImportObjectKey,
  detectConversationImport,
  putConversationImport,
} from '../src/store/conversation-imports.js';
import { LocalObjectStore } from '../src/store/objects.js';

const SOURCE_SESSION = '11111111-1111-4111-8111-111111111111';
const CLAUDE_JSONL = [
  {
    type: 'file-history-snapshot', messageId: 'snapshot-before-first-message',
    snapshot: { trackedFileBackups: {} },
  },
  {
    type: 'attachment', sessionId: SOURCE_SESSION,
    attachment: { type: 'hook_success', hookName: 'SessionStart:startup' },
  },
  {
    type: 'ai-title', sessionId: SOURCE_SESSION, aiTitle: 'Importer design',
  },
  {
    parentUuid: null, isSidechain: false, userType: 'external', cwd: '/tmp/source',
    sessionId: SOURCE_SESSION, version: '2.1.0', gitBranch: 'main', type: 'user',
    message: { role: 'user', content: 'Design the importer.' },
    uuid: '10000000-0000-4000-8000-000000000001', timestamp: '2026-08-01T10:00:00Z',
  },
  {
    parentUuid: '10000000-0000-4000-8000-000000000001', isSidechain: false,
    userType: 'external', cwd: '/tmp/source', sessionId: SOURCE_SESSION, version: '2.1.0',
    gitBranch: 'main', type: 'assistant',
    message: {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture',
      content: [{ type: 'text', text: 'Use a provider-neutral handoff.' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    },
    uuid: '10000000-0000-4000-8000-000000000002', timestamp: '2026-08-01T10:00:01Z',
  },
].map((record) => JSON.stringify(record)).join('\n') + '\n';
const CODEX_JSONL = [
  { timestamp: '2026-08-01T11:00:00Z', type: 'session_meta', payload: {
    id: '22222222-2222-4222-8222-222222222222', timestamp: '2026-08-01T11:00:00Z',
    cwd: '/tmp/source', originator: 'codex_cli_rs', cli_version: '0.144.5', source: 'cli', model_provider: 'openai',
  } },
  { timestamp: '2026-08-01T11:00:01Z', type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Carry Codex context.' }],
  } },
  { timestamp: '2026-08-01T11:00:02Z', type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Context retained.' }],
  } },
].map((record) => JSON.stringify(record)).join('\n') + '\n';

const temporary = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe('conversation import storage', () => {
  it('detects and stores a project-scoped native history content-addressed', async () => {
    const root = temporary('karmax-conversation-objects-');
    try {
      const objects = new LocalObjectStore(root);
      const data = Buffer.from(CLAUDE_JSONL);
      expect(detectConversationImport(data)).toBe('claude-code');
      const ref = await putConversationImport(objects, 'project_1', data, '../Source session.jsonl');
      expect(ref.name).toBe('Source session.jsonl');
      expect(ref.projectId).toBe('project_1');
      expect(ref.id).toMatch(/^[a-f0-9]{64}$/);
      expect((await objects.get(conversationImportObjectKey('project_1', ref.id))).equals(data)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects junk and unsafe object references', () => {
    expect(() => detectConversationImport(Buffer.from('not json'))).toThrow(ConversationImportError);
    expect(() => conversationImportObjectKey('../other', 'a'.repeat(64))).toThrow(ConversationImportError);
    expect(() => conversationImportObjectKey('project', '../secret')).toThrow(ConversationImportError);
  });

  it('recognizes Codex JSONL and pretty-printed Claude exports', () => {
    expect(detectConversationImport(Buffer.from(`\uFEFF${CODEX_JSONL}`))).toBe('codex');
    expect(detectConversationImport(Buffer.from(JSON.stringify({ chat_messages: [] }, null, 2)))).toBe('claude-export');
  });

  it('does not mistake Claude prompt history for a resumable transcript', () => {
    const history = JSON.stringify({
      display: 'Only a prompt', project: '/tmp/source', sessionId: SOURCE_SESSION, timestamp: 1,
    });
    expect(() => detectConversationImport(Buffer.from(history))).toThrow('not a recognized Codex or Claude conversation');
  });
});

describe('Krmax panagent bridge', () => {
  it('copies an uploaded Claude history without losing native records', async () => {
    const home = temporary('karmax-native-claude-import-');
    try {
      const result = await importWithPanagent({ source: { data: Buffer.from(CLAUDE_JSONL) },
        provider: 'claude', forkHome: home, worldPath: '/tmp/imported', mode: 'transcript', native: true });
      expect(result.kind).toBe('native');
      if (result.kind !== 'native') return;
      const file = path.join(home, 'projects', '-tmp-imported', `${result.sessionId}.jsonl`);
      const imported = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const original = CLAUDE_JSONL.trim().split('\n').map((line) => JSON.parse(line));
      expect(imported).toHaveLength(original.length);
      expect(imported[0].snapshot).toEqual(original[0].snapshot);
      expect(imported[3].message).toEqual(original[3].message);
      expect(imported[3].uuid).not.toBe(original[3].uuid);
      expect(imported[4].parentUuid).toBe(imported[3].uuid);
      expect(imported[3].sessionId).toBe(result.sessionId);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('preserves native Codex tool and compaction payloads on upload under a fresh identity', async () => {
    const home = temporary('karmax-native-codex-import-');
    const records = [
      { ordinal: 0, type: 'session_meta', payload: { id: SOURCE_SESSION, timestamp: '2026-09-09T00:00:00Z', history_mode: 'paginated' } },
      { ordinal: 1, type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'call1', arguments: '{"cmd":"pwd"}' } },
      { ordinal: 2, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call1', output: 'native output' } },
      { ordinal: 3, type: 'compacted', payload: { message: 'compact context', replacement_history: [] } },
    ];
    try {
      const source = { data: Buffer.from('\uFEFF' + records.map((record) => JSON.stringify(record)).join('\n') + '\n') };
      const options = { source, provider: 'codex' as const, forkHome: home, worldPath: '/tmp/imported', mode: 'transcript' as const, native: true };
      const first = await importWithPanagent(options), second = await importWithPanagent(options);
      expect(first.kind).toBe('native'); expect(second.kind).toBe('native');
      if (first.kind !== 'native' || second.kind !== 'native') return;
      expect(first.sessionId).not.toBe(second.sessionId);
      const dir = path.join(home, 'sessions', 'forked');
      const file = path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith(`${first.sessionId}.jsonl`))!);
      const imported = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(imported.slice(1)).toEqual(records.slice(1));
      expect(source.data.toString().startsWith('\uFEFF')).toBe(true);
      const paginated = Buffer.from(JSON.stringify({ ...records[0], payload: { ...records[0]!.payload,
        history_base: { thread_id: '99999999-9999-4999-8999-999999999999', end_byte_offset: 200, end_ordinal_exclusive: 1 } } }) + '\n');
      await expect(importWithPanagent({ ...options, source: { data: paginated } })).rejects.toThrow('missing ancestor');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it.each(['codex', 'claude'] as const)('exports a durable Karmax transcript as resumable %s JSONL', async (provider) => {
    const sessionId = provider === 'codex'
      ? '33333333-3333-4333-8333-333333333333'
      : '44444444-4444-4444-8444-444444444444';
    const data = await exportConversationWithPanagent({
      provider, sessionId, title: 'Existing API conversation', cwd: '/tmp/exported',
      messages: [
        { id: 'user-1', role: 'user', text: 'Keep this context.', ts: Date.parse('2026-08-25T10:00:00Z') },
        { id: 'agent-1', role: 'agent', text: 'Context preserved.', ts: Date.parse('2026-08-25T10:00:01Z') },
      ],
    });
    expect(detectConversationImport(data)).toBe(provider === 'codex' ? 'codex' : 'claude-code');
    const records = data.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(provider === 'codex' ? records[0].payload.id : records[0].sessionId).toBe(sessionId);
    expect(data.toString('utf8')).toContain('Context preserved.');
  });

  it('converts an uploaded Claude history into a fresh resumable Codex session', async () => {
    const home = temporary('karmax-panagent-codex-');
    try {
      const result = await importWithPanagent({
        source: { data: Buffer.from(CLAUDE_JSONL), name: 'claude.jsonl' },
        provider: 'codex', forkHome: home, worldPath: '/tmp/new-world', mode: 'transcript', native: true,
      });
      expect(result.kind).toBe('native');
      if (result.kind !== 'native') return;
      expect(result.sessionId).not.toBe(SOURCE_SESSION);
      const file = path.join(home, 'sessions', 'forked', fs.readdirSync(path.join(home, 'sessions', 'forked')).find((name) => name.endsWith(`${result.sessionId}.jsonl`))!);
      const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records[0].payload.id).toBe(result.sessionId);
      expect(records.some((record) => record.type === 'response_item'
        && record.payload?.role === 'assistant')).toBe(true);
      expect(fs.statSync(file).mode & 0o077).toBe(0);
      expect(result.warnings?.some((item) => item.code === 'claude_file_history_snapshot_not_represented')).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('uses a guarded semantic handoff when the destination has no native writer', async () => {
    const home = temporary('karmax-panagent-context-');
    try {
      const result = await importWithPanagent({
        source: { data: Buffer.from(CLAUDE_JSONL) }, provider: 'mock', forkHome: home,
        worldPath: '/tmp/new-world', mode: 'transcript', native: false,
      });
      expect(result.kind).toBe('context');
      if (result.kind !== 'context') return;
      expect(result.message.text).toContain('untrusted context');
      expect(result.message.text).toContain('Design the importer.');
      expect(result.message.text).toContain('Use a provider-neutral handoff.');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('installs a converted Codex history where Claude resolves the new world', async () => {
    const home = temporary('karmax-panagent-claude-');
    try {
      const result = await importWithPanagent({
        source: { data: Buffer.from(CODEX_JSONL), name: 'codex.jsonl' },
        provider: 'claude', forkHome: home, worldPath: '/tmp/another-world', mode: 'transcript', native: true,
      });
      expect(result.kind).toBe('native');
      if (result.kind !== 'native') return;
      const file = path.join(home, 'projects', '-tmp-another-world', `${result.sessionId}.jsonl`);
      const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records.every((record) => record.sessionId === result.sessionId)).toBe(true);
      expect(records.some((record) => record.type === 'assistant')).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts only public ChatGPT and Claude share URLs', () => {
    expect(publicConversationShare('https://chatgpt.com/share/abc')).toBe('https://chatgpt.com/share/abc');
    expect(publicConversationShare('https://claude.ai/share/abc')).toBe('https://claude.ai/share/abc');
    expect(publicConversationShare('https://chatgpt.com/c/private')).toBeUndefined();
    expect(publicConversationShare('http://chatgpt.com/share/abc')).toBeUndefined();
    expect(publicConversationShare('https://example.com/share/abc')).toBeUndefined();
    expect(publicConversationShare('not a url')).toBeUndefined();
  });
});
