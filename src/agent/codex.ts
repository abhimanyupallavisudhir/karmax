import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput, RUNAWAY_BACKSTOP } from './types.js';
import { TOOL_SCHEMAS, platformToolHandlers } from './tools.js';
import { codexReasoningEffort } from './effort.js';
import { openaiUserContent, materializeImageFiles } from './images.js';
import { messagesToDeliver } from './history.js';
import { scrubbedEnv } from '../autonomy/config-homes.js';
import { registerAgent, unregisterAgent, killAgent } from './custody.js';

/**
 * Codex/OpenAI provider adapter (SPEC §7.1). Two rails, chosen per profile:
 *   - **API key** → the OpenAI **Responses API** (metered, pay-per-token). The
 *     session id we store/resume is the provider's `response.id`.
 *   - **Subscription** (ChatGPT sign-in) → the **`codex` CLI** driven headlessly
 *     (`codex exec --json`) with `CODEX_HOME` = the leased config home, so the turn
 *     runs on the user's ChatGPT plan (5-hour + weekly windows) — the analogue of
 *     Claude's Agent-SDK path. Rollouts under `$CODEX_HOME/sessions/` power resume.
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
    const auth = input.resolvedAuth;
    // Route on the PROFILE's resolved auth first: an API key → Responses API; a
    // config home → the Codex CLI on a subscription. Only with no explicit profile
    // auth do we fall back to the ambient environment.
    if (auth?.apiKey) return this.runResponsesApi(input, ctx);
    if (auth?.configHome) return this.runCodexExec(input, ctx);
    if (process.env.OPENAI_API_KEY) return this.runResponsesApi(input, ctx);
    if (CodexAdapter.hasAmbientSubscription()) return this.runCodexExec(input, ctx);
    throw new Error('CodexAdapter: no OPENAI_API_KEY and no Codex login found');
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
      : [{ role: 'user', content: respId ? 'Continue.' : 'Begin the task described in the instructions. Call signal_completion when done.' }];

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

  // ─── Codex CLI on a ChatGPT subscription (`codex exec --json`) ───────────────
  private async runCodexExec(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    const cmd = process.env.KARMAX_CODEX_EXEC_CMD ?? 'codex';
    const model = input.profile.model ?? 'gpt-5.5';
    const effort = codexReasoningEffort(model, input.profile.effort);
    const cwd = input.world.handle.root;
    // CODEX_HOME = the leased config home (its auth.json holds the subscription
    // login). scrubbedEnv also strips OPENAI_API_KEY so a stray key can't shadow it.
    const env = scrubbedEnv({ provider: 'codex', configHome: input.resolvedAuth?.configHome });

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
      ? (toSend.length ? toSend.map((m) => (m.role === 'agent' ? `assistant: ${m.text}` : m.text)).join('\n\n') : 'Continue.')
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
    if (child.pid) registerAgent({ pid: child.pid, cmd: path.basename(cmd), provider: 'codex', role: input.role, owner: process.pid, startedAt: Date.now() });

    // Mid-turn cancel (SPEC §5.6): kill the whole process GROUP when the workflow
    // cancels — SIGTERM, escalating to SIGKILL after a grace window.
    const onAbort = () => { void killAgent(child.pid); };
    if (ctx.signal?.aborted) onAbort();
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
    // Heartbeat so a long turn isn't killed by Temporal's activity timeout.
    const hb = ctx.heartbeat ? setInterval(() => { try { ctx.heartbeat!(); } catch {} }, 10_000) : undefined;

    let threadId: string | undefined = input.session;
    let finalText = '';
    let limit: { resetInSeconds?: number } | undefined;
    let stderr = '';
    let buf = '';

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
      }
      // Usage/session-limit → capture the machine-readable reset (resets_in_seconds).
      const blob = JSON.stringify(ev);
      if (/usage.?limit|rate.?limit|quota|UsageLimitReached/i.test(blob)) {
        const secs = ev.error?.resets_in_seconds ?? ev.resets_in_seconds ?? ev.error?.retry_after ?? ev.retry_after;
        limit = { resetInSeconds: typeof secs === 'number' ? secs : undefined };
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

    const code: number = await new Promise((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('close', (c) => resolve(c ?? -1));
    });
    if (buf.trim()) handleLine(buf); // flush a trailing partial line
    if (hb) clearInterval(hb);
    cleanupImages(); // remove the temp image files now the child has consumed them
    unregisterAgent(child.pid); // child has exited — clear its custody record
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
      throw new Error(`Codex usage limit reached${limit.resetInSeconds != null ? ` · resets in ${limit.resetInSeconds}s` : ''}`);
    }
    if (code !== 0 && !finalText) {
      throw new Error(`codex exec failed (exit ${code}): ${stderr.slice(0, 500) || '(no output)'}`);
    }
    return { session: threadId, output: finalText };
  }
}
