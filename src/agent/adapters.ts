import { AgentAdapter } from './types.js';
import { Provider } from '../domain/types.js';
import { MockAdapter } from './mock.js';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';
import { AcpAdapter } from './acp.js';
import { hasAcpAmbientLogin, isAgentProvider, mockAgentEnabled } from './provider-registry.js';

/**
 * Builds the provider → adapter map. The mock is there only where the operator
 * forces it (`KARMAX_AGENT_PROVIDER=mock`: hermetic tests), so nothing else can
 * route a turn to it.
 */
export function buildAdapters(): Map<Provider, AgentAdapter> {
  const m = new Map<Provider, AgentAdapter>();
  if (mockAgentEnabled()) m.set('mock', new MockAdapter());
  m.set('codex', new CodexAdapter());
  m.set('claude', new ClaudeAdapter());
  m.set('opencode', new AcpAdapter('opencode'));
  return m;
}

/**
 * Pick a fallback provider only for profiles that do not explicitly choose one.
 * Connected accounts remain provider-specific and are selected by their profile.
 * Native-harness credentials retain precedence; a Kimi key selects OpenCode
 * because its default OpenCode model is a Kimi model. With no credential on the
 * host — a hosted installation, where every organization connects its own — it
 * is Claude: a turn then asks for a login or key instead of pretending to work.
 */
export function defaultProvider(): { provider: Provider; reason: string } {
  const forced = process.env.KARMAX_AGENT_PROVIDER as Provider | undefined;
  if (forced && isAgentProvider(forced)) return { provider: forced, reason: `forced via KARMAX_AGENT_PROVIDER=${forced}` };
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'claude', reason: 'ANTHROPIC_API_KEY present' };
  if (ClaudeAdapter.hasAmbientLogin()) return { provider: 'claude', reason: 'Claude Code login present' };
  if (CodexAdapter.hasAmbientSubscription()) return { provider: 'codex', reason: 'Codex login present' };
  if (process.env.OPENAI_API_KEY) return { provider: 'codex', reason: 'OPENAI_API_KEY present' };
  if (hasAcpAmbientLogin('opencode')) return { provider: 'opencode', reason: 'OpenCode credential present' };
  if (process.env.KIMI_API_KEY) return { provider: 'opencode', reason: 'KIMI_API_KEY present for OpenCode' };
  return { provider: 'claude', reason: 'no agent credential on this host; turns use the organization\'s Claude login or API key' };
}
