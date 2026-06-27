import { AgentAdapter } from './types.js';
import { Provider } from '../domain/types.js';
import { MockAdapter } from './mock.js';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';

/**
 * Builds the provider → adapter map. The mock is always available (hermetic
 * tests); real adapters are added when their auth is present. The shipped app
 * NEVER defaults to mock — see {@link defaultProvider}.
 */
export function buildAdapters(): Map<Provider, AgentAdapter> {
  const m = new Map<Provider, AgentAdapter>();
  m.set('mock', new MockAdapter());
  m.set('codex', new CodexAdapter());
  m.set('claude', new ClaudeAdapter());
  return m;
}

/**
 * Auto-detect the real provider to use by default (SPEC philosophy: real agent,
 * never mock-by-default). ANTHROPIC key → claude; ambient Claude Code login →
 * claude; OPENAI key → codex; else mock with a loud warning.
 */
export function defaultProvider(): { provider: Provider; reason: string } {
  const forced = process.env.KARMAX_AGENT_PROVIDER as Provider | undefined;
  if (forced) return { provider: forced, reason: `forced via KARMAX_AGENT_PROVIDER=${forced}` };
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'claude', reason: 'ANTHROPIC_API_KEY present' };
  if (ClaudeAdapter.hasAmbientLogin()) return { provider: 'claude', reason: 'Claude Code login present' };
  if (process.env.OPENAI_API_KEY) return { provider: 'codex', reason: 'OPENAI_API_KEY present' };
  return { provider: 'mock', reason: 'NO AGENT CREDENTIALS — falling back to mock (no real work)' };
}
