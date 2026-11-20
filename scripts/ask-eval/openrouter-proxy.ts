/**
 * A pass-through in front of OpenRouter for the Ask evaluation (README.md).
 *
 * tavya reaches OpenRouter at KARMAX_OPENROUTER_API_URL, for the included
 * model's management API (one key per organization) and for every model
 * request of a turn. Pointing that at this proxy keeps tavya's own code path
 * exactly as production runs it, while letting the evaluation
 *  - answer the management API itself (no management key needed): each
 *    organization gets a key `sk-eval-<org>` that the proxy swaps for the real
 *    one (OPENROUTER_KEY) — so every request says which organization sent it;
 *  - forward only the Ask task under test (a task the agent creates that would
 *    run a model of its own is refused, so it costs nothing and is not counted);
 *  - measure every round: time to first byte and first token, tokens, cached
 *    tokens, OpenRouter's reported cost (usage.cost, else /generation), the
 *    provider that served it, finish reason, the tool calls asked for and the
 *    tool results sent back (errors, unknown tools, bad JSON);
 *  - stop spending at a budget.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const UPSTREAM = 'https://openrouter.ai/api/v1';

export interface Round {
  at: number;
  ttfbMs: number;
  /** First streamed content, reasoning or tool-call delta. */
  firstTokenMs?: number;
  /** First streamed visible text (what the person sees appear). */
  firstTextMs?: number;
  totalMs: number;
  status: number;
  provider?: string;
  model?: string;
  generationId?: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  toolCalls: Array<{ name: string; arguments: string }>;
  /** Tool results this request carried back (the previous round's calls). */
  toolResults: Array<{ name?: string; error: boolean; text: string }>;
  error?: string;
}

export interface Trial {
  organizationId: string;
  /** The Ask's first message: a request whose first user message differs is not this trial's. */
  prompt: string;
  rounds: Round[];
  requestBodies: number[];
  refused: number;
  systemPrompt?: string;
}

export class OpenRouterProxy {
  private server?: http.Server;
  private trials = new Map<string, Trial>();
  spentUsd = 0;
  refusedOutside = 0;
  /** Cost of every round, also those of trials since closed. */
  private usageByOrg = new Map<string, number>();

