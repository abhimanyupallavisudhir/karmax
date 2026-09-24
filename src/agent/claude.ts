import { ReportedUsage } from '../timing/usage.js';
import { currentTiming, timed } from '../timing/index.js';
import { apiMcpTools } from '../mcp/connections/client.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput, RUNAWAY_BACKSTOP } from './types.js';
import { TOOL_SCHEMAS, PLATFORM_TOOL_SCHEMAS, SDK_CONTROL_TOOL_SCHEMAS, platformToolHandlers } from './tools.js';
import { CLAUDE_DEFAULT_MODEL, claudeMaxTokens, claudeMessagesEffort } from './effort.js';
import { anthropicUserContent, collectAnthropicImageBlocks } from './images.js';
import { messagesToDeliver, conversationToPromptText } from './history.js';
import { createFollowUpInjector, toSdkUserMessage, followUpContent } from './sdk-stream.js';
import { agentMcpToConfig } from '../contrib/manifests.js';
import { newSubagentTracker, trackTaskMessage, pendingSubagentCount, pendingBackgroundShellCount } from './subagents.js';
import {
  ProviderFailure,
  classifyLimitError,
  isTransportError,
  providerErrorFromMessage,
  providerFailure,
} from './limits.js';
import { spawn } from 'node:child_process';
import { createCustodyEnv, registerAgent, releaseAgent, killAgent } from './custody.js';
import { trackProcess } from '../util/processes.js';
import { activityDetail, claudeToolActivity, toolActivityDetail } from './activity.js';
import { hasClaudeNativeCredential, platformMcpSpec } from '../autonomy/config-homes.js';
import { isRemoteAgentWorld, remoteAgentEnv, seedRemoteAgentHome, spawnRemoteAgentProcess, type RemoteSpawnedProcess,
  syncRemoteAgentHomeBestEffort } from './remote-process.js';
import { worldWorkingDirectory } from '../world/types.js';
import { recoverClaudeToolInputs } from './claude-history.js';
import { ensureClaudeAccessTokenFresh, refreshClaudeAccessToken } from './usage.js';

/**
 * Claude provider adapter (SPEC §7.1, §9.1: the Claude Agent SDK / Messages API,
 * never the bare CLI). Two auth routes:
 *   - ANTHROPIC_API_KEY → the Messages API tool-use loop (this file).
 *   - ambient Claude Code login → the Agent SDK (same harness as Claude Code),
 *     loaded lazily so its absence never breaks the build.
 */
/** Messages-API tool definitions: every provider-neutral schema, Anthropic-shaped.
 *  Exported so the cross-rail control-tool coverage test reads the SAME list the
 *  rail sends rather than a restatement of it. */
