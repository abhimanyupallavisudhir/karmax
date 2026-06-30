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
    const events = await get(`/api/tasks/${t.id}/events?since=0`);
    expect(events.some((e: any) => e.type === 'spend.requested' && e.payload.status === 'needs_funding')).toBe(true);
    // funds unchanged (no charge on a non-granted spend)
    const cards = await get(`/api/cards?projectId=${projectId}`);
    expect(cards.find((c: any) => c.id === cardId).available).toBe(498000);
  });
});
