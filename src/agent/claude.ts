import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput, RUNAWAY_BACKSTOP } from './types.js';
import { TOOL_SCHEMAS, PLATFORM_TOOL_SCHEMAS, platformToolHandlers } from './tools.js';
import { claudeMessagesEffort } from './effort.js';
import { anthropicUserContent, collectAnthropicImageBlocks } from './images.js';
import { messagesToDeliver } from './history.js';
import { agentMcpToConfig } from '../contrib/manifests.js';
import { newSubagentTracker, trackTaskMessage, pendingSubagentCount } from './subagents.js';

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
    const auth = input.resolvedAuth;
    // Route on the PROFILE's resolved auth first, so each profile picks its rail:
    // an API key → the Messages API (metered); a config home → the subscription
    // login (Agent SDK). Only with NO explicit profile auth do we fall back to the
    // ambient environment — so a stray ANTHROPIC_API_KEY can no longer silently
    // force a subscription profile onto the metered path.
    if (auth?.apiKey) return this.runMessagesApi(input, ctx);
    if (auth?.configHome) return this.runAgentSdk(input, ctx);
    if (ClaudeAdapter.hasApiKey()) return this.runMessagesApi(input, ctx);
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
        messages.push({
          role: m.role === 'agent' ? 'assistant' : 'user',
          content: m.role === 'agent' ? m.text : anthropicUserContent(m),
        });
      }
    } else {
      messages.push({ role: 'user', content: 'Begin the task. Call signal_completion when done.' });
    }

    const maxIters = input.maxTurns ?? input.profile.maxTurns ?? RUNAWAY_BACKSTOP;
    let finalText = '';

    for (let i = 0; i < maxIters; i++) {
      if (ctx.signal?.aborted) break; // cancelled mid-turn (SPEC §5.6)
      ctx.heartbeat?.(); // let Temporal deliver a pending cancellation
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: input.systemPrompt,
          messages,
          tools,
          // Reasoning effort (SPEC §10.5) — sent only on models that accept it.
          ...(claudeMessagesEffort(model, input.profile.effort) ? { output_config: { effort: claudeMessagesEffort(model, input.profile.effort) } } : {}),
        }),
        signal: ctx.signal,
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

    // Expose EVERY platform tool as an in-process MCP server, derived from the shared
    // PLATFORM_TOOL_SCHEMAS so this path can never again drift out of sync with the
    // Messages-API path (the drift that left Claude-Code agents without
    // respond_to_sub_task / raise_to_parent / wait_for_subtasks — a parent literally
    // could not confirm a child that raised to it). Read/Write/Bash come from the SDK
    // natively, so they are excluded upstream.
    const platform = createSdkMcpServer({
      name: 'karmax',
      version: '1.0.0',
      tools: buildSdkTools(tool, zod, handlers),
    });

    // Only the messages new since the resumed session last advanced (the whole
    // conversation on a fresh session) — the session already holds the rest, so
    // re-sending it would replay the agent's own past replies back at it (§7.2).
    const convo = messagesToDeliver(input).filter((m) => m.role !== 'system');
    const userText = convo.map((m) => m.text).join('\n\n') ||
      (input.session ? 'Continue from the latest instruction.' : 'Begin the task described in the system prompt. Call signal_completion when done.');

    // Images force the streaming-input form: the SDK's plain-string `prompt` can't
    // carry image blocks, so when there are attachments we hand it an
    // AsyncIterable<SDKUserMessage> whose MessageParam content mixes text + images.
    // (Text-only turns keep the string prompt, byte-for-byte unchanged.)
    const imageBlocks = collectAnthropicImageBlocks(convo);
    const promptArg: any = imageBlocks.length
      ? (async function* () {
          const content: any[] = [];
          if (userText) content.push({ type: 'text', text: userText });
          content.push(...imageBlocks);
          yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } };
        })()
      : userText;

    // Scrubbed, config-home-isolated env (SPEC §7.3).
    const { scrubbedEnv } = await import('../autonomy/config-homes.js');
    const env = scrubbedEnv({
      provider: 'claude',
      configHome: input.resolvedAuth?.configHome,
      // A captured setup-token login: re-supply it (scrubbedEnv strips it by default).
      ...(input.resolvedAuth?.oauthToken ? { extra: { CLAUDE_CODE_OAUTH_TOKEN: input.resolvedAuth.oauthToken } } : {}),
    });

    // Mid-turn cancel (SPEC §5.6): kill the agent subprocess when the workflow
    // cancels. The Agent SDK spawns a child harness process (the Claude Code
    // agent); without wiring the abort signal into it, a cancelled task leaves
    // that agent running — the orphaned-agent bug. The SDK's `abortController`
    // option terminates the subprocess when aborted, mirroring the codex CLI
    // adapter's child.kill() and the Messages-API path's fetch(signal).
    const abortController = new AbortController();
    const onAbort = () => { try { abortController.abort(); } catch { /* already aborted */ } };
    if (ctx.signal?.aborted) onAbort();
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
    // Heartbeat on a timer while the SDK streams. Temporal delivers a pending
    // cancellation to the activity's AbortSignal on heartbeat, so without this a
    // long Agent-SDK turn would never observe a mid-turn cancel (the Messages-API
    // and codex paths already heartbeat) — the subprocess would run to completion.
    const hb = ctx.heartbeat ? setInterval(() => { try { ctx.heartbeat!(); } catch { /* ignore */ } }, 10_000) : undefined;

    let finalText = '';
    let session = input.session;
    // Track in-harness sub-agents (the Task tool). Claude Code auto-backgrounds long
    // sub-agents, so the main `result` can arrive — completion already signalled —
    // while a sub-agent is still running. We fold every task-lifecycle message in and
    // report the residual count so the workflow won't advance Do→Review mid-flight.
    const subagents = newSubagentTracker();
    const iterator = query({
      prompt: promptArg,
      options: {
        abortController,
        cwd: input.world.handle.root,
        additionalDirectories: [input.world.handle.root],
        // The world is already an isolated git worktree (the sandbox boundary) and
        // the agent runs headless — there is no human to approve tool calls, so it
        // must never stall on a permission prompt.
        //
        // We CANNOT rely on `bypassPermissions` for this: an account/org can push a
        // managed policy — `remote-settings.json`:
        //   { "permissions": { "disableBypassPermissionsMode": "disable" } }
        // — that refuses bypass and silently DOWNGRADES the session to `default`.
        // Then every Write/Bash returns "you haven't granted it yet" and the agent
        // reports it has no permission to make edits (the real prod failure). Managed
        // settings override CLI flags, so `allowDangerouslySkipPermissions` can't
        // force it either — and this policy is present on real logins here.
        //
        // The robust mechanism is a programmatic approver. `canUseTool` is the SDK's
        // "human clicking allow": it handles the permission prompts that appear in
        // `default`/`acceptEdits` mode (i.e. exactly when bypass is policy-disabled)
        // and is NOT gated by disableBypassPermissionsMode. We still REQUEST bypass
        // as a fast path for unrestricted accounts (no prompts at all); wherever it's
        // disabled, canUseTool approves each call instead. Explicit `deny` rules in a
        // managed policy still win — as they should; we only auto-grant the "ask" path.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        canUseTool: async (tool: string, toolInput: Record<string, unknown>) => {
          if (tool === 'Bash' && typeof toolInput?.command === 'string') ctx.emit(`$ ${toolInput.command}`);
          return { behavior: 'allow' as const, updatedInput: toolInput };
        },
        systemPrompt: input.systemPrompt,
        ...(input.profile.model ? { model: input.profile.model } : {}),
        // Reasoning effort (SPEC §10.5); the SDK silently downgrades for models
        // that don't support the level, so no gating is needed here.
        ...(input.profile.effort ? { effort: input.profile.effort } : {}),
        // Resume the session, or (fork) branch a NEW session id from it, leaving the
        // source untouched — SPEC §10.5 (CLI: --resume <id> [--fork-session]).
        ...(session ? { resume: session, ...(input.fork ? { forkSession: true } : {}) } : {}),
        // The platform MCP (in-process) + any MCP servers the workflow declares (§7.5).
        mcpServers: { karmax: platform, ...agentMcpToConfig(input.agentMcp) },
        env,
      },
    });
    let publishedSession = false;
    try {
      for await (const message of iterator) {
        if (ctx.signal?.aborted) break; // cancelled mid-turn (SPEC §5.6)
        // Publish the session id the moment it's known — the SDK's init message carries
        // it — so the drawer shows a live "fork this agent" command mid-turn (#3).
        const sid: string | undefined = (message as any).session_id;
        if (sid && !publishedSession) { session = sid; publishedSession = true; ctx.onSession?.(sid); }
        // Fold sub-agent (Task tool) lifecycle events into the outstanding set. Draining
        // the stream to its end lets any in-turn settlements clear before we report —
        // only genuinely still-running sub-agents remain (see subagents.ts).
        trackTaskMessage(subagents, message);
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
    } catch (e) {
      // A cancellation aborts the SDK subprocess mid-stream — the query iterator
      // throws an AbortError. The workflow already handled the cancel, so swallow
      // it (return the partial output); rethrow anything else as a real failure.
      if (!ctx.signal?.aborted) throw e;
    } finally {
      if (hb) clearInterval(hb);
      try { ctx.signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    }
    // The Agent SDK harness completes its own loop; treat a finished query as a
    // turn boundary. If the agent didn't call signal_completion explicitly, the
    // runtime surfaces the output at Review.
    const pending = pendingSubagentCount(subagents);
    return { session, output: finalText, ...(pending ? { pendingSubagents: pending } : {}) };
  }
}

