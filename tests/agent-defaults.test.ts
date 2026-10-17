import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdapters, defaultProvider } from '../src/agent/adapters.js';
import { CLAUDE_DEFAULT_MODEL } from '../src/agent/effort.js';
import {
  makeDefaultProfiles, organizationProfileId, projectProfileId, repairMockProfiles,
} from '../src/agent/profiles.js';
import { assertRunnableProvider, isAgentProvider, mockAgentEnabled } from '../src/agent/provider-registry.js';
import { runTurn } from '../src/agent/runtime.js';
import { Store } from '../src/store/db.js';
import type { Avatar } from '../src/domain/types.js';

// tavya.io once ran a new organization's automatic task on the mock agent: with
// no credentials on the host at first boot, `defaultProvider()` picked the mock,
// `seedProfiles()` stamped it onto every installation role default, and every
// organization without defaults of its own inherited it. The console showed it
// as "claude · default model", and the turn answered "(mock agent: no
// directives; nothing to do)". The mock is a test fixture: it runs only where
// the operator asks for it, and a profile naming it anywhere else fails loudly.

const SAVED = ['KARMAX_AGENT_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'HOME', 'KARMAX_CLAUDE_MODEL'] as const;
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defaults-'));
  for (const key of SAVED) delete process.env[key];
  // No ambient Claude, Codex or OpenCode login: a fresh hosted install.
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
});
afterEach(() => {
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the default agent', () => {
  it('is Claude Opus 5.5, even on a host with no agent credentials', () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(defaultProvider().provider).toBe('claude');
    const profiles = makeDefaultProfiles(defaultProvider().provider);
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) expect([profile.provider, profile.model]).toEqual(['claude', 'claude-opus-5-5']);
  });

  it('is the mock only where the operator forces it', () => {
    process.env.KARMAX_AGENT_PROVIDER = 'mock';
    expect(defaultProvider().provider).toBe('mock');
    expect(mockAgentEnabled()).toBe(true);
  });
});

describe('the mock agent outside tests', () => {
  it('is not an agent anyone can choose', () => {
    expect(mockAgentEnabled()).toBe(false);
    expect(isAgentProvider('mock')).toBe(false);
    expect(isAgentProvider('claude')).toBe(true);
    process.env.KARMAX_AGENT_PROVIDER = 'mock';
    expect(isAgentProvider('mock')).toBe(true);
  });

  it('has no adapter, so nothing can route a turn to it', () => {
    expect(buildAdapters().has('mock')).toBe(false);
    expect(buildAdapters().has('claude')).toBe(true);
    process.env.KARMAX_AGENT_PROVIDER = 'mock';
    expect(buildAdapters().has('mock')).toBe(true);
  });

  it('fails a turn whose profile still names it, saying how to fix it', async () => {
    expect(() => assertRunnableProvider({ provider: 'mock' })).toThrow(/no model.*choose a model/i);
    expect(() => assertRunnableProvider({ provider: 'claude' })).not.toThrow();
    // The runtime refuses it too, whatever adapter map it was handed.
    await expect(runTurn({ profile: { id: 'do-default', name: 'Do', provider: 'mock', role: 'do' } } as never,
      { adapters: buildAdapters() } as never)).rejects.toThrow(/no model.*choose a model/i);
    process.env.KARMAX_AGENT_PROVIDER = 'mock';
    expect(() => assertRunnableProvider({ provider: 'mock' })).not.toThrow();
  });
});

describe('profiles left on the mock by an earlier boot', () => {
  const avatar = (provider: 'mock' | 'codex'): Avatar => ({
    id: `avatar-${provider}`, organizationId: 'org_x', projectId: 'p1', ownerUserId: 'u1', name: provider,
    purpose: '', prompt: 'p', promptVersion: 1, roles: [], callableBy: ['user:u1'], authorityMode: 'full',
    runtime: { provider, ...(provider === 'codex' ? { model: 'gpt-5.5' } : {}), effort: 'high' },
    createdAt: 1, updatedAt: 1,
  } as unknown as Avatar);

  it('are moved onto the default agent, keeping everything else', async () => {
    const store = await Store.create(':memory:');
    await store.upsertProfile({ id: 'do-default', name: 'Do', provider: 'mock', role: 'do', effort: 'high', mcpConnections: [] });
    await store.upsertProfile({ id: organizationProfileId('org_x', 'merge'), name: 'Merge', provider: 'mock', role: 'merge' });
    await store.upsertProfile({ id: projectProfileId('p1', 'do'), name: 'Do', provider: 'codex', model: 'gpt-5.5', role: 'do' });
    await store.upsertAvatar(avatar('mock'));
    await store.upsertAvatar(avatar('codex'));

    expect(await repairMockProfiles(store, 'claude')).toBe(3);
    expect(await store.getProfile('do-default')).toEqual({ id: 'do-default', name: 'Do', provider: 'claude',
      model: 'claude-opus-5-5', role: 'do', effort: 'high', mcpConnections: [] });
    expect(await store.getProfile(organizationProfileId('org_x', 'merge'))).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    expect(await store.getProfile(projectProfileId('p1', 'do'))).toMatchObject({ provider: 'codex', model: 'gpt-5.5' });
    expect((await store.getAvatar('avatar-mock'))?.runtime).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    expect((await store.getAvatar('avatar-codex'))?.runtime).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'high' });
    // Idempotent.
    expect(await repairMockProfiles(store, 'claude')).toBe(0);
  });

  it('stay where the mock is the installation agent (tests, demos)', async () => {
    process.env.KARMAX_AGENT_PROVIDER = 'mock';
    const store = await Store.create(':memory:');
    await store.upsertProfile({ id: 'do-default', name: 'Do', provider: 'mock', role: 'do' });
    expect(await repairMockProfiles(store, 'mock')).toBe(0);
    expect((await store.getProfile('do-default'))?.provider).toBe('mock');
  });
});
