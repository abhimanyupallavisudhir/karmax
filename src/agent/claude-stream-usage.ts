import type { AdapterTurn } from './types.js';

type Counters = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
const FIELDS: [keyof Counters, string][] = [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_input_tokens'], ['cacheWriteTokens', 'cache_creation_input_tokens']];

/**
 * What one Claude Code session spent, counted per model request as its frames
 * arrive, so a turn that dies mid-way (a usage limit, a lost sandbox) still
 * reports what it used. The SDK's own counters can't do that: `result.usage` is
 * the main loop of the last result only, and `modelUsage` is cumulative over the
 * whole resumed session, so neither isolates one turn, and a failed turn has no
 * result at all.
 *
 * Each request is keyed by its message id and keeps the largest value seen per
 * counter: `message_start` and every assistant frame carry the final input and
 * cache counts but a partial output count, which `message_delta` completes.
 * Claude Code 2.1.281 streams those events for the main loop only, so a
 * sub-agent's output tokens are its partial count (its input and cache, the bulk
 * of an agent's tokens, are exact).
 */
export class ClaudeStreamUsage {
  private readonly requests = new Map<string, Counters & { model?: string }>();
  /** The request each agent (main loop or sub-agent) is streaming now. */
  private readonly streaming = new Map<string, string>();

  observe(frame: any): void {
    const agent = String(frame?.parent_tool_use_id ?? '');
    if (frame?.type === 'stream_event') {
      const event = frame.event;
      if (event?.type === 'message_start' && event.message?.id) {
        this.streaming.set(agent, String(event.message.id));
        this.add(String(event.message.id), event.message.usage, event.message.model);
      } else if (event?.type === 'message_delta') {
        const id = this.streaming.get(agent);
        if (id) this.add(id, event.usage);
      }
    } else if (frame?.type === 'assistant' && frame.message?.id
      // Claude Code's own notices ("API Error: …") are `<synthetic>`: no request was made.
      && frame.message.model !== '<synthetic>') {
      this.add(String(frame.message.id), frame.message.usage, frame.message.model);
    }
  }

  total(): AdapterTurn['usage'] {
    if (!this.requests.size) return undefined;
    const sum = (rows: Iterable<Counters>): Counters => {
      const total: Counters = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const row of rows) for (const [key] of FIELDS) total[key] += row[key];
      return total;
    };
    const byModel = new Map<string, Counters[]>();
    for (const request of this.requests.values()) {
      if (!request.model) continue;
      byModel.set(request.model, [...(byModel.get(request.model) ?? []), request]);
    }
    const total = sum(this.requests.values());
    return { ...total, inputTokensIncludeCacheRead: false,
      totalTokens: total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens,
      ...(byModel.size ? { models: Object.fromEntries([...byModel].map(([model, rows]) => [model, sum(rows)])) } : {}) };
  }

  private add(id: string, usage: any, model?: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const request = this.requests.get(id) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const [key, field] of FIELDS) {
      const value = usage[field];
      if (typeof value === 'number' && Number.isFinite(value) && value > request[key]) request[key] = value;
    }
    if (typeof model === 'string' && model) request.model = model;
    this.requests.set(id, request);
  }
}
