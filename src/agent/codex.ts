import { workEnvironment, codexWorkProfile } from './work-environment.js';
import { ReportedUsage } from '../timing/usage.js';
import { readOpenAiResponse, readStreamOnceMore } from './api-streams.js';
import { currentTiming, timed } from '../timing/index.js';
import { platformMcpSpec } from '../autonomy/config-homes.js';
import { selectedCodexMcpFlags } from '../mcp/connections/codex-selection.js';
import { apiMcpTools } from '../mcp/connections/client.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput, RUNAWAY_BACKSTOP } from './types.js';
import { PLATFORM_TOOL_SCHEMAS, SDK_CONTROL_TOOL_SCHEMAS, TOOL_SCHEMAS, platformToolHandlers } from './tools.js';
import { CONTROL_SERVER_NAME, controlMcpServerSpec, startControlBridge } from './control-bridge.js';
import { codexReasoningEffort } from './effort.js';
import { openaiUserContent, materializeImageFiles } from './images.js';
import { messagesToDeliver, conversationToPromptText } from './history.js';
import { scrubbedEnv } from '../autonomy/config-homes.js';
import { createCustodyEnv, registerAgent, releaseAgent, killAgent } from './custody.js';
import { trackProcess } from '../util/processes.js';
import {
  apiThrottle,
  classifyLimitError,
  nativeProviderDiagnostic,
  providerErrorFromMessage,
  providerFailure,
  providerFailureDisplay,
  ProviderFailure,
  ProviderStreamError,
  ProviderOutage,
  ProviderPolicyFailure,
  isProviderPolicyRejection,
  type ProviderFailureMetadata,
} from './limits.js';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { activityDetail, codexItemActivity, toolActivityDetail } from './activity.js';
import { ensureRemoteCodexSessionTools, isRemoteAgentWorld, remoteAgentEnv, seedRemoteAgentHome,
  spawnRemoteAgentProcess, syncRemoteAgentHomeBestEffort } from './remote-process.js';
import { worldWorkingDirectory } from '../world/types.js';
import { prepareCodexHistory } from './codex-history.js';
import { readLocalCodexHistory, installLocalCodexSnapshot, publishLocalCodexHistory } from './codex-history-files.js';
import { localProviderCli } from './provider-cli.js';
import { withTimeout } from '../util/timeout.js';
import { utf8Tail } from '../util/utf8-tail.js';
import { ensureCodexLoginFresh, refreshCodexLogin } from './usage.js';
import { BRAND } from '../domain/brand.js';

/**
 * Codex/OpenAI provider adapter (SPEC §7.1). Two rails, chosen per profile:
 *   - **API key** → the OpenAI **Responses API** (metered, pay-per-token). The
 *     session id we store/resume is the provider's `response.id`.
 *   - **Subscription** (ChatGPT sign-in) → the **`codex app-server`**, a long-lived
 *     JSON-RPC process driven over stdio with `CODEX_HOME` = the leased config home,
 *     so the turn runs on the user's ChatGPT plan (5-hour + weekly windows) — the
 *     analogue of Claude's Agent-SDK path. Unlike one-shot `codex exec`, the
 *     app-server keeps a live thread we can **steer mid-turn** (`turn/steer`), which
 *     is what gives the subscription path in-flight follow-up injection (SPEC §5.6).
 *     Threads persist under `$CODEX_HOME` and power resume. The old `codex exec` path
 *     is kept as a fallback (`KARMAX_CODEX_USE_EXEC=1`, or older CLIs without app-server).
 */
/** Responses-API function tools: every provider-neutral schema, flat-shaped.
 *  Exported so the cross-rail control-tool coverage test reads the SAME list the
 *  rail sends rather than a restatement of it. */
export const RESPONSES_API_TOOLS = TOOL_SCHEMAS.map((t) => ({
  type: 'function', name: t.name, description: t.description, parameters: t.parameters,
}));

/** A terminal OAuth-expiry/unauthorized signal is revalidated once through the
 * canonical host authority. Invalid keys, explicitly revoked grants, and wrong
 * scopes still require a human; the retry is bounded so a persistent 401 is not
 * hidden. */
export function isRecoverableRemoteCodexCredentialFailure(error: unknown): boolean {
  if (!(error instanceof ProviderFailure) || error.metadata.kind !== 'credential') return false;
  const diagnostic = error.metadata.diagnostic;
  const code = String(diagnostic?.code ?? '').toLowerCase();
  const message = String(diagnostic?.message ?? error.message).toLowerCase();
  if (/^(?:invalid_api_key|revoked|insufficient_scope)$/.test(code)) return false;
  return /^(?:token_expired|expired_token|access_token_expired)$/.test(code)
    // A remote process can only attempt to rotate Karmax's inert marker. The
    // canonical host may still refresh successfully, so revalidate there once.
    || code === 'invalid_grant'
    || code === 'unauthorized'
    || (diagnostic?.status === 401 && code === 'other'
      && /missing bearer or basic authentication(?: in (?:the )?header)?/.test(message))
    || (diagnostic?.status === 401 && /\b(?:access|authentication|oauth)?\s*token\b.*\bexpired\b|\bexpired\b.*\btoken\b/.test(message));
}

/**
 * The app-server `dynamicTools` registration — tools the server asks US to
 * execute over `item/tool/call`, i.e. tools that run inside this activity.
 *
 *  · remote world → every platform tool, because a Codex CLI running inside a
 *    cloud sandbox cannot launch the host's absolute stdio `karmax` MCP path.
 *  · local world → only the TURN-LOCAL controls. The durable platform tools are
 *    already served by the config home's gateway-backed `karmax` MCP under the
 *    turn's scoped token; registering them twice would give the model two doors
 *    to the same operation. This mirrors the Claude Agent-SDK rail exactly
 *    (`remote ? PLATFORM_TOOL_SCHEMAS : SDK_CONTROL_TOOL_SCHEMAS`).
 */
export function codexDynamicTools(remote: boolean): Array<{ type: string; name: string; description: string; inputSchema: unknown }> {
  return (remote ? PLATFORM_TOOL_SCHEMAS : SDK_CONTROL_TOOL_SCHEMAS).map((tool) => ({
    type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters,
  }));
}

/** Return a tools-compatible session without rewriting a rollout that another
 * thread may reference. Invalid native history fails before starting a turn. */
