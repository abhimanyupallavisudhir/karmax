/**
 * Digits in a currency's minor unit, as payment amounts are stored and as the
 * rails report them. Stripe's convention, not ISO 4217's: ISK is two-decimal
 * there (Intl says none), so an amount a card reports reads the same here.
 * web/app.js `currencyDigits` mirrors this table (tests/payment-controls-ui).
 */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

export function minorUnitDigits(currency: string): number {
  const code = currency.toLowerCase();
  return ZERO_DECIMAL.has(code) ? 0 : THREE_DECIMAL.has(code) ? 3 : 2;
}

/** `minor` in major units with the currency's digits, e.g. 1000 JPY → "1000", 1234 USD → "12.34". */
export function formatMinorUnits(minor: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}
