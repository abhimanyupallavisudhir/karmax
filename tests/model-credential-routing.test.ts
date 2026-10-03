import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { Vault } from '../src/autonomy/vault.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { credPolicyKey } from '../src/platform/credential-sources.js';
import { Store } from '../src/store/db.js';
import { MemoryWorldProvider } from '../src/world/memory.js';
import { WorldRegistry } from '../src/world/registry.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';

describe('model-agnostic harness credential routing', () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-model-routing-'));
    store = (await Store.create(':memory:'));
  });

  afterEach(async () => {
    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['claude', 'codex'] as const)('%s login and API credentials follow the configured order in either direction', async (provider) => {
    const organization = await store.createOrganization({ name: 'Ordering' });
    const project = await store.createProject('Work', {}, organization.id);
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const handle = `${provider}:${organization.id}:key`;
    await broker.registerHandle(handle, 'fixture-api-key', INSTALLATION_SCOPE);
    const configHomes = new ConfigHomeManager(path.join(dir, 'homes'));
    const home = configHomes.ensure(provider, 'subscription', organization.id);
    fs.writeFileSync(path.join(home, provider === 'claude' ? '.credentials.json' : 'auth.json'),
      JSON.stringify(provider === 'claude' ? { claudeAiOauth: { accessToken: 'fixture-token' } }
        : { tokens: { access_token: 'fixture-token', refresh_token: 'fixture-refresh' } }));
    const login = `login:${organization.id}:${provider}:subscription`;
    const key = `key:handle:${handle}`;
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(),
      profiles: new ProfileResolver(store, provider), broker, configHomes });
    for (const order of [[login, key], [key, login]]) {
      await store.kvSet(credPolicyKey.organization(organization.id), JSON.stringify({ order, on: [login, key] }));
      expect(await core.resolveCredentialOrder({ taskId: 'ordering', projectId: project.id, provider })).toEqual(order);
    }
  });

  it('uses model prefixes when clear and Credentials precedence when ambiguous', async () => {
    const organization = (await store.createOrganization({ name: 'Design' }));
    const project = (await store.createProject('Site', {}, organization.id));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const googleHandle = `google:${organization.id}:primary`;
    const kimiHandle = `kimi:${organization.id}:design`;
    (await broker.registerHandle(googleHandle, 'google-secret', INSTALLATION_SCOPE));
    (await broker.registerHandle(kimiHandle, 'kimi-secret', INSTALLATION_SCOPE));
    const configHomes = new ConfigHomeManager(path.join(dir, 'homes'));
    const grokHome = configHomes.ensure('opencode', 'grok-subscription', organization.id);
    configHomes.setModelProvider(grokHome, 'xai');
    fs.mkdirSync(path.join(grokHome, 'data', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(grokHome, 'data', 'opencode', 'auth.json'), JSON.stringify({ xai: { type: 'oauth' } }));
    const grokLogin = `login:${organization.id}:opencode:grok-subscription`;
    (await store.kvSet(credPolicyKey.organization(organization.id), JSON.stringify({
      order: [grokLogin, `key:handle:${googleHandle}`, `key:handle:${kimiHandle}`],
    })));
    (await store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      role: 'do',
      provider: 'opencode',
      model: 'custom-design-model',
      modelProvider: 'xai', // historical duplicate must not affect routing
      capabilities: [],
    }));

    const core = makeCoreActivities({
      store,
      worlds: new WorldRegistry(),
      adapters: new Map(),
      profiles: new ProfileResolver(store, 'opencode'),
      broker,
      configHomes,
    });
    const task = {
      projectId: project.id,
      agents: { do: { provider: 'opencode', modelProvider: 'xai' } },
    } as any;

    expect(await core.resolveCredentialOrder({
      taskId: 'custom-task',
      projectId: project.id,
      provider: 'opencode',
      role: 'do',
      task,
    })).toEqual([grokLogin, `key:handle:${googleHandle}`, `key:handle:${kimiHandle}`]);

    task.agents.do.model = 'kimi/k3';
    expect(await core.resolveCredentialOrder({
      taskId: 'kimi-task',
      projectId: project.id,
      provider: 'opencode',
      role: 'do',
      task,
    })).toEqual([`key:handle:${kimiHandle}`]);
  });

  it('passes the exact leased environment-key provider to the OpenCode turn', async () => {
    const project = (await store.createProject('Personal design'));
    const runtimeTask = (await store.createTask({ projectId: project.id, title: 'Design', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'design it' } as any }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault-runtime')));
    (await broker.registerHandle('xai:legacy', 'must-not-be-resolved', INSTALLATION_SCOPE));
    (await store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      role: 'do',
      provider: 'opencode',
      model: 'custom-design-model',
      auth: { kind: 'apiKeyHandle', handle: 'xai:legacy' },
      capabilities: [],
    }));
    let captured: any;
    const adapters = new Map<any, any>([['opencode', {
      provider: 'opencode',
      async runTurn(input: any) {
        captured = input;
        return { output: 'done', termination: { kind: 'success', status: 'end_turn' } };
      },
    }]]);
    const worlds = new WorldRegistry();
    worlds.register(new MemoryWorldProvider());
    const world = await worlds.create('memory', { taskId: runtimeTask.id, base: 'main' });
    const core = makeCoreActivities({
      store,
      worlds,
      adapters,
      profiles: new ProfileResolver(store, 'opencode'),
      broker,
    });

    await core.runAgentTurn({
      taskId: runtimeTask.id,
      role: 'do',
      worldHandle: world.handle,
      messages: [{ id: 'm1', role: 'user', text: 'design it', ts: 0 }],
      task: {
        projectId: project.id,
        title: 'Design',
        prompt: 'design it',
        project: {},
        workflow: 'software-dev',
      },
      accountCredentialKind: 'key',
      accountCredentialProvider: 'google',
    } as any);

    expect(captured.profile).toMatchObject({
      provider: 'opencode',
      model: 'custom-design-model',
      modelProvider: 'google',
    });
    expect(captured.resolvedAuth).toBeUndefined();
    await world.destroy();
  });

  it('does not bypass a Credentials policy that disables every compatible source', async () => {
    const organization = (await store.createOrganization({ name: 'Disabled' }));
    const project = (await store.createProject('Disabled credentials', {}, organization.id));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault-disabled')));
    const handle = `google:${organization.id}:disabled`;
    (await broker.registerHandle(handle, 'disabled-secret', INSTALLATION_SCOPE));
    (await store.kvSet(credPolicyKey.organization(organization.id), JSON.stringify({
      off: [`key:handle:${handle}`],
    })));
    (await store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      role: 'do',
      provider: 'opencode',
      model: 'google/gemini-2.5-pro',
      capabilities: [],
    }));
    const core = makeCoreActivities({
      store,
      worlds: new WorldRegistry(),
      adapters: new Map(),
      profiles: new ProfileResolver(store, 'opencode'),
      broker,
    });

    expect(await core.resolveCredentialOrder({
      taskId: 'disabled-task',
      projectId: project.id,
      provider: 'opencode',
      role: 'do',
      task: { projectId: project.id } as any,
    })).toEqual([`missing:${organization.id}:google`]);
  });
});

