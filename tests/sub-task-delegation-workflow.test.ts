import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { VaultItems } from '../src/autonomy/vault-items.js';

/**
 * pramana#59: sub-tasks asked a person for what their parent already held. A
 * parent is approved a vault credential (as from the inbox, after it started);
 * its sub-task, a real workflow child with its own minted token, reveals it
 * through the real gateway without anyone being asked (wiki SPEC §8.2,
 * src/platform/delegation.ts).
 */
describe('a sub-task uses what its parent was approved', () => {
  let h: Harness;
  let gateway: Awaited<ReturnType<Harness['startGateway']>>;
  const previous = { url: process.env.KARMAX_GATEWAY_URL, floor: process.env.KARMAX_AGENT_MIN_FREE_MB, load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR };

  beforeAll(async () => {
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    h = await bootHarness('mock');
    gateway = await h.startGateway();
    process.env.KARMAX_GATEWAY_URL = gateway.internalUrl;
  }, 120_000);

  afterAll(async () => {
    await h?.stop();
    for (const [name, value] of [['KARMAX_GATEWAY_URL', previous.url], ['KARMAX_AGENT_MIN_FREE_MB', previous.floor],
      ['KARMAX_AGENT_MAX_LOAD_FACTOR', previous.load]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('reveals a credential approved for its parent, asking no one, with its parent\'s scope', async () => {
    const repo = await h.makeRepo('sub-task-delegation');
    const project = await h.store.createProject('Delegation', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false });
    const vault = new VaultItems(h.store, h.broker, undefined, project.organizationId);
    const item = await vault.save({ type: 'api-key', label: 'Deploy key', policy: { use: 'ask', reveal: 'auto' }, secrets: { secret: 'sk-parent-held' } });
    const apiToken = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const parent = await h.api.createTask(apiToken, { projectId: project.id, title: 'Parent', draft: true,
      params: { 'agent:do': { provider: 'mock' } },
      prompt: [`@subtask Use the key :: @reveal ${item.id}`, '@wait'].join('\n') } as any);
    // Organization-wide, on behalf of its person, with everything but the vault:
    // only the approval below grants the key.
    const person = (await h.tokens.mintPrincipal('user:a', ['*'], undefined, undefined, project.organizationId)).token;
    const delegation = (await h.tokens.delegateHuman(person, { taskId: parent.id, organizationId: project.organizationId }))!;
    const stored = (await h.store.getTask(parent.id))!.params;
    await h.store.updateTaskParams(parent.id, { ...stored, _authorization: { ...stored._authorization as object,
      scope: 'organization', organizationId: project.organizationId, delegationId: delegation.id,
      capabilities: ['task:*', 'project:read', 'credential:read', 'create-sub-task', 'signal-completion', 'merge-into:*'] } });
    const asked = await vault.request({ taskId: parent.id, caps: [], itemId: item.id, mode: 'reveal', why: 'deploy' });
    await vault.resolve(asked.requestId!, { action: 'task', by: 'user:a' });
    await h.api.queueTask(apiToken, parent.id);

    const reveal = await vi.waitFor(async () => {
      const child = (await h.store.listTasks(project.id)).find((task) => task.parentTaskId === parent.id);
      expect(child).toBeTruthy();
      const event = (await h.store.eventsSince(child!.id, 0))
        .find((candidate) => candidate.type === 'agent.activity' && (candidate.payload as any).id === `reveal-${item.id}`);
      expect(event).toBeTruthy();
      return JSON.parse((event!.payload as any).detail);
    }, { timeout: 90_000, interval: 250 });
    expect(reveal).toMatchObject({ status: 'granted' });
    // Its turn ran with its parent's organization scope, on its person's behalf.
    const child = (await h.store.listTasks(project.id)).find((task) => task.parentTaskId === parent.id)!;
    const childDelegation = (child.params._authorization as { delegationId?: string }).delegationId!;
    expect(await h.tokens.delegationCovers(childDelegation, { organizationId: project.organizationId })).toBe(true);
    expect((await vault.requests()).filter((request) => request.status === 'pending')).toEqual([]);
  }, 150_000);
});
