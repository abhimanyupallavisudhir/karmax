/**
 * API list prices, as the exchange rate between models and token counters when
 * the scheduler measures spend (wiki features/quota-scheduling). A subscription
 * does not charge them; each login's real quota per dollar is learned from its
 * own usage readings (state.ts), so only their ratios matter.
 */
export interface TokenPrice {
  /** Dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: [RegExp, TokenPrice][] = [
  [/fable-5-1|mythos-5-1/, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [/gpt|codex|^o\d/, { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }],
];
const DEFAULT_PRICE: TokenPrice = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

export function tokenPrice(model: string | undefined): TokenPrice {
  const name = (model ?? '').toLowerCase();
  return PRICES.find(([pattern]) => pattern.test(name))?.[1] ?? DEFAULT_PRICE;
}

export interface Counters {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokensIncludeCacheRead?: boolean;
}

/** API-equivalent dollars of one turn's usage, each model at its own price when the breakdown is known. */
export function usageCostUsd(usage: Counters & { models?: Record<string, Counters> }, model?: string): number {
  const one = (c: Counters, name: string | undefined) => {
    const p = tokenPrice(name);
    const cacheRead = Math.max(0, c.cacheReadTokens ?? 0);
    const input = c.inputTokensIncludeCacheRead ?? usage.inputTokensIncludeCacheRead ? Math.max(0, c.inputTokens - cacheRead) : Math.max(0, c.inputTokens);
    return (input * p.input + Math.max(0, c.outputTokens) * p.output + cacheRead * p.cacheRead
      + Math.max(0, c.cacheWriteTokens ?? 0) * p.cacheWrite) / 1e6;
  };
  const models = Object.entries(usage.models ?? {});
  return models.length ? models.reduce((sum, [name, c]) => sum + one(c, name), 0) : one(usage, model);
}
