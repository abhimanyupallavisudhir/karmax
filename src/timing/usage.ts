import type { AdapterTurn } from '../agent/types.js';

/** Only complete, provider-reported totals are returned. A missing round cannot
 * become zero, including optional cache counters. No tokenizer estimates. */
export class ReportedUsage {
  private rounds: Partial<NonNullable<AdapterTurn['usage']>>[] = [];
  add(raw: any, provider: 'claude' | 'codex') {
    const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    const value = {
      inputTokens: number(raw?.input_tokens), outputTokens: number(raw?.output_tokens),
      cacheReadTokens: number(provider === 'claude' ? raw?.cache_read_input_tokens : raw?.input_tokens_details?.cached_tokens),
      cacheWriteTokens: provider === 'claude' ? number(raw?.cache_creation_input_tokens) : undefined,
      inputTokensIncludeCacheRead: provider === 'codex',
    };
    this.rounds.push(value);
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  }
  total(): AdapterTurn['usage'] {
    if (!this.rounds.length || this.rounds.some(r => r.inputTokens === undefined || r.outputTokens === undefined)) return undefined;
    const total: NonNullable<AdapterTurn['usage']> = { inputTokens: 0, outputTokens: 0,
      inputTokensIncludeCacheRead: this.rounds[0]!.inputTokensIncludeCacheRead };
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      if (this.rounds.every(r => r[key] !== undefined)) total[key] = this.rounds.reduce((n, r) => n + r[key]!, 0);
    }
    // Anthropic excludes cache from input. A total is unknown without both cache counters.
    if (total.inputTokensIncludeCacheRead) total.totalTokens = total.inputTokens + total.outputTokens;
    else if (total.cacheReadTokens !== undefined && total.cacheWriteTokens !== undefined)
      total.totalTokens = total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens;
    return total;
  }
}
