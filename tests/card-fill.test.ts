import { describe, expect, it, vi } from 'vitest';
import { fillCardInWorld } from '../src/autonomy/card-fill.js';

describe('remote secure card fill', () => {
  it('passes PAN/CVC only through the world process environment, never argv or output', async () => {
    const exec = vi.fn(async (_cmd: string, argv: string[], options: any) => {
      expect(argv.join(' ')).not.toContain('4242424242424242');
      expect(argv.join(' ')).not.toContain('123');
      expect(options.env).toMatchObject({
        KARMAX_CARD_NUMBER: '4242424242424242',
        KARMAX_CARD_CVC: '123',
        KARMAX_CARD_DOMAIN: 'shop.example',
      });
      return { code: 0, stdout: JSON.stringify({ origin: 'https://checkout.shop.example' }), stderr: '' };
    });
    const result = await fillCardInWorld({ exec } as any, {
      cdpUrl: 'http://127.0.0.1:9222',
      domain: 'shop.example',
      selectors: { number: '@focused', expiry: '@tab', cvc: '@tab' },
      details: { number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2030 },
    });
    expect(result).toEqual({ origin: 'https://checkout.shop.example' });
    expect(JSON.stringify(result)).not.toContain('4242424242424242');
    expect(exec).toHaveBeenCalledOnce();
  });
});
