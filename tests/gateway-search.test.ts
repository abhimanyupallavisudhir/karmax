import { describe, it, expect } from 'vitest';
import { Gateway } from '../src/gateway/server.js';

describe('cross-project console search (RQ-14/UI-18)', () => {
  it('authorizes each project before searching and bounds each response', async () => {
    const gateway = Object.create(Gateway.prototype) as any;
    const searched: string[] = [];
    gateway.auth = async (_req: unknown, projectId: string) => ({ apiToken: projectId });
    gateway.deps = {
      store: { listProjects: async () => [{ id: 'allowed' }, { id: 'foreign' }, { id: 'no-discovery' }] },
      tokens: { check: async (token: string, capability: string) => ({ ok: token === 'allowed' || (token === 'no-discovery' && capability === 'task:read') }) },
      api: { searchTasks: async (_token: string, id: string) => {
        searched.push(id); return { tasks: Array.from({ length: 150 }, (_, i) => ({ id: String(i) })), total: 150 };
      } },
    };
    const result = await gateway.searchProjects({}, { destroyed: false }, 'hello');
    expect(searched).toEqual(['allowed']);
    expect(result).toEqual([{ projectId: 'allowed', tasks: expect.any(Array), total: 150 }]);
    expect(result[0].tasks).toHaveLength(100);
    expect(await gateway.searchProjects({}, { destroyed: true }, 'hello')).toEqual([]);
    expect(await gateway.searchProjects({}, { destroyed: false }, 'a')).toEqual([]);
  });
  it('does not disguise a search failure as an empty result', async () => {
    const gateway = Object.create(Gateway.prototype) as any;
    gateway.auth = async () => ({ apiToken: 'allowed' });
    gateway.deps = { store: { listProjects: async () => [{ id: 'p' }] }, tokens: { check: async () => ({ ok: true }) },
      api: { searchTasks: async () => { throw new Error('database unavailable'); } } };
    await expect(gateway.searchProjects({}, { destroyed: false }, 'hello')).rejects.toThrow('database unavailable');
  });
});
