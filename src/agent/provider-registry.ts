import type { AgentProfile, Provider } from '../domain/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Kimi and xAI remain model/API-key namespaces, but their native coding
// harnesses are not admitted until their ACP servers meet the parity bar.
export const AGENT_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'opencode', 'mock'];
export const LOGIN_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'opencode'];

export const MODEL_PROVIDERS = [
  'anthropic',
  'openai',
  'kimi',
  'moonshotai',
  'xai',
  'google',
  'openrouter',
  'groq',
  'mistral',
  'deepseek',
] as const;

/** Provider prefix from OpenCode's canonical `provider/model` model id. */
export function modelProviderFromModel(model: string | undefined): string | undefined {
  const slash = model?.indexOf('/') ?? -1;
  if (slash <= 0) return undefined;
  return model!.slice(0, slash).trim() || undefined;
}

/** Credential-pool namespace for a profile, distinct from its coding harness. */
export function credentialProvider(profile: Pick<AgentProfile, 'provider' | 'modelProvider' | 'model'>): string {
  if (profile.modelProvider?.trim()) return profile.modelProvider.trim();
  if (profile.provider === 'opencode') {
    const prefix = modelProviderFromModel(profile.model);
    if (prefix) return prefix;
  }
  return profile.provider;
}

/** Backward-compatible credential namespaces that represent the same API vendor. */
export function credentialAliases(provider: string): string[] {
  if (provider === 'claude' || provider === 'anthropic') return ['claude', 'anthropic'];
  if (provider === 'codex' || provider === 'openai') return ['codex', 'openai'];
  if (provider === 'grok' || provider === 'xai') return ['grok', 'xai'];
  return [provider];
}

/** Canonical model-provider id expected by a general-model harness. */
export function canonicalModelProvider(provider: string): string {
  if (provider === 'claude') return 'anthropic';
  if (provider === 'codex') return 'openai';
  if (provider === 'grok') return 'xai';
  return provider;
}

/** Subscription homes belong to a harness; API keys belong to a model vendor. */
export function credentialMatchesProfile(
  profile: Pick<AgentProfile, 'provider' | 'modelProvider' | 'model'>,
  credential: { provider: string; kind: 'login' | 'ambient' | 'key' },
): boolean {
  return credential.kind === 'key'
    ? credentialAliases(credentialProvider(profile)).includes(credential.provider)
    : credential.provider === profile.provider;
}

export function isAgentProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value);
}

export function isLoginProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (LOGIN_PROVIDERS as readonly string[]).includes(value);
}

export type AcpProvider = Extract<Provider, 'opencode' | 'kimi' | 'grok'>;
const ACP_PROVIDERS: readonly AcpProvider[] = ['opencode', 'kimi', 'grok'];

export function isAcpProvider(provider: unknown): provider is AcpProvider {
  return typeof provider === 'string' && (ACP_PROVIDERS as readonly string[]).includes(provider);
}

/** Official, account-scoped home for each ACP harness. */
export function acpHomeEnv(provider: AcpProvider, home: string): Record<string, string> {
  switch (provider) {
    case 'opencode':
      return {
        XDG_DATA_HOME: path.join(home, 'data'),
        XDG_CONFIG_HOME: path.join(home, 'config'),
        OPENCODE_CONFIG_DIR: path.join(home, 'config', 'opencode'),
      };
    case 'kimi':
      return { KIMI_CODE_HOME: home };
    case 'grok':
      return { GROK_HOME: home };
  }
}

export function acpNativeCredentialFiles(provider: AcpProvider): string[] {
  switch (provider) {
    case 'opencode':
      return [path.join('data', 'opencode', 'auth.json')];
    case 'kimi':
      return ['credentials'];
    case 'grok':
      return ['auth.json'];
  }
}

/** Does an ACP harness home contain a native subscription credential? */
export function hasAcpHomeLogin(provider: AcpProvider, home: string): boolean {
  if (provider === 'kimi') {
    const dir = path.join(home, 'credentials');
    try {
      return fs.readdirSync(dir).some((name) => name.endsWith('.json'));
    } catch {
      return false;
    }
  }
  return acpNativeCredentialFiles(provider).some((file) => fs.existsSync(path.join(home, file)));
}

export function hasAcpAmbientLogin(provider: AcpProvider): boolean {
  const home =
    provider === 'opencode'
      ? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'opencode')
      : provider === 'kimi'
        ? process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code')
        : process.env.GROK_HOME ?? path.join(os.homedir(), '.grok');
  if (provider === 'opencode') return fs.existsSync(path.join(home, 'auth.json'));
  return hasAcpHomeLogin(provider, home);
}

/** Environment variable expected by a model provider when a broker key is used. */
export function apiKeyEnv(provider: string): string {
  switch (provider) {
    case 'claude':
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'codex':
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'kimi':
      return 'KIMI_API_KEY';
    case 'moonshotai':
      return 'MOONSHOT_API_KEY';
    case 'xai':
    case 'grok':
      return 'XAI_API_KEY';
    case 'google':
      return 'GEMINI_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'groq':
      return 'GROQ_API_KEY';
    case 'mistral':
      return 'MISTRAL_API_KEY';
    case 'deepseek':
      return 'DEEPSEEK_API_KEY';
    default:
      // A model prefix is user input, not authority to read arbitrary host keys.
      return '';
  }
}
