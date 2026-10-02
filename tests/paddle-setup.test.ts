import { describe, expect, it, vi } from 'vitest';
import { provisionPaddle } from '../src/billing/paddle-setup.js';
import { PADDLE_WEBHOOK_EVENTS, type PaddleRuntimeConfig } from '../src/billing/paddle.js';

function fixture() {
  const records = { products: [] as any[], prices: [] as any[], 'client-tokens': [] as any[], 'notification-settings': [] as any[] };
  let serial = 0;
  const fetcher = vi.fn(async (url: any, init: any) => {
    const u = new URL(url), [kind, id] = u.pathname.slice(1).split('/');
    const collection = records[kind as keyof typeof records];
    if (!collection) throw new Error(`unexpected fixture endpoint ${u.pathname}`);
    const body = init.body ? JSON.parse(init.body) : {};
    if (init.method === 'GET') return Response.json({ data: id ? collection.find(v => v.id === id)
      : collection.filter(v => !u.searchParams.has('product_id') || v.product_id === u.searchParams.get('product_id')),
      meta: { pagination: { has_more: false } } });
    if (init.method === 'PATCH') {
      const item = collection.find(v => v.id === id);
      Object.assign(item, body);
      return Response.json({ data: item });
    }
    const item = { ...body, id: `id_${++serial}`, status: 'active',
      ...(kind === 'client-tokens' ? { token: 'test_public' } : {}),
      ...(kind === 'notification-settings' ? { endpoint_secret_key: 'pdl_ntfset_private' } : {}) };
    collection.push(item);
    return Response.json({ data: item });
  });
  return { records, fetcher };
}

describe('Paddle automated setup', () => {
  it('creates then reuses the exact monthly catalog, client token and real-event webhook', async () => {
    const { records, fetcher } = fixture();
    const config: PaddleRuntimeConfig = { environment: 'sandbox', apiKey: 'pdl_sdbx_apikey_secret' };
    const save = vi.fn(async (patch) => { Object.assign(config, patch); });
    const result = await provisionPaddle(config, 'https://tavya.test', 'Tavya', save, fetcher);
    expect(result.webhookUrl).toBe('https://tavya.test/api/subscriptions/paddle/webhook');
    expect(JSON.stringify(result)).not.toContain('pdl_ntfset_private');
    expect(records.products).toHaveLength(3);
    expect(records.prices.map(p => p.unit_price)).toEqual([
      { amount: '900', currency_code: 'USD' }, { amount: '1900', currency_code: 'USD' }, { amount: '500', currency_code: 'USD' },
      { amount: '400', currency_code: 'USD' },
    ]);
    const pack = records.prices.at(-1);
    expect(pack).toMatchObject({ product_id: config.storagePackProductId, quantity: { minimum: 1, maximum: 999999 },
      billing_cycle: { interval: 'month', frequency: 1 }, custom_data: { karmax_billing_role: 'storagePackPriceId' } });
    expect(config.storagePackPriceId).toBe(pack.id);
    expect(records.products.at(-1)).toMatchObject({ tax_category: 'saas', custom_data: { karmax_billing_role: 'storage' } });
    expect(records['notification-settings'][0]).toMatchObject({ traffic_source: 'platform', subscribed_events: [...PADDLE_WEBHOOK_EVENTS] });
    expect(config.webhookSecret).toBe('pdl_ntfset_private');
    await provisionPaddle(config, 'https://tavya.test', 'Tavya', save, fetcher);
    expect(records.products).toHaveLength(3);
    expect(records.prices).toHaveLength(4);
    expect(records['client-tokens']).toHaveLength(1);
    expect(records['notification-settings']).toHaveLength(1);
  });
  it('rejects an existing price with a wrong amount instead of silently changing it', async () => {
    const { records, fetcher } = fixture();
    const config: PaddleRuntimeConfig = { environment: 'sandbox', apiKey: 'secret' };
    const save = async (patch: Partial<PaddleRuntimeConfig>) => { Object.assign(config, patch); };
    await provisionPaddle(config, 'https://tavya.test', 'Tavya', save, fetcher);
    records.prices[0].unit_price.amount = '90';
    await expect(provisionPaddle(config, 'https://tavya.test', 'Tavya', save, fetcher)).rejects.toThrow(/published/);
    expect(records.prices).toHaveLength(4);
  });
  it('adds the storage pack to a catalog provisioned before packs existed', async () => {
    const { records, fetcher } = fixture();
    const config: PaddleRuntimeConfig = { environment: 'sandbox', apiKey: 'secret' };
    const save = async (patch: Partial<PaddleRuntimeConfig>) => { Object.assign(config, patch); };
    await provisionPaddle(config, 'https://tavya.test', 'Tavya', save, fetcher);
    records.products.pop(); records.prices.pop();
    delete config.storagePackProductId; delete config.storagePackPriceId;
    await provisionPaddle(config, 'https://tavya.test', 'Tavya', save, fetcher);
    expect(records.products).toHaveLength(3);
    expect(records.prices).toHaveLength(4);
    expect(fetcher.mock.calls.filter(([, init]: any) => init.method === 'POST').map(([url]: any) => new URL(url).pathname))
      .toEqual(['/products', '/products', '/prices', '/prices', '/prices', '/products', '/prices', '/client-tokens',
        '/notification-settings', '/products', '/prices']);
  });
  it('never sends an API key to an untrusted pagination URL', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [], meta: { pagination: { has_more: true, next: 'https://attacker.test/steal' } } }));
    await expect(provisionPaddle({ apiKey: 'secret' }, 'https://tavya.test', 'Tavya', async () => {}, fetcher)).rejects.toThrow(/pagination/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
