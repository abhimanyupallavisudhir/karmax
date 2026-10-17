import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

// A pending request the browser can only learn about by refetching is the bug
// behind andhbhakt.com#1: get_credential/fill_credential raised the request,
// but nothing announced it, so neither the conversation nor the inbox showed it
// until the page was reloaded. Every way of raising one must announce it once.
describe('credential approval requests are announced however they are raised', () => {
  it('records credential.approval-requested for request_credential, get_credential, fill_credential and use_session', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-approval-announce-'));
    const store = await Store.create(':memory:');
    let close: (() => Promise<void>) | undefined;
    try {
      const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
      const vault = new VaultItems(store, broker, home);
      const ask = { use: 'ask', reveal: 'ask' } as const;
      const revealed = await vault.save({ type: 'api-key', label: 'Reveal me', policy: ask, secrets: { secret: 'sk-1' } });
      const filled = await vault.save({ type: 'login', label: 'Fill me', domains: ['example.com'], username: 'a', policy: ask, secrets: { password: 'pw' } });
      const asked = await vault.save({ type: 'api-key', label: 'Ask for me', policy: ask, secrets: { secret: 'sk-2' } });
      const session = await vault.save({ type: 'session', label: 'Session', domains: ['example.com'], policy: ask,
        secrets: { session: JSON.stringify({ version: 1, capturedAt: 1, cookies: [], storage: [] }) } } as any);
      const project = await store.createProject('Announcements');
      await store.setOrganizationMembership('org_personal', 'u_creator', 'member');
      const task = await store.createTask({ projectId: project.id, title: 'Ask', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' },
        createdBy: { kind: 'user', userId: 'u_creator' } });
      const bus = new KarmaxBus();
      store.onEventRecorded((event) => bus.emit(event));
      const heard: Array<{ type: string; payload: any }> = [];
      bus.onTask(task.id, (event) => { heard.push(event as any); });
      const tokens = new TokenAuthority(store);
      const gateway = await Gateway.create({ store, broker, bus, tokens,
        contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any, api: {} as any,
        taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'announcement test' }, worlds: new WorldRegistry(),
      } as any);
      const running = await gateway.listen(await findFreePortFrom(48_700));
      close = running.close;
      const agent = await tokens.mint({ taskId: task.id, projectId: project.id, organizationId: 'org_personal', principal: 'task:test',
        profileId: 'do', ceiling: ['credential:read', 'use-credential:*'], grantorCaps: ['credential:read'] });
      const post = async (route: string, body: unknown) => (await (await fetch(`${running.url}${route}`, {
        method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })).json()) as any;
      const announced = async () => (await store.eventsSince(task.id, 0))
        .filter((event) => event.type === 'credential.approval-requested').map((event) => event.payload as any);

      const reveal = await post('/api/vault/resolve', { itemId: revealed.id, why: 'deploy' });
      const fill = await post('/api/vault/fill', { itemId: filled.id, field: 'password', selector: '#pw' });
      const request = await post('/api/vault/requests', { itemId: asked.id, why: 'need it', urgency: 'critical' });
      const restore = await post('/api/vault/session/use', { itemId: session.id });
      for (const result of [reveal, fill, request, restore]) expect(result).toMatchObject({ status: 'needs_approval', requestId: expect.any(String) });

      expect(await announced()).toEqual([
        { requestId: reveal.requestId, status: 'approval-needed', mode: 'reveal', kind: 'access', itemId: revealed.id, why: 'deploy' },
        { requestId: fill.requestId, status: 'approval-needed', mode: 'use', kind: 'access', itemId: filled.id },
        { requestId: request.requestId, status: 'approval-needed', mode: 'use', kind: 'access', itemId: asked.id, why: 'need it', urgency: 'critical' },
        { requestId: restore.requestId, status: 'approval-needed', mode: 'use', kind: 'access', itemId: session.id },
      ]);
      // Live: the bus carried each one to the browser's socket.
      expect(heard.filter((event) => event.type === 'credential.approval-requested').map((event) => event.payload.requestId))
        .toEqual([reveal.requestId, fill.requestId, request.requestId, restore.requestId]);
      // The inbox (the bell, notifications) learns it from the same event.
      expect((await store.listInbox('u_creator', 'org_personal')).filter((item) => item.taskId === task.id && item.kind === 'approval-requested'))
        .toHaveLength(1);

      // A retry joins the pending request without announcing it again.
      expect(await post('/api/vault/resolve', { itemId: revealed.id })).toMatchObject({ requestId: reveal.requestId });
      expect(await post('/api/vault/requests', { itemId: revealed.id, mode: 'reveal' })).toMatchObject({ requestId: reveal.requestId });
      expect(await announced()).toHaveLength(4);
    } finally {
      await close?.();
      await store.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('announces a request raised directly through the vault service', async () => {
    const store = await Store.create(':memory:');
    try {
      const vault = new VaultItems(store, undefined, os.tmpdir());
      const project = await store.createProject('Direct');
      const task = await store.createTask({ projectId: project.id, title: 'Direct', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
      const missing = await vault.request({ taskId: task.id, caps: [], domain: 'cloudflare.com', why: 'DNS' });
      expect(missing).toMatchObject({ status: 'not_in_vault', requestId: expect.any(String) });
      expect((await store.eventsSince(task.id, 0)).filter((event) => event.type === 'credential.approval-requested').map((event) => event.payload))
        .toEqual([{ requestId: missing.requestId, status: 'approval-needed', mode: 'use', kind: 'access', domain: 'cloudflare.com', why: 'DNS' }]);
      // Another organization's vault never announces onto this task.
      const foreign = new VaultItems(store, undefined, os.tmpdir(), 'org_other');
      await foreign.request({ taskId: task.id, caps: [], domain: 'example.org' });
      expect((await store.eventsSince(task.id, 0)).filter((event) => event.type === 'credential.approval-requested')).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});