/**
 * WF-6: the account pool is installation-wide — every organization's logins and
 * API keys sit in one coordinator. Only the per-turn allow-list keeps a lease
 * inside the task's organization, so a missing list must fail closed, and the
 * turn must refuse a leased home or key that is not its organization's.
 */
describe('credential leases stay inside the task’s organization', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-lease-tenancy-'));
    store = (await Store.create(':memory:'));
  });
  afterEach(async () => {
    (await store.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never asks the coordinator for "any account of this provider" when the policy could not be read', async () => {
    const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
    const leases: any[] = [];
    const client = { workflow: {
      async signalWithStart(_workflow: unknown, options: any) { leases.push(options.signalArgs[0]); },
      getHandle: () => ({ query: async () => ({ waiting: false }) }),
    } } as never;
    const coord = makeCoordinatorActivities({ client, taskQueue: 'test' });
    await coord.leaseAccount('task_a', 'task_a#0', 'claude', undefined);
    await coord.leaseAccount('task_a', 'task_a#1', 'claude', ['login:org_a:claude:main']);
    await coord.leaseAccount('task_a', 'task_a#2', 'mock', undefined);
    expect(leases.map((lease) => lease.allowed)).toEqual([
      ['missing:policy-unavailable'], ['login:org_a:claude:main'], undefined,
    ]);
  });

  it('refuses a leased login home or API key that belongs to another organization', async () => {
    const mine = (await store.createOrganization({ name: 'Mine' }));
    const theirs = (await store.createOrganization({ name: 'Theirs' }));
    const project = (await store.createProject('Work', {}, mine.id));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const theirKey = `claude:${theirs.id}:key`;
    const myKey = `claude:${mine.id}:key`;
    (await broker.registerHandle(theirKey, 'their-api-key', INSTALLATION_SCOPE));
    (await broker.registerHandle(myKey, 'my-api-key', INSTALLATION_SCOPE));
    const configHomes = new ConfigHomeManager(path.join(dir, 'homes'));
    const login = (organizationId: string) => {
      const home = configHomes.ensure('claude', 'subscription', organizationId);
      fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `${organizationId}-token` } }));
      return home;
    };
    const theirHome = login(theirs.id);
    const myHome = login(mine.id);
    const task = (await store.createTask({ projectId: project.id, title: 'Turn', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' } }));
    let ran = 0;
    const adapters = new Map([['claude', { provider: 'claude', async runTurn() {
      ran++;
      return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'done' };
    } }]]) as any;
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    const core = makeCoreActivities({ store, worlds, adapters, broker, configHomes,
      profiles: new ProfileResolver(store, 'claude') });
    const turn = (lease: Record<string, unknown>) => core.runAgentTurn({ taskId: task.id, role: 'do',
      agentTurnId: `${task.id}#${ran}`, agentSlotGranted: true, worldHandle: world.handle,
      messages: [{ id: 'm1', role: 'user', text: 'work', ts: 0 }],
      task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {},
        workflow: 'software-dev', agents: { do: { provider: 'claude' } } }, ...lease } as any);
    try {
      await expect(turn({ accountConfigHome: theirHome, accountCredentialKind: 'login' })).rejects.toThrow(/not available to this organization/);
      await expect(turn({ accountApiKeyHandle: theirKey, accountCredentialKind: 'key' })).rejects.toThrow(/not available to this organization/);
      expect(ran).toBe(0);
      await turn({ accountConfigHome: myHome, accountCredentialKind: 'login' });
      expect(ran).toBe(1);
      // The organization's own key passes this check (the broker then applies
      // its usual per-task grant, which this bare task does not hold).
      const own = await turn({ accountApiKeyHandle: myKey, accountCredentialKind: 'key' }).catch((error) => error);
      expect(String(own)).not.toMatch(/not available to this organization/);
    } finally { await world.destroy(); }
  });
});
