import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { paymentMerchantMatches } from '../src/util/payment-merchant.js';

/**
 * AU-26: a real-time card authorization consumes a reservation only when its
 * merchant is the one the agent reserved for. Matching used to be a two-way
 * substring test on letters and digits, so `a.co` ("aco") admitted
 * "TACO BELL" and a merchant called just "OP" admitted `shop.example`.
 */
describe('payment merchant matching', () => {
  it.each([
    ['shop.example', { name: 'shop.example' }],
    ['shop.example', { name: 'SHOP EXAMPLE LTD' }],
    ['github.com', { name: 'GITHUB, INC.' }],
    ['https://www.github.com/checkout', { name: 'GitHub' }],
    ['github.com', { name: 'Unrelated descriptor', url: 'https://billing.github.com/pay' }],
    ['Acme Corp', { name: 'ACME CORP INTL' }],
    [null, { name: 'anything at all' }],
  ])('accepts %s for %j', (reserved, merchant) => {
    expect(paymentMerchantMatches(reserved, merchant)).toBe(true);
  });

  it.each([
    ['a.co', { name: 'TACO BELL' }],
    ['shop.example', { name: 'OP' }],
    ['x.ai', { name: 'EXAIR CORP' }],
    ['shop.example', { name: 'SHOPPING EXAMPLES' }],
    ['github.com', { name: 'GITHUB', url: 'https://github.com.evil.example' }],
    ['github.com', { name: 'NOTGITHUB' }],
    ['Acme Corp', { name: 'ACME' }],
    ['shop.example', {}],
  ])('refuses %s for %j', (reserved, merchant) => {
    expect(paymentMerchantMatches(reserved, merchant)).toBe(false);
  });

  it('consumes only the reservation for the authorizing merchant', async () => {
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Merchants');
      const reserve = (merchant: string) => store.createPaymentSpendRequest({ organizationId: project.organizationId!,
        projectId: project.id, taskId: 'task_m', cardId: 'card_m', amount: 1_000, merchant, status: 'authorized' });
      await reserve('a.co');
      expect(await store.findPaymentAuthorization('card_m', 1_000, { name: 'TACO BELL' })).toBeUndefined();
      const shop = await reserve('shop.example');
      expect((await store.findPaymentAuthorization('card_m', 1_000, { name: 'SHOP EXAMPLE' }))?.id).toBe(shop.id);
    } finally { await store.close(); }
  });
});
