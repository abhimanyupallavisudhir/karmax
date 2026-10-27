import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { PaddleSubscriptionProvider, type PaddleRuntimeConfig } from '../src/billing/paddle.js';

/** Paddle **sandbox** harness ([[ops/billing-paddle]] § Sandbox harness traps).
 *
 *   PADDLE_SANDBOX_KEY_FILE=… npx tsx scripts/paddle-sandbox.ts subscribe        # a test-card Individual subscription
 *   PADDLE_SANDBOX_KEY_FILE=… npx tsx scripts/paddle-sandbox.ts subscribe packs  # a storage pack alone (beside a gifted plan)
 *   PADDLE_SANDBOX_KEY_FILE=… npx tsx scripts/paddle-sandbox.ts packs <sub_…>    # packs alone: add, end with the last, resume
 *   PADDLE_SANDBOX_KEY_FILE=… npx tsx scripts/paddle-sandbox.ts top-up <sub_…>   # one compute top-up, then find it
 *   PADDLE_SANDBOX_KEY_FILE=… npx tsx scripts/paddle-sandbox.ts cancel <sub_…>   # cancel it now
 *
 * The sandbox key may not create customers, and checkout links must be on
 * tavya.io, so `subscribe` creates the transaction itself and pays it in a
 * headless browser that serves tavya.io's checkout page from web/. It refuses
 * anything but the sandbox API, and never touches a subscription it was not given. */

const API = 'https://sandbox-api.paddle.com';
// Sandbox catalog (ops/billing-paddle). The sandbox has no compute pack product,
// so top-ups use the storage pack's: a non-catalog price only needs a product.
const SANDBOX = { individualPriceId: 'pri_01m38g03d37ahpajqj1hnjbv03', teamBasePriceId: 'pri_01m38g03mfxan93nh9sa6pwzvj',
  teamSeatPriceId: 'pri_01m38g043d0k5q28wzjsa4ae4v', individualProductId: 'pro_01m38g02zxjx42dfff9szvjc3b',
  teamProductId: 'pro_01m38g03672ndyqpkkdectz9cp', storagePackPriceId: 'pri_01m3x1mfs6dm17jb5bd044pzg1',
  storagePackProductId: 'pro_01m3x1mf8hg6c0q18pr9tym5cd', clientToken: 'test_f28f40c7be99ba060ce20ee9a93' };
const FIXTURES = new Set(['sub_01m38h1259c5y81cjywqhcmqnc']);

const keyFile = process.env.PADDLE_SANDBOX_KEY_FILE;
if (!keyFile) throw new Error('set PADDLE_SANDBOX_KEY_FILE to a file holding the sandbox API key');
const apiKey = fs.readFileSync(keyFile, 'utf8').trim();
if (!apiKey.includes('_sdbx_')) throw new Error('not a Paddle sandbox key');

