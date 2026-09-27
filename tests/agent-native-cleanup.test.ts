import { expect, it, vi } from 'vitest';
vi.mock('../src/agent/work-environment.js', () => ({
  workEnvironment: () => ({}),
  claudeWorkEnvironment: async () => ({ settings: undefined, cleanup: async () => { throw new Error('cleanup failed'); } }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (config: any) => config,
  tool: (name: string) => ({ name }),
  query: () => (async function* () { yield { type: 'result', subtype: 'success', result: 'done' }; })(),
}));
import { ClaudeAdapter } from '../src/agent/claude.js';
it('keeps a native successful result when work-environment cleanup fails', async () => {
  const result = await new ClaudeAdapter().runTurn({ profile: { provider: 'claude' }, world: { handle: { root: '/tmp' } },
    messages: [], role: 'do', systemPrompt: 'test', resolvedAuth: { configHome: '/tmp/nonexistent-native-cleanup' } } as any,
  { emit() {}, emitActivity() {} } as any);
  expect(result.termination.kind).toBe('success');
});
