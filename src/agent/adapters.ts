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
 * Pick a fallback provider only for profiles that do not explicitly choose one.
 * Connected accounts remain provider-specific and are selected by their profile;
 * this is not a statement of which providers are available to karmax.
 */
export function defaultProvider(): { provider: Provider; reason: string } {
  const forced = process.env.KARMAX_AGENT_PROVIDER as Provider | undefined;
  if (forced) return { provider: forced, reason: `forced via KARMAX_AGENT_PROVIDER=${forced}` };
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'claude', reason: 'ANTHROPIC_API_KEY present' };
  if (ClaudeAdapter.hasAmbientLogin()) return { provider: 'claude', reason: 'Claude Code login present' };
  if (CodexAdapter.hasAmbientSubscription()) return { provider: 'codex', reason: 'Codex login present' };
  if (process.env.OPENAI_API_KEY) return { provider: 'codex', reason: 'OPENAI_API_KEY present' };
  return { provider: 'mock', reason: 'no configured provider credential' };
}
