import { expect, it, vi } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';

it('routes activity in a batch without hydrating task conversations (GW-6)', async () => {
  const h = await stubGateway();
  try {
    const project = await h.store.createProject('Activity Feed');
    const task = await h.store.createTask({ projectId: project.id, title: 'History', workflow: 'just-do', workflowVersion: '1', params: {} });
    for (let n = 0; n < 20; n++) await h.store.appendEvent({ taskId: task.id, type: 'fixture', ts: Date.now(), payload: {} });
    const token = (await h.tokens.mintPrincipal('user:test', ['*'], project.id)).token;
    const hydrate = vi.spyOn(h.store, 'getTask');
    const response = await fetch(`${h.base}/api/activity`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(20);
    expect(hydrate).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('shares a short timing setting cache across gateway requests (GW-12)', async () => {
  const h = await stubGateway();
  try {
    const read = vi.spyOn(h.store, 'getSettings');
    for (let n = 0; n < 12; n++) await fetch(`${h.base}/api/login`, { method: 'POST', body: '{}' });
    expect(read.mock.calls.filter(([scope, key]) => scope === 'global' && key === 'timing').length).toBeLessThanOrEqual(1);
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    const changed = await fetch(`${h.base}/api/settings/global/timing`, { method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ values: { enabled: true } }) });
    expect(changed.status).toBe(200);
    expect((h.gateway as any).timingValue).toBe(true);
  } finally { await h.close(); }
});