export const MESSAGES_API_TOOLS = TOOL_SCHEMAS.map((t) => ({
  name: t.name, description: t.description, input_schema: t.parameters,
}));

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;

  static hasApiKey(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  static hasAmbientLogin(): boolean {
    try {
      const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
      return hasClaudeNativeCredential(dir);
    } catch {
      return false;
    }
  }

  async runTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    // Optional for compatibility with third-party adapters/test harnesses built
    // before structured timeline events were introduced.
    ctx.emitActivity ??= () => {};
    const auth = input.resolvedAuth;
    // Route on the turn's coordinator-resolved auth first:
    // an API key → the Messages API (metered); a config home → the subscription
    // login (Agent SDK). Only with no explicit lease material do we fall back to
    // the ambient environment.
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
    // Must match `defaultModel('claude')` — a model-less profile otherwise silently
    // lost its reasoning effort here (the old fallback, claude-sonnet-4-5, is real
    // but not effort-capable, so `claudeMessagesEffort` returned undefined for it).
    const model = input.profile.model ?? CLAUDE_DEFAULT_MODEL;
    (await (await currentTiming())?.mark('provider.selected', { provider: 'claude', model }));
    const mcp = await apiMcpTools(input.world, input.agentMcp, ctx.signal);
    try {
    const handlers = { ...platformToolHandlers(input.world, ctx), ...mcp.handlers };
    const tools = [...MESSAGES_API_TOOLS, ...mcp.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))];

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
      messages.push({ role: 'user', content: 'Begin the task described in the instructions.' });
    }

    const maxIters = input.maxTurns ?? input.profile.maxTurns ?? RUNAWAY_BACKSTOP;
    let finalText = '';
    const reportedUsage = new ReportedUsage();
    let terminalStatus: string | undefined;
    let terminalReason: string | undefined;
    // How many `input.messages` this turn has consumed. This path rebuilds the full
    // history each call (stateless), so it starts having delivered them all; follow-ups
    // that land mid-turn are folded in at the idle boundary below (SPEC §5.6).
    let deliveredIndex = input.messages.length;
    // Fold any follow-ups queued at/after `deliveredIndex` into the running exchange
    // as fresh user turns — same-activity injection so the agent keeps working instead
    // of ending the turn and re-running from scratch. Returns how many were added.
    const injectFollowUps = async (): Promise<number> => {
      if (!ctx.pullFollowUps) return 0;
      let added = 0;
      try {
        for (const m of await ctx.pullFollowUps(deliveredIndex)) {
          if (m.role !== 'system' && m.role !== 'agent') {
            messages.push({ role: 'user', content: anthropicUserContent(m) });
            added++;
          }
          deliveredIndex++;
        }
      } catch { /* a failed poll must never break the turn */ }
      return added;
    };

    for (let i = 0; i < maxIters; i++) {
      if (ctx.signal?.aborted) break; // cancelled mid-turn (SPEC §5.6)
      ctx.heartbeat?.(); // let Temporal deliver a pending cancellation
      const data = await timed('provider.roundtrip', async () => {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            // A whole coding response (a rewritten file, a long explanation + tool call)
            // can exceed 8192 output tokens; too low a cap truncates mid-response, which
            // the loop below then has to recover from at the cost of an extra billed
            // round trip. Derived per model (see effort.ts) instead of hard-coded.
            max_tokens: claudeMaxTokens(model),
            system: input.systemPrompt,
            messages,
            tools,
            // Reasoning effort (SPEC §10.5) — sent only on models that accept it.
            ...(claudeMessagesEffort(model, input.profile.effort) ? { output_config: { effort: claudeMessagesEffort(model, input.profile.effort) } } : {}),
          }),
          signal: ctx.signal,
        });
        if (!res.ok) {
          const message = `Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`;
          throw providerErrorFromMessage('claude', message, 'structured');
        }
        const data = (await res.json()) as any;
        (await (await currentTiming())?.markOnce('first.output'));
        return data;
      });
      // Usage accounting is required even when timing collection is absent.
      const roundUsage = reportedUsage.add(data.usage, 'claude');
      (await (await currentTiming())?.mark('provider.usage', roundUsage));
      messages.push({ role: 'assistant', content: data.content });
      const toolUses = (data.content ?? []).filter((b: any) => b.type === 'tool_use');
      const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (text) {
        finalText = text;
        ctx.emit(text, 'assistant');
        ctx.emitActivity({ id: `message-${i}`, kind: 'message', phase: 'completed', title: text });
      }
      if (toolUses.length === 0) {
        // A `max_tokens` cut-off is a TRUNCATED response, not a finished turn — the
        // model ran out of output budget mid-thought (often right after narrating an
        // action, before emitting its tool_use). Breaking here treats that chopped-off
        // preamble as completion, which surfaces the task at Review having done nothing
        // — the metered-path twin of the "agent just stopped" bug. Ask it to continue
        // instead; the enclosing maxIters loop bounds this so it can't spin forever.
        if (data.stop_reason === 'max_tokens') {
          messages.push({ role: 'user', content: 'Continue.' });
          continue;
        }
        if (data.stop_reason !== 'end_turn') {
          throw new Error(
            `Anthropic Messages turn did not complete successfully (stop_reason=${String(data.stop_reason ?? 'missing')})`,
          );
        }
        // The agent is idle. If a follow-up landed mid-turn, fold it in and keep going
        // in this same activity rather than ending the turn (SPEC §5.6); else finish.
        if (await injectFollowUps()) continue;
        terminalStatus = 'end_turn';
        terminalReason = data.stop_reason;
        break;
      }

      const toolResults: any[] = [];
      let completed = false;
      for (const use of toolUses) {
        const handler = handlers[use.name];
        ctx.emitActivity(claudeToolActivity(use, 'started'));
        const result = handler ? await handler(use.input ?? {}) : `unknown tool ${use.name}`;
        ctx.emitActivity(claudeToolActivity(use, 'completed', result));
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
        if (use.name === 'signal_completion') completed = true;
      }
      messages.push({ role: 'user', content: toolResults });
      if (completed) {
        terminalStatus = 'tool_use';
        terminalReason = 'signal_completion';
        break;
      }
    }

    if (ctx.signal?.aborted) throw new Error('Anthropic Messages turn cancelled');
    if (!terminalStatus) {
      throw new Error(`Anthropic Messages turn exceeded its ${maxIters}-iteration backstop without a successful terminal response`);
    }

    // The Messages API is stateless — there is no provider conversation id to
    // resume by, so we don't fabricate one (SPEC §10.5). Use the Agent SDK path
    // (ambient Claude Code login) for resumable sessions.
    return {
      termination: { kind: 'success', status: terminalStatus, ...(terminalReason ? { reason: terminalReason } : {}) },
      session: input.session,
      output: finalText,
      delivered: deliveredIndex,
      usage: reportedUsage.total(),
    };
    } finally { await mcp.close(); }
  }

  // ─── Claude Agent SDK (ambient Claude Code login) ───────────────────────────
  private async runAgentSdk(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const configHome = input.resolvedAuth?.configHome
      ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    input = { ...input, resolvedAuth: { ...input.resolvedAuth, configHome } };
    if (input.session) {
      const repaired = await recoverClaudeToolInputs({ session: input.session, configHome, world: input.world });
      if (repaired) {
        input = { ...input, session: repaired, fork: false };
        ctx.emitActivity?.({ id: 'claude-history-recovery', kind: 'status', phase: 'completed',
          title: 'Recovered imported Claude tool inputs; resuming a repaired copy' });
      }
    }
    if (!hasClaudeNativeCredential(configHome)) return this.runAgentSdkAttempt(input, ctx);
    let latestSession = input.session;
    let fork = input.fork;
    const retryCtx: PlatformToolContext = {
      ...ctx,
      onSession: (session) => { latestSession = session; fork = false; ctx.onSession?.(session); },
    };
    try {
      return await this.runAgentSdkAttempt(input, retryCtx);
    } catch (error) {
      // Native local refresh normally handles expiry; remote projections have
      // no refresh authority. Recover a terminal expiry once, before the
      // activity quarantines a refreshable login as a hard credential failure.
      if (ctx.signal?.aborted || !(error instanceof ProviderFailure)
        || error.metadata.kind !== 'credential'
        || !/\b(?:oauth|access) token\b.*\bexpired\b|\bexpired\b.*\b(?:oauth|access) token\b/i.test(error.message)) throw error;
      ctx.emitActivity({ id: 'claude-credential-recovery', kind: 'status', phase: 'started',
        title: 'Refreshing Claude access token' });
      try {
        await refreshClaudeAccessToken({ configHome });
      } catch (refreshError) {
        ctx.emitActivity({ id: 'claude-credential-recovery', kind: 'status', phase: 'failed',
          title: 'Could not refresh Claude access token',
          detail: activityDetail(refreshError instanceof Error ? refreshError.message : refreshError) });
        throw error;
      }
      if (ctx.signal?.aborted) throw error;
      ctx.emitActivity({ id: 'claude-credential-recovery', kind: 'status', phase: 'completed',
        title: 'Refreshed Claude access token; resuming turn' });
      return this.runAgentSdkAttempt({ ...input, ...(latestSession ? { session: latestSession, fork } : {}) }, retryCtx);
    }
  }

  private async runAgentSdkAttempt(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    let sdk: any;
    try {
      sdk = await import('@anthropic-ai/claude-agent-sdk');
    } catch (e) {
      // Distinguish "deps not installed" from the orphaned-instance signature
      // (karmax#3): a karmax booted from a task world keeps running after that
      // worktree is deleted post-merge, so this lazy import fails from a path
      // that no longer exists even though every real install has the SDK. Name
      // the actual problem — the 2026-07-09 incident burned a Resolve turn (and
      // a human) chasing a phantom missing dependency.
      const here = path.dirname(fileURLToPath(import.meta.url));
      if (!fs.existsSync(here)) {
        throw new Error(
          `krmax is running from a deleted directory (${here}) — an orphaned app instance, ` +
            `likely booted from a task world that has since merged and been removed (karmax#3). ` +
            `Kill this process (pid ${process.pid}); it is poisoning the shared task queue. ` +
            `Original error: ${String(e)}`,
        );
      }
      throw new Error(`Claude Agent SDK not installed: ${String(e)}`);
    }
    const { query, createSdkMcpServer, tool } = sdk;
    const zod = (await import('zod')).z;
    const handlers = platformToolHandlers(input.world, ctx);
    const remote = isRemoteAgentWorld(input.world);
    const configHome = input.resolvedAuth?.configHome;
    const remoteNativeLogin = !!(remote && configHome && hasClaudeNativeCredential(configHome));
    // Rotate the canonical host credential before projecting it. Mid-turn
    // expiry is handled by the bounded refresh-and-resume wrapper above.
    if (remoteNativeLogin) {
      let preflightStarted = false;
      try {
        const refreshed = await ensureClaudeAccessTokenFresh({
          configHome,
          onRefresh: () => {
            preflightStarted = true;
            ctx.emitActivity({
              id: 'claude-credential-preflight', kind: 'status', phase: 'started',
              title: 'Refreshing Claude login before remote turn',
            });
          },
        });
        if (refreshed) ctx.emitActivity({
          id: 'claude-credential-preflight', kind: 'status', phase: 'completed',
          title: 'Claude login refreshed for remote turn',
        });
      } catch (error) {
        if (preflightStarted) ctx.emitActivity({
          id: 'claude-credential-preflight', kind: 'status', phase: 'failed',
          title: 'Could not refresh Claude login for remote turn',
          ...(activityDetail(error instanceof Error ? error.message : error)
            ? { detail: activityDetail(error instanceof Error ? error.message : error) } : {}),
        });
        throw error;
      }
    }
    const remoteHome = remote
      ? await timed('bootstrap.home', () => seedRemoteAgentHome(input.world, 'claude', configHome ?? '', input.session, input.profile.mcpConnections === undefined ? undefined : 'none'))
      : undefined;
    // The SDK only sees a codeless exit when the sandbox stream drops; the
    // process knows the agent may still be running there (task 348).
    let remoteProcess: RemoteSpawnedProcess | undefined;

    // Only turn-local controls live in-process. Historically this SDK server and
    // the config-home stdio bridge were both registered as `karmax`; the SDK
    // instance shadowed the durable bridge and could lose its transport during a
    // continuation re-init, surfacing only "Stream closed". Separate names and
    // disjoint tool sets remove that collision.
    const controls = createSdkMcpServer({
      name: 'karmax_control',
      version: '1.0.0',
      // A remote CLI cannot launch the control plane's absolute stdio-MCP path.
      // Keep every platform/control tool in the SDK host process instead; the
      // Claude wire protocol already supports SDK MCP servers across custom spawn.
      tools: buildSdkTools(tool, zod, handlers, remote ? PLATFORM_TOOL_SCHEMAS : SDK_CONTROL_TOOL_SCHEMAS),
    });
    const configuredMcp = input.profile.mcpConnections === undefined ? configHomeMcpServers(input.resolvedAuth?.configHome) : {};
    if (input.profile.mcpConnections !== undefined) {
      delete configuredMcp['chrome-devtools']; delete configuredMcp.playwright;
    }
    if (input.profile.mcpConnections === undefined && remoteHome?.browserMcp) {
      delete configuredMcp['chrome-devtools'];
      delete configuredMcp.playwright;
      Object.assign(configuredMcp, remoteHome.browserMcp);
    }
    const { forwardEnv: _forwardEnv, ...platform } = platformMcpSpec(
      process.env.KARMAX_GATEWAY_URL ?? 'http://127.0.0.1:4505',
    );
    platform.env = {
      ...(platform.env ?? {}),
      ...(input.extraEnv?.KARMAX_TOKEN ? { KARMAX_TOKEN: input.extraEnv.KARMAX_TOKEN } : {}),
    };

    // Only the messages new since the resumed session last advanced (the whole
    // conversation on a fresh session) — the session already holds the rest, so
    // re-sending it would replay the agent's own past replies back at it (§7.2).
    const convo = messagesToDeliver(input).filter((m) => m.role !== 'system');
    // Attribute agent turns (`assistant:`) so a replayed full transcript — a fork, or
    // a resume whose provider session couldn't be reattached — never folds the agent's
    // OWN prior replies back in as fresh user input (§7.2). The initial delta collapses
    // to one user turn (text concatenated, images appended); later follow-ups arrive as
    // their own user messages via in-flight injection below.
    const userText = conversationToPromptText(convo) ||
      (input.session ? 'Continue from the latest instruction.' : 'Begin the task described in the system prompt.');
    const imageBlocks = collectAnthropicImageBlocks(convo);
    const initialContent: string | any[] = imageBlocks.length
      ? [...(userText ? [{ type: 'text', text: userText }] : []), ...imageBlocks]
      : userText;

    // Streaming-input mode (SPEC §5.6): the SDK's `prompt` is a live async iterable.
    // We yield the initial delta, keep the stream open, and inject follow-ups that land
    // in the workflow WHILE the turn runs — the SDK delivers each to the live agent at
    // its next turn boundary, exactly like a human typing mid-run in the CLI. With no
    // live channel (a resumed retry, or a unit test), we close right after the initial
    // message, collapsing to the old single-shot behaviour.
    //
    // `deliveredIndex` tracks how many `input.messages` this turn has consumed (the
    // initial delta covers everything up to the schedule snapshot); each injected
    // follow-up advances it, and it is reported back so the workflow positions the
    // agent's reply and advances its boundary past exactly what was delivered.
    let deliveredIndex = input.messages.length;
    const injector = createFollowUpInjector([toSdkUserMessage(initialContent)]);
    const promptArg: any = injector.stream;

    // Fetch + inject any follow-ups queued at/after `deliveredIndex`. Serialized by
    // `pollLock` so the interval poller and the idle-boundary poll can't double-count.
    let pollLock = false;
    const drainFollowUps = async (): Promise<number> => {
      if (!ctx.pullFollowUps || injector.closed || pollLock) return 0;
      pollLock = true;
      try {
        const news = await ctx.pullFollowUps(deliveredIndex);
        let injected = 0;
        for (const m of news) {
          // If the turn ended (injector closed) between the poll and here, leave the
          // rest for the NEXT turn — do NOT advance `deliveredIndex` past a message we
          // couldn't inject, or it would be marked delivered yet never reach the agent.
          if (injector.closed) break;
          // Mid-turn appends are follow-ups (user) or child-event notices (system).
          // Inject user messages into the live session; skip system (the real adapters
          // never send conversation system messages) — but count both so the index
          // stays aligned with the workflow's `msgs` array.
          if (m.role !== 'system' && m.role !== 'agent') {
            injector.push(toSdkUserMessage(followUpContent(m)));
            injected++;
          }
          deliveredIndex++;
        }
        return injected;
      } catch {
        return 0; // a failed poll must never break the turn
      } finally {
        pollLock = false;
      }
    };

    // Scrubbed, config-home-isolated env (SPEC §7.3).
    const { scrubbedEnv } = await import('../autonomy/config-homes.js');
    let env = scrubbedEnv({
      provider: 'claude',
      configHome: input.resolvedAuth?.configHome,
      // A captured setup-token login: re-supply it (scrubbedEnv strips it by default),
      // plus project secrets and JIT-resolved subprocess env (git credentials,
      // platform token). Karmax-owned values win on a name collision.
      extra: {
        ...(input.secretEnv ?? {}),
        ...(input.extraEnv ?? {}),
        ...(input.resolvedAuth?.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: input.resolvedAuth.oauthToken } : {}),
      },
    });
    if (remoteHome) env = remoteAgentEnv('claude', remoteHome.absolute, {
      ...env,
      KARMAX_GATEWAY_URL: process.env.KARMAX_PUBLIC_URL ?? process.env.KARMAX_GATEWAY_URL,
    }, Object.keys(input.secretEnv ?? {}));
    if (remoteHome?.runtimeBin) env.PATH = `${remoteHome.runtimeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

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

    // Poll the workflow for mid-turn follow-ups and inject them into the live session
    // (SPEC §5.6). With no live channel there's nothing to poll; the stream then just
    // carries the initial message and closes at the turn's terminal result below.
    let followPoll: ReturnType<typeof setInterval> | undefined;
    if (ctx.pullFollowUps) followPoll = setInterval(() => { void drainFollowUps(); }, 1200);

    let finalText = '';
    let session = input.session;
    let completionSeen = false; // agent called signal_completion → stop injecting, end the turn
    const toolActivities = new Map<string, ReturnType<typeof claudeToolActivity>>();
    // tool_use_id → the raw provider tool name, so the tool_result frame can apply
    // the same credential-bearing denylist the tool_use frame did (the result is
    // where `/api/vault/resolve`'s plaintext `value` actually arrives).
    const toolNames = new Map<string, string>();
    let successfulResult: any;
    // Track in-harness sub-agents (the Task tool). Claude Code auto-backgrounds long
    // sub-agents, so the main `result` can arrive — completion already signalled —
    // while a sub-agent is still running. We fold every task-lifecycle message in and
    // report the residual count so the workflow won't advance Do→Review mid-flight.
    const subagents = newSubagentTracker();
    // Ending the input stream closes the harness's stdin, and from that instant Claude
    // Code rejects EVERY control request with "Stream closed" (its `sendRequest` guards
    // on `inputClosed`). That channel carries the in-process `karmax_control` MCP tools
    // (create_review_info, signal_completion, …) and the `canUseTool` approver — so it
    // must outlive the agent's work, not just its first idle moment. And a `result` is
    // NOT reliably the end of the harness: while an in-harness sub-agent or backgrounded
    // shell is still running it keeps the session alive, folds the settlement back in,
    // and drives the agent through more exchanges. Closing there left agents working for
    // the rest of the turn against a dead control channel — the "Stream closed" reports.
    // So hold the stream open until a result arrives with nothing outstanding, bounded
    // because a backgrounded shell may be a dev server the task deliberately left running.
    const settleGraceMs = Number(process.env.KARMAX_AGENT_BG_SETTLE_MS ?? 300_000);
    let settleDeadline: number | undefined;
    const harnessStillWorking = (): boolean => {
      if (!subagents.size) return false;
      settleDeadline ??= Date.now() + settleGraceMs;
      return Date.now() < settleDeadline;
    };
    const startupEnd = (await (await currentTiming())?.start('process.sdk-startup.opaque'));
    const iterator = query({
      prompt: promptArg,
      options: {
        abortController,
        cwd: worldWorkingDirectory(input.world.handle),
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
        // Run on TOP of Claude Code's own system prompt, not instead of it. A bare
        // string here is a *custom* prompt that REPLACES the default (SDK docs:
        // "string - Use a custom system prompt"), stripping the claude_code harness
        // scaffolding — the persistence/anti-preamble conditioning that makes the CLI
        // keep working through "I'll apply the edit now."-style narration instead of
        // ending the turn. Without it the model reverts to conversational-assistant
        // behavior: it narrates intent, emits no tool call, and the SDK query ends —
        // which karmax records as a finished turn with completed:false → needsInput →
        // Review with an empty diff (the "agent just stopped" reports, only in karmax
        // and never in the CLI, because the CLI always runs this preset). We keep
        // karmax's own task/tooling instructions by APPENDING them to the preset.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemPrompt },
        ...(input.profile.model ? { model: input.profile.model } : {}),
        // Reasoning effort (SPEC §10.5); the SDK silently downgrades for models
        // that don't support the level, so no gating is needed here.
        ...(input.profile.effort ? { effort: input.profile.effort } : {}),
        // Resume the session, or (fork) branch a NEW session id from it, leaving the
        // source untouched — SPEC §10.5 (CLI: --resume <id> [--fork-session]).
        ...(session ? { resume: session, ...(input.fork ? { forkSession: true } : {}) } : {}),
        // Strict mode prevents the same on-disk `karmax` entry from being loaded
        // again. Re-declare the config home's other servers explicitly so its
        // selected browser/user servers are preserved.
        mcpServers: {
          ...configuredMcp,
          ...agentMcpToConfig(input.agentMcp),
          ...(!remote ? { karmax: { ...platform, alwaysLoad: true } } : {}),
          karmax_control: controls,
        },
        strictMcpConfig: true,
        env,
        // Spawn the agent harness ourselves (same call the SDK makes internally:
        // stdio ['pipe','pipe','ignore'], the SDK's forwarded abort signal) so the
        // subprocess pid is visible to karmax. That buys the two things the SDK's
        // opaque default spawn couldn't give us:
        //  - custody (src/agent/custody.ts): a pidfile + inherited marker (with
        //    the detached process group as fallback), so cleanup crosses tool-
        //    created sessions and a later boot can recover after SIGKILL;
        //  - the live task-manager registry (dashboard Processes panel), with the
        //    task attribution and an escalating kill.
        spawnClaudeCodeProcess: (o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
          if (remote && remoteHome) {
            const remoteEnv = remoteAgentEnv('claude', remoteHome.absolute, o.env,
              Object.keys(input.secretEnv ?? {}));
            if (remoteHome.runtimeBin) remoteEnv.PATH = `${remoteHome.runtimeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
            remoteProcess = spawnRemoteAgentProcess({
              world: input.world,
              provider: 'claude',
              command: o.command,
              args: o.args,
              cwd: worldWorkingDirectory(input.world.handle),
              env: remoteEnv,
              signal: o.signal,
            });
            return remoteProcess as any;
          }
          const custody = createCustodyEnv(o.env);
          const child = spawn(o.command, o.args, {
            cwd: o.cwd,
            env: custody.env,
            signal: o.signal,
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true,
            detached: true, // own process group remains the custody fallback
          });
          // The SDK attaches its own transport handling after this callback returns;
          // cover the spawn→return edge so an asynchronous ENOENT never becomes an
          // unhandled EventEmitter error in the host process.
          child.on('error', () => {});
          if (child.pid) {
            const pid = child.pid;
            registerAgent({ pid, cmd: o.command.split('/').pop() ?? o.command, provider: 'claude', taskId: input.world.handle.id, role: input.role, owner: process.pid, custodyId: custody.custodyId, startedAt: Date.now() });
            const untrack = trackProcess({
              pid,
              kind: 'agent',
              label: `claude agent (${input.role})`,
              taskId: input.world.handle.id,
              startedAt: Date.now(),
              kill: () => killAgent(pid, 2500, custody.custodyId),
            });
            child.once('exit', () => { untrack(); void releaseAgent(pid, custody.custodyId); });
          }
          return child;
        },
      },
    });
    let publishedSession = false;
    try {
      for await (const message of iterator) {
        (await startupEnd?.());
        (await (await currentTiming())?.markOnce('provider.first-event'));
        if (input.profile.mcpConnections !== undefined && message.type === 'system' && (message as any).subtype === 'init') {
          const inventory = (message as any).mcp_servers ?? [];
          const missing = (input.agentMcp ?? []).filter((s) => !inventory.some((c: any) => c.name === s.name && c.status === 'connected'));
          if (missing.length) throw new Error(`MCP connections could not start: ${missing.map((s) => s.name).join(', ')}. Check Agent tools settings.`);
        }
        if (ctx.signal?.aborted) break; // cancelled mid-turn (SPEC §5.6)
        // Publish the session id the moment it's known — the SDK's init message carries
        // it — so the drawer shows a live "fork this agent" command mid-turn (#3).
        const sid: string | undefined = (message as any).session_id;
        if (sid && !publishedSession) { session = sid; publishedSession = true; ctx.onSession?.(sid); }
        // Fold sub-agent (Task tool) lifecycle events into the outstanding set. Draining
        // the stream to its end lets any in-turn settlements clear before we report —
        // only genuinely still-running sub-agents remain (see subagents.ts).
        trackTaskMessage(subagents, message);
        if (!subagents.size) settleDeadline = undefined; // drained ⇒ a fresh grace for the next batch
        if (message.type === 'assistant') {
          const content = (message.message?.content ?? []) as any[];
          const text = content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');
          // Claude Code exposes provider failures on the assistant frame itself.
          // In task #183 a session limit arrived as `error: rate_limit`, followed by
          // a misleading SDK result (`subtype: success`, `is_error: true`,
          // `errors: ['completed']`). Waiting for that result erased the only useful
          // signal and routed the task to human escalation. Preserve the structured
          // error here, before the generic terminal-result handling can flatten it.
          const assistantError = (message as any).error ?? (message as any).message?.error;
          if (assistantError === 'rate_limit') {
            const cls = classifyLimitError(text, { providerOrigin: true });
            throw providerFailure(text || 'Claude usage limit reached', {
              kind: 'quota',
              permanence: 'transient',
              provider: 'claude',
              source: 'structured',
              window: cls.window ?? '5h',
              ...(cls.resetHint ? { resetHint: cls.resetHint } : {}),
              ...(cls.note ? { note: cls.note } : {}),
            });
          }
          if (assistantError === 'authentication_failed' || assistantError === 'oauth_org_not_allowed') {
            throw providerFailure(text || `Claude credential rejected (${assistantError})`, {
              kind: 'credential', permanence: 'hard', provider: 'claude', source: 'structured',
            });
          }
          if (assistantError === 'billing_error') {
            throw providerFailure(text || 'Claude billing account is unavailable', {
              kind: 'quota', permanence: 'hard', provider: 'claude', source: 'structured',
            });
          }
          if (assistantError === 'overloaded' || assistantError === 'server_error') {
            throw new Error(`Claude provider ${assistantError}: ${text || 'temporarily unavailable'}`);
          }
          if (assistantError === 'max_output_tokens') {
            // The response was cut at a mechanical output boundary. Retrying the
            // activity resumes the same provider session, so the agent continues
            // rather than asking a human to diagnose a token counter.
            throw new Error(`turn interrupted before completion: Claude reached max_output_tokens${text ? ` · ${text}` : ''}`);
          }
          // Claude Code sometimes carries the only real failure in a text block,
          // then emits the same misleading `success` / `completed` result envelope
          // seen with structured limits. Task #240 was exactly this shape:
          // "API Error: Connection closed mid-response" followed by a nominally
          // successful result. Preserve recognized transport failures before that
          // terminal frame can erase them. Requiring both the provider's API-error
          // prefix and our conservative transport classifier avoids treating an
          // agent merely discussing a connection error as a failed turn.
          if (/^\s*API Error:/i.test(text) && isTransportError(text)) {
            throw new Error(`Claude provider transport interruption: ${text}`);
          }
          if (/^\s*(?:Failed to authenticate\.\s*)?API Error:\s*401\b/i.test(text)) {
            throw providerErrorFromMessage('claude', text);
          }
          if (text) {
            finalText = text;
            ctx.emit(text, 'assistant');
            ctx.emitActivity({
              id: String((message as any).uuid ?? `message-${Date.now()}`),
              kind: 'message',
              phase: 'completed',
              title: text,
            });
          }
          for (const block of content) {
            if (block?.type === 'tool_use') {
              const activity = claudeToolActivity(block, 'started');
              toolActivities.set(activity.id, activity);
              toolNames.set(activity.id, String(block.name ?? ''));
              ctx.emitActivity(activity);
            }
            else if (block?.type === 'thinking') {
              const detail = activityDetail(block.thinking ?? block.text);
              ctx.emitActivity({
                id: String(block.signature ?? `${(message as any).uuid ?? 'thinking'}-thinking`),
                kind: 'reasoning',
                phase: 'completed',
                title: 'Reasoning',
                ...(detail ? { detail } : {}),
              });
            }
          }
          // The agent's explicit "I'm done" — a signal_completion tool call (the MCP
          // tool name is namespaced, e.g. `mcp__karmax__signal_completion`). Once seen,
          // stop injecting: the agent decided the turn is over, so a follow-up arriving
          // now belongs to the NEXT turn / Review, not crammed into this one.
          if (content.some((b: any) => b.type === 'tool_use' && /signal_completion$/.test(String(b.name ?? '')))) {
            completionSeen = true;
          }
        } else if (message.type === 'user') {
          const content = Array.isArray((message as any).message?.content) ? (message as any).message.content : [];
          for (const block of content) {
            if (block?.type !== 'tool_result') continue;
            const id = String(block.tool_use_id ?? 'tool-result');
            const detail = toolActivityDetail(toolNames.get(id), block.content ?? (message as any).tool_use_result);
            const prior = toolActivities.get(id);
            ctx.emitActivity({
              id,
              kind: prior?.kind ?? 'tool',
              phase: block.is_error ? 'failed' : 'completed',
              title: prior?.title ?? (block.is_error ? 'Tool failed' : 'Tool completed'),
              ...(detail ? { detail } : {}),
            });
          }
        } else if (message.type === 'rate_limit_event') {
          const info = (message as any).rate_limit_info;
          // `overageStatus: rejected` only says that paid overage is unavailable;
          // it is commonly paired with `status: allowed` while subscription quota
          // remains. Treating that informational field as a turn rejection parked
          // a login whose live /usage panel showed just 10% used (task #245).
          // Conversely, a rejected base window is still usable when the SDK says
          // overage is allowed/in use.
          const overageUsable = info?.overageStatus === 'allowed' || info?.overageStatus === 'allowed_warning'
            || info?.isUsingOverage === true || info?.overageInUse === true;
          if (info?.status === 'rejected' && !overageUsable) {
            const kind = String(info.rateLimitType ?? 'five_hour');
            const window = kind === 'five_hour' || kind === 'overage'
              ? '5h'
              : /^seven_day_(?:opus|sonnet)$/.test(kind) ? 'model' : 'weekly';
            const reset = Number(info.resetsAt);
            const resetMs = Number.isFinite(reset) ? (reset < 1_000_000_000_000 ? reset * 1000 : reset) : 0;
            const seconds = resetMs > Date.now() ? Math.ceil((resetMs - Date.now()) / 1000) : 0;
            throw providerFailure('Claude usage limit reached', {
              kind: 'quota', permanence: 'transient', provider: 'claude', source: 'structured', window,
              ...(seconds ? { resetHint: `in ${seconds}s` } : {}),
              ...(window === 'model' ? { note: kind.replace(/^seven_day_/, '') } : {}),
            });
          }
        } else if (message.type === 'tool_progress') {
          ctx.emitActivity({
            id: String((message as any).tool_use_id),
            kind: 'tool',
            phase: 'updated',
            title: String((message as any).tool_name ?? 'Tool call'),
            detail: `${Number((message as any).elapsed_time_seconds ?? 0).toFixed(1)}s elapsed`,
          });
        } else if (message.type === 'tool_use_summary') {
          ctx.emitActivity({
            id: String((message as any).preceding_tool_use_ids?.[0] ?? (message as any).uuid ?? 'tool-summary'),
            kind: 'tool',
            phase: 'updated',
            title: 'Tool activity',
            ...(activityDetail((message as any).summary) ? { detail: activityDetail((message as any).summary) } : {}),
          });
        } else if (message.type === 'system' && (message as any).subtype === 'status') {
          const status = (message as any).status;
          if (status) ctx.emitActivity({ id: 'claude-status', kind: 'status', phase: 'updated', title: status === 'compacting' ? 'Compacting conversation context' : 'Contacting Claude' });
        } else if (message.type === 'system' && (message as any).subtype === 'task_started' && !(message as any).skip_transcript) {
          ctx.emitActivity({
            id: String((message as any).task_id),
            kind: 'subagent',
            phase: 'started',
            title: String((message as any).description ?? 'Started sub-agent'),
            ...(activityDetail((message as any).prompt) ? { detail: activityDetail((message as any).prompt) } : {}),
          });
        } else if (message.type === 'system' && (message as any).subtype === 'task_progress') {
          ctx.emitActivity({
            id: String((message as any).task_id),
            kind: 'subagent',
            phase: 'updated',
            title: String((message as any).description ?? 'Sub-agent working'),
            ...(activityDetail((message as any).summary ?? (message as any).last_tool_name) ? { detail: activityDetail((message as any).summary ?? (message as any).last_tool_name) } : {}),
          });
        } else if (message.type === 'system' && (message as any).subtype === 'task_notification' && !(message as any).skip_transcript) {
          const failed = (message as any).status === 'failed';
          ctx.emitActivity({
            id: String((message as any).task_id),
            kind: 'subagent',
            phase: failed ? 'failed' : 'completed',
            title: String((message as any).summary ?? `Sub-agent ${(message as any).status}`),
          });
        } else if (message.type === 'system' && (message as any).subtype === 'permission_denied') {
          ctx.emitActivity({
            id: String((message as any).tool_use_id),
            kind: 'tool',
            phase: 'failed',
            title: `${String((message as any).tool_name ?? 'Tool')} denied`,
            ...(activityDetail((message as any).message) ? { detail: activityDetail((message as any).message) } : {}),
          });
        } else if (message.type === 'result') {
          session = message.session_id ?? session;
          const result = message as any;
          if (result.subtype !== 'success' || result.is_error === true) {
            const detail = Array.isArray(result.errors) ? result.errors.join('; ') : result.error ?? result.terminal_reason ?? '';
            const message =
              `Claude Agent SDK turn failed (${String(result.subtype ?? 'unknown')}): ` +
              String(detail || 'provider reported an unsuccessful result');
            throw providerErrorFromMessage('claude', message);
          }
          successfulResult = result;
          // The agent went idle (finished responding to its current input). End the
          // turn — UNLESS a follow-up landed in the meantime and the agent hasn't
          // declared completion, in which case inject it and let the session continue
          // in-place rather than tearing down and resuming on a fresh turn — or the
          // harness still has work in flight that will drive the agent again, in which
          // case the input stream (and with it the control channel) stays open.
          if ((completionSeen || !(await drainFollowUps())) && !harnessStillWorking()) {
            (await injector.close());
          }
        }
      }
    } catch (e) {
      // A cancellation aborts the SDK subprocess mid-stream — the query iterator
      // throws an AbortError. The workflow already handled the cancel, so swallow
      // it (return the partial output); rethrow anything else as a real failure.
      if (!ctx.signal?.aborted) {
        if (e instanceof ProviderFailure) throw e;
        if (remoteProcess?.lost) throw remoteProcess.lost;
        const message = e instanceof Error ? e.message : String(e);
        const classified = providerErrorFromMessage('claude', message);
        if (classified instanceof ProviderFailure || !(e instanceof Error)) throw classified;
        throw e; // preserve the original stack for unrelated SDK failures
      }
    } finally {
      if (hb) clearInterval(hb);
      if (followPoll) clearInterval(followPoll);
      (await injector.close()); // release the input stream so the SDK subprocess can't wedge open
      try { ctx.signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
      if (remoteHome && input.resolvedAuth?.configHome) {
        const failure = await syncRemoteAgentHomeBestEffort(input.world, 'claude', remoteHome, input.resolvedAuth.configHome);
        if (failure) ctx.emitActivity({
          id: 'claude-remote-state-sync', kind: 'error', phase: 'failed',
          title: 'Could not preserve remote Claude state', detail: failure.message.slice(0, 1000),
        });
      }
    }
    if (ctx.signal?.aborted) throw new Error('Claude Agent SDK turn cancelled');
    if (!successfulResult) {
      if (remoteProcess?.lost) throw remoteProcess.lost;
      throw new Error('Claude Agent SDK stream ended unexpectedly without a successful result event');
    }
    // Only a subtype=success result is a turn boundary. `delivered` = every message
    // this turn consumed (initial delta + in-flight injections).
    const pending = pendingSubagentCount(subagents);
    const pendingShells = pendingBackgroundShellCount(subagents);
    return {
      termination: {
        kind: 'success',
        status: 'success',
        ...((successfulResult.terminal_reason ?? successfulResult.stop_reason)
          ? { reason: String(successfulResult.terminal_reason ?? successfulResult.stop_reason) }
          : {}),
      },
      session,
      output: finalText,
      delivered: deliveredIndex,
      usage: (() => {
        const reported = new ReportedUsage();
        reported.add(successfulResult.usage, 'claude');
        return reported.total();
      })(),
      ...(pending ? { pendingSubagents: pending } : {}),
      ...(pendingShells ? { pendingBackgroundShells: pendingShells } : {}),
    };
  }
}

