import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { minorUnitDigits } from '../src/util/currency.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const fn = (name: string) => {
  const start = app.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = app.indexOf('{', app.indexOf(')', start)); i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`${name} not found`);
};
// readTaskPayments converts with the console's currency helpers.
const helpers = ['currencyDigits', 'toMinorUnits', 'fromMinorUnits'].map(fn).join('\n');
const source = app.slice(app.indexOf('function readTaskPayments(box)'), app.indexOf('async function wireTaskPayments('));
const read = new Function(`${helpers}\n${source}; return readTaskPayments;`)() as (box: unknown) => unknown;
const digits = new Function(`${helpers}; return currencyDigits;`)() as (currency: string) => number;
const box = (value: string, valid = true, currency = 'usd') => ({
  dataset: { policy: JSON.stringify({ cardIds: ['work', 'personal'] }) },
  querySelector: (selector: string) => selector === '.payment-currency' ? { value: currency } : { value, checkValidity: () => valid },
});

describe('compact payment controls', () => {
  it('distinguishes zero budget from unlimited and sends integer minor units', () => {
    expect(read(box('0'))).toEqual({ cardIds: ['work', 'personal'], budget: 0, currency: 'usd' });
    expect(read(box(''))).toEqual({ cardIds: ['work', 'personal'], budget: null, currency: 'usd' });
    expect(read(box('12.34'))).toEqual({ cardIds: ['work', 'personal'], budget: 1234, currency: 'usd' });
    expect(read(box('1000', true, 'jpy'))).toEqual({ cardIds: ['work', 'personal'], budget: 1000, currency: 'jpy' });
  });
  it('never serializes an invalid or overflowing budget as unlimited', () => {
    expect(() => read(box('-1', false))).toThrow();
    expect(() => read(box('1e308'))).toThrow();
  });
  it('does not overwrite a policy while the controls are loading', () => {
    expect(read({ dataset: {} })).toBeUndefined();
  });
  // #367 review item 12: minor units follow the payment rail (Stripe), not
  // Intl: ISK has no decimals in Intl but two in Stripe. The console and the
  // server read amounts the same way.
  it('agrees with the server on every currency’s minor unit', () => {
    for (const currency of ['usd', 'eur', 'gbp', 'jpy', 'krw', 'vnd', 'kwd', 'bhd', 'isk', 'huf', 'twd', 'ugx', 'xyz'])
      expect([currency, digits(currency)]).toEqual([currency, minorUnitDigits(currency)]);
    expect(minorUnitDigits('isk')).toBe(2);
    expect(minorUnitDigits('JPY')).toBe(0);
    expect(minorUnitDigits('kwd')).toBe(3);
  });
});
