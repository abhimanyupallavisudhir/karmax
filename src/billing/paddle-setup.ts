import { HOSTED_PLANS, STORAGE_PACK } from '../domain/entitlements.js';
import { PADDLE_WEBHOOK_EVENTS, type PaddleRuntimeConfig } from './paddle.js';

/** Re-runnable provisioning: discover existing remote objects before creating
 * anything, checkpoint each result, and never retry an uncertain write here. */
export async function provisionPaddle(config: PaddleRuntimeConfig, publicUrl: string, siteName: string,
  save: (patch: Partial<PaddleRuntimeConfig>) => Promise<void>, fetcher: typeof fetch = fetch) {
  if (!config.apiKey) throw new Error('save a Paddle API key first');
  const origin = new URL(publicUrl).origin;
  if (!origin.startsWith('https://')) throw new Error('Paddle requires a public HTTPS checkout domain');
  const base = config.environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const url = new URL(path, base);
    if (url.origin !== base) throw new Error('invalid Paddle pagination URL');
    const response = await fetcher(url.toString(), { method, headers: {
      Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Paddle-Version': '1',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const payload = await response.json() as any;
    if (!response.ok) throw new Error(`Paddle setup failed (${response.status}, ${payload.error?.code ?? 'unknown_error'}). Check the account before retrying.`);
    return payload;
  };
  const list = async (path: string) => {
    const records: any[] = [];
    let next: string | null = path;
    const visited = new Set<string>();
    while (next) {
      if (visited.has(next) || visited.size >= 100) throw new Error('Paddle catalog pagination is incomplete');
      visited.add(next);
      const page = await request(next);
      if (!Array.isArray(page.data)) throw new Error('Paddle returned an invalid catalog');
      records.push(...page.data);
      next = page.meta?.pagination?.has_more ? page.meta.pagination.next : null;
      if (page.meta?.pagination?.has_more && !next) throw new Error('Paddle omitted the next catalog page');
    }
    return records;
  };
  const one = (matches: any[], description: string) => {
    if (matches.length > 1) throw new Error(`multiple Paddle ${description} match; reconcile them before continuing`);
    return matches[0];
  };
  const products = await list('/products?status=active&per_page=200');
  const product = async (role: 'individual' | 'team' | 'storage',
    key: 'individualProductId' | 'teamProductId' | 'storagePackProductId', name: string) => {
    const configured = config[key];
    let found = configured ? products.find((p) => p.id === configured)
      : one(products.filter((p) => p.custom_data?.karmax_billing_role === role && p.custom_data?.karmax_origin === origin), `${role} products`);
    if (configured && !found) throw new Error(`configured Paddle ${role} product is unavailable`);
    if (!found) found = (await request('/products', 'POST', { name: `${siteName} ${name}`,
      tax_category: 'saas', custom_data: { karmax_billing_role: role, karmax_origin: origin } })).data;
    if (found.tax_category !== 'saas') throw new Error(`Paddle ${role} product must use the SaaS tax category`);
    await save({ [key]: found.id });
    return found.id as string;
  };
  const individualProductId = await product('individual', 'individualProductId', HOSTED_PLANS.individual.name);
  const teamProductId = await product('team', 'teamProductId', HOSTED_PLANS.team.name);
  const price = async (role: 'individualPriceId' | 'teamBasePriceId' | 'teamSeatPriceId' | 'storagePackPriceId',
    productId: string, amount: number, name: string) => {
    const prices = await list(`/prices?product_id=${encodeURIComponent(productId)}&status=active&per_page=200`);
    let found = config[role] ? prices.find((p) => p.id === config[role])
      : one(prices.filter((p) => p.custom_data?.karmax_billing_role === role && p.custom_data?.karmax_origin === origin), `${role} prices`);
    if (config[role] && !found) throw new Error(`configured Paddle ${role} is unavailable`);
    if (!found) found = (await request('/prices', 'POST', { product_id: productId, description: name, name,
      billing_cycle: { interval: 'month', frequency: 1 }, trial_period: null, tax_mode: 'external',
      unit_price: { amount: String(amount), currency_code: 'USD' },
      quantity: { minimum: 1, maximum: role === 'teamSeatPriceId' || role === 'storagePackPriceId' ? 999999 : 1 },
      custom_data: { karmax_billing_role: role, karmax_origin: origin } })).data;
    if (found.product_id !== productId || found.unit_price?.amount !== String(amount) || found.unit_price?.currency_code !== 'USD'
      || found.billing_cycle?.interval !== 'month' || found.billing_cycle?.frequency !== 1 || found.trial_period
      || found.tax_mode !== 'external') throw new Error(`Paddle ${role} does not match the published monthly USD plan`);
    await save({ [role]: found.id });
  };
  await price('individualPriceId', individualProductId, HOSTED_PLANS.individual.monthlyBasePriceCents, 'Individual monthly');
  await price('teamBasePriceId', teamProductId, HOSTED_PLANS.team.monthlyBasePriceCents, 'Team monthly');
  await price('teamSeatPriceId', teamProductId, HOSTED_PLANS.team.monthlyAdditionalActiveUserPriceCents, 'Additional active user monthly');
  const pack = `${STORAGE_PACK.bytes / 1024 ** 3} GB storage pack`;
  await price('storagePackPriceId', await product('storage', 'storagePackProductId', 'storage pack'),
    STORAGE_PACK.monthlyPriceCents, `${pack} monthly`);
  if (!config.clientToken) {
    const name = `${origin} subscription checkout`;
    let token = one((await list('/client-tokens')).filter((t) => t.name === name && t.status === 'active'), 'client tokens');
    if (!token) token = (await request('/client-tokens', 'POST', { name })).data;
    await save({ clientToken: token.token });
  }
  const destination = `${origin}/api/subscriptions/paddle/webhook`;
  let webhook = one((await list('/notification-settings')).filter((w) => w.destination === destination && w.type === 'url'), 'webhook destinations');
  const body = { description: `${siteName} subscriptions`, type: 'url', destination, api_version: 1,
    subscribed_events: [...PADDLE_WEBHOOK_EVENTS], traffic_source: 'platform', include_sensitive_fields: false };
  if (!webhook) webhook = (await request('/notification-settings', 'POST', body)).data;
  else webhook = (await request(`/notification-settings/${encodeURIComponent(webhook.id)}`, 'PATCH', { ...body, active: true })).data;
  if (!webhook.endpoint_secret_key) webhook = (await request(`/notification-settings/${encodeURIComponent(webhook.id)}`)).data;
  if (!webhook.endpoint_secret_key) throw new Error('Paddle omitted the webhook signing secret');
  await save({ webhookSecret: webhook.endpoint_secret_key });
  return { checkoutUrl: `${origin}/billing/checkout`, webhookUrl: destination,
    remaining: ['Approve the domain and default payment link in Paddle', 'Complete identity review and payouts',
      'Confirm pricing for products below $10', 'Verify sandbox lifecycle and review launch policies before enabling live checkout'] };
}
