import { afterEach, expect, it, vi } from 'vitest';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import * as credentialFill from '../src/autonomy/fill.js';
import * as worldFill from '../src/autonomy/world-fill.js';
import * as taskBrowser from '../src/autonomy/task-browser.js';

afterEach(() => { vi.restoreAllMocks(); });

// AU-14: the gateway types a credential into the calling task's own browser —
// in its world when its agent runs there, else the one its agent launched on
// this host — and the agent has no say in which.
it.each([
  ['local', { worldPath: '/tmp/fill-world', branch: 'karmax/fill' }, 'http://127.0.0.1:45999'],
  ['container', { world: { kind: 'container', id: 'x', root: '/tmp/fill-world', branch: 'karmax/fill', base: 'main' } }, 'http://127.0.0.1:9222'],
] as const)('fills the %s task’s own browser', async (_name, placement, expected) => {
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Fill routing');
    const task = await store.createTask({ projectId: project.id, title: 'Fill', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
    await store.saveView(task.id, { taskId: task.id, title: 'Fill', workflow: 'just-do', stage: 'do', status: 'active', ...placement } as any);
    vi.spyOn(taskBrowser, 'localTaskBrowserUrl').mockImplementation((id) => { expect(id).toBe(task.id); return 'http://127.0.0.1:45999'; });
    const local = vi.spyOn(credentialFill, 'fillViaCdp').mockResolvedValue({ origin: 'https://example.com' });
    const inWorld = vi.spyOn(worldFill, 'fillInWorld').mockResolvedValue({ origin: 'https://example.com' });
    const worlds = new WorldRegistry();
    vi.spyOn(worlds, 'open').mockResolvedValue({} as any);
    const gateway = Object.assign(Object.create(Gateway.prototype), { deps: { store, worlds } });
    await gateway.fillCredential(task.id, { selector: '#pw', expectDomains: ['example.com'], resolveText: () => 'pw', cdpUrl: 'http://127.0.0.1:1' });
    const [call] = [...local.mock.calls.map(([args]) => args), ...inWorld.mock.calls.map(([, args]) => args)];
    expect(call?.cdpUrl).toBe(expected);
  } finally { await store.close(); }
});