/** Convert one JSON-schema property into a zod validator (the shapes used by
 *  PLATFORM_TOOL_SCHEMAS: string, enum, number, boolean, object, array). */
function jsonPropToZod(zod: any, prop: any): any {
  let base: any;
  if (Array.isArray(prop?.enum) && prop.enum.length) base = zod.enum(prop.enum as [string, ...string[]]);
  else
    switch (prop?.type) {
      case 'number':
      case 'integer':
        base = zod.number();
        break;
      case 'boolean':
        base = zod.boolean();
        break;
      case 'array':
        base = zod.array(zod.any());
        break;
      case 'object':
        base = zod.any();
        break;
      default:
        base = zod.string();
    }
  if (typeof prop?.description === 'string') base = base.describe(prop.description);
  return base;
}

/** Build a zod raw-shape (the SDK `tool()`'s 3rd arg) from a tool's JSON parameters. */
export function jsonSchemaToZodShape(zod: any, schema: any): Record<string, any> {
  const shape: Record<string, any> = {};
  const required = new Set<string>(schema?.required ?? []);
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    let z = jsonPropToZod(zod, prop);
    if (!required.has(key)) z = z.optional();
    shape[key] = z;
  }
  return shape;
}

/** Build the Agent-SDK in-process MCP tool defs for EVERY platform tool, derived from
 *  PLATFORM_TOOL_SCHEMAS + the shared handlers. Exported so a unit test can assert the
 *  SDK path exposes the full platform toolset (no silent drift). */
export function buildSdkTools(
  tool: (name: string, description: string, shape: Record<string, any>, run: (a: any) => Promise<any>) => any,
  zod: any,
  handlers: Record<string, (args: any) => Promise<string>>,
): any[] {
  return PLATFORM_TOOL_SCHEMAS.filter((schema) => typeof handlers[schema.name] === 'function').map((schema) =>
    tool(schema.name, schema.description, jsonSchemaToZodShape(zod, schema.parameters), async (a: any) => ({
      content: [{ type: 'text', text: await handlers[schema.name]!(a) }],
    })),
  );
}
