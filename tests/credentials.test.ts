import { describe, it, expect } from 'vitest';
import {
  enumerateCredentials,
  resolveCredentials,
  credentialsForProvider,
  defaultEnabled,
  isEnabled,
} from '../src/platform/credentials.js';
import { agentAccountHandles, credPolicyKey, readPolicyLayers } from '../src/platform/credential-sources.js';

const sources = {
  logins: [
    { provider: 'claude', account: 'manyu', path: '/h/cm', loggedIn: true },
    { provider: 'claude', account: 'mats', path: '/h/ct', loggedIn: true },
    { provider: 'codex', account: 'work', path: '/h/cx', loggedIn: true },
    { provider: 'claude', account: 'loggedout', path: '/h/lo', loggedIn: false }, // excluded
  ],
  ambient: { claude: true, codex: true },
  ambientHomes: { claude: '/home/test/.claude', codex: '/home/test/.codex' },
  envKeys: { claude: false, codex: true }, // OPENAI_API_KEY present
  handles: ['claude:broker1'],
};
const all = enumerateCredentials(sources);
const keys = (cs: { key: string }[]) => cs.map((c) => c.key);

describe('credential enumeration', () => {
  it('hides infrastructure vault handles from agent account selection', () => {
    expect(agentAccountHandles(['claude:work', 'codex:personal', 'kimi:design', 'xai:grok',
      'checkpoint:encryption-key',
      'github-app:private-key', 'world-provider:org:e2b:api-key']))
      .toEqual(['claude:work', 'codex:personal', 'kimi:design', 'xai:grok']);
  });

  it('lists logged-in logins, ambient logins, env keys, and broker handles', () => {
    const k = keys(all);
    expect(k).toEqual(
      expect.arrayContaining(['login:claude:manyu', 'login:claude:mats', 'login:codex:work', 'ambient:claude', 'ambient:codex', 'key:codex', 'key:handle:claude:broker1']),
    );
    expect(k).not.toContain('login:claude:loggedout'); // not logged in
    expect(k).not.toContain('key:claude'); // ANTHROPIC_API_KEY absent
    expect(all.find((c) => c.key === 'login:claude:manyu')?.configHome).toBe('/h/cm');
    expect(all.find((c) => c.key === 'ambient:claude')?.configHome).toBe('/home/test/.claude');
    expect(all.find((c) => c.key === 'ambient:codex')?.configHome).toBe('/home/test/.codex');
  });

  it('uses tenant-qualified login and key ids outside the personal organization', () => {
    const scoped = enumerateCredentials({
      organizationId: 'org_acme',
      logins: [{ provider: 'claude', account: 'work', path: '/h/acme', loggedIn: true }],
      ambient: {},
      envKeys: {},
      handles: ['claude:org_acme:metered'],
    });
    expect(keys(scoped)).toEqual([
      'login:org_acme:claude:work',
      'key:handle:claude:org_acme:metered',
    ]);
    expect(agentAccountHandles([
      'claude:legacy-personal',
      'claude:org_acme:metered',
      'claude:org_beta:metered',
    ], 'org_acme')).toEqual(['claude:org_acme:metered']);
  });

  it('keeps a model vendor on model-agnostic subscription credentials', () => {
    const credentials = enumerateCredentials({
      logins: [{
        provider: 'opencode',
        account: 'grok-subscription',
        path: '/h/oc',
        loggedIn: true,
        modelProvider: 'xai',
      }],
      ambient: {},
      envKeys: {},
      handles: [],
    });
    expect(credentials).toEqual([expect.objectContaining({
      key: 'login:opencode:grok-subscription',
      provider: 'opencode',
      modelProvider: 'xai',
      label: 'opencode:grok-subscription (xai)',
    })]);
  });

  it('keeps a detected model vendor on an ambient OpenCode credential', () => {
    const credentials = enumerateCredentials({
      logins: [],
      ambient: { opencode: true },
      ambientModelProviders: { opencode: 'xai' },
      envKeys: {},
      handles: [],
    });
    expect(credentials).toEqual([expect.objectContaining({
      key: 'ambient:opencode',
      modelProvider: 'xai',
      label: 'opencode (ambient login · xai)',
    })]);
  });
});

