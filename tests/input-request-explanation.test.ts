import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { requestExplanation } from '../src/agent/explanation.js';

vi.mock('../src/agent/explanation.js', async (original) => ({
  ...await original<typeof import('../src/agent/explanation.js')>(),
  requestExplanation: vi.fn(async () => 'Pick where to publish.'),
}));

describe('input request explanations over HTTP', () => {
  let home: string;
  let store: Store;
  let base: string;
  let token: string;
  let taskId: string;
  let view: any;
  let close: () => Promise<void>;
  const sourceKey = 'input-request:1710000010000';
  const post = (body: object) => fetch(`${base}/api/tasks/${taskId}/explanations`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-input-explanation-'));
    store = new Store(':memory:');
    const project = store.createProject('Input explanations');
    taskId = store.createTask({ projectId: project.id, title: 'Choose a target',
      workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'Publish my update' } }).id;
    view = { status: 'waiting', updatedAt: 1710000010000,
      waitingFor: { kind: 'human', detail: 'Choose a deployment target.' },
      actions: [{ name: 'followUp', roles: ['do'], enabled: true }] };
    const gateway = new Gateway({ store, bus: new KarmaxBus(), tokens: new TokenAuthority(),
      contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any,
      api: { taskConversation: async () => ({ messages: [{ role: 'user', text: 'Publish my update', ts: 1 }] }),
        getTaskView: async () => view } as any,
      taskQueue: 'test', staticDir: home, worlds: new WorldRegistry(),
      agentInfo: { provider: 'mock', reason: 'test' },
    } as any);
    vi.spyOn(gateway as any, 'explanationApiKey').mockReturnValue('test-only-key');
    const running = await gateway.listen(await findFreePortFrom(48_400));
    base = running.url;
    close = running.close;
    token = (await (await fetch(`${base}/api/session`)).json() as any).token;
  });

  afterAll(async () => { await close?.(); store?.close(); fs.rmSync(home, { recursive: true, force: true }); });

  it('rejects stale text and the wrong conversation before calling the model', async () => {
    for (const body of [
      { role: 'do', sourceKey, inputRequest: 'Different question' },
      { role: 'merge', sourceKey, inputRequest: view.waitingFor.detail },
      { role: 'do', sourceKey: 'input-request:1', inputRequest: view.waitingFor.detail },
    ]) expect((await post(body)).status).toBe(409);
    expect(requestExplanation).not.toHaveBeenCalled();
  });

  it('explains the authoritative prompt and persists its source through resolution', async () => {
    const response = await post({ role: 'do', sourceKey, inputRequest: view.waitingFor.detail });
    expect(response.status).toBe(200);
    const event = await response.json() as any;
    expect(event.payload).toMatchObject({ sourceKey, text: 'Pick where to publish.',
      sourceRequest: { text: 'Choose a deployment target.', ts: view.updatedAt } });
    expect(requestExplanation).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Choose a deployment target.', userContext: ['Publish my update'],
    }));
    view = { status: 'active', updatedAt: 1710000020000, actions: [] };
    const reloaded = await fetch(`${base}/api/tasks/${taskId}/explanations`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await reloaded.json() as any[])[0].payload.sourceRequest).toEqual(event.payload.sourceRequest);
    // The model picker can also explain a historical prompt again.
    expect((await post({ role: 'do', sourceKey })).status).toBe(200);
    expect((await post({ role: 'do', sourceKey: 'input-request:1710000020000', inputRequest: 'Gone' })).status).toBe(409);
  });
});
