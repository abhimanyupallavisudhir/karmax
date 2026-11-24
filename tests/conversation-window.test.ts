import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message, TaskView } from '../src/domain/types.js';
import { conversationSlice, windowedConversation } from '../src/platform/conversation-window.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Gateway } from '../src/gateway/server.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';

// A long task's page reads the newest messages of its conversation, then
// earlier ones as the reader asks (wiki ops/performance-history, pramana#137:
// 940 messages made every open and every refresh carry 2.3 MB, the Do
// transcript twice).

const message = (i: number, role: Message['role'] = i % 2 ? 'agent' : 'user'): Message =>
  ({ id: `m${i}`, ts: 1_790_000_000_000 + i, role, text: `message ${i}` }) as Message;
const conversation = (n: number) => Array.from({ length: n }, (_, i) => message(i));

describe('conversation window', () => {
  it('keeps the newest messages, says where they start, and sends the Do transcript once', () => {
    const messages = conversation(10);
    const resolve = [message(0, 'user'), message(1, 'agent'), message(2, 'agent')];
    const view = { messages, transcripts: [{ role: 'do', label: 'Do agent', messages }, { role: 'resolve', label: 'Resolve agent', messages: resolve }] };
    const windowed = windowedConversation(view, 4);
    expect(windowed.messages!.map((m) => m.id)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(windowed.transcripts).toEqual([{ role: 'do', label: 'Do agent', sameAsMessages: true },
      { role: 'resolve', label: 'Resolve agent', messages: resolve }]);
    expect(windowed.conversationWindow.roles).toEqual({ do: { from: 6, total: 10 }, resolve: { from: 0, total: 3 } });
    expect(windowed.conversationWindow.revision).toMatch(/^[\w-]{10,}$/);
    // Smaller than all of it.
    expect(windowedConversation(view, 100).conversationWindow.roles.do).toEqual({ from: 0, total: 10 });
  });

  it('names a revision that changes with a new or changed message in the window, and leaves out what the caller has', () => {
    const messages = conversation(10);
    const { revision } = windowedConversation({ messages, transcripts: [{ role: 'do', label: 'Do agent', messages }] }, 4).conversationWindow;
    expect(windowedConversation({ messages: conversation(10), transcripts: [{ role: 'do', label: 'Do agent', messages }] }, 4).conversationWindow.revision).toBe(revision);
    expect(windowedConversation({ messages: conversation(11) }, 4).conversationWindow.revision).not.toBe(revision);
    const edited = conversation(10);
    edited[9] = { ...edited[9]!, to: ['user:ada'] } as Message;
    expect(windowedConversation({ messages: edited }, 4).conversationWindow.revision).not.toBe(revision);
    // A window of another size is another revision.
    expect(windowedConversation({ messages }, 5).conversationWindow.revision).not.toBe(revision);

    const unchanged = windowedConversation({ messages, transcripts: [{ role: 'do', label: 'Do agent', messages }] }, 4, revision);
    expect(unchanged).not.toHaveProperty('messages');
    expect(unchanged).not.toHaveProperty('transcripts');
    expect(unchanged.conversationWindow).toEqual({ revision, unchanged: true, roles: { do: { from: 6, total: 10 } } });
  });

  it('slices earlier messages by index, for any transcript', () => {
    const messages = conversation(10);
    const resolve = conversation(3);
    const view = { messages, transcripts: [{ role: 'do', label: 'Do agent', messages }, { role: 'resolve', label: 'Resolve agent', messages: resolve }] };
    expect(conversationSlice(view, 'do', 6, 4)).toEqual({ role: 'do', from: 2, total: 10, messages: messages.slice(2, 6) });
    expect(conversationSlice(view, 'do', 3, 50)).toEqual({ role: 'do', from: 0, total: 10, messages: messages.slice(0, 3) });
    expect(conversationSlice(view, 'resolve', 3, 2)).toEqual({ role: 'resolve', from: 1, total: 3, messages: resolve.slice(1, 3) });
    expect(conversationSlice(view, 'merge', 3, 2)).toEqual({ role: 'merge', from: 0, total: 0, messages: [] });
  });
});

describe('the task view route', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  let fixtures = 0;
  async function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-conversation-window-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = await Store.create(':memory:');
    cleanups.push(() => store.close());
    const project = await store.createProject('Long task');
    const tokens = new TokenAuthority(store);
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
    const gateway = await Gateway.create({ api, store, tokens, client, worlds, taskQueue: 'test',
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), staticDir: 'web',
      agentInfo: { provider: 'mock', reason: 'conversation window test' } });
    const server = await gateway.listen(await findFreePortFrom(49_900 + 10 * fixtures++));
    cleanups.push(() => server.close());
    const task = await store.createTask({ projectId: project.id, title: 'Long', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'go' } });
    const messages = conversation(12);
    await store.saveView(task.id, { taskId: task.id, title: 'Long', workflow: 'software-dev', stage: 'do', status: 'active', messages,
      transcripts: [{ role: 'do', label: 'Do agent', messages }], actions: [], state: {}, updatedAt: 1 } as TaskView);
    const reader = (await tokens.mintPrincipal('user:ada', ['task:read', 'project:read', 'organization:read'], project.id)).token;
    const get = async (route: string, token = reader) => {
      const response = await fetch(`${server.url}${route}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() as any };
    };
    return { store, task, messages, get, tokens, project };
  }

  it('serves the whole conversation by default, and a window on request', async () => {
    const f = await fixture();
    const full = await f.get(`/api/tasks/${f.task.id}`);
    expect(full.status).toBe(200);
    expect(full.body.messages).toHaveLength(12);
    expect(full.body.transcripts[0].messages).toHaveLength(12);
    expect(full.body).not.toHaveProperty('conversationWindow');

    const windowed = await f.get(`/api/tasks/${f.task.id}?messages=5`);
    expect(windowed.body.messages.map((m: Message) => m.id)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
    expect(windowed.body.transcripts).toEqual([{ role: 'do', label: 'Do agent', sameAsMessages: true }]);
    expect(windowed.body.conversationWindow.roles).toEqual({ do: { from: 7, total: 12 } });
    expect(windowed.body.stage).toBe('do');

    const again = await f.get(`/api/tasks/${f.task.id}?messages=5&known=${windowed.body.conversationWindow.revision}`);
    expect(again.body).not.toHaveProperty('messages');
    expect(again.body.conversationWindow.unchanged).toBe(true);
    expect(again.body.stage).toBe('do');

    // A new message: the window moves and says so.
    const grown = [...f.messages, message(12)];
    await f.store.saveView(f.task.id, { taskId: f.task.id, title: 'Long', workflow: 'software-dev', stage: 'do', status: 'active', messages: grown,
      transcripts: [{ role: 'do', label: 'Do agent', messages: grown }], actions: [], state: {}, updatedAt: 2 } as TaskView);
    const moved = await f.get(`/api/tasks/${f.task.id}?messages=5&known=${windowed.body.conversationWindow.revision}`);
    expect(moved.body.messages.map((m: Message) => m.id)).toEqual(['m8', 'm9', 'm10', 'm11', 'm12']);
    expect(moved.body.conversationWindow.roles.do).toEqual({ from: 8, total: 13 });
  });

  it('serves earlier messages to those who may read the task', async () => {
    const f = await fixture();
    const page = await f.get(`/api/tasks/${f.task.id}/transcript?role=do&before=7&limit=3`);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ role: 'do', from: 4, total: 12, messages: f.messages.slice(4, 7) });
    expect((await f.get(`/api/tasks/${f.task.id}/transcript?before=7&limit=0`)).status).toBe(400);
    const outsider = (await f.tokens.mintPrincipal('user:eve', ['project:read'], f.project.id)).token;
    expect((await f.get(`/api/tasks/${f.task.id}/transcript?role=do&before=7&limit=3`, outsider)).status).toBe(403);
  });
});