describe('default policy: logins/ambient ON, API keys OFF (opt-in)', () => {
  it('enables logins + ambient, excludes keys, and orders logins before ambient', () => {
    const r = keys(resolveCredentials(all, {}));
    expect(r).toEqual(['login:claude:manyu', 'login:claude:mats', 'login:codex:work', 'ambient:claude', 'ambient:codex']);
    expect(r).not.toContain('key:codex');
    expect(r).not.toContain('key:handle:claude:broker1');
  });
  it('defaultEnabled: subscriptions on; a key is off when a subscription exists, on when it is the only option', () => {
    expect(defaultEnabled(all.find((c) => c.kind === 'login')!, all)).toBe(true);
    expect(defaultEnabled(all.find((c) => c.key === 'key:codex')!, all)).toBe(false); // codex has a login/ambient → off
    // a key-only provider (no login/ambient) → the key is enabled by default so it still works.
    const keyOnly = enumerateCredentials({ logins: [], ambient: { claude: false, codex: false }, envKeys: { claude: false, codex: true }, handles: [] });
    expect(defaultEnabled(keyOnly[0]!, keyOnly)).toBe(true);
    expect(keys(resolveCredentials(keyOnly, {}))).toEqual(['key:codex']);
  });
});

describe('enable / disable across scopes (task → project → global)', () => {
  it('assigns the legacy global policy only to org_personal', () => {
    const values = new Map([[credPolicyKey.global(), JSON.stringify({ off: ['ambient:claude'] })]]);
    expect(readPolicyLayers((key) => values.get(key), { organizationId: 'org_personal' }).global?.off)
      .toEqual(['ambient:claude']);
    expect(readPolicyLayers((key) => values.get(key), { organizationId: 'org_other' }).global)
      .toBeUndefined();
  });

  it('a global "on" opts a key in (ranked after logins/ambient)', () => {
    const r = keys(resolveCredentials(all, { global: { on: ['key:codex'] } }));
    expect(r).toContain('key:codex');
    expect(r.indexOf('key:codex')).toBeGreaterThan(r.indexOf('login:codex:work'));
  });
  it('a global "off" disables a login', () => {
    expect(keys(resolveCredentials(all, { global: { off: ['login:claude:manyu'] } }))).not.toContain('login:claude:manyu');
  });
  it('a task scope OVERRIDES a global disable (re-enables it)', () => {
    const layers = { global: { off: ['login:claude:mats'] }, task: { on: ['login:claude:mats'] } };
    expect(keys(resolveCredentials(all, layers))).toContain('login:claude:mats');
    expect(isEnabled('login:claude:mats', layers, true)).toBe(true);
  });
  it('a project "on" opts in an API key that the global default leaves off', () => {
    expect(keys(resolveCredentials(all, { project: { on: ['key:handle:claude:broker1'] } }))).toContain('key:handle:claude:broker1');
  });
});

describe('precedence ordering', () => {
  it('an explicit order wins; lower scope order overrides higher', () => {
    const g = credentialsForProvider(all, 'claude', { global: { order: ['ambient:claude', 'login:claude:mats', 'login:claude:manyu'] } });
    expect(keys(g)).toEqual(['ambient:claude', 'login:claude:mats', 'login:claude:manyu']);
    // project order supersedes global order
    const p = credentialsForProvider(all, 'claude', {
      global: { order: ['ambient:claude', 'login:claude:mats', 'login:claude:manyu'] },
      project: { order: ['login:claude:manyu', 'ambient:claude', 'login:claude:mats'] },
    });
    expect(keys(p)).toEqual(['login:claude:manyu', 'ambient:claude', 'login:claude:mats']);
  });
  it('credentialsForProvider filters to one provider', () => {
    expect(credentialsForProvider(all, 'codex', {}).every((c) => c.provider === 'codex')).toBe(true);
    expect(keys(credentialsForProvider(all, 'codex', {}))).toEqual(['login:codex:work', 'ambient:codex']);
  });
});
