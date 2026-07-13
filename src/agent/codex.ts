import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput, RUNAWAY_BACKSTOP } from './types.js';
import { TOOL_SCHEMAS, platformToolHandlers } from './tools.js';
import { codexReasoningEffort } from './effort.js';
import { openaiUserContent, materializeImageFiles } from './images.js';
import { messagesToDeliver, conversationToPromptText } from './history.js';
import { scrubbedEnv } from '../autonomy/config-homes.js';
import { registerAgent, unregisterAgent, killAgent, killProcessGroup } from './custody.js';
import { trackProcess } from '../util/processes.js';
import { classifyLimitError, providerErrorFromMessage, providerFailure, type ProviderFailureMetadata } from './limits.js';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { activityDetail, codexItemActivity } from './activity.js';

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
  private runSubscription(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    if (process.env.KARMAX_CODEX_USE_EXEC === '1') return this.runCodexExec(input, ctx);
    return this.runCodexAppServer(input, ctx);
  }

  // ─── OpenAI Responses API (API key, metered) ────────────────────────────────
  private async runResponsesApi(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const apiKey = input.resolvedAuth?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('CodexAdapter: OPENAI_API_KEY not set');
    const baseUrl = process.env.KARMAX_OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const model = input.profile.model ?? 'gpt-5.5';
    const handlers = platformToolHandlers(input.world, ctx);
    // Responses API function tools are flat ({type:'function', name, ...}).
    const tools = TOOL_SCHEMAS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));

    // On a fresh session, replay the full conversation so a login switch (which
    // drops the server-bound previous_response_id) doesn't lose context; when
    // continuing the same session, send only the messages new since it last
    // advanced (the rest is carried server-side by previous_response_id).
    let respId: string | undefined = input.session; // resume from a prior response id
    const convo = messagesToDeliver(input).filter((m) => m.role !== 'system');
    let nextInput: any[] = convo.length
      ? convo.map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.role === 'agent' ? m.text : openaiUserContent(m) }))
      : [{ role: 'user', content: respId ? 'Continue.' : 'Begin the task described in the instructions.' }];

    // Turn cap is optional: unset ⇒ effectively unlimited (a high runaway backstop
    // only, so a pathological infinite tool-loop can't burn unbounded spend).
    const maxIters = input.maxTurns ?? input.profile.maxTurns ?? RUNAWAY_BACKSTOP;
    let finalText = '';
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
      if (!res.ok) {
        const message = `OpenAI Responses API ${res.status}: ${(await res.text()).slice(0, 500)}`;
        throw providerErrorFromMessage('codex', message, 'structured');
      }
      const data = (await res.json()) as any;
      respId = data.id ?? respId;
      if (data.status !== 'completed') {
        const reason = data.incomplete_details?.reason ?? data.error?.message ?? data.error?.code ?? 'no reason supplied';
        const message = `OpenAI Responses turn did not complete successfully (status=${String(data.status ?? 'missing')}): ${String(reason)}`;
        throw providerErrorFromMessage('codex', message, 'structured');
      }

      const outputs: any[] = data.output ?? [];
      const calls = outputs.filter((o) => o.type === 'function_call');
      const text = outputs
        .filter((o) => o.type === 'message')
        .flatMap((m: any) => (m.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text))
        .join('\n');
      if (text) {
        finalText = text;
        ctx.emit(text);
        ctx.emitActivity({ id: `response-${respId}-${i}`, kind: 'message', phase: 'completed', title: text });
      }
      if (calls.length === 0) {
        // Idle. Fold in any follow-up that landed mid-turn and keep going on the same
        // response chain (previous_response_id carries the history); else finish.
        const more = await injectFollowUps();
        if (more.length) { nextInput = more; continue; }
        terminalStatus = data.status;
        terminalReason = data.incomplete_details?.reason;
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
        ctx.emitActivity({
          id: String(call.call_id ?? `${call.name}-${i}`),
          kind: 'tool',
          phase: 'started',
          title: String(call.name ?? 'Tool call'),
          ...(activityDetail(args) ? { detail: activityDetail(args) } : {}),
        });
        const result = handler ? await handler(args) : `unknown tool ${call.name}`;
        ctx.emitActivity({
          id: String(call.call_id ?? `${call.name}-${i}`),
          kind: 'tool',
          phase: 'completed',
          title: String(call.name ?? 'Tool call'),
          ...(activityDetail(result) ? { detail: activityDetail(result) } : {}),
        });
        toolOutputs.push({ type: 'function_call_output', call_id: call.call_id, output: result });
        if (call.name === 'signal_completion') completed = true;
      }
      nextInput = toolOutputs;
      if (completed) {
        terminalStatus = data.status;
        terminalReason = 'signal_completion';
        break;
      }
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
    };
  }

  // ─── Codex app-server on a ChatGPT subscription (live JSON-RPC thread) ────────
  private async runCodexAppServer(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const cmd = process.env.KARMAX_CODEX_EXEC_CMD ?? 'codex';
    const model = input.profile.model ?? undefined;
    const effort = codexReasoningEffort(model ?? 'gpt-5.5', input.profile.effort);
    const cwd = input.world.handle.root;
    // CODEX_HOME = the leased config home (its auth.json holds the subscription
    // login). scrubbedEnv also strips OPENAI_API_KEY so a stray key can't shadow it.
    const env = scrubbedEnv({ provider: 'codex', configHome: input.resolvedAuth?.configHome, ...(input.extraEnv ? { extra: input.extraEnv } : {}) });

    // Detached ⇒ its own process group, so killAgent(-pid) reaps codex's descendants.
    const child = spawn(cmd, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    if (child.pid) registerAgent({ pid: child.pid, cmd: path.basename(cmd), provider: 'codex', role: input.role, owner: process.pid, startedAt: Date.now() });
    const client = new CodexAppServerClient(child.stdin!, child.stdout!);
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const cleanups: Array<() => void> = [];
    const hb = ctx.heartbeat ? setInterval(() => { try { ctx.heartbeat!(); } catch { /* ignore */ } }, 10_000) : undefined;
    // Materialize a set of messages' image attachments to real files → `localImage`
    // input items (the app-server takes paths, like `codex exec -i`). Cleaned in finally.
    const imageItems = (msgs: any[]): any[] => {
      const { files, cleanup } = materializeImageFiles(msgs);
      cleanups.push(cleanup);
      return files.map((p) => ({ type: 'localImage', path: p }));
    };

    // Headless posture (SPEC §7.3): the world (worktree/container) IS the sandbox
    // boundary, so run with approvals off and full access — the app-server analogue
    // of `codex exec --dangerously-bypass-approvals-and-sandbox`. Any approval the
    // server still requests is auto-granted below.
    client.onServerRequest((method) => (/approval/i.test(method) ? { decision: 'approved_for_session' } : {}));

    let threadId: string | undefined = input.session;
    let currentTurnId: string | undefined;
    let turnActive = false;
    let finalText = '';
    let limit: ProviderFailureMetadata | undefined;
    let turnError: string | undefined;
    let terminalStatus: string | undefined;
    let terminalReason: string | undefined;
    let shuttingDown = false;
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
    child.once('error', (e) => { turnError = turnError ?? `codex app-server spawn error: ${String(e)}`; turnActive = false; client.close(); settleTurn?.(); });
    child.once('close', (code, signal) => {
      if (!shuttingDown && !turnError) {
        turnError = `codex app-server connection closed unexpectedly (code ${code ?? -1}${signal ? `, signal ${signal}` : ''})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`;
      }
      turnActive = false;
      client.close();
      settleTurn?.();
    });

    const noteLimit = (blob: string) => {
      const cls = classifyLimitError(blob, { providerOrigin: true });
      if (!cls.limited) return;
      const m = blob.match(/"?(?:resets_in_seconds|resetInSeconds|retry_after|retryAfter)"?\s*[:=]\s*(\d+)/);
      const resetHint = m ? `in ${Number(m[1])}s` : cls.resetHint;
      limit = {
        kind: cls.kind ?? 'quota',
        permanence: cls.hard ? 'hard' : 'transient',
        provider: 'codex',
        source: 'structured',
        ...(cls.window ? { window: cls.window } : {}),
        ...(resetHint ? { resetHint } : {}),
        ...(cls.note ? { note: cls.note } : {}),
      };
    };

    client.onNotification((method, params) => {
      switch (method) {
        case 'turn/started':
          currentTurnId = params?.turn?.id ?? currentTurnId;
          turnActive = true;
          break;
        case 'item/started':
          // Surface a command as it begins, mirroring the exec/SDK live terminal feed.
          if (params?.item?.type === 'commandExecution' && typeof params.item.command === 'string') ctx.emit(`$ ${params.item.command}`);
          {
            const activity = codexItemActivity(params?.item, 'started');
            if (activity) ctx.emitActivity(activity);
          }
          break;
        case 'item/completed':
          if (params?.item?.type === 'agentMessage' && typeof params.item.text === 'string' && params.item.text) {
            finalText = params.item.text;
            ctx.emit(finalText);
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
            noteLimit(JSON.stringify(params?.turn?.error ?? params?.turn ?? {}));
          }
          turnActive = false;
          settleTurn?.();
          break;
        case 'error': {
          const blob = JSON.stringify(params ?? {});
          noteLimit(blob);
          turnError = params?.error?.message ?? blob;
          // A retryable error is handled internally by the server; only a terminal one
          // (or a usage limit) ends the turn from our side.
          if (limit || params?.willRetry === false) {
            turnActive = false;
            settleTurn?.();
          }
          break;
        }
        default:
          break;
      }
    });

    // Mid-turn cancel (SPEC §5.6): interrupt the active turn, then reap the group.
    const onAbort = () => {
      if (threadId && currentTurnId) client.request('turn/interrupt', { threadId, turnId: currentTurnId }).catch(() => undefined);
      void killAgent(child.pid);
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
              await client.request('turn/steer', { threadId, expectedTurnId: currentTurnId, input: [{ type: 'text', text: m.text, text_elements: [] }, ...imageItems([m])] });
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
    const followPoll = ctx.pullFollowUps ? setInterval(() => { void steerFollowUps(); }, 1200) : undefined;

    try {
      // ── Handshake ──
      await client.request('initialize', { clientInfo: { name: 'karmax', title: 'karmax', version: '1.0.0' }, capabilities: null });
      client.notify('initialized');

      // ── Thread: resume the prior one, or start fresh (systemPrompt → developer
      //    instructions; the thread carries them so resumes don't re-send them). ──
      const resuming = !!input.session;
      if (resuming) {
        // Resume otherwise reloads the CLI/config defaults (`:workspace` +
        // on-request in current Codex), discarding karmax's headless posture.
        await client.request('thread/resume', {
          threadId: input.session,
          cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          ...(model ? { model } : {}),
        });
      } else {
        const started = await client.request<any>('thread/start', {
          cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          developerInstructions: input.systemPrompt,
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
      let nextInput: any[] = [{ type: 'text', text: initialText, text_elements: [] }, ...imageItems(convo)];

      // ── Turn loop (Model-B): run a turn; follow-ups arriving DURING it are steered
      //    in-flight; any that land after it start a follow-on turn in this same
      //    activity, until the agent is idle with nothing pending. ──
      for (;;) {
        if (ctx.signal?.aborted) break;
        turnError = undefined;
        terminalStatus = undefined;
        terminalReason = undefined;
        const settled = awaitTurnSettled();
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
        await settled;
        if (ctx.signal?.aborted) break;
        if (limit) break; // usage limit → throw below so the workflow rotates the login
        if (turnError) break;
        if (terminalStatus !== 'completed') {
          turnError = `codex app-server stream ended unexpectedly without a completed terminal event`;
          break;
        }

        // Collect follow-ups that weren't steered in (arrived after the last poll /
        // after completion) → drive a follow-on turn; else the turn is done.
        nextInput = [];
        if (ctx.pullFollowUps) {
          for (const m of await ctx.pullFollowUps(deliveredIndex)) {
            if (m.role !== 'system' && m.role !== 'agent') nextInput.push({ type: 'text', text: m.text, text_elements: [] }, ...imageItems([m]));
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
      if (!ctx.signal?.aborted) turnError = turnError ?? String((e as Error)?.message ?? e);
    } finally {
      shuttingDown = true;
      if (hb) clearInterval(hb);
      if (followPoll) clearInterval(followPoll);
      try { ctx.signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
      client.close();
      void killAgent(child.pid);
      unregisterAgent(child.pid);
      for (const c of cleanups) { try { c(); } catch { /* ignore */ } }
    }

    // A limit can also arrive as a rejected request (handshake/turn) or a subprocess
    // death recorded in `turnError` — scan it so those paths rotate the login too.
    if (turnError && !limit) noteLimit(turnError);
    if (limit) {
      // Same shape as the exec path so limits.ts computes the refresh instant and the
      // workflow rotates to another login (RESOLVE-PLAN §2.4).
      throw providerFailure(
        `Codex usage limit reached${limit.resetHint ? ` · resets ${limit.resetHint}` : ''}`,
        limit,
      );
    }
    if (turnError) {
      throw new Error(`codex app-server turn failed: ${turnError}${stderr ? ` · ${stderr.slice(0, 300)}` : ''}`);
    }
    if (terminalStatus !== 'completed') {
      throw new Error('codex app-server stream ended unexpectedly without a completed terminal event');
    }
    return {
      termination: { kind: 'success', status: terminalStatus, ...(terminalReason ? { reason: terminalReason } : {}) },
      session: threadId,
      output: finalText,
      delivered: deliveredIndex,
    };
  }

  // ─── Codex CLI on a ChatGPT subscription (`codex exec --json`) ───────────────
  private async runCodexExec(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const cmd = process.env.KARMAX_CODEX_EXEC_CMD ?? 'codex';
    const model = input.profile.model ?? 'gpt-5.5';
    const effort = codexReasoningEffort(model, input.profile.effort);
    const cwd = input.world.handle.root;
    // CODEX_HOME = the leased config home (its auth.json holds the subscription
    // login). scrubbedEnv also strips OPENAI_API_KEY so a stray key can't shadow it.
    const env = scrubbedEnv({ provider: 'codex', configHome: input.resolvedAuth?.configHome, ...(input.extraEnv ? { extra: input.extraEnv } : {}) });

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
    const flags = ['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', lastFile];
    if (model) flags.push('-m', model);
    if (effort) flags.push('-c', `model_reasoning_effort=${effort}`);
    // Image attachments: `codex exec -i <FILE>` (and `exec resume -i <FILE>`) take
    // real file paths, so materialize the referenced attachments to a temp dir and
    // attach each. Fresh turn → every message's images; resuming → only the new
    // messages' (history is server-side). One `-i` per file to avoid the multi-value
    // flag swallowing the positional prompt.
    const { files: imageFiles, cleanup: cleanupImages } = materializeImageFiles(toSend);
    for (const f of imageFiles) flags.push('-i', f);
    // Args go straight to execve (no shell), so a multi-line prompt needs no escaping.
    const args = resuming ? ['exec', 'resume', input.session!, ...flags, promptText] : ['exec', ...flags, promptText];

    // Detached ⇒ the child is its own process-group leader, so a kill of the
    // GROUP (kill(-pid)) reaps codex's descendant tool processes too, not just
    // the root — the "descendants survive" gap called out in PLAN-efficiency.
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    // Process-tree custody (src/agent/custody.ts): record the root pid so a
    // boot-time sweep can reap this group if karmax is SIGKILLed mid-turn
    // (systemd-oomd / crash), and drop the record when the turn ends normally.
    // Also surface it in the live task-manager registry (dashboard Processes
    // panel) under its task.
    let untrack = () => {};
    if (child.pid) {
      registerAgent({ pid: child.pid, cmd: path.basename(cmd), provider: 'codex', taskId: input.world.handle.id, role: input.role, owner: process.pid, startedAt: Date.now() });
      untrack = trackProcess({
        pid: child.pid,
        kind: 'agent',
        label: `codex agent (${input.role})`,
        taskId: input.world.handle.id,
        startedAt: Date.now(),
        kill: (sig) => (sig === 'SIGKILL' ? killProcessGroup(child.pid, 'SIGKILL') : void killAgent(child.pid)),
      });
    }

    // Mid-turn cancel (SPEC §5.6): kill the whole process GROUP when the workflow
    // cancels — SIGTERM, escalating to SIGKILL after a grace window.
    const onAbort = () => { void killAgent(child.pid); };
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
      if (t === 'turn.completed') sawCompleted = true;
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
        ctx.emit(text);
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
      const blob = JSON.stringify(ev);
      const cls = classifyLimitError(blob, { providerOrigin: true });
      if (cls.limited) {
        const secs = ev.error?.resets_in_seconds ?? ev.resets_in_seconds ?? ev.error?.retry_after ?? ev.retry_after;
        const resetHint = typeof secs === 'number' ? `in ${secs}s` : cls.resetHint;
        limit = {
          kind: cls.kind ?? 'quota',
          permanence: cls.hard ? 'hard' : 'transient',
          provider: 'codex',
          source: 'structured',
          ...(cls.window ? { window: cls.window } : {}),
          ...(resetHint ? { resetHint } : {}),
          ...(cls.note ? { note: cls.note } : {}),
        };
      }
    };

    child.stdout?.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    const exited: { code: number; signal?: NodeJS.Signals; spawnError?: string } = await new Promise((resolve) => {
      child.once('error', (e) => resolve({ code: -1, spawnError: String(e) }));
      child.once('close', (c, signal) => resolve({ code: c ?? -1, ...(signal ? { signal } : {}) }));
    });
    if (buf.trim()) handleLine(buf); // flush a trailing partial line
    if (hb) clearInterval(hb);
    cleanupImages(); // remove the temp image files now the child has consumed them
    unregisterAgent(child.pid); // child has exited — clear its custody record
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
      throw providerFailure(
        `Codex usage limit reached${limit.resetHint ? ` · resets ${limit.resetHint}` : ''}`,
        limit,
      );
    }
    if (exited.spawnError) {
      throw new Error(`codex exec spawn failed: ${exited.spawnError}`);
    }
    if (exited.code !== 0) {
      const why = exited.signal ? `signal ${exited.signal}` : `exit ${exited.code}`;
      const diagnostic = (exited.spawnError ?? turnFailure ?? stderr.slice(0, 500)) || '(no diagnostic)';
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
    };
  }
}