export async function ensureLocalCodexSessionTools(configHome: string, session: string, dynamicTools?: unknown[]): Promise<string> {
  const sources = new Map<string, ReturnType<typeof readLocalCodexHistory>>();
  const snapshot = await prepareCodexHistory(session, async (id) => {
    const source = readLocalCodexHistory(configHome, id); sources.set(id, source); return source;
  }, { dynamicTools });
  if (snapshot) return installLocalCodexSnapshot(configHome, session, snapshot);
  for (const [id, source] of sources) publishLocalCodexHistory(configHome, source, id);
  return session;
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;

  static hasApiKey(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  /** A Codex **subscription** (ChatGPT sign-in) present — `auth.json` in the active
   *  CODEX_HOME (or ~/.codex). Distinct from an API key. */
  static hasAmbientSubscription(): boolean {
    try {
      const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
      return fs.existsSync(path.join(home, 'auth.json'));
    } catch {
      return false;
    }
  }

  async runTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    ctx.emitActivity ??= () => {};
    const auth = input.resolvedAuth;
    // Route on the PROFILE's resolved auth first: an API key → Responses API; a
    // config home → the Codex CLI on a subscription. Only with no explicit profile
    // auth do we fall back to the ambient environment.
    if (auth?.apiKey) return this.runResponsesApi(input, ctx);
    if (auth?.configHome) return this.runSubscription(input, ctx);
    if (process.env.OPENAI_API_KEY) return this.runResponsesApi(input, ctx);
    if (CodexAdapter.hasAmbientSubscription()) return this.runSubscription(input, ctx);
    throw new Error('CodexAdapter: no OPENAI_API_KEY and no Codex login found');
  }

  /** The ChatGPT-subscription rail: the app-server (live, steerable) by default, or
   *  the legacy one-shot `codex exec` when forced via `KARMAX_CODEX_USE_EXEC`. */
  private async runSubscription(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    try { return await this.runSubscriptionWithRecovery(input, ctx); }
    catch (error) {
      // A sandbox controls its PTY bytes. Preserve its turn failure, but shared
      // account health must come from a host-side provider request or probe.
      if (isRemoteAgentWorld(input.world) && (error instanceof ProviderFailure || error instanceof ProviderStreamError))
        throw new Error(error.message, { cause: error });
      throw error;
    }
  }

  private async runSubscriptionWithRecovery(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    if (process.env.KARMAX_CODEX_USE_EXEC === '1' && !isRemoteAgentWorld(input.world)) return this.runCodexExec(input, ctx);
    const remote = isRemoteAgentWorld(input.world);
    const configHome = input.resolvedAuth?.configHome;
    if (!remote || !configHome) return this.runCodexAppServer(input, ctx);

    let latestSession = input.session;
    let fork = input.fork;
    const retryCtx: PlatformToolContext = {
      ...ctx,
      onSession: (session) => {
        latestSession = session;
        fork = false;
        ctx.onSession?.(session);
      },
    };
    // A remote projection cannot refresh itself and current Codex treats an
    // expired ID token as logged out even while its access token remains valid.
    // Revalidate centrally before launching so routine one-hour expiry never
    // consumes a model turn or quarantines a healthy shared login.
    let preflightStarted = false;
    try {
      const refreshed = await ensureCodexLoginFresh({
        configHome,
        onRefresh: () => {
          preflightStarted = true;
          ctx.emitActivity({
            id: 'codex-credential-preflight', kind: 'status', phase: 'started',
            title: 'Refreshing Codex login before remote turn',
          });
        },
      });
      if (refreshed) ctx.emitActivity({
        id: 'codex-credential-preflight', kind: 'status', phase: 'completed',
        title: 'Codex login refreshed for remote turn',
      });
    } catch (error) {
      if (preflightStarted) ctx.emitActivity({
        id: 'codex-credential-preflight', kind: 'status', phase: 'failed',
        title: 'Could not refresh Codex login for remote turn',
        ...(activityDetail(error instanceof Error ? error.message : error)
          ? { detail: activityDetail(error instanceof Error ? error.message : error) } : {}),
      });
      throw error;
    }
    // The sandbox intentionally receives no rotating refresh token (only an
    // inert login-state marker). If its projection loses auth, recover through
    // the canonical home below;
    // valid turns pay no extra provider process or metadata request.
    try {
      return await this.runCodexAppServer(input, retryCtx);
    } catch (error) {
      if (ctx.signal?.aborted || !isRecoverableRemoteCodexCredentialFailure(error)) throw error;
      ctx.emitActivity({
        id: 'codex-credential-recovery', kind: 'status', phase: 'started',
        title: 'Revalidating Codex access token',
      });
      try {
        await refreshCodexLogin({ configHome, force: true });
      } catch (refreshError) {
        ctx.emitActivity({
          id: 'codex-credential-recovery', kind: 'status', phase: 'failed',
          title: 'Could not revalidate Codex access token',
          ...(activityDetail(refreshError instanceof Error ? refreshError.message : refreshError)
            ? { detail: activityDetail(refreshError instanceof Error ? refreshError.message : refreshError) } : {}),
        });
        throw error;
      }
      if (ctx.signal?.aborted) throw error;
      ctx.emitActivity({
        id: 'codex-credential-recovery', kind: 'status', phase: 'completed',
        title: 'Refreshed Codex access token; resuming turn',
      });
      try {
        return await this.runCodexAppServer({ ...input, ...(latestSession ? { session: latestSession, fork } : {}) }, retryCtx);
      } catch (retryError) {
        // The host just refreshed this login and read its account with the new
        // token, so a model request still rejected with a credential error is
        // OpenAI's fault, not the login's. On 2026-09-25 chatgpt.com answered
        // every ChatGPT login with 401 invalid_api_key (openai/codex#48237);
        // the sandbox could only report that its inert refresh marker failed.
        if (ctx.signal?.aborted || !isRecoverableRemoteCodexCredentialFailure(retryError)) throw retryError;
        throw new ProviderOutage('OpenAI is rejecting Codex model requests even though this ChatGPT login is valid '
          + `(it refreshed and read its account just now). This is an OpenAI-side outage; ${BRAND} will keep retrying.`,
          { cause: retryError });
      }
    }
  }

  // ─── OpenAI Responses API (API key, metered) ────────────────────────────────
  private async runResponsesApi(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const apiKey = input.resolvedAuth?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('CodexAdapter: OPENAI_API_KEY not set');
    const baseUrl = process.env.KARMAX_OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const model = input.profile.model ?? 'gpt-5.5';
    (await (await currentTiming())?.mark('provider.selected', { provider: 'codex', model }));
    const mcp = await apiMcpTools(input.world, input.agentMcp, ctx.signal);
    try {
    const handlers = { ...platformToolHandlers(input.world, ctx, () => workEnvironment(input)), ...mcp.handlers };
    // Responses API function tools are flat ({type:'function', name, ...}).
    const tools = [...RESPONSES_API_TOOLS, ...mcp.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }))];

    // On a fresh session, replay the full conversation so a login switch (which
    // drops the server-bound previous_response_id) doesn't lose context; when
    // continuing the same session, send only the messages new since it last
    // advanced (the rest is carried server-side by previous_response_id).
    let respId: string | undefined = input.session; // resume from a prior response id
    let reportedSession: string | undefined; // last id handed to ctx.onSession (fire once per change)
    const convo = messagesToDeliver(input).filter((m) => m.role !== 'system');
    let nextInput: any[] = convo.length
      ? convo.map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.role === 'agent' ? m.text : openaiUserContent(m) }))
      : [{ role: 'user', content: respId ? 'Continue.' : 'Begin the task described in the instructions.' }];

    // Turn cap is optional: unset ⇒ effectively unlimited (a high runaway backstop
    // only, so a pathological infinite tool-loop can't burn unbounded spend).
    const maxIters = input.maxTurns ?? input.profile.maxTurns ?? RUNAWAY_BACKSTOP;
    let finalText = '';
    const reportedUsage = new ReportedUsage();
    let completionPending = false;
    let terminalStatus: string | undefined;
    let terminalReason: string | undefined;
    // How many `input.messages` this turn has consumed (the initial delta covers up to
    // the schedule snapshot); follow-ups that land mid-turn are folded in at the idle
    // boundary as fresh user input on the resumed response chain (SPEC §5.6).
    let deliveredIndex = input.messages.length;
    const injectFollowUps = async (): Promise<any[]> => {
      if (!ctx.pullFollowUps) return [];
      const add: any[] = [];
      try {
        for (const m of await ctx.pullFollowUps(deliveredIndex)) {
          if (m.role !== 'system' && m.role !== 'agent') add.push({ role: 'user', content: openaiUserContent(m) });
          deliveredIndex++;
        }
      } catch { /* a failed poll must never break the turn */ }
      return add;
    };

    for (let i = 0; i < maxIters || (i === maxIters && completionPending); i++) {
      if (ctx.signal?.aborted) break; // cancelled mid-turn (SPEC §5.6)
      ctx.heartbeat?.(); // let Temporal deliver a pending cancellation
      // `instructions` is NOT carried across `previous_response_id` — the
      // Responses API drops the prior turn's instructions. Sending it only on
      // the first call meant a multi-step tool-using turn lost its entire system
      // prompt (task, world path, wiki context, role template) after the very
      // first model call, and a resumed turn never sent it at all. Always send
      // it, alongside the chain id. (Claude's metered path does the same.)
      // `stream`: text reaches the task as it is generated (LT-5); the terminal
      // event carries the same response object the non-streaming call returns.
      const body: any = { model, tools, tool_choice: completionPending ? 'none' : 'auto', store: true, stream: true, input: nextInput, instructions: input.systemPrompt };
      if (respId) body.previous_response_id = respId;
      // Reasoning effort (SPEC §10.5) — only reasoning models accept it (not gpt-4.1).
      const reasoningEffort = codexReasoningEffort(model, input.profile.effort);
      if (reasoningEffort) body.reasoning = { effort: reasoningEffort };

      const data = await timed('provider.roundtrip', () => readStreamOnceMore('OpenAI Responses API', async () => {
        const res = await fetch(`${baseUrl}/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: ctx.signal,
      });
      if (!res.ok) {
        const message = `OpenAI Responses API ${res.status}: ${(await res.text()).slice(0, 500)}`;
        throw providerErrorFromMessage('codex', message, 'structured', apiThrottle(res));
      }
      const data = await readOpenAiResponse(res, (text) => ctx.emit(text, 'assistant'));
      (await (await currentTiming())?.markOnce('first.output'));
      return data;
      }));
      // Usage accounting is required even when timing collection is absent.
      const roundUsage = reportedUsage.add(data.usage, 'codex');
      (await (await currentTiming())?.mark('provider.usage', roundUsage));
      respId = data.id ?? respId;
      // Checkpoint the session as soon as we have one. This is the sole writer of
      // the crash-resume record: without it a worker restart or heartbeat timeout
      // mid-turn replays the whole turn from the *previous* turn's response id,
      // re-running every tool call already executed this turn. Every other
      // adapter does this; this rail was the only one that didn't.
      if (respId && respId !== reportedSession) { reportedSession = respId; ctx.onSession?.(respId); }
      if (data.status !== 'completed') {
        const reason = data.incomplete_details?.reason ?? data.error?.message ?? data.error?.code ?? 'no reason supplied';
        // Hitting an output boundary is an interruption, not a failure: the
        // response chain survives, so the retry resumes it. Phrase it with the
        // prefix isTransportError() recognises so it classifies as a retryable
        // `agent-infra`, matching ACP and both Claude paths. Anything else is a
        // genuine non-retryable provider error.
        if (data.incomplete_details?.reason === 'max_output_tokens' || data.status === 'incomplete') {
          throw providerErrorFromMessage('codex',
            `turn interrupted before completion: ${String(reason)}`, 'structured');
        }
        const message = `OpenAI Responses turn did not complete successfully (status=${String(data.status ?? 'missing')}): ${String(reason)}`;
        throw providerErrorFromMessage('codex', message, 'structured');
      }

      const outputs: any[] = data.output ?? [];
      const calls = outputs.filter((o) => o.type === 'function_call');
      if (completionPending && calls.length)
        throw new Error('OpenAI Responses completion acknowledgement unexpectedly requested tools');
      const text = outputs
        .filter((o) => o.type === 'message')
        .flatMap((m: any) => (m.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text))
        .join('\n');
      if (text) {
        finalText = text;
        ctx.emit(text, 'assistant');
        ctx.emitActivity({ id: `response-${respId}-${i}`, kind: 'message', phase: 'completed', title: text });
      }
      if (calls.length === 0) {
        // Idle. Fold in any follow-up that landed mid-turn and keep going on the same
        // response chain (previous_response_id carries the history); else finish.
        const more = completionPending ? [] : await injectFollowUps();
        if (more.length) { nextInput = more; continue; }
        terminalStatus = data.status;
        terminalReason = completionPending ? 'signal_completion' : data.incomplete_details?.reason;
        break;
      }

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
        // `toolActivityDetail` suppresses the detail outright for credential-bearing
        // tools — a get_credential result carries the approved plaintext reveal.
        const startedDetail = toolActivityDetail(call.name, args);
        ctx.emitActivity({
          id: String(call.call_id ?? `${call.name}-${i}`),
          kind: 'tool',
          phase: 'started',
          title: String(call.name ?? 'Tool call'),
          ...(startedDetail ? { detail: startedDetail } : {}),
        });
        let result: unknown;
        let failed = false;
        try {
          if (!handler) throw new Error(`unknown tool ${call.name}`);
          result = await handler(args);
        } catch (error) {
          failed = true;
          result = { is_error: true, error: error instanceof Error ? error.message : String(error) };
        }
        const doneDetail = toolActivityDetail(call.name, result);
        ctx.emitActivity({
          id: String(call.call_id ?? `${call.name}-${i}`),
          kind: 'tool',
          phase: 'completed',
          title: String(call.name ?? 'Tool call'),
          ...(doneDetail ? { detail: doneDetail } : {}),
        });
        toolOutputs.push({ type: 'function_call_output', call_id: call.call_id, output: typeof result === 'string' ? result : JSON.stringify(result) });
        if (!failed && call.name === 'signal_completion') completed = true;
      }
      nextInput = toolOutputs;
      // A response containing function calls cannot be resumed until every
      // output is submitted. Acknowledge completion with tools disabled, even
      // at the iteration cap, before returning a resumable session.
      if (completed) completionPending = true;
    }

    if (ctx.signal?.aborted) throw new Error('OpenAI Responses turn cancelled');
    if (!terminalStatus) {
      throw new Error(`OpenAI Responses turn exceeded its ${maxIters}-iteration backstop without a successful terminal response`);
    }

    return {
      termination: { kind: 'success', status: terminalStatus, ...(terminalReason ? { reason: terminalReason } : {}) },
      session: respId,
      output: finalText,
      delivered: deliveredIndex,
      usage: reportedUsage.total(),
    };
    } finally { try { await mcp.close(); } catch { /* cleanup must not replace the turn outcome */ } }
  }

  // ─── Codex app-server on a ChatGPT subscription (live JSON-RPC thread) ────────
  private async runCodexAppServer(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const runtimeWorld = input.world.withoutProjectEnvironment?.() ?? input.world;
    const workEnv = workEnvironment(input);
    const workConfig = { 'shell_environment_policy.set': workEnv };
    const cmd = process.env.KARMAX_CODEX_EXEC_CMD ?? localProviderCli('codex');
    const model = input.profile.model ?? undefined;
    (await (await currentTiming())?.mark('provider.selected', { provider: 'codex', model }));
    const effort = codexReasoningEffort(model ?? 'gpt-5.5', input.profile.effort);
    const cwd = worldWorkingDirectory(runtimeWorld.handle);
    // CODEX_HOME = the leased config home (its auth.json holds the subscription
    // login). scrubbedEnv also strips OPENAI_API_KEY so a stray key can't shadow it.
    const remote = isRemoteAgentWorld(runtimeWorld);
    const remoteHome = remote
      ? await timed('bootstrap.home', () => seedRemoteAgentHome(runtimeWorld, 'codex', input.resolvedAuth?.configHome ?? '', input.session, input.profile.mcpConnections === undefined ? undefined : 'none'))
      : undefined;
    const dynamicTools = codexDynamicTools(remote);
    // Resume/fork cannot override dynamicTools. Migrate into a new rollout
    // identity instead of changing bytes referenced by existing descendants.
    let preparedSession = input.session;
    if (remoteHome && input.session)
      preparedSession = await timed('bootstrap.session-tools', () => ensureRemoteCodexSessionTools(runtimeWorld, remoteHome, input.session!, dynamicTools)) ?? input.session;
    else if (!remote && input.session && input.resolvedAuth?.configHome)
      preparedSession = await ensureLocalCodexSessionTools(input.resolvedAuth.configHome, input.session, dynamicTools) ?? input.session;
    let env = scrubbedEnv({ provider: 'codex', configHome: input.resolvedAuth?.configHome,
      extra: input.extraEnv });
    if (remoteHome) env = remoteAgentEnv('codex', remoteHome.absolute, {
      ...env,
      KARMAX_GATEWAY_URL: process.env.KARMAX_PUBLIC_URL ?? process.env.KARMAX_GATEWAY_URL,
    });
    if (remoteHome?.runtimeBin) env.PATH = `${remoteHome.runtimeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
    Object.assign(env, { OPENAI_API_KEY: '', CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '' });
    const custody = remote ? undefined : createCustodyEnv(env);
    if (custody) env = custody.env;

    const mcpFlags = await timed('bootstrap.mcp-config', () => selectedCodexMcpFlags(runtimeWorld, cmd, cwd, env, [...(input.profile.mcpConnections !== undefined && !isRemoteAgentWorld(runtimeWorld) ? [{ name: 'karmax', ...platformMcpSpec(process.env.KARMAX_GATEWAY_URL ?? 'http://127.0.0.1:4505') }] : []), ...(input.agentMcp ?? [])], input.profile.mcpConnections !== undefined, ctx.signal, remoteHome?.configuredMcpServers));

    // Detached group is the fallback; the inherited custody marker crosses groups.
    const startupEnd = (await (await currentTiming())?.start('process.startup'));
    const child: any = remote
      ? spawnRemoteAgentProcess({ world: runtimeWorld, provider: 'codex', command: cmd, args: ['app-server', ...mcpFlags], cwd, env, signal: ctx.signal })
      : spawn(cmd, ['app-server', ...mcpFlags], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    if (child.pid) registerAgent({ pid: child.pid, cmd: path.basename(cmd), provider: 'codex', taskId: input.world.handle.id, role: input.role, owner: process.pid, ...(custody ? { custodyId: custody.custodyId } : {}), startedAt: Date.now() });
    const client = new CodexAppServerClient(child.stdin!, child.stdout!);
    const platformHandlers = platformToolHandlers(input.world, ctx, () => workEnvironment(input));
    let stderr = '';
    child.stderr?.on('data', (d: Buffer | string) => { stderr = utf8Tail(stderr + d.toString(), 64 * 1024); });

    const cleanups: Array<() => void> = [];
    const hb = ctx.heartbeat ? setInterval(() => { try { ctx.heartbeat!(); } catch { /* ignore */ } }, 10_000) : undefined;
    // Materialize a set of messages' image attachments to real files → `localImage`
    // input items (the app-server takes paths, like `codex exec -i`). Cleaned in finally.
    const imageItems = async (msgs: any[]): Promise<any[]> => {
      const { files, cleanup } = materializeImageFiles(msgs);
      cleanups.push(cleanup);
      if (remote) {
        const uploaded: string[] = [];
        for (const file of files) {
          const relative = `.karmax-injection/agent/codex/images/${path.basename(file)}`;
          const content = fs.readFileSync(file);
          if (!runtimeWorld.writeFileBuffer) throw new Error('remote world cannot receive image attachments');
          await runtimeWorld.writeFileBuffer(relative, content);
          uploaded.push(path.posix.join(runtimeWorld.handle.root, relative));
        }
        return uploaded.map((p) => ({ type: 'localImage', path: p }));
      }
      return files.map((p) => ({ type: 'localImage', path: p }));
    };

    // Headless posture (SPEC §7.3): the world (worktree/container) IS the sandbox
    // boundary, so run with approvals off and full access — the app-server analogue
    // of `codex exec --dangerously-bypass-approvals-and-sandbox`. Any approval the
    // server still requests is auto-granted below.
    // The dynamic-tool control channel. It used to answer only in remote worlds,
    // which meant a LOCAL Codex-subscription agent had no turn-local controls at
    // all: no way to record a Review verdict, a resolve transition, review info,
    // or a sub-task. It is now always served; `dynamicTools` above decides which
    // names exist (remote: every platform tool, because a remote CLI cannot launch
    // the host's stdio `karmax` MCP; local: only the turn-local controls, since
    // the config home's `karmax` MCP already serves the durable ones).
    client.onServerRequest(async (method, params) => {
      if (/approval/i.test(method)) return { decision: 'approved_for_session' };
      if (method !== 'item/tool/call') return {};
      const tool = String(params?.tool ?? '');
      const handler = platformHandlers[tool];
      if (!handler) return { contentItems: [{ type: 'inputText', text: `unknown ${BRAND} tool ${tool}` }], success: false };
      const id = String(params?.callId ?? tool);
      // Credential-bearing tools never publish a detail (see SECRET_TOOL_NAMES).
      const startedDetail = toolActivityDetail(tool, params?.arguments);
      ctx.emitActivity({ id, kind: 'tool', phase: 'started', title: tool,
        ...(startedDetail ? { detail: startedDetail } : {}) });
      try {
        const result = await handler(params?.arguments ?? {});
        const doneDetail = toolActivityDetail(tool, result);
        ctx.emitActivity({ id, kind: 'tool', phase: 'completed', title: tool,
          ...(doneDetail ? { detail: doneDetail } : {}) });
        return { contentItems: [{ type: 'inputText', text: result }], success: true };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.emitActivity({ id, kind: 'tool', phase: 'failed', title: tool, detail });
        return { contentItems: [{ type: 'inputText', text: detail }], success: false };
      }
    });

    let threadId: string | undefined = preparedSession;
    let currentTurnId: string | undefined;
    let turnActive = false;
    let finalText = '';
    let streamingItem: string | undefined;
    let streamingText = '';
    let limit: ProviderFailureMetadata | undefined;
    let turnError: string | undefined;
    let terminalStatus: string | undefined;
    let terminalReason: string | undefined;
    let shuttingDown = false;
    let modelCredentialHealthy = false;
    // One `thread/tokenUsage/updated` arrives per model request: `last` is that
    // request, `total` the whole thread. Resuming replays the previous turn's
    // reading under its old turn id, so only turns this run started count, and a
    // re-emitted thread total is never counted twice.
    const reportedUsage = new ReportedUsage();
    const ownTurns = new Set<string>();
    let countedThreadTotal: number | undefined;
    const mcpStartup: any[] = [];
    // Codex Apps is a provider-managed, optional MCP. Its OAuth token has a
    // separate lifecycle from the ChatGPT/Codex login in CODEX_HOME. In
    // particular, an expired Apps token can produce a terminal-looking 401
    // notification while the model credential remains completely healthy.
    // Never let that nested integration error poison the shared model login.
    const isOptionalAppsMcpError = (blob: string): boolean => {
      const appsFailed = mcpStartup.some((event) => {
        const name = String(event?.name ?? event?.serverName ?? '');
        const status = String(event?.status ?? event?.state ?? '');
        return /^codex[_ -]?apps$/i.test(name) && /fail|error/i.test(status);
      });
      if (!appsFailed) return false;
      if (/\bmcp\b/i.test(blob) && /\bcodex[_ -]?apps\b/i.test(blob)) return true;
      // Current app-server drops the MCP identity from its subsequent top-level
      // error notification. Correlate that generic credential-looking 401 only
      // when this same app-server has just authenticated the main account API.
      // This is positive provider evidence, not wording-based guesswork.
      const cls = classifyLimitError(blob, { providerOrigin: true });
      return modelCredentialHealthy && cls.limited === true && cls.hard === true && cls.kind === 'credential';
    };
    // How many `input.messages` this turn has consumed — the initial delta up to the
    // schedule snapshot, then one more per in-flight follow-up steered/started below.
    let deliveredIndex = input.messages.length;

    // Turn-completion signalling: each turn/start awaits the next terminal event
    // (turn/completed, or a non-retried error).
    let settleTurn: (() => void) | undefined;
    const awaitTurnSettled = () => new Promise<void>((resolve) => { settleTurn = resolve; });

    // If the subprocess dies (bad spawn, an app-server-less older CLI, a crash), don't
    // hang waiting on a response that will never come: record it and settle the turn so
    // the awaited handshake/turn rejects promptly and the workflow can resolve/retry.
    child.once('error', (e: Error) => { turnError = turnError ?? `codex app-server spawn error: ${String(e)}`; turnActive = false; client.close(); settleTurn?.(); });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!shuttingDown && !turnError) {
        turnError = child.lost?.message
          ?? `codex app-server connection closed unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? -1}`})${stderr ? `: ${utf8Tail(stderr, 200)}` : ''}`;
      }
      turnActive = false;
      client.close();
      settleTurn?.();
    });

    let policyFailure: ProviderPolicyFailure | undefined;
    const noteLimit = (native: unknown, operation = 'app-server notification') => {
      if (isProviderPolicyRejection(native, { providerOrigin: true })) {
        policyFailure ??= new ProviderPolicyFailure(native, 'codex', { model, operation });
        return;
      }
      const blob = native instanceof Error ? native.message : typeof native === 'string' ? native : JSON.stringify(native ?? {});
      const cls = classifyLimitError(blob, { providerOrigin: true });
      if (!cls.limited) return;
      const m = blob.match(/"?(?:resets_in_seconds|resetInSeconds|retry_after|retryAfter)"?\s*[:=]\s*(\d+)/);
      const resetHint = m ? `in ${Number(m[1])}s` : cls.resetHint;
      const diagnostic = nativeProviderDiagnostic(native, { model, operation });
      limit = {
        kind: cls.kind ?? 'quota',
        permanence: cls.hard ? 'hard' : 'transient',
        provider: 'codex',
        source: 'structured',
        ...(cls.window ? { window: cls.window } : {}),
        ...(resetHint ? { resetHint } : {}),
        ...(cls.note ? { note: cls.note } : {}),
        ...(diagnostic ? { diagnostic } : {}),
      };
    };

    const notificationTrace = await currentTiming();
    client.onNotification((method, params) => {
      void notificationTrace?.markOnce('provider.first-event');
      switch (method) {
        case 'turn/started':
          currentTurnId = params?.turn?.id ?? currentTurnId;
          if (currentTurnId) ownTurns.add(currentTurnId);
          turnActive = true;
          break;
        case 'thread/tokenUsage/updated': {
          const threadTotal = params?.tokenUsage?.total?.totalTokens;
          if (!ownTurns.has(params?.turnId) || threadTotal === countedThreadTotal) break;
          countedThreadTotal = threadTotal;
          const round = reportedUsage.addCodexCli(params.tokenUsage.last);
          void notificationTrace?.mark('provider.usage', round);
          break;
        }
        case 'item/started':
          // Surface a command as it begins, mirroring the exec/SDK live terminal feed.
          if (params?.item?.type === 'commandExecution' && typeof params.item.command === 'string') ctx.emit(`$ ${params.item.command}`);
          {
            const activity = codexItemActivity(params?.item, 'started');
            if (activity) ctx.emitActivity(activity);
          }
          break;
        case 'item/agentMessage/delta':
          // Token deltas (LT-5): publish the message's growing text; its
          // item/completed below records the message itself.
          if (typeof params?.delta === 'string' && params.delta) {
            if (streamingItem !== String(params.itemId)) { streamingItem = String(params.itemId); streamingText = ''; }
            streamingText += params.delta;
            ctx.emit(streamingText, 'assistant');
          }
          break;
        case 'item/completed':
          if (params?.item?.type === 'agentMessage' && typeof params.item.text === 'string' && params.item.text) {
            finalText = params.item.text;
            if (finalText !== streamingText) ctx.emit(finalText, 'assistant');
            streamingItem = undefined;
            streamingText = '';
          }
          {
            const activity = codexItemActivity(params?.item, 'completed');
            if (activity) ctx.emitActivity(activity);
          }
          break;
        case 'item/mcpToolCall/progress':
          ctx.emitActivity({
            id: String(params?.itemId ?? 'mcp-tool'),
            kind: 'tool',
            phase: 'updated',
            title: 'Tool call',
            ...(activityDetail(params?.message) ? { detail: activityDetail(params.message) } : {}),
          });
          break;
        case 'mcpServer/startupStatus/updated':
          mcpStartup.push(params);
          ctx.emitActivity({
            id: `mcp-startup-${String(params?.name ?? params?.serverName ?? mcpStartup.length)}`,
            kind: 'status', phase: 'updated', title: `MCP · ${String(params?.name ?? params?.serverName ?? 'startup')}`,
            ...(activityDetail(params) ? { detail: activityDetail(params) } : {}),
          });
          break;
        case 'warning':
        case 'configWarning':
          ctx.emitActivity({
            id: `${method}-${String(params?.message ?? params?.title ?? 'warning').slice(0, 80)}`,
            kind: 'status',
            phase: 'updated',
            title: String(params?.title ?? 'Warning'),
            ...(activityDetail(params?.message) ? { detail: activityDetail(params.message) } : {}),
          });
          break;
        case 'turn/completed':
          terminalStatus = String(params?.turn?.status ?? 'missing');
          terminalReason = params?.turn?.error?.message ?? params?.turn?.reason;
          if (terminalStatus !== 'completed') {
            const detail = terminalReason ?? JSON.stringify(params?.turn?.error ?? params?.turn ?? {});
            turnError = terminalStatus === 'interrupted' || terminalStatus === 'cancelled'
              ? `codex app-server turn interrupted before completion (${terminalStatus}): ${detail}`
              : `codex app-server turn failed (${terminalStatus}): ${detail}`;
            // A usage limit can surface on a failed turn (not only an `error` notif) —
            // classify it here too so the workflow re-leases the login rather than
            // burning a Resolve turn (parity with the codex-exec blob scan).
            noteLimit(params?.turn?.error ?? params?.turn ?? {}, 'turn/completed');
          }
          turnActive = false;
          settleTurn?.();
          break;
        case 'error': {
          const blob = JSON.stringify(params ?? {});
          // The app-server reports optional Codex Apps startup failures on the
          // same top-level `error` channel as model failures. It can continue the
          // model turn without that MCP, so leave the already-emitted MCP status
          // visible and wait for the real turn terminal event.
          if (!isProviderPolicyRejection(params, { providerOrigin: true }) && isOptionalAppsMcpError(blob)) break;
          // `willRetry=true` is an intermediate Responses-stream notification,
          // not the terminal result of the turn. Current Codex uses messages such
          // as "Reconnecting... 2/5" with `codexErrorInfo=unauthorized`; treating
          // that credential-looking enum as final quarantines a healthy shared
          // login and aborts Codex before attempts 3–5 can succeed. Surface the
          // safe diagnostic, but let app-server own its advertised retry loop.
          if (params?.willRetry === true) {
            const diagnostic = nativeProviderDiagnostic(params, { model, operation: 'app-server notification' });
            ctx.emitActivity({
              id: `codex-provider-retry-${String(currentTurnId ?? threadId ?? 'turn')}`,
              kind: 'status', phase: 'updated', title: diagnostic?.message ?? 'Codex reconnecting',
              ...(diagnostic ? { detail: [
                diagnostic.code,
                diagnostic.status ? `HTTP ${diagnostic.status}` : undefined,
                diagnostic.retryAttempt && diagnostic.retryMax
                  ? `attempt ${diagnostic.retryAttempt}/${diagnostic.retryMax}` : undefined,
              ].filter(Boolean).join(' · ') } : {}),
            });
            break;
          }
          noteLimit(params, 'app-server notification');
          turnError = params?.error?.message ?? blob;
          // Only terminal notifications reach this path.
          turnActive = false;
          settleTurn?.();
          break;
        }
        default:
          break;
      }
    });

    // Mid-turn cancel (SPEC §5.6): interrupt the active turn, then reap the group.
    const onAbort = () => {
      if (threadId && currentTurnId) client.request('turn/interrupt', { threadId, turnId: currentTurnId }).catch(() => undefined);
      if (child.pid) void killAgent(child.pid, 2500, custody?.custodyId);
      else child.kill('SIGTERM');
      settleTurn?.();
    };
    if (ctx.signal?.aborted) onAbort();
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });

    // Pull + steer follow-ups into the LIVE turn (`turn/steer`) — the subscription
    // path's in-flight injection (SPEC §5.6). Serialized so the poller and the
    // between-turns drain can't double-count. A steer that races a just-finished turn
    // fails harmlessly; we leave that message for the next turn (index not advanced).
    let pollLock = false;
    const steerFollowUps = async (): Promise<void> => {
      if (!ctx.pullFollowUps || !turnActive || pollLock) return;
      pollLock = true;
      try {
        const news = await ctx.pullFollowUps(deliveredIndex);
        for (const m of news) {
          if (!turnActive) break; // turn ended mid-drain → leave the rest for next turn
          if (m.role !== 'system' && m.role !== 'agent') {
            try {
              await client.request('turn/steer', { threadId, expectedTurnId: currentTurnId, input: [{ type: 'text', text: m.text, text_elements: [] }, ...await imageItems([m])] });
            } catch {
              break; // steer rejected (turn no longer active) → don't advance past it
            }
          }
          deliveredIndex++;
        }
      } finally {
        pollLock = false;
      }
    };
    let steering: Promise<void> | undefined;
    const followPoll = ctx.pullFollowUps ? setInterval(() => {
      if (!steering) steering = steerFollowUps().catch(() => {}).finally(() => { steering = undefined; });
    }, 1200) : undefined;

    try {
      // ── Handshake ──
      await client.request('initialize', { clientInfo: { name: BRAND, title: BRAND, version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false } });
      client.notify('initialized');
      if (remote) child.startupComplete();
      (await startupEnd?.());
      // The account read and MCP startup are independent: wait for them together (LT-1).
      const accountHealth = timed('provider.account-health', () => withTimeout(client.request('account/rateLimits/read', {}), 5_000))
        .then(() => { modelCredentialHealthy = true; }, () => {
          // Older app-servers may not expose this endpoint. They retain the
          // explicit MCP-name correlation above, but do not get the stronger
          // generic-error correlation without positive account proof.
        });
      const requiredMcp = input.profile.mcpConnections !== undefined ? (input.agentMcp ?? []).map((s) => s.name) : remote ? Object.keys(remoteHome?.browserMcp ?? {}) : [];
      const readiness = requiredMcp.length ? timed('provider.mcp-readiness', async () => {
        // Dynamic Karmax tools use this control channel and therefore need no
        // sandbox startup probe. Browser MCPs really do launch remotely: ask
        // app-server for its authoritative inventory and fail before the model
        // turn when an explicitly provisioned browser did not load.
        const required = requiredMcp;
        let servers: any[] = [];
        let missing = required;
        const deadline = Date.now() + 30_000;
        do {
          const inventory = await client.request<any>('mcpServerStatus/list', {
            cursor: null, limit: 100, detail: 'toolsAndAuthOnly', threadId: null,
          });
          servers = Array.isArray(inventory?.data) ? inventory.data : [];
          missing = required.filter((name) => {
            const server = servers.find((candidate) => candidate?.name === name);
            if (!server) return true;
            const tools = server.tools && typeof server.tools === 'object' ? Object.keys(server.tools) : [];
            return name === 'chrome-devtools' || name === 'playwright' ? tools.length === 0 : false;
          });
          if (!missing.length || Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        } while (true);
        if (missing.length) {
          const observed = servers.map((server) => ({ name: server?.name,
            tools: server?.tools && typeof server.tools === 'object' ? Object.keys(server.tools) : [] }));
          throw new Error(`remote Codex MCP startup incomplete (missing ${missing.join(', ')}; observed ${JSON.stringify(observed)}; startup ${JSON.stringify(mcpStartup)})`);
        }
      }) : undefined;
      const [, ready] = await Promise.allSettled([accountHealth, readiness]);
      if (ready.status === 'rejected') throw ready.reason;

      const sessionEnd = (await (await currentTiming())?.start('provider.session.prepare'));
      // ── Thread: resume the prior one, or start fresh (systemPrompt → developer
      //    instructions; the thread carries them so resumes don't re-send them). ──
      const resuming = !!input.session;
      if (resuming && input.fork) {
        const forked = await client.request<any>('thread/fork', {
          config: workConfig,
          threadId: preparedSession,
          // The native history stays in Codex. We only need the thread id;
          // returning all prior tool/image payloads can stream tens of MB.
          excludeTurns: true,
          cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          developerInstructions: input.systemPrompt,
          ...(model ? { model } : {}),
        });
        threadId = forked?.thread?.id ?? threadId;
      } else if (resuming) {
        // Resume otherwise reloads the CLI/config defaults (`:workspace` +
        // on-request in current Codex), discarding karmax's headless posture.
        await client.request('thread/resume', {
          config: workConfig,
          threadId: preparedSession,
          excludeTurns: true,
          cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          ...(model ? { model } : {}),
        });
      } else {
        const started = await client.request<any>('thread/start', {
          config: workConfig,
          cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          developerInstructions: input.systemPrompt,
          dynamicTools,
          ...(model ? { model } : {}),
        });
        threadId = started?.thread?.id ?? threadId;
      }
      if (threadId) ctx.onSession?.(threadId);
      if (!threadId) throw new Error('codex app-server: no thread id after start/resume');

      // ── Initial input (the delta; agent turns attributed so a fresh-thread replay
      //    never folds the agent's own prior replies back in as user input). ──
      const convo = messagesToDeliver(input).filter((m) => m.role !== 'system');
      const initialText = conversationToPromptText(convo) || (resuming ? 'Continue.' : 'Begin the task described in the developer instructions.');
      let nextInput: any[] = [{ type: 'text', text: initialText, text_elements: [] }, ...await imageItems(convo)];

      (await sessionEnd?.());
      // ── Turn loop (Model-B): run a turn; follow-ups arriving DURING it are steered
      //    in-flight; any that land after it start a follow-on turn in this same
      //    activity, until the agent is idle with nothing pending. ──
      for (;;) {
        if (ctx.signal?.aborted) break;
        turnError = undefined;
        terminalStatus = undefined;
        terminalReason = undefined;
        const settled = awaitTurnSettled();
        const providerRoundEnd = (await (await currentTiming())?.start('provider.cli-roundtrip.opaque'));
        const started = await client.request<any>('turn/start', {
          threadId,
          input: nextInput,
          // Reassert this per turn as well as per thread. Besides defending against
          // config/default drift, this updates resumed threads created by older karmax.
          sandboxPolicy: { type: 'dangerFullAccess' },
          approvalPolicy: 'never',
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        });
        currentTurnId = started?.turn?.id ?? currentTurnId;
        if (currentTurnId) ownTurns.add(currentTurnId);
        await settled;
        (await providerRoundEnd?.(ctx.signal?.aborted ? 'cancelled' : turnError || terminalStatus !== 'completed' ? 'failed' : 'ok'));
        if (ctx.signal?.aborted) break;
        if (limit) break; // usage limit → throw below so the workflow rotates the login
        if (turnError) break;
        if (terminalStatus !== 'completed') {
          turnError = `codex app-server stream ended unexpectedly without a completed terminal event`;
          break;
        }

        // Collect follow-ups that weren't steered in (arrived after the last poll /
        // after completion) → drive a follow-on turn; else the turn is done.
        await steering;
        nextInput = [];
        if (ctx.pullFollowUps) {
          for (const m of await ctx.pullFollowUps(deliveredIndex)) {
            if (m.role !== 'system' && m.role !== 'agent') nextInput.push({ type: 'text', text: m.text, text_elements: [] }, ...await imageItems([m]));
            deliveredIndex++;
          }
        }
        if (!nextInput.length) break;
      }
    } catch (e) {
      // A rejected request (handshake/turn) — including a rate-limited one — lands here.
      // Record it (unless we're cancelling, where a rejection is expected) so the checks
      // below classify a limit and rotate the login, or surface a partial result instead
      // of discarding output already produced (mirrors the exec/SDK error tolerance).
      if (!ctx.signal?.aborted) {
        if (e instanceof ProviderStreamError) noteLimit(e, 'app-server request');
        turnError = turnError ?? String((e as Error)?.message ?? e);
      }
    } finally {
      shuttingDown = true;
      if (hb) clearInterval(hb);
      if (followPoll) clearInterval(followPoll);
      try { ctx.signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
      client.close();
      let stopped = true;
      try {
        if (child.pid) await killAgent(child.pid, 2500, custody?.custodyId);
        else await child.stop();
      } catch (error) {
        // Cleanup must not replace the turn outcome, but a writer whose exit is
        // unconfirmed may still be appending to its history: don't export it
        // (docs/codex-history-integrity.md).
        stopped = false;
        ctx.emitActivity({
          id: 'codex-remote-state-sync', kind: 'error', phase: 'failed',
          title: 'Could not confirm Codex stopped; its history was not exported',
          detail: String((error as Error)?.message ?? error).slice(0, 1000),
        });
      }
      for (const c of cleanups) { try { c(); } catch { /* ignore */ } }
      if (stopped && remoteHome && input.resolvedAuth?.configHome) {
        const failure = await syncRemoteAgentHomeBestEffort(runtimeWorld, 'codex', remoteHome, input.resolvedAuth.configHome, threadId);
        if (failure) ctx.emitActivity({
          id: 'codex-remote-state-sync', kind: 'error', phase: 'failed',
          title: 'Could not preserve remote Codex state', detail: failure.message.slice(0, 1000),
        });
      }
    }

    if (policyFailure) throw policyFailure;
    if (limit) {
      // Same shape as the exec path so limits.ts computes the refresh instant and the
      // workflow rotates to another login (RESOLVE-PLAN §2.4).
      throw providerFailure(providerFailureDisplay(limit), limit);
    }
    if (turnError) {
      throw new Error(`codex app-server turn failed: ${turnError}${stderr ? ` · ${utf8Tail(stderr, 300)}` : ''}`);
    }
    if (terminalStatus !== 'completed') {
      throw new Error('codex app-server stream ended unexpectedly without a completed terminal event');
    }
    return {
      termination: { kind: 'success', status: terminalStatus, ...(terminalReason ? { reason: terminalReason } : {}) },
      session: threadId,
      output: finalText,
      delivered: deliveredIndex,
      usage: reportedUsage.total(),
    };
  }

  // ─── Codex CLI on a ChatGPT subscription (`codex exec --json`) ───────────────
  private async runCodexExec(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const work = codexWorkProfile(input);
    try { return await this.runCodexExecProcess(input, ctx, work.args); }
    finally { work.cleanup(); }
  }

  private async runCodexExecProcess(input: TurnInput, ctx: PlatformToolContext, workArgs: string[]): Promise<AdapterTurn> {
    if (input.session && input.resolvedAuth?.configHome) {
      const home = input.resolvedAuth.configHome;
      input = { ...input, session: await ensureLocalCodexSessionTools(home, input.session) };
    }
    const cmd = process.env.KARMAX_CODEX_EXEC_CMD ?? localProviderCli('codex');
    const model = input.profile.model ?? 'gpt-5.5';
    (await (await currentTiming())?.mark('provider.selected', { provider: 'codex', model }));
    const effort = codexReasoningEffort(model, input.profile.effort);
    const cwd = worldWorkingDirectory(input.world.handle);
    // CODEX_HOME = the leased config home (its auth.json holds the subscription
    // login). scrubbedEnv also strips OPENAI_API_KEY so a stray key can't shadow it.
    const env = scrubbedEnv({ provider: 'codex', configHome: input.resolvedAuth?.configHome,
      extra: input.extraEnv });

    Object.assign(env, { OPENAI_API_KEY: '', CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '' });
    const resuming = !!input.session;
    // The messages to actually send: the whole conversation on a fresh thread, only
    // the delta new since the thread last advanced when resuming (history is held
    // server-side in the rollout).
    const toSend = messagesToDeliver(input).filter((m) => m.role !== 'system');
    // `codex exec` takes a single prompt string. Fresh turn: prepend the assembled
    // system prompt (role template) to the whole conversation (exec has no separate
    // system channel). Resuming: the thread already holds the history, so send only
    // the new messages.
    const promptText = resuming
      ? (toSend.length ? conversationToPromptText(toSend) : 'Continue.')
      : `${input.systemPrompt}\n\n----- CONVERSATION -----\n${
          toSend.map((m) => `${m.role === 'agent' ? 'assistant' : m.role}: ${m.text}`).join('\n\n') || 'Begin the task.'
        }`;

    const lastFile = path.join(os.tmpdir(), `karmax-codex-${crypto.randomBytes(6).toString('hex')}.txt`);
    // Headless posture: `codex exec` is non-interactive (no approval prompt to
    // answer), and karmax's world (worktree/container) IS the sandbox boundary
    // (SPEC §7.3) — the same stance as the Claude adapter's bypassPermissions — so
    // we bypass Codex's own approvals+sandbox rather than depend on its landlock.
    const flags = [...await selectedCodexMcpFlags(input.world, cmd, cwd, env, [...(input.profile.mcpConnections !== undefined && !isRemoteAgentWorld(input.world) ? [{ name: 'karmax', ...platformMcpSpec(process.env.KARMAX_GATEWAY_URL ?? 'http://127.0.0.1:4505') }] : []), ...(input.agentMcp ?? [])], input.profile.mcpConnections !== undefined, ctx.signal), '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', lastFile];
    if (model) flags.push('-m', model);
    if (effort) flags.push('-c', `model_reasoning_effort=${effort}`);
    // Turn-local controls (`confirm_decision`, `resolve_decision`, `create_review_info`,
    // …). `codex exec` is a one-shot subprocess with no dynamic-tool control channel —
    // its only extension point is stdio MCP servers it spawns itself — so they reach
    // this activity through the per-turn socket bridge (control-bridge.ts). Registered
    // with `-c` overrides rather than by writing the leased config home: the socket path
    // is per-turn, and two concurrent turns sharing a home would clobber each other.
    // Values are JSON, which is valid TOML for strings and arrays.
    const control = await startControlBridge(platformToolHandlers(input.world, ctx, () => workEnvironment(input)));
    if (control) {
      const spec = controlMcpServerSpec(control);
      flags.push('-c', `mcp_servers.${CONTROL_SERVER_NAME}.command=${JSON.stringify(spec.command)}`);
      flags.push('-c', `mcp_servers.${CONTROL_SERVER_NAME}.args=${JSON.stringify(spec.args)}`);
      for (const [name, value] of Object.entries(spec.env))
        flags.push('-c', `mcp_servers.${CONTROL_SERVER_NAME}.env.${name}=${JSON.stringify(value)}`);
    }
    // Image attachments: `codex exec -i <FILE>` (and `exec resume -i <FILE>`) take
    // real file paths, so materialize the referenced attachments to a temp dir and
    // attach each. Fresh turn → every message's images; resuming → only the new
    // messages' (history is server-side). One `-i` per file to avoid the multi-value
    // flag swallowing the positional prompt.
    const { files: imageFiles, cleanup: cleanupImages } = materializeImageFiles(toSend);
    for (const f of imageFiles) flags.push('-i', f);
    // Args go straight to execve (no shell), so a multi-line prompt needs no escaping.
    const args = [...workArgs, ...(resuming ? ['exec', 'resume', input.session!, ...flags, '-'] : ['exec', ...flags, '-'])];

    // Keep a detached root group as fallback, while the inherited custody marker
    // covers descendants that create their own groups/sessions.
    const custody = createCustodyEnv(env);
    (await (await currentTiming())?.mark('process.spawn.requested'));
    const child = spawn(cmd, args, { cwd, env: custody.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdin.on('error', () => {}); // process failure is reported by close/error below
    child.stdin.end(promptText);

    // Process-tree custody (src/agent/custody.ts): record the root pid so a
    // boot-time sweep can reap this group if karmax is SIGKILLed mid-turn
    // (systemd-oomd / crash), and drop the record when the turn ends normally.
    // Also surface it in the live task-manager registry (dashboard Processes
    // panel) under its task.
    let untrack = () => {};
    if (child.pid) {
      registerAgent({ pid: child.pid, cmd: path.basename(cmd), provider: 'codex', taskId: input.world.handle.id, role: input.role, owner: process.pid, custodyId: custody.custodyId, startedAt: Date.now() });
      untrack = trackProcess({
        pid: child.pid,
        kind: 'agent',
        label: `codex agent (${input.role})`,
        taskId: input.world.handle.id,
        startedAt: Date.now(),
        kill: (sig) => void killAgent(child.pid, sig === 'SIGKILL' ? 0 : 2500, custody.custodyId),
      });
    }

    // Mid-turn cancel (SPEC §5.6): kill the whole custody scope when the workflow
    // cancels — SIGTERM, escalating to SIGKILL after a grace window.
    const onAbort = () => { void killAgent(child.pid, 2500, custody.custodyId); };
    if (ctx.signal?.aborted) onAbort();
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
    // Heartbeat so a long turn isn't killed by Temporal's activity timeout.
    const hb = ctx.heartbeat ? setInterval(() => { try { ctx.heartbeat!(); } catch {} }, 10_000) : undefined;

    let threadId: string | undefined = input.session;
    let finalText = '';
    let limit: ProviderFailureMetadata | undefined;
    let stderr = '';
    let buf = '';
    let sawCompleted = false;
    let turnFailure: string | undefined;
    const reportedUsage = new ReportedUsage();

    const handleLine = (line: string) => {
      const s = line.trim();
      if (!s) return;
      let ev: any;
      try {
        ev = JSON.parse(s);
      } catch {
        return; // non-JSON progress line
      }
      const t: string = ev.type ?? ev.msg?.type ?? '';
      if (t === 'turn.completed') {
        sawCompleted = true;
        // On a resumed thread `codex exec` reports cumulative thread totals, not
        // this turn's; an unknown turn share is recorded as unknown, never inflated.
        if (!input.session && ev.usage) reportedUsage.addCodexCli(ev.usage);
      }
      if (t === 'turn.failed') turnFailure = ev.error?.message ?? JSON.stringify(ev.error ?? ev);
      if (/thread\.(started|created)|session\.created/.test(t)) {
        const prev = threadId;
        threadId = ev.thread_id ?? ev.threadId ?? ev.session_id ?? ev.id ?? threadId;
        // Publish it mid-turn for the live "fork this agent" command (#3).
        if (threadId && threadId !== prev) ctx.onSession?.(threadId);
      }
      // Stream assistant text to the live log; keep the latest as a fallback output.
      const text = ev.item?.text ?? (ev.item?.type === 'agent_message' ? ev.item?.text ?? ev.item?.message : undefined) ?? ev.text;
      if (/item\.completed|agent_message|turn\.completed/.test(t) && typeof text === 'string' && text) {
        finalText = text;
        ctx.emit(text, 'assistant');
        ctx.emitActivity({ id: String(ev.item?.id ?? `exec-message-${Date.now()}`), kind: 'message', phase: 'completed', title: text });
      }
      if (t === 'item.started' && ev.item?.type === 'command_execution') {
        ctx.emitActivity({ id: String(ev.item.id ?? ev.item.command), kind: 'command', phase: 'started', title: String(ev.item.command ?? 'Run command') });
      }
      if (t === 'item.completed' && ev.item?.type === 'command_execution') {
        const failed = typeof ev.item.exit_code === 'number' && ev.item.exit_code !== 0;
        ctx.emitActivity({
          id: String(ev.item.id ?? ev.item.command),
          kind: 'command',
          phase: failed ? 'failed' : 'completed',
          title: String(ev.item.command ?? 'Run command'),
          ...(activityDetail(ev.item.aggregated_output ?? ev.item.output) ? { detail: activityDetail(ev.item.aggregated_output ?? ev.item.output) } : {}),
        });
      }
      // Usage/session-limit → capture the machine-readable reset (resets_in_seconds).
      // Only a failure event is judged: the agent's own command output and prose
      // (`item.completed`, `agent_message`) mention 401s and rate limits routinely,
      // and matching them quarantined a healthy login.
      const failureEvent = t === 'turn.failed' || t === 'error' || ev.error !== undefined;
      const cls = failureEvent ? classifyLimitError(JSON.stringify(ev), { providerOrigin: true }) : undefined;
      if (cls?.limited) {
        const secs = ev.error?.resets_in_seconds ?? ev.resets_in_seconds ?? ev.error?.retry_after ?? ev.retry_after;
        const resetHint = typeof secs === 'number' ? `in ${secs}s` : cls.resetHint;
        const diagnostic = nativeProviderDiagnostic(ev, { model, operation: 'codex exec event' });
        limit = {
          kind: cls.kind ?? 'quota',
          permanence: cls.hard ? 'hard' : 'transient',
          provider: 'codex',
          source: 'structured',
          ...(cls.window ? { window: cls.window } : {}),
          ...(resetHint ? { resetHint } : {}),
          ...(cls.note ? { note: cls.note } : {}),
          ...(diagnostic ? { diagnostic } : {}),
        };
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr?.on('data', (d) => {
      stderr = utf8Tail(stderr + d.toString(), 64 * 1024);
    });

    const exited: { code: number; signal?: NodeJS.Signals; spawnError?: string } = await new Promise((resolve) => {
      child.once('error', (e) => resolve({ code: -1, spawnError: String(e) }));
      child.once('close', (c, signal) => resolve({ code: c ?? -1, ...(signal ? { signal } : {}) }));
    });
    if (buf.trim()) handleLine(buf); // flush a trailing partial line
    if (hb) clearInterval(hb);
    (await control?.close()); // the control socket must not outlive the turn it mutates
    cleanupImages(); // remove the temp image files now the child has consumed them
    await releaseAgent(child.pid, custody.custodyId); // settle marked background tools, then clear custody
    untrack();
    try { ctx.signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }

    // Prefer the -o final-message file (authoritative) over the streamed text.
    try {
      const f = fs.readFileSync(lastFile, 'utf8').trim();
      if (f) finalText = f;
    } catch {
      /* no file — e.g. the turn failed before producing one */
    }
    try { fs.rmSync(lastFile, { force: true }); } catch { /* ignore */ }

    if (limit) {
      // Throw so the workflow's quota handling marks THIS login exhausted and
      // re-leases another (RESOLVE-PLAN §2.4). Encode the reset so limits.ts can
      // compute the refresh instant precisely.
      throw providerFailure(providerFailureDisplay(limit), limit);
    }
    if (exited.spawnError) {
      throw new Error(`codex exec spawn failed: ${exited.spawnError}`);
    }
    if (exited.code !== 0) {
      const why = exited.signal ? `signal ${exited.signal}` : `exit ${exited.code}`;
      const diagnostic = (exited.spawnError ?? turnFailure ?? utf8Tail(stderr, 500)) || '(no diagnostic)';
      throw new Error(
        `codex exec connection terminated before successful completion (${why}): ${diagnostic}`,
      );
    }
    if (turnFailure) {
      throw new Error(`codex exec turn failed: ${turnFailure}`);
    }
    if (!sawCompleted) {
      throw new Error('codex exec stream ended unexpectedly without a turn.completed event');
    }
    // `codex exec` is a one-shot subprocess — no way to inject mid-run, so it delivers
    // exactly the schedule snapshot; a follow-up that landed mid-turn reaches the agent
    // on the next turn (the workflow keeps it after the boundary). `delivered` reflects
    // that: everything up to `input.messages.length`.
    return {
      termination: { kind: 'success', status: 'turn.completed' },
      session: threadId,
      output: finalText,
      delivered: input.messages.length,
      usage: reportedUsage.total(),
    };
  }
}