/** Convert one JSON-schema property into a zod validator (the shapes used by
 *  PLATFORM_TOOL_SCHEMAS: string, enum, number, boolean, object, array).
 *
 *  Nested `items` / `properties` are converted **recursively**. Collapsing them to
 *  `any` erased the member field names from the schema the model is shown — e.g.
 *  `create_review_info.actions` surfaced as `items: {}` even though its source
 *  schema fully specifies `kind`/`label`/`command`/`server`/`openUrls` — so the
 *  model had to guess the shape and its actions were silently discarded. */
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
        base = zod.array(prop.items ? jsonPropToZod(zod, prop.items) : zod.unknown());
        break;
      case 'object':
        // Unknown keys are preserved rather than stripped: a tool boundary should
        // not silently discard arguments it failed to describe.
        base = prop.properties
          ? zod.looseObject(jsonSchemaToZodShape(zod, prop))
          : zod.record(zod.string(), zod.unknown());
        break;
      case 'string':
        base = zod.string();
        break;
      default:
        // No declared type is an empty schema — "anything goes". Coercing it to
        // `string()` rejected structured arguments outright.
        base = zod.unknown();
    }
  // JSON Schema measures maxLength in Unicode code points, while Zod's `.max()`
  // currently uses JavaScript UTF-16 code units. Refine explicitly so the SDK
  // path agrees with the provider schemas and the shared tool handler.
  if (prop?.type === 'string' && Number.isInteger(prop?.maxLength)) {
    base = base.refine((value: string) => [...value].length <= prop.maxLength, {
      message: `Too big: expected string to have <=${prop.maxLength} characters`,
    });
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

/** Read a config home's MCP servers so strict SDK isolation can preserve its
 * browser/user servers while replacing the on-disk karmax entry for this turn. */
export function configHomeMcpServers(home: string | undefined): Record<string, any> {
  if (!home) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    if (!parsed?.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) return {};
    const { karmax: _karmax, karmax_control: _karmaxControl, ...others } = parsed.mcpServers;
    return others;
  } catch {
    return {};
  }
}

/** Build in-process defs only for turn-local controls. Durable platform tools are
 * intentionally served by the stdio karmax MCP, never registered a second time. */
export function buildSdkTools(
  tool: (name: string, description: string, shape: Record<string, any>, run: (a: any) => Promise<any>) => any,
  zod: any,
  handlers: Record<string, (args: any) => Promise<string>>,
  schemas = SDK_CONTROL_TOOL_SCHEMAS,
): any[] {
  return schemas.filter((schema) => typeof handlers[schema.name] === 'function').map((schema) =>
    tool(schema.name, schema.description, jsonSchemaToZodShape(zod, schema.parameters), async (a: any) => ({
      content: [{ type: 'text', text: await handlers[schema.name]!(a) }],
    })),
  );
}
