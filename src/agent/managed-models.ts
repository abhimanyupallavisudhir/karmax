import type { AgentProfile } from '../domain/types.js';
import { apiKeyEnv, canonicalModelProvider, credentialProvider } from './provider-registry.js';

/** Installation-side authorization boundary for platform-funded model calls.
 * Values are worst-case micro-dollar debits per admitted request, keyed by
 * `provider/model`, `provider/*`, or `provider`. Invalid/absent configuration
 * fails managed admission closed and never affects BYOK. */
export function managedModelRailAvailable(
  hosted: boolean,
  policy: { managedSpendCapMicros?: number | null; managedModelProviders: string[] },
  profile: Pick<AgentProfile, 'provider' | 'model' | 'modelProvider'>,
): boolean {
  const provider = canonicalModelProvider(credentialProvider(profile));
  return hosted && !!policy.managedSpendCapMicros && policy.managedModelProviders.includes(provider)
    && !!managedModelCostCeiling(provider, profile.model)
    && ((profile.provider === 'claude' && !!process.env.ANTHROPIC_API_KEY)
      || (profile.provider === 'codex' && !!process.env.OPENAI_API_KEY)
      || (profile.provider === 'opencode' && !!process.env[apiKeyEnv(provider)]));
}

export function managedModelCostCeiling(provider: string, model?: string): number | undefined {
  const raw = process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS;
  if (!raw) return undefined;
  let values: Record<string, unknown>;
  try { values = JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; }
  const value = values[`${provider}/${model ?? '*'}`] ?? values[`${provider}/*`] ?? values[provider];
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}
