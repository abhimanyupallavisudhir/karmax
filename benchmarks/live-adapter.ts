import fs from 'node:fs';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';
import { currentTiming } from '../src/timing/index.js';
import type { AgentAdapter } from '../src/agent/types.js';

// Deliberately restricted benchmark, never installed in the production adapter registry.
export const liveLimits = { maxRequests: 2000, maxOutputTokens: 512, maxBodyBytes: 32_000,
  maxEstimatedDollars: 20, requestTimeoutMs: 60_000, maxTurns: 6 };
const models = { codex: 'gpt-5.5', claude: 'claude-sonnet-4-6' } as const;
const allowed = new Set(['search_connection_tools', 'execute_connection_tool']);
export function liveBenchmark(output: string) {
  for (const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY']) if (!process.env[key]) throw Error(`${key} is absent; no live requests started`);
  for (const [key, expected] of Object.entries({KARMAX_OPENAI_BASE_URL:'https://api.openai.com/v1',KARMAX_ANTHROPIC_BASE_URL:'https://api.anthropic.com'})) {
    if (process.env[key] && process.env[key] !== expected) throw Error('Benchmark requires direct official provider endpoints');
  }
  const originalFetch = globalThis.fetch;
  const contexts = new Map<string, number>();
  const requests: any[] = [];
  let spent = 0, reserved = 0, halted = false;
  const save = () => fs.writeFileSync(output + '.usage.json', JSON.stringify({ limits:liveLimits, models, estimatedDollars:spent, requests }, null, 2));
  globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    if (!['https://api.openai.com/v1/responses', 'https://api.anthropic.com/v1/messages'].includes(url)) return originalFetch(resource, init);
    const provider = url.includes('anthropic') ? 'claude' : 'codex';
    const body = JSON.parse(String(init?.body));
    if (body.model !== models[provider]) throw Error('benchmark model is not priced');
    body.tools = body.tools.filter((t: any) => allowed.has(t.name));
    if (provider === 'codex') body.max_output_tokens = liveLimits.maxOutputTokens;
    else body.max_tokens = liveLimits.maxOutputTokens;
    const serialized = JSON.stringify(body);
    const bytes = Buffer.byteLength(serialized);
    const contextUpperBound = bytes + (body.previous_response_id ? contexts.get(body.previous_response_id) ?? Infinity : 0);
    // Reserve a pessimistic full context on every call, including server-side history.
    // This is well above these short conversations; fail closed on unreported usage.
    const reserve = (32_000 * 5 + liveLimits.maxOutputTokens * 30) / 1e6;
    if (halted || requests.length >= liveLimits.maxRequests || bytes > liveLimits.maxBodyBytes || contextUpperBound > 32_000 || spent + reserved + reserve > liveLimits.maxEstimatedDollars) throw Error('benchmark spend/request/context limit');
    reserved += reserve;
    const row: any = { provider, model:body.model, requestBytes:bytes, maxOutputTokens:liveLimits.maxOutputTokens, reasoning:body.reasoning ?? body.output_config ?? null };
    requests.push(row);
    try {
      const response = await originalFetch(resource, {...init, body:serialized, signal:AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(liveLimits.requestTimeoutMs)])});
      row.status = response.status;
      if (!response.ok) { halted = true; spent += reserve; save(); return new Response(JSON.stringify({error:{message:`Benchmark provider HTTP ${response.status}`}}), {status:response.status}); }
      const data: any = await response.json();
      const u = data.usage;
      if (!u || !Number.isFinite(u.input_tokens) || !Number.isFinite(u.output_tokens)) throw Error('benchmark missing provider usage');
      row.usage = u; row.resolvedModel = data.model;
      if (provider === 'codex' && data.id) contexts.set(data.id, contextUpperBound + liveLimits.maxOutputTokens);
      row.estimatedDollars = provider === 'codex'
        ? ((u.input_tokens - (u.input_tokens_details?.cached_tokens ?? 0))*5 + (u.input_tokens_details?.cached_tokens ?? 0)*.5 + u.output_tokens*30)/1e6
        : (u.input_tokens*3 + (u.cache_read_input_tokens ?? 0)*.3 + (u.cache_creation_input_tokens ?? 0)*3.75 + u.output_tokens*15)/1e6;
      spent += row.estimatedDollars;
      // Reject unexpected tool calls before an adapter can execute them.
      const calls = provider === 'codex' ? (data.output ?? []).filter((x:any)=>x.type==='function_call') : (data.content ?? []).filter((x:any)=>x.type==='tool_use');
      if (calls.some((x:any)=>!allowed.has(x.name))) throw Error('benchmark unexpected tool');
      row.toolNames = calls.map((x:any)=>x.name);
      save();
      return new Response(JSON.stringify(data), {status:200, headers:{'content-type':'application/json'}});
    } catch { halted = true; row.failed = true; spent += reserve; save(); throw Error('benchmark request failed; collection halted'); }
    finally { reserved -= reserve; }
  };
  const adapters = {codex:new CodexAdapter(), claude:new ClaudeAdapter()};
  return {
    models, requests, limits:liveLimits,
    checkpoint(value:unknown) { fs.writeFileSync(output + ".partial.json", JSON.stringify(value)); },
    adapter(connectionIds: string[]): AgentAdapter {
      return {provider:'mock', async runTurn(input, ctx) {
        const text = input.messages.filter(m=>m.role==='user').at(-1)!.text;
        const provider = text.startsWith('codex:') ? 'codex' : 'claude';
        const scenario = text.split(':')[1];
        const plan = 'This is a NEW independent run. Previous reads do not count; perform all requested reads again now. ' + (scenario === 'conversation' ? 'Use no tools. Reply with exactly: Fixture complete.'
          : `First search_connection_tools on connection ${connectionIds[0]} with search "read fixture". Then ${scenario === 'one-action' ? `read connection ${connectionIds[0]} once` : scenario === 'parallel-actions' ? `request reads on all three connections in a single batch of three tool calls` : `read the three connections in order, one tool call per model response, waiting for each result before the next`}. Use execute_connection_tool with tool FIXTURE_READ and arguments {}. Finish with exactly: Fixture complete. Do not emit text until all reads finish.`);
        const systemPrompt = `You are running a read-only latency fixture. Follow the user's instructions exactly. Available fixture connections in order: ${connectionIds.join(', ')}. Do not use any other tools. Perform exactly the requested reads for this new run, then stop.`;
        const messages = [{id:'benchmark',role:'user' as const,text:plan,ts:Date.now()}];
        currentTiming()?.mark('adapter.invoked', {provider,model:models[provider],systemPromptChars:systemPrompt.length,transcriptChars:plan.length,messageCount:1,sessionMode:input.session?'resumed':'fresh'});
        const result = await adapters[provider].runTurn({...input, profile:{...input.profile,provider,model:models[provider],effort:'low',maxTurns:liveLimits.maxTurns},
          systemPrompt,messages,deliveredMessages:0,maxTurns:liveLimits.maxTurns,agentMcp:undefined,
          resolvedAuth:{apiKey:process.env[provider==='codex'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY']!}}, {...ctx,pullFollowUps:undefined});
        if (result.output.trim() !== 'Fixture complete.') throw Error('benchmark completion validation failed');
        return result;
      }};
    },
    close(){ globalThis.fetch=originalFetch; save(); },
  };
}