  constructor(private readonly realKey: string, private readonly budgetUsd: number) {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => { void this.handle(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `eval proxy: ${error instanceof Error ? error.message : String(error)}` } }));
    }); });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/api/v1`;
  }

  async stop() { await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()); }

  /** The Ask under test in `organizationId` from now on (one at a time per organization). */
  open(organizationId: string, prompt: string): Trial {
    const trial: Trial = { organizationId, prompt, rounds: [], requestBodies: [], refused: 0 };
    this.trials.set(organizationId, trial);
    return trial;
  }

  close(organizationId: string) { this.trials.delete(organizationId); }

  overBudget() { return this.spentUsd >= this.budgetUsd; }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://proxy');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = await new Promise<string>((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => resolve(s)); });
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    // The management API tavya's included model uses (src/agent/included-model.ts).
    if (path === '/keys' && req.method === 'POST') {
      const organizationId = String(JSON.parse(body || '{}').name ?? '').replace(/^tavya /, '');
      return json(200, { data: { hash: `h-${organizationId}` }, key: `sk-eval-${organizationId}` });
    }
    const keyPath = path.match(/^\/keys\/h-(.+)$/);
    if (keyPath) return json(200, { data: { usage: this.usageByOrg.get(keyPath[1]!) ?? 0, disabled: false } });
    if (path === '/models' || path.startsWith('/models/')) {
      const upstream = await fetch(`${UPSTREAM}${path}${url.search}`);
      return json(upstream.status, await upstream.json());
    }
    if (path !== '/chat/completions') return json(404, { error: { message: `eval proxy: ${req.method} ${path} is not served` } });

    const organizationId = String(req.headers.authorization ?? '').replace(/^Bearer sk-eval-/, '');
    const request = JSON.parse(body);
    const firstUser = (request.messages as any[]).find((m) => m.role === 'user');
    const firstText = typeof firstUser?.content === 'string' ? firstUser.content
      : Array.isArray(firstUser?.content) ? firstUser.content.map((p: any) => p.text ?? '').join('') : '';
    const trial = this.trials.get(organizationId);
    if (!trial || !firstText.includes(trial.prompt)) {
      this.refusedOutside++;
      if (trial) trial.refused++;
      return json(403, { error: { message: 'eval proxy: only the Ask under test may call a model' } });
    }
    if (this.overBudget()) return json(402, { error: { message: `eval proxy: evaluation budget of $${this.budgetUsd} spent` } });
    const system = request.messages.find((m: any) => m.role === 'system')?.content;
    // Claude's system prompt comes as text parts marked for caching.
    trial.systemPrompt ??= Array.isArray(system) ? system.map((part: any) => part.text ?? '').join('') : system;
    trial.requestBodies.push(body.length);
    const round: Round = { at: Date.now(), ttfbMs: 0, totalMs: 0, status: 0, toolCalls: [], toolResults: toolResults(request.messages) };
    trial.rounds.push(round);
    const started = performance.now();
    const upstream = await fetch(`${UPSTREAM}/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.realKey}` }, body });
    round.ttfbMs = performance.now() - started;
    round.status = upstream.status;
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    if (!upstream.body) { res.end(); return; }
    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    const calls: Array<{ name: string; arguments: string }> = [];
    const reader = upstream.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
      const text = decoder.decode(value, { stream: true });
      if (upstream.status !== 200) { raw += text; continue; }
      buffer += text;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) round.error = JSON.stringify(chunk.error).slice(0, 300);
        round.provider ??= chunk.provider;
        round.model ??= chunk.model;
        round.generationId ??= chunk.id;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? {};
        const now = performance.now() - started;
        if (round.firstTokenMs === undefined && (delta.content || delta.reasoning || delta.reasoning_content || delta.tool_calls?.length)) round.firstTokenMs = now;
        if (round.firstTextMs === undefined && delta.content) round.firstTextMs = now;
        for (const call of delta.tool_calls ?? []) {
          const i = Number(call.index ?? calls.length);
          calls[i] ??= { name: '', arguments: '' };
          if (call.function?.name) calls[i]!.name += call.function.name;
          if (call.function?.arguments) calls[i]!.arguments += call.function.arguments;
        }
        if (choice?.finish_reason) round.finishReason = choice.finish_reason;
        if (chunk.usage) {
          round.promptTokens = chunk.usage.prompt_tokens;
          round.completionTokens = chunk.usage.completion_tokens;
          round.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
          round.reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
          if (typeof chunk.usage.cost === 'number') round.costUsd = chunk.usage.cost;
        }
      }
    }
    res.end();
    round.totalMs = performance.now() - started;
    round.toolCalls = calls.filter(Boolean);
    if (upstream.status !== 200) round.error = raw.slice(0, 400);
    if (round.costUsd === undefined && round.generationId && upstream.status === 200) round.costUsd = await this.generationCost(round.generationId);
    const cost = round.costUsd ?? 0;
    this.spentUsd += cost;
    this.usageByOrg.set(organizationId, (this.usageByOrg.get(organizationId) ?? 0) + cost);
  }

  /** OpenRouter's own record of a generation, for a stream that carried no cost. */
  private async generationCost(id: string): Promise<number | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      const response = await fetch(`${UPSTREAM}/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${this.realKey}` } });
      if (response.ok) {
        const data = (await response.json() as any)?.data;
        if (typeof data?.total_cost === 'number') return data.total_cost;
      }
    }
    return undefined;
  }
}

/** The tool results at the end of a request (the answers to the previous round's calls). */
function toolResults(messages: any[]): Round['toolResults'] {
  const out: Round['toolResults'] = [];
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role === 'tool') i--;
  const assistant = messages[i];
  const names = new Map<string, string>((assistant?.tool_calls ?? []).map((c: any) => [c.id, c.function?.name]));
  for (const m of messages.slice(i + 1)) {
    const text = String(m.content ?? '');
    out.push({ name: names.get(m.tool_call_id), error: text.startsWith('error: '), text: text.slice(0, 300) });
  }
  return out;
}
