import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ prompts: [] as string[], attempt: 0 }));
vi.mock('../src/agent/usage.js', () => ({ ensureClaudeAccessTokenFresh: vi.fn(), refreshClaudeAccessToken: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (config: any) => config,
  tool: (name: string) => ({ name }),
  query: ({ prompt }: any) => (async function* () {
    const message = (await prompt[Symbol.asyncIterator]().next()).value;
    state.prompts.push(message.message.content);
    yield { type: 'system', subtype: 'init', session_id: 'native-session' };
    if (++state.attempt === 1) {
      yield { type: 'assistant', user_message_uuids: [message.uuid], message: { content: [{ type: 'text', text: 'Started work' }] } };
      throw providerFailure('OAuth access token expired', { provider: 'claude', kind: 'credential', permanence: 'hard', source: 'structured' });
    }
    yield { type: 'result', subtype: 'success', result: 'done', num_turns: 1 };
  })(),
}));
import { ClaudeAdapter } from '../src/agent/claude.js';
import { providerFailure } from '../src/agent/limits.js';
let home: string;
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
it('resumes after OAuth refresh without replaying acknowledged instructions', async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-delivery-'));
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake', refreshToken: 'fake' } }));
  const result = await new ClaudeAdapter().runTurn({ profile: { provider: 'claude' }, world: { handle: { root: home } },
    messages: [{ role: 'user', text: 'ORIGINAL_INSTRUCTION' }], role: 'do', systemPrompt: 'test', resolvedAuth: { configHome: home } } as any,
  { emit() {}, emitActivity() {} } as any);
  expect(result.termination.kind).toBe('success');
  expect(state.prompts[0]).toBe('ORIGINAL_INSTRUCTION');
  expect(state.prompts[1]).not.toContain('ORIGINAL_INSTRUCTION');
  expect(result.delivered).toBe(1);
});
