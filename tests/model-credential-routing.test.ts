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

describe('model-agnostic harness credential routing', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-model-routing-'));
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses model prefixes when clear and Credentials precedence when ambiguous', async () => {
    const organization = store.createOrganization({ name: 'Design' });
    const project = store.createProject('Site', {}, organization.id);
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const googleHandle = `google:${organization.id}:primary`;
    const kimiHandle = `kimi:${organization.id}:design`;
    broker.registerHandle(googleHandle, 'google-secret');
    broker.registerHandle(kimiHandle, 'kimi-secret');
    const configHomes = new ConfigHomeManager(path.join(dir, 'homes'));
    const grokHome = configHomes.ensure('opencode', 'grok-subscription', organization.id);
    configHomes.setModelProvider(grokHome, 'xai');
    fs.mkdirSync(path.join(grokHome, 'data', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(grokHome, 'data', 'opencode', 'auth.json'), JSON.stringify({ xai: { type: 'oauth' } }));
    const grokLogin = `login:${organization.id}:opencode:grok-subscription`;
    store.kvSet(credPolicyKey.organization(organization.id), JSON.stringify({
      order: [grokLogin, `key:handle:${googleHandle}`, `key:handle:${kimiHandle}`],
    }));
    store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      role: 'do',
      provider: 'opencode',
      model: 'custom-design-model',
      modelProvider: 'xai', // historical duplicate must not affect routing
      capabilities: [],
    });

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
    const project = store.createProject('Personal design');
    const runtimeTask = store.createTask({ projectId: project.id, title: 'Design', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'design it' } as any });
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault-runtime')));
    broker.registerHandle('xai:legacy', 'must-not-be-resolved');
    store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      role: 'do',
      provider: 'opencode',
      model: 'custom-design-model',
      auth: { kind: 'apiKeyHandle', handle: 'xai:legacy' },
      capabilities: [],
    });
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
    const organization = store.createOrganization({ name: 'Disabled' });
    const project = store.createProject('Disabled credentials', {}, organization.id);
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault-disabled')));
    const handle = `google:${organization.id}:disabled`;
    broker.registerHandle(handle, 'disabled-secret');
    store.kvSet(credPolicyKey.organization(organization.id), JSON.stringify({
      off: [`key:handle:${handle}`],
    }));
    store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      role: 'do',
      provider: 'opencode',
      model: 'google/gemini-2.5-pro',
      capabilities: [],
    });
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
