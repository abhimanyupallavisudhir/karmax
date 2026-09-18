import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';

describe('request_spend through the agent loop (SPEC §7.6)', () => {
  let h: Harness;
  let base: string;
  let token: string;
  let projectId: string;
  let cardId: string;
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const J = (r: Response) => r.json() as Promise<any>;
  const get = (p: string) => fetch(`${base}${p}`, { headers: auth() }).then(J);
  const post = (p: string, b: any) => fetch(`${base}${p}`, { method: 'POST', headers: auth(), body: JSON.stringify(b) }).then(J);
  const poll = async (id: string, stage: string) => {
    for (let i = 0; i < 60; i++) {
      const v = await get(`/api/tasks/${id}`);
      if (v?.stage === stage) return v;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${id} never reached ${stage}`);
  };

  beforeAll(async () => {
    h = await bootHarness('mock');
    const gw = await h.startGateway();
    base = gw.url;
    token = ((await (await fetch(`${base}/api/session`)).json()) as any).token;
    const repo = await h.makeRepo('spend');
    projectId = (await post('/api/projects', { name: 'Pay', config: { repos: [repo] } })).id;
    const card = await post('/api/cards', { scope: 'project', projectId, label: 'Ops', cap: 1000000 });
    cardId = card.id;
    h.store.setSettings(projectId, 'payments', { budget: null });
    await post(`/api/cards/${cardId}/fund`, { amount: 500000 }); // $5,000.00
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('grants a spend within funds and decrements the card', async () => {
    const t = await post(`/api/projects/${projectId}/tasks`, { workflow: 'just-do', params: { prompt: '@spend 2000 :: buy a widget' } });
    await poll(t.id, 'review');
    await post(`/api/tasks/${t.id}/signal`, { signal: 'confirm' });
    await poll(t.id, 'done');
    const cards = await get(`/api/cards?projectId=${projectId}`);
    expect(cards.find((c: any) => c.id === cardId).available).toBe(498000); // 500000 - 2000
    const events = await get(`/api/tasks/${t.id}/events?since=0`);
    expect(events.some((e: any) => e.type === 'spend.requested' && e.payload.status === 'granted')).toBe(true);
  });

  it('surfaces needs_funding when the card is short', async () => {
    const t = await post(`/api/projects/${projectId}/tasks`, { workflow: 'just-do', params: { prompt: '@spend 600000 :: buy something expensive' } });
    const v = await poll(t.id, 'review');
    expect(v.reviewInfo.summary).toMatch(/Funding needed/i);
    const paymentAction = v.reviewInfo.actions.findIndex((action: any) =>
      action.kind === 'payment' && action.operation === 'approve');
    expect(paymentAction).toBeGreaterThanOrEqual(0);
    const events = await get(`/api/tasks/${t.id}/events?since=0`);
    expect(events.some((e: any) => e.type === 'spend.requested' && e.payload.status === 'needs_funding')).toBe(true);
    // funds unchanged (no charge on a non-granted spend)
    const cards = await get(`/api/cards?projectId=${projectId}`);
    expect(cards.find((c: any) => c.id === cardId).available).toBe(498000);

    // The review action resolves the durable request, settles once, and retries
    // the task. The retried request_spend observes that settlement instead of
    // charging a second time.
    await post(`/api/cards/${cardId}/fund`, { amount: 102000 });
    const resolved = await post(`/api/tasks/${t.id}/review-action`, { index: paymentAction });
    expect(resolved.result.status).toBe('granted');
    const after = await get(`/api/cards?projectId=${projectId}`);
    expect(after.find((c: any) => c.id === cardId).available).toBe(0);
  });
  it('raises the task budget through HTTP and resumes the earliest payment without a separate approval', async () => {
    await post(`/api/cards/${cardId}/fund`, { amount: 10000 });
    const created = await post(`/api/projects/${projectId}/tasks`, { workflow: 'just-do', params: {
      prompt: '@spend 1500 :: budget approval', paymentPolicy: { cardIds: [cardId], budget: 1000 },
    } });
    await poll(created.id, 'review');
    const before = await get(`/api/tasks/${created.id}/payments`);
    expect(before).toMatchObject({ budget: 1000, spent: 0, cardIds: [cardId] });
    const response = await fetch(`${base}/api/tasks/${created.id}/payments`, { method: 'PUT', headers: auth(),
      body: JSON.stringify({ cardIds: [cardId], budget: 1500 }) });
    const after = await J(response);
    expect(response.status, JSON.stringify(after)).toBe(200);
    expect(after).toMatchObject({ budget: 1500, spent: 1500 });
    expect(after.released).toHaveLength(1);
    for (let i = 0; i < 60; i++) {
      const events = await get(`/api/tasks/${created.id}/events?since=0`);
      if (events.filter((event: any) => event.type === 'turn.prompt' && event.payload.role === 'do').length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const resumed = await get(`/api/tasks/${created.id}/events?since=0`);
    expect(resumed.filter((event: any) => event.type === 'turn.prompt' && event.payload.role === 'do')).toHaveLength(2);
    const saved = h.store.getTask(created.id)!;
    expect((saved.params as any).paymentPolicy.budget).toBe(1500);
    // Retrying the edit cannot charge the already-resolved request again.
    const again = await fetch(`${base}/api/tasks/${created.id}/payments`, { method: 'PUT', headers: auth(),
      body: JSON.stringify({ cardIds: [cardId], budget: 1500 }) }).then(J);
    expect(again).toMatchObject({ spent: 1500, released: [] });
  });

  it('requires payment authority, rejects invalid policies and duplicate organization names', async () => {
    const created = await post(`/api/projects/${projectId}/tasks`, { workflow: 'just-do', draft: true, params: { prompt: 'Draft payment' } });
    const actor = h.tokens.mint({ taskId: created.id, projectId, profileId: 'test', principal: `task:${created.id}`, ceiling: ['task:read', 'task:edit', 'task:create'], grantorCaps: ['task:read', 'task:edit', 'task:create'] });
    const headers = { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' };
    const readOnly = await fetch(`${base}/api/tasks/${created.id}/payments`, { headers }).then(J);
    expect(readOnly).toMatchObject({ spent: 0, canEdit: false });
    expect((await fetch(`${base}/api/tasks/${created.id}/payments`, { method: 'PUT', headers,
      body: JSON.stringify({ cardIds: [cardId], budget: 999999 }) })).status).toBe(403);
    expect((await fetch(`${base}/api/tasks/${created.id}/params`, { method: 'PATCH', headers,
      body: JSON.stringify({ params: { paymentPolicy: { cardIds: [cardId], budget: 999999 } } }) })).status).not.toBe(200);
    expect((await fetch(`${base}/api/tasks/${created.id}/payments`, { method: 'PUT', headers: auth(),
      body: JSON.stringify({ cardIds: [cardId], budget: -1 }) })).status).not.toBe(200);
    const duplicate = await post('/api/cards', { scope: 'organization', label: ' ops ', cap: 1000 });
    expect(duplicate.error).toMatch(/name.*unique/i);
    const otherProject = h.store.createProject('Another project', {});
    const otherCard = await post('/api/cards', { scope: 'project', projectId: otherProject.id, label: 'Other', cap: 1000 });
    expect((await fetch(`${base}/api/tasks/${created.id}/payments`, { method: 'PUT', headers: auth(),
      body: JSON.stringify({ cardIds: [otherCard.id], budget: 100 }) })).status).not.toBe(200);
  });

  it('captures the zero organization default on new tasks', async () => {
    const project = h.store.createProject('Zero defaults', {});
    const task = await post(`/api/projects/${project.id}/tasks`, { workflow: 'just-do', draft: true, params: { prompt: 'Default budget' } });
    expect(task.params.paymentPolicy.budget).toBe(0);
  });

  it('captures inherited defaults and preserves them when a draft is replaced', async () => {
    h.store.setSettings(projectId, 'payments', { cardIds: [cardId], budget: 4500 });
    const task = await post(`/api/projects/${projectId}/tasks`, { workflow: 'just-do', draft: true, params: { prompt: 'Inherited payments' } });
    expect(task.params.paymentPolicy).toEqual({ cardIds: [cardId], budget: 4500 });
    h.store.setSettings(projectId, 'payments', { cardIds: [], budget: 0 });
    const response = await fetch(`${base}/api/tasks/${task.id}/params`, { method: 'PATCH', headers: auth(),
      body: JSON.stringify({ params: { prompt: 'Edited prompt' }, replace: true }) });
    expect(response.status).toBe(200);
    expect(await get(`/api/tasks/${task.id}/payments`)).toMatchObject({ cardIds: [cardId], budget: 4500, spent: 0 });
    const next = await post(`/api/projects/${projectId}/tasks`, { workflow: 'just-do', draft: true, params: { prompt: 'New defaults' } });
    expect(next.params.paymentPolicy).toEqual({ cardIds: [], budget: 0 });
  });

});
