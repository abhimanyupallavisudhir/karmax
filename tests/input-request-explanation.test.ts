import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
// Keep the real explanation client: with isolate:false, a module mock cannot
// replace the client captured by a Gateway imported by an earlier test file.
describe('input request explanations over HTTP', () => {
  let home: string;
  let store: Store;
  let base: string;
  let token: string;
  let taskId: string;
  let view: any;
  let close: () => Promise<void>;
  let modelServer: http.Server;
  let tokens: TokenAuthority;
  let projectId: string;
  const modelRequests: any[] = [];
  const sourceKey = 'input-request:1710000010000';
  const post = (body: object) => fetch(`${base}/api/tasks/${taskId}/explanations`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-input-explanation-'));
    store = (await Store.create(':memory:'));
    const project = (await store.createProject('Input explanations'));
    modelServer = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      modelRequests.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Pick where to publish.' } }] }));
    });
    await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
    const address = modelServer.address() as { port: number };
    (await store.setSettings(project.id, 'explanation', { endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions` }));
    taskId = (await store.createTask({ projectId: project.id, title: 'Choose a target',
      workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'Publish my update' } })).id;
    view = { status: 'waiting', updatedAt: 1710000010000,
      waitingFor: { kind: 'human', detail: 'Choose a deployment target.' },
      actions: [{ name: 'followUp', roles: ['do'], enabled: true }] };
    tokens = new TokenAuthority();
    projectId = project.id;
    const gateway = (await Gateway.create({ store, bus: new KarmaxBus(), tokens,
      contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any,
      api: { taskConversation: async () => ({ messages: [{ role: 'user', text: 'Publish my update', ts: 1 }] }),
        getTaskView: async () => view } as any,
      taskQueue: 'test', staticDir: home, worlds: new WorldRegistry(),
      agentInfo: { provider: 'mock', reason: 'test' },
    } as any));
    vi.spyOn(gateway as any, 'explanationApiKey').mockReturnValue('test-only-key');
    const running = await gateway.listen(await findFreePortFrom(48_400));
    base = running.url;
    close = running.close;
    token = (await (await fetch(`${base}/api/session`)).json() as any).token;
  });

  afterAll(async () => {
    await close?.();
    if (modelServer) await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
    (await store?.close());
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('rejects stale text and the wrong conversation before calling the model', async () => {
    for (const body of [
      { role: 'do', sourceKey, inputRequest: 'Different question' },
      { role: 'merge', sourceKey, inputRequest: view.waitingFor.detail },
      { role: 'do', sourceKey: 'input-request:1', inputRequest: view.waitingFor.detail },
    ]) expect((await post(body)).status).toBe(409);
    expect(modelRequests).toHaveLength(0);
  });

  it('lets only a settings manager point an explanation at another endpoint with the organization\'s key', async () => {
    const received: string[] = [];
    const other = http.createServer((req, res) => { received.push(String(req.headers.authorization)); res.end('{}'); });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    try {
      const agent = (await tokens.mint({ taskId, profileId: 'do', role: 'do', principal: 'user:reader', projectId,
        ceiling: ['task:conversation:read', 'task:conversation:message'],
        grantorCaps: ['task:conversation:read', 'task:conversation:message'] })).token;
      const response = await fetch(`${base}/api/tasks/${taskId}/explanations`, {
        method: 'POST', headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'do', sourceKey, inputRequest: view.waitingFor.detail, settings: {
          endpoint: `http://127.0.0.1:${(other.address() as { port: number }).port}/v1/chat/completions`,
          model: 'any', prompt: 'Explain.' } }),
      });
      expect(response.status).toBe(403);
      expect(received).toEqual([]);
    } finally { await new Promise<void>((resolve) => other.close(() => resolve())); }
  });

  it('explains the authoritative prompt and persists its source through resolution', async () => {
    const response = await post({ role: 'do', sourceKey, inputRequest: view.waitingFor.detail });
    expect(response.status).toBe(200);
    const event = await response.json() as any;
    expect(event.payload).toMatchObject({ sourceKey, text: 'Pick where to publish.',
      sourceRequest: { text: 'Choose a deployment target.', ts: view.updatedAt } });
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0].url).toBe('/v1/chat/completions');
    expect(modelRequests[0].body.messages[1].content).toContain('Choose a deployment target.');
    expect(modelRequests[0].body.messages[1].content).toContain('Publish my update');
    view = { status: 'active', updatedAt: 1710000020000, actions: [] };
    const reloaded = await fetch(`${base}/api/tasks/${taskId}/explanations`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await reloaded.json() as any[])[0].payload.sourceRequest).toEqual(event.payload.sourceRequest);
    // The model picker can also explain a historical prompt again.
    expect((await post({ role: 'do', sourceKey })).status).toBe(200);
    expect(modelRequests).toHaveLength(2);
    expect((await post({ role: 'do', sourceKey: 'input-request:1710000020000', inputRequest: 'Gone' })).status).toBe(409);
  });
});
