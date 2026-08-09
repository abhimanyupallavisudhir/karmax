import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationImportStore,
  conversationShareProvider,
  loadSharedConversation,
  parseConversationBuffer,
} from '../src/agent/conversation-source.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

describe('conversation sources', () => {
  it('parses Claude Code and Codex rollout JSONL without tool noise', () => {
    const claude = [
      { type: 'system', message: 'boot' },
      { type: 'user', message: { role: 'user', content: 'Fix the bug' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }, { type: 'tool_use', name: 'Edit' }] } },
    ].map((value) => JSON.stringify(value)).join('\n');
    expect(parseConversationBuffer(Buffer.from(claude), 'claude.jsonl')).toEqual({
      provider: 'claude',
      messages: [{ role: 'user', text: 'Fix the bug' }, { role: 'agent', text: 'Done' }],
    });

    const codex = [
      { type: 'session_meta', payload: { id: 's1' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add tests' }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests added' }] } },
    ].map((value) => JSON.stringify(value)).join('\n');
    expect(parseConversationBuffer(Buffer.from(codex), 'rollout.jsonl')).toEqual({
      provider: 'codex',
      messages: [{ role: 'user', text: 'Add tests' }, { role: 'agent', text: 'Tests added' }],
    });
  });

  it('follows the active ChatGPT mapping branch', () => {
    const exported = {
      current_node: 'a2',
      mapping: {
        root: { id: 'root', parent: null, message: null },
        u1: { id: 'u1', parent: 'root', message: { author: { role: 'user' }, content: { parts: ['Question'] } } },
        a2: { id: 'a2', parent: 'u1', message: { author: { role: 'assistant' }, content: { parts: ['Answer'] } } },
        abandoned: { id: 'abandoned', parent: 'u1', message: { author: { role: 'assistant' }, content: { parts: ['Old branch'] } } },
      },
    };
    expect(parseConversationBuffer(Buffer.from(JSON.stringify(exported)), 'conversation.json').messages)
      .toEqual([{ role: 'user', text: 'Question' }, { role: 'agent', text: 'Answer' }]);
  });

  it('stores validated imports content-addressed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-conversation-'));
    homes.push(home);
    const store = new ConversationImportStore(home);
    const bytes = Buffer.from(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } })}\n`);
    const first = store.put(bytes, 'claude.jsonl');
    const second = store.put(bytes, 'copy.jsonl');
    expect(first).toMatchObject({ id: second.id, provider: 'claude', messageCount: 1 });
    expect(store.read(first.id)).toEqual(bytes);
    expect(() => store.put(Buffer.from('not json'), 'notes.txt')).toThrow(/Codex or Claude/);
  });

  it('loads only allow-listed ChatGPT and Claude share URLs', async () => {
    expect(conversationShareProvider('https://chatgpt.com/share/abc')).toBe('chatgpt');
    expect(conversationShareProvider('https://chat.openai.com/share/abc')).toBe('chatgpt');
    expect(conversationShareProvider('https://claude.ai/share/abc')).toBe('claude');
    expect(conversationShareProvider('http://claude.ai/share/abc')).toBeUndefined();
    expect(conversationShareProvider('https://example.com/share/abc')).toBeUndefined();

    const fetcher = async (input: string | URL) => {
      expect(String(input)).toBe('https://claude.ai/api/chat_snapshots/abc');
      return new Response(JSON.stringify({ chat_messages: [
        { sender: 'human', text: 'Plan it' },
        { sender: 'assistant', text: 'Here is the plan' },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await expect(loadSharedConversation('https://claude.ai/share/abc', fetcher as typeof fetch)).resolves.toEqual([
      { role: 'user', text: 'Plan it' },
      { role: 'agent', text: 'Here is the plan' },
    ]);
  });

  it('decodes ChatGPT conversation payloads embedded in Next.js router frames', async () => {
    const conversation = { current_node: 'a', mapping: {
      u: { parent: null, message: { author: { role: 'user' }, content: { parts: ['Hello'] } } },
      a: { parent: 'u', message: { author: { role: 'assistant' }, content: { parts: ['Hi'] } } },
    } };
    const frame = JSON.stringify([1, JSON.stringify({ loaderData: { conversation } })]);
    const html = `<html><script>self.__next_f.push(${frame})</script></html>`;
    const fetcher = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(loadSharedConversation('https://chatgpt.com/share/abc', fetcher as typeof fetch)).resolves.toEqual([
      { role: 'user', text: 'Hello' },
      { role: 'agent', text: 'Hi' },
    ]);
  });
});