async function paddle(pathname: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(new URL(pathname, API), { method, headers: { authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${JSON.stringify(json.error ?? json)}`);
  return json.data;
}

function guard(subscriptionId: string | undefined): string {
  if (!subscriptionId || !/^sub_[a-z0-9]{26}$/.test(subscriptionId)) throw new Error('give a sandbox subscription id');
  if (FIXTURES.has(subscriptionId)) throw new Error(`${subscriptionId} is a test fixture; make your own with subscribe`);
  return subscriptionId;
}

async function subscribe(packsAlone = false) {
  const transaction = await paddle('/transactions', 'POST', {
    items: [{ price_id: packsAlone ? SANDBOX.storagePackPriceId : SANDBOX.individualPriceId, quantity: 1 }],
    collection_mode: 'automatic', custom_data: { karmax_harness: crypto.randomUUID() },
    checkout: { url: 'https://tavya.io/billing/checkout' } });
  console.log('transaction', transaction.id, transaction.status);
  const web = path.resolve('web');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.route('https://tavya.io/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/subscriptions/paddle/checkout-config')
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ environment: 'sandbox', clientToken: SANDBOX.clientToken }) });
      const file = url.pathname === '/billing/checkout' ? 'paddle-checkout.html' : url.pathname.slice(1);
      const full = path.join(web, file);
      if (!full.startsWith(web + path.sep) || !fs.existsSync(full)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ path: full });
    });
    await page.goto(`https://tavya.io/billing/checkout?_ptxn=${transaction.id}`);
    const frame = page.frameLocator('iframe[name="paddle_frame"], iframe.paddle-frame').first();
    // Step 1, without a customer on the transaction: email and location.
    await frame.getByTestId('authenticationEmailInput').fill('tavya-sandbox@example.com', { timeout: 60_000 });
    await frame.getByTestId('countriesSelect').selectOption('US');
    await frame.getByTestId('postcodeInput').fill('10001');
    await frame.getByTestId('combinedAuthenticationLocationFormSubmitButton').click();
    await frame.getByTestId('cardNumberInput').fill('4242 4242 4242 4242', { timeout: 60_000 });
    await frame.getByTestId('expiryDateField').fill('12/30');
    await frame.getByTestId('cardVerificationValueInput').fill('100');
    await frame.getByTestId('cardholderNameInput').fill('Tavya Sandbox');
    await frame.getByTestId('cardPaymentFormSubmitButton').click();
    await page.getByText('Payment received').waitFor({ timeout: 120_000 });
  } catch (error) {
    // Paddle renames its test ids now and then: show the ones the checkout has.
    const shot = path.join(os.tmpdir(), 'paddle-sandbox-checkout.png');
    await page.screenshot({ path: shot }).catch(() => undefined);
    const ids = await page.frame({ name: 'paddle_frame' })?.locator('[data-testid]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')).join(' ')).catch(() => '');
    console.error(`checkout stuck (screenshot ${shot}); test ids on the page: ${ids}`);
    throw error;
  } finally { await browser.close(); }
  for (let attempt = 0; attempt < 30; attempt++) {
    const paid = await paddle(`/transactions/${transaction.id}`);
    if (paid.subscription_id) { console.log('subscription', paid.subscription_id, 'transaction', paid.status); return; }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('the transaction never got a subscription');
}

async function topUp(subscriptionId: string) {
  const config: PaddleRuntimeConfig = { environment: 'sandbox', apiKey, webhookSecret: 'unused', ...SANDBOX,
    computePackProductId: SANDBOX.storagePackProductId };
  const provider = new PaddleSubscriptionProvider(() => config);
  const topUpId = `topup_${crypto.randomUUID()}`;
  const since = Date.now();
  const before = await paddle(`/subscriptions/${subscriptionId}`);
  console.log('subscription', subscriptionId, before.status, 'items', before.items.map((item: any) => `${item.price.id}×${item.quantity}`).join(', '));
  const charged: any = await provider.chargeComputeTopUp({ subscriptionId, topUpId, amountCents: 1000 });
  console.log('charge answered', JSON.stringify({ id: charged?.id, status: charged?.status,
    items: charged?.items?.map((item: any) => `${item.price.id}×${item.quantity}`) }));
  for (let attempt = 0; attempt < 40; attempt++) {
    const found = await provider.findComputeTopUp({ subscriptionId, topUpId, since });
    console.log(new Date().toISOString(), 'findComputeTopUp', JSON.stringify(found));
    if (found && 'state' in found && found.state !== 'pending') {
      const transaction = await paddle(`/transactions/${found.transactionId}`);
      console.log('transaction', JSON.stringify({ id: transaction.id, status: transaction.status, origin: transaction.origin,
        subscription_id: transaction.subscription_id, collection_mode: transaction.collection_mode,
        totals: transaction.details?.totals, items: transaction.items.map((item: any) => ({ quantity: item.quantity,
          price: { id: item.price.id, product_id: item.price.product_id, name: item.price.name, description: item.price.description,
            custom_data: item.price.custom_data, unit_price: item.price.unit_price, billing_cycle: item.price.billing_cycle } })) }, null, 1));
      const after = await paddle(`/subscriptions/${subscriptionId}`);
      console.log('subscription after', after.status, 'items', after.items.map((item: any) => `${item.price.id}×${item.quantity}`).join(', '),
        'next', after.next_billed_at);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error('the top-up never settled');
}

/** What the provider does to a subscription of packs alone: add one, remove
 * them all (it ends with the period), add one back (it is kept). */
async function packs(subscriptionId: string) {
  const config: PaddleRuntimeConfig = { environment: 'sandbox', apiKey, webhookSecret: 'unused', ...SANDBOX };
  const provider = new PaddleSubscriptionProvider(() => config);
  const show = async (step: string) => {
    const now = await paddle(`/subscriptions/${subscriptionId}`);
    console.log(step.padEnd(28), now.status, 'items', now.items.map((item: any) => `${item.price.id}×${item.quantity}`).join(', '),
      'scheduled', JSON.stringify(now.scheduled_change), 'next', now.next_billed_at);
    return now;
  };
  const settled = async (storagePacks: number) => JSON.stringify(await provider.reconcileRequest({ kind: 'storage', subscriptionId, storagePacks }, 'ref', Date.now()));
  await show('before');
  await provider.updateStoragePacks({ subscriptionId, storagePacks: 2, idempotencyKey: 'sandbox' });
  await show('2 packs');
  console.log('reconcile 2 →', await settled(2));
  await provider.updateStoragePacks({ subscriptionId, storagePacks: 0, idempotencyKey: 'sandbox' });
  const ending = await show('0 packs (ends with period)');
  if (ending.scheduled_change?.action !== 'cancel') throw new Error('the last pack did not schedule the end');
  console.log('reconcile 0 →', await settled(0));
  await provider.updateStoragePacks({ subscriptionId, storagePacks: 0, idempotencyKey: 'sandbox' });
  await provider.updateStoragePacks({ subscriptionId, storagePacks: 2, idempotencyKey: 'sandbox' });
  const kept = await show('2 again (kept)');
  if (kept.scheduled_change) throw new Error('adding a pack back did not keep the subscription');
  await provider.updateStoragePacks({ subscriptionId, storagePacks: 0, idempotencyKey: 'sandbox' });
  await provider.changePlan({ subscriptionId, plan: 'individual', seats: 1, items: {}, idempotencyKey: 'sandbox' });
  const planned = await show('ending, then a plan added');
  if (planned.scheduled_change) throw new Error('adding a plan did not keep the subscription');
}

async function cancel(subscriptionId: string) {
  const result = await paddle(`/subscriptions/${subscriptionId}/cancel`, 'POST', { effective_from: 'immediately' });
  console.log('subscription', subscriptionId, result.status);
}

const [command, argument] = process.argv.slice(2);
if (command === 'subscribe') await subscribe(argument === 'packs');
else if (command === 'packs') await packs(guard(argument));
else if (command === 'top-up') await topUp(guard(argument));
else if (command === 'cancel') await cancel(guard(argument));
else throw new Error('usage: paddle-sandbox.ts subscribe [packs] | packs <sub_…> | top-up <sub_…> | cancel <sub_…>');
