import './helpers/isolated-home.js';
import { afterEach, describe, expect, it } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { WorldRegistry } from '../src/world/registry.js';

/**
 * GET /api/tasks/:id/conversation (the get_conversation tool, the share
 * dialog's preview, the .jsonl download) of a task that has not begun: a
 * draft (a co-ordinator's proposal), a task armed on its trigger, a repeatable
 * series. No agent has said or read anything yet, so its conversation is
 * empty — not a server error (tavya-error 748a9a77ba9f95d4, 2026-11-26).
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function fixture() {
  const store = await Store.create(':memory:');
  await store.claimPersonalOrganization('test');
  const project = await store.createProject('Acme');
  const tokens = new TokenAuthority(store);
  // No execution exists for any of these tasks: a live query would fail.
  const client = { workflow: { getHandle: () => ({ query: async () => { throw new Error('workflow not found'); } }) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, worlds: new WorldRegistry() });
  const h = await stubGateway({ store, tokens, api, client });
  closers.push(h.close);
  const { token } = await tokens.mintPrincipal('user:test', ['*'], project.id);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${h.base}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json() as any };
  };
  const get = (path: string) => call('GET', path);
  const task = (params: Record<string, unknown>) => store.createTask({ projectId: project.id, title: 'X',
    workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'Draft the launch post', ...params } });
  return { get, call, task };
}

describe('the conversation of a task that has not begun', () => {
  it.each([
    ['a draft', { draft: true }],
    ['a task armed on its trigger', { triggers: [{ kind: 'event', type: 'ila.entry', recurring: true }], triggerState: 'armed' }],
    ['a repeatable series', { repeatable: true }],
  ])('is empty for %s', async (_label, params) => {
    const f = await fixture();
    const created = await f.task(params);
    for (const role of ['do', 'review']) {
      const read = await f.get(`/api/tasks/${created.id}/conversation?role=${role}`);
      expect(read, JSON.stringify(read.json)).toEqual({ status: 200, json: { role, messages: [] } });
    }
    // Nothing to download either: the caller's 404, not tavya's 500.
    expect((await f.get(`/api/tasks/${created.id}/conversation.jsonl`)).status).toBe(404);
    // Nor an agent to fork: the caller's 409, not tavya's 500.
    const fork = await f.call('POST', `/api/tasks/${created.id}/fork-agent`, { message: 'Carry on' });
    expect(fork.status, JSON.stringify(fork.json)).toBe(409);
  });

  it('is a 404 for a task that does not exist', async () => {
    const f = await fixture();
    const read = await f.get('/api/tasks/task_nonexistent/conversation');
    expect(read.status, JSON.stringify(read.json)).toBe(404);
  });
});
