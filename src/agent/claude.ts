import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput, RUNAWAY_BACKSTOP } from './types.js';
import { TOOL_SCHEMAS, platformToolHandlers } from './tools.js';

/**
 * Claude provider adapter (SPEC §7.1, §9.1: the Claude Agent SDK / Messages API,
 * never the bare CLI). Two auth routes:
 *   - ANTHROPIC_API_KEY → the Messages API tool-use loop (this file).
 *   - ambient Claude Code login → the Agent SDK (same harness as Claude Code),
 *     loaded lazily so its absence never breaks the build.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;

  static hasApiKey(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  static hasAmbientLogin(): boolean {
    try {
      const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
      return fs.existsSync(path.join(dir, '.credentials.json'));
    } catch {
      return false;
    }
  }

  async runTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    if (input.resolvedAuth?.apiKey || ClaudeAdapter.hasApiKey()) return this.runMessagesApi(input, ctx);
    if (ClaudeAdapter.hasAmbientLogin()) return this.runAgentSdk(input, ctx);
    throw new Error('ClaudeAdapter: no ANTHROPIC_API_KEY and no Claude Code login found');
  }

  // ─── Anthropic Messages API (tool-use loop) ─────────────────────────────────
  private async runMessagesApi(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const apiKey = input.resolvedAuth?.apiKey ?? process.env.ANTHROPIC_API_KEY!;
    const baseUrl = process.env.KARMAX_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
    const model = input.profile.model ?? 'claude-sonnet-4-5';
    const handlers = platformToolHandlers(input.world, ctx);
    const tools = TOOL_SCHEMAS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

    const messages: any[] = [];
    const userMsgs = input.messages.filter((m) => m.role !== 'system');
    if (userMsgs.length) {
      for (const m of userMsgs) {
        messages.push({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text });
      }
    } else {
      messages.push({ role: 'user', content: 'Begin the task. Call signal_completion when done.' });
    }

    const maxIters = input.maxTurns ?? input.profile.maxTurns ?? RUNAWAY_BACKSTOP;
    let finalText = '';

    for (let i = 0; i < maxIters; i++) {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 4096, system: input.systemPrompt, messages, tools }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const data = (await res.json()) as any;
      messages.push({ role: 'assistant', content: data.content });
      const toolUses = (data.content ?? []).filter((b: any) => b.type === 'tool_use');
      const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (text) {
        finalText = text;
        ctx.emit(text);
      }
      if (toolUses.length === 0) break;

      const toolResults: any[] = [];
      let completed = false;
      for (const use of toolUses) {
        const handler = handlers[use.name];
        const result = handler ? await handler(use.input ?? {}) : `unknown tool ${use.name}`;
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: result });
        if (use.name === 'signal_completion') completed = true;
      }
      messages.push({ role: 'user', content: toolResults });
      if (completed) break;
    }

    // The Messages API is stateless — there is no provider conversation id to
    // resume by, so we don't fabricate one (SPEC §10.5). Use the Agent SDK path
    // (ambient Claude Code login) for resumable sessions.
    return { session: input.session, output: finalText };
  }

  // ─── Claude Agent SDK (ambient Claude Code login) ───────────────────────────
  private async runAgentSdk(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    let sdk: any;
    try {
      sdk = await import('@anthropic-ai/claude-agent-sdk');
    } catch (e) {
      throw new Error(`Claude Agent SDK not installed: ${String(e)}`);
    }
    const { query, createSdkMcpServer, tool } = sdk;
    const zod = (await import('zod')).z;
    const handlers = platformToolHandlers(input.world, ctx);

    // Expose the platform tools as an in-process MCP server.
    const platform = createSdkMcpServer({
      name: 'karmax',
      version: '1.0.0',
      tools: [
        tool('signal_completion', 'Signal that the turn is complete.', { summary: zod.string().optional() }, async (a: any) => ({
          content: [{ type: 'text', text: await handlers.signal_completion!(a) }],
        })),
        tool('create_review_info', 'Attach review output.', { summary: zod.string().optional(), diff: zod.string().optional(), html: zod.string().optional() }, async (a: any) => ({
          content: [{ type: 'text', text: await handlers.create_review_info!(a) }],
        })),
        tool('create_sub_task', 'Spawn a child task.', { title: zod.string(), prompt: zod.string() }, async (a: any) => ({
          content: [{ type: 'text', text: await handlers.create_sub_task!(a) }],
        })),
        tool('save_skill', 'Save a reusable skill.', { name: zod.string(), content: zod.string() }, async (a: any) => ({
          content: [{ type: 'text', text: await handlers.save_skill!(a) }],
        })),
      ],
    });

    const userText = input.messages.filter((m) => m.role !== 'system').map((m) => m.text).join('\n\n') ||
      'Begin the task described in the system prompt. Call signal_completion when done.';

    // Scrubbed, config-home-isolated env (SPEC §7.3).
    const { scrubbedEnv } = await import('../autonomy/config-homes.js');
    const env = scrubbedEnv({
      provider: 'claude',
      configHome: input.resolvedAuth?.configHome,
      // A captured setup-token login: re-supply it (scrubbedEnv strips it by default).
      ...(input.resolvedAuth?.oauthToken ? { extra: { CLAUDE_CODE_OAUTH_TOKEN: input.resolvedAuth.oauthToken } } : {}),
    });

    let finalText = '';
    let session = input.session;
    const iterator = query({
      prompt: userText,
      options: {
        cwd: input.world.handle.root,
        additionalDirectories: [input.world.handle.root],
        permissionMode: 'acceptEdits',
        systemPrompt: input.systemPrompt,
        ...(input.profile.model ? { model: input.profile.model } : {}),
        ...(session ? { resume: session } : {}),
        mcpServers: { karmax: platform },
        env,
      },
    });
    for await (const message of iterator) {
      if (message.type === 'assistant') {
        const text = (message.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        if (text) {
          finalText = text;
          ctx.emit(text);
        }
      } else if (message.type === 'result') {
        session = message.session_id ?? session;
      }
    }
    // The Agent SDK harness completes its own loop; treat a finished query as a
    // turn boundary. If the agent didn't call signal_completion explicitly, the
    // runtime surfaces the output at Review.
    return { session, output: finalText };
  }
}
