// A task that inherits a default agent its organization can't run is pinned to
// tavya's included model when it starts (wiki features/included-model § Default).
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { AuthorizationService, organizationScope as authorizationScope } from '../src/platform/authorization.js';
import { organizationScope } from '../src/autonomy/vault-keys.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { WorldRegistry } from '../src/world/registry.js';
import { saveIncludedModel } from '../src/agent/included-model.js';
import { organizationProfileId } from '../src/agent/profiles.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-included-default-'));
  const store = await Store.create(':memory:', { hosted: true });
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  // No real OpenRouter call: the management key is only checked for presence.
  await saveIncludedModel(store, broker, { managementKey: 'mgmt-key' });
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id);
  const authorization = await AuthorizationService.create(store);
  await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: authorizationScope(organization.id), profileId: 'superadmin' });
  const tokens = new TokenAuthority(store);
  const owner = (await tokens.mintPrincipal('user:owner', await authorization.capabilities('user:owner', project.id, organization.id),
    project.id, undefined, organization.id)).token;
  const started: any[] = [];
  const client = { workflow: {
    getHandle: () => ({ executeUpdate: async () => ({}), signal: async () => undefined, terminate: async () => undefined,
      cancel: async () => undefined, describe: async () => ({ status: { name: 'RUNNING' } }), result: async () => undefined, query: async () => [] }),
    start: async (_type: string, options: any) => { started.push(options.args[0]); return {}; },
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization, contentDir: path.join(dir, 'content'),
    worlds: new WorldRegistry(), hosted: true, broker, defaultAgentProvider: 'claude', configHomes: new ConfigHomeManager(path.join(dir, 'homes')) });
  return { store, broker, organization, project, api, owner, started };
}

const included = { provider: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017', effort: 'max' };

describe('a new task\'s default agent', () => {
  it('is the included model when nothing of the organization\'s own runs its Task default', async () => {
    const f = await fixture();
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Make a CSV report' });
    await expect.poll(() => f.started.length).toBeGreaterThan(0);
    expect(f.started[0].agents.do).toMatchObject(included);
    expect(JSON.parse((await f.store.kvGet(`task-agents:${task.id}`))!).do).toMatchObject(included);
  });

  it('is its Task default once a login or key of its own runs that, and an explicit choice is never replaced', async () => {
    const f = await fixture();
    await f.store.upsertProfile({ id: organizationProfileId(f.organization.id, 'do'), name: 'Do', role: 'do', provider: 'codex', model: 'gpt-6.1-sol' });
    await f.broker.registerHandle(`openai:${f.organization.id}:main`, 'sk-test', organizationScope(f.organization.id));
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Make a CSV report' });
    await expect.poll(() => f.started.length).toBe(1);
    // Left to inherit, as before: nothing pinned, and the run is recorded on Codex.
    expect(f.started[0].agents?.do).toBeUndefined();
    expect(JSON.parse((await f.store.kvGet(`task-agents:${task.id}`))!).do).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol' });

    // Claude, chosen with no Claude login, stays Claude (the form says what it lacks).
    await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Review it', params: { 'agent:do': { provider: 'claude', model: 'claude-opus-5-5' } } });
    await expect.poll(() => f.started.length).toBe(2);
    expect(f.started[1].agents.do).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
  });
});
