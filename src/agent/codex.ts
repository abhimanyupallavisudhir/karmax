import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput } from './types.js';
import { TOOL_SCHEMAS, platformToolHandlers } from './tools.js';

/**
 * Codex/OpenAI provider adapter (SPEC §7.1). Uses the OpenAI chat-completions
 * API with function-calling to drive an agentic tool loop in the world. Auth is
 * the OPENAI_API_KEY (resolved JIT; never journaled). Completion is the
 * structured signal_completion tool call.
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
    const model = input.profile.model ?? 'gpt-5.1';
    const handlers = platformToolHandlers(input.world, ctx);
    const tools = TOOL_SCHEMAS.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const messages: any[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text })),
    ];
    if (!input.messages.some((m) => m.role === 'user')) {
      messages.push({ role: 'user', content: 'Begin the task described above. Call signal_completion when done.' });
    }

    const maxIters = input.maxTurns ?? input.profile.maxTurns ?? 24;
    let finalText = '';

    for (let i = 0; i < maxIters; i++) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', parallel_tool_calls: false }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 500)}`);
      }
      const data = (await res.json()) as any;
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('OpenAI: empty response');
      messages.push(msg);
      if (msg.content) {
        finalText = msg.content;
        ctx.emit(msg.content);
      }
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) break; // model yielded with no tool call → turn boundary

      let completed = false;
      for (const call of calls) {
        const name = call.function?.name;
        let args: any = {};
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          /* leave args empty */
        }
        const handler = handlers[name];
        const result = handler ? await handler(args) : `unknown tool ${name}`;
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        if (name === 'signal_completion') completed = true;
      }
      if (completed) break;
    }

    return { session: input.session ?? `codex-${input.world.handle.id}`, output: finalText };
  }
}
