import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acpHomeEnv,
  apiKeyEnv,
  canonicalModelProvider,
  credentialAliases,
  credentialMatchesProfile,
  credentialProvider,
  hasAcpHomeLogin,
  isAgentProvider,
  isLoginProvider,
  modelProviderFromModel,
} from '../src/agent/provider-registry.js';

describe('agent/model provider separation', () => {
  it('never maps arbitrary model prefixes to host infrastructure keys', () => {
    expect(apiKeyEnv('e2b')).toBe('');
    expect(apiKeyEnv('daytona')).toBe('');
    expect(apiKeyEnv('stripe')).toBe('');
    expect(apiKeyEnv('openai')).toBe('OPENAI_API_KEY');
    expect(apiKeyEnv('opencode')).toBe('');
  });
  it('admits OpenCode but keeps native Kimi and Grok harnesses disabled', () => {
    expect(isAgentProvider('opencode')).toBe(true);
    expect(isLoginProvider('opencode')).toBe(true);
    expect(isAgentProvider('kimi')).toBe(false);
    expect(isAgentProvider('grok')).toBe(false);
  });

  it('infers OpenCode credentials only from canonical provider/model ids', () => {
    expect(credentialProvider({ provider: 'opencode', model: 'kimi/k3' })).toBe('kimi');
    expect(modelProviderFromModel('google/gemini-2.5-pro')).toBe('google');
    expect(modelProviderFromModel('gemini-2.5-pro')).toBeUndefined();
    expect(credentialProvider({ provider: 'opencode', model: 'gemini-2.5-pro' })).toBe('opencode');
    expect(credentialProvider({ provider: 'kimi', model: 'k3' })).toBe('kimi');
  });

  it('keeps legacy harness key namespaces compatible with model-vendor names', () => {
    expect(credentialAliases('anthropic')).toEqual(['claude', 'anthropic']);
    expect(credentialAliases('openai')).toEqual(['codex', 'openai']);
    expect(credentialAliases('xai')).toEqual(['grok', 'xai']);
    expect(canonicalModelProvider('claude')).toBe('anthropic');
    expect(canonicalModelProvider('codex')).toBe('openai');
    expect(canonicalModelProvider('xai')).toBe('xai');
  });

  it('accepts model-vendor keys but only harness-native subscription homes', () => {
    const profile = { provider: 'opencode' as const, model: 'kimi/k3' };
    expect(credentialMatchesProfile(profile, { provider: 'kimi', kind: 'key' })).toBe(true);
    expect(credentialMatchesProfile(profile, { provider: 'opencode', kind: 'ambient' })).toBe(true);
    expect(credentialMatchesProfile(profile, { provider: 'kimi', kind: 'login' })).toBe(false);
  });
});

describe('official ACP config homes', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('maps each harness to its documented startup home', () => {
    expect(acpHomeEnv('opencode', '/h')).toEqual({
      XDG_DATA_HOME: '/h/data',
      XDG_CONFIG_HOME: '/h/config',
      OPENCODE_CONFIG_DIR: '/h/config/opencode',
    });
    expect(acpHomeEnv('kimi', '/h')).toEqual({ KIMI_CODE_HOME: '/h' });
    expect(acpHomeEnv('grok', '/h')).toEqual({ GROK_HOME: '/h' });
  });

  it('recognizes Kimi’s credentials directory without depending on a token filename', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-kimi-home-'));
    fs.mkdirSync(path.join(dir, 'credentials'));
    expect(hasAcpHomeLogin('kimi', dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'credentials', 'kimi-code.json'), '{}');
    expect(hasAcpHomeLogin('kimi', dir)).toBe(true);
  });
});

// Hosted deployments force cloud worlds, and the task form offers every
// admitted agent in every project. So admission itself is the gate: an agent
// that cannot run in an E2B/Daytona world is never offered (task #515's
// OpenCode failed at its first turn on tavya.io before remote-acp.ts).
describe('agent admission', () => {
  it('admits only agents that also run in a cloud world', async () => {
    const { AGENT_PROVIDERS, isAcpProvider } = await import('../src/agent/provider-registry.js');
    const { remoteAcpSupported } = await import('../src/agent/remote-acp.js');
    for (const provider of AGENT_PROVIDERS)
      if (isAcpProvider(provider)) expect(remoteAcpSupported(provider), provider).toBe(true);
    expect(remoteAcpSupported('kimi')).toBe(false);
  });
});
