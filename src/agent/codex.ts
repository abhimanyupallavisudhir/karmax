import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput, RUNAWAY_BACKSTOP } from './types.js';
import { TOOL_SCHEMAS, platformToolHandlers } from './tools.js';
import { codexReasoningEffort } from './effort.js';

/**
 * Codex/OpenAI provider adapter (SPEC §7.1). Uses the OpenAI **Responses API**
 * with function-calling so the session id we store and resume is the provider's
 * own conversation handle (`response.id` → `previous_response_id`), not a
 * karmax-fabricated id (SPEC §10.5). Auth is OPENAI_API_KEY (resolved JIT).
 */
export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;

  static hasAuth(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  async runTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const apiKey = input.resolvedAuth?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('CodexAdapter: OPENAI_API_KEY not set');
    const baseUrl = process.env.KARMAX_OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const model = input.profile.model ?? 'gpt-4.1';
    const handlers = platformToolHandlers(input.world, ctx);
    // Responses API function tools are flat ({type:'function', name, ...}).
    const tools = TOOL_SCHEMAS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));

    // Send only the latest human message; history is carried by previous_response_id.
    const recent = input.messages.filter((m) => m.role !== 'agent');
    const firstText = recent.length ? recent[recent.length - 1]!.text : 'Begin the task described in the instructions. Call signal_completion when done.';
    let nextInput: any[] = [{ role: 'user', content: firstText }];

    let respId: string | undefined = input.session; // resume from a prior response id
    // Turn cap is optional: unset ⇒ effectively unlimited (a high runaway backstop
    // only, so a pathological infinite tool-loop can't burn unbounded spend).
    const maxIters = input.maxTurns ?? input.profile.maxTurns ?? RUNAWAY_BACKSTOP;
    let finalText = '';

    for (let i = 0; i < maxIters; i++) {
      if (ctx.signal?.aborted) break; // cancelled mid-turn (SPEC §5.6)
      ctx.heartbeat?.(); // let Temporal deliver a pending cancellation
      const body: any = { model, tools, tool_choice: 'auto', store: true, input: nextInput };
      if (respId) body.previous_response_id = respId;
      else body.instructions = input.systemPrompt;
      // Reasoning effort (SPEC §10.5) — only reasoning models accept it (not gpt-4.1).
      const reasoningEffort = codexReasoningEffort(model, input.profile.effort);
      if (reasoningEffort) body.reasoning = { effort: reasoningEffort };

      const res = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      if (!res.ok) throw new Error(`OpenAI Responses API ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const data = (await res.json()) as any;
      respId = data.id ?? respId;

      const outputs: any[] = data.output ?? [];
      const calls = outputs.filter((o) => o.type === 'function_call');
      const text = outputs
        .filter((o) => o.type === 'message')
        .flatMap((m: any) => (m.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text))
        .join('\n');
      if (text) {
        finalText = text;
        ctx.emit(text);
      }
      if (calls.length === 0) break;

      const toolOutputs: any[] = [];
      let completed = false;
      for (const call of calls) {
        let args: any = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          /* leave empty */
        }
        const handler = handlers[call.name];
        const result = handler ? await handler(args) : `unknown tool ${call.name}`;
        toolOutputs.push({ type: 'function_call_output', call_id: call.call_id, output: result });
        if (call.name === 'signal_completion') completed = true;
      }
      nextInput = toolOutputs;
      if (completed) break;
    }

    return { session: respId, output: finalText };
  }
}
