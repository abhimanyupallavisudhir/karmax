import type { AgentProfile } from '../domain/types.js';
import { isComputerless } from '../domain/computer.js';
import type { World } from '../world/types.js';
import { currentTiming, timed } from '../timing/index.js';
import { ReportedUsage } from '../timing/usage.js';
import { readChatCompletion, readStreamOnceMore } from './api-streams.js';
import { claudeToolActivity } from './activity.js';
import { chatUserContent } from './images.js';
import { apiThrottle, providerErrorFromMessage } from './limits.js';
import { apiKeyEnv, credentialProvider, modelProviderFromModel } from './provider-registry.js';
import { COMPUTERLESS_TOOL_SCHEMAS, computerlessToolHandlers, type ToolSchema } from './tools.js';
import { AdapterTurn, AgentAdapter, PlatformToolContext, RUNAWAY_BACKSTOP, TurnInput } from './types.js';

/**
 * Turns of a task without a computer (wiki features/computerless-tasks). The
 * agent runs here, in the worker, as a model API tool-use loop offered only
 * tavya's platform tools (`COMPUTERLESS_TOOL_SCHEMAS`): no shell, files, jobs,
 * browser or pull request, so nothing it does executes on the shared host.
 *
 * Only API rails can run host-side: the Claude Messages API, the OpenAI
 * Responses API, and OpenAI-compatible Chat Completions for OpenCode models
 * (tavya's included model on OpenRouter, or a key of the organization's own).
 * A subscription login (Claude Code, Codex) is its CLI: its turns run that
 * CLI in a small sandbox of its own, offered the same tools
 * (src/agent/login-sandbox.ts); with nowhere to run one the task says so
 * (`computerlessModelNeed`).
 */

export function isComputerlessWorld(world: Pick<World, 'handle'>): boolean {
  return isComputerless(world?.handle?.kind);
}

/** An agent this task without a computer cannot run. Not retryable: the
 * person changes the model, or gives the task a computer. */
export class ComputerlessModelUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComputerlessModelUnsupported';
  }
}

/** OpenAI-compatible Chat Completions endpoints, by OpenCode model prefix. */
function chatEndpoints(): Record<string, string> {
  return {
    openrouter: process.env.KARMAX_OPENROUTER_API_URL ?? 'https://openrouter.ai/api/v1',
    openai: process.env.KARMAX_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    moonshotai: 'https://api.moonshot.ai/v1',
    xai: 'https://api.x.ai/v1',
    groq: 'https://api.groq.com/openai/v1',
    mistral: 'https://api.mistral.ai/v1',
  };
}

/** Where an OpenCode model (`<provider>/<model>`) is served host-side. */
export function chatCompletionsEndpoint(model: string | undefined): { vendor: string; baseUrl: string; model: string } | undefined {
  const vendor = modelProviderFromModel(model);
  const baseUrl = vendor ? chatEndpoints()[vendor] : undefined;
  if (!vendor || !baseUrl) return undefined;
  return { vendor, baseUrl: baseUrl.replace(/\/$/, ''), model: model!.slice(vendor.length + 1) };
}

const NEEDS_API = 'A task without a computer runs its agent on tavya itself, which takes an API key or tavya\'s included model. '
  + 'Pick one of those as its Model in Parameters, or give the task a computer.';

const loginName = (provider: string) => provider === 'claude' ? 'A Claude Code login' : provider === 'codex' ? 'A Codex login' : 'A login';

/** What would let a task without a computer run its model: an API key (or
 * another model), a computer for its login's CLI, or another model. */
export type ComputerlessFix = 'key' | 'computer' | 'model';

/** Whether a turn with `auth` runs its login's CLI (in a login sandbox, or on
 * a self-hosted install's own machine): a Claude Code or Codex login, not a
 * key or a model gateway. */
export function runsLoginCli(profile: Pick<AgentProfile, 'provider'>, auth: { apiKey?: string; configHome?: string; gateway?: unknown } | undefined): boolean {
  return (profile.provider === 'claude' || profile.provider === 'codex') && !auth?.apiKey && !auth?.gateway;
}

/**
 * Why `profile` cannot run without a computer, or undefined if it can.
 * `apiKey`: the turn has an API key for it (its own, leased, or the included
 * model's) — it runs host-side. `login`: a Claude Code or Codex login serves
 * it — its CLI runs in a small sandbox of its own (src/agent/login-sandbox.ts),
 * if `compute` says there is somewhere to run one (`true`), else why not.
 * Shared by the turn, which refuses before it starts, and by readiness,
 * which says so on the task form.
 */
export function computerlessModelNeed(profile: Pick<AgentProfile, 'provider' | 'model' | 'modelProvider'>,
  rail: { apiKey: boolean; login?: boolean; compute?: true | string }): { message: string; fix: ComputerlessFix } | undefined {
  if (profile.provider === 'mock') return undefined;
  if (profile.provider === 'opencode') {
    const vendor = credentialProvider(profile);
    if (vendor !== 'anthropic' && !chatCompletionsEndpoint(profile.model))
      return { fix: 'model', message: `OpenCode's ${vendor} models can't run without a computer. ${NEEDS_API}` };
  } else if (profile.provider !== 'claude' && profile.provider !== 'codex') {
    return { fix: 'model', message: `The ${profile.provider} agent can't run without a computer. ${NEEDS_API}` };
  }
  if (rail.apiKey) return undefined;
  if (profile.provider === 'opencode') return { fix: 'key', message: `An OpenCode login can't run without a computer. ${NEEDS_API}` };
  if (rail.login && rail.compute === true) return undefined;
  if (rail.login) return { fix: 'computer', message: `${loginName(profile.provider)} replies from a small cloud computer, and ${
    rail.compute ?? 'this organization has none it can use'}. Connect a computer (Settings → Computers), or use an API key.` };
  return { fix: 'key', message: `${loginName(profile.provider)} or an API key is needed: there is neither here. Add one in Settings → Agents.` };
}

/** {@link computerlessModelNeed}'s sentence alone. */
export function computerlessModelGap(profile: Pick<AgentProfile, 'provider' | 'model' | 'modelProvider'>,
  rail: { apiKey: boolean; login?: boolean; compute?: true | string }): string | undefined {
  return computerlessModelNeed(profile, rail)?.message;
}

/**
 * The API key a turn of a task without a computer spends, or undefined when
 * there is none (the turn refuses; readiness says "Can't start yet"). Such a
 * turn runs in the worker for every organization alike, so the worker's own
 * environment is not the organization's: its keys are spent only where they
 * would be anyway —
 *  - a key resolved for the organization (`resolvedAuth.apiKey`: its own
 *    leased key, or the included model's per-organization key; a model
 *    gateway or OpenRouter rail serves a Claude Code or Codex CLI, which needs
 *    a computer, so it is not one);
 *  - a self-hosted installation's own organization, whose operator is its only
 *    customer (as `gatherCredentialSources` offers host credentials).
 * A leased login is a login, whatever the environment holds.
 */
export function computerlessApiKey(profile: Pick<AgentProfile, 'provider' | 'model' | 'modelProvider'>, options: {
  hosted: boolean; organizationId: string;
  resolvedAuth?: { apiKey?: string; configHome?: string };
}): string | undefined {
  if (options.resolvedAuth?.apiKey) return options.resolvedAuth.apiKey;
  if (options.resolvedAuth?.configHome) return undefined;
  const hostKeys = !options.hosted && options.organizationId === 'org_personal';
  const name = profile.provider === 'mock' ? '' : apiKeyEnv(credentialProvider(profile));
  return hostKeys && name ? process.env[name] || undefined : undefined;
}

/** Run one turn of a task without a computer: its login's CLI in the machine
 * the activity gave it (`harnessWorld`), else `adapter`'s host-side rail. */
export async function runComputerlessTurn(adapter: AgentAdapter, input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
  if (input.harnessWorld) return adapter.runTurn(input, ctx);
  if (!adapter.runComputerlessTurn) throw new ComputerlessModelUnsupported(`The ${adapter.provider} agent can't run without a computer. ${NEEDS_API}`);
  return adapter.runComputerlessTurn(input, ctx);
}

/** The refusal for a subscription login asked to run host-side: its CLI runs
 * only in a machine (`harnessWorld`), which this turn was not given. */
export function loginNeedsComputer(provider: string): ComputerlessModelUnsupported {
  return new ComputerlessModelUnsupported(computerlessModelGap({ provider: provider as AgentProfile['provider'] }, { apiKey: false, login: true })
    ?? NEEDS_API);
}

/** Whether `world` is a task without a computer whose login's CLI runs in a machine of its own this turn. */
export function platformOnlyHarness(input: Pick<TurnInput, 'world' | 'harnessWorld'>): boolean {
  return !!input.harnessWorld && isComputerlessWorld(input.world);
}

/**
 * The platform tools a host-side Ask turn is offered at first (wiki
 * features/computerless-tasks § What an Ask costs). Every model call resends
 * every tool's description, and all 65 are ~15k tokens: more than the rest of
 * an Ask's prompt. These cover what Asks do (ask-eval 2026-11-19: 98% of their
 * tool calls); `more_tools` lists and turns on the rest.
 */
export const ASK_TOOL_NAMES = [
  'platform_request', 'describe_platform', 'get_task', 'search_tasks', 'find_task', 'get_conversation',
  'create_task', 'queue_task', 'signal_task', 'message_agent', 'set_task_priority',
  'add_follow_up_trigger', 'remove_follow_up_trigger', 'my_authorization', 'request_permission',
  'read_wiki', 'search_wiki', 'list_events', 'pause', 'escalate_to_human',
  'list_credentials', 'list_connections', 'search_connection_tools', 'execute_connection_tool',
];

const firstSentence = (text: string) => (text.match(/^[^.\n]*\.?/)?.[0] ?? text).slice(0, 160);

/** Ask's tool set for one host-side turn: {@link ASK_TOOL_NAMES} plus
 * `more_tools`, which turns on any other tool of a task without a computer
 * for the rest of the turn. `handlers` are {@link computerlessToolHandlers}:
 * nothing else is ever callable, offered or not. */
export class AskToolset {
  private readonly on = new Set(ASK_TOOL_NAMES);
  constructor(private readonly handlers: Record<string, (args: any) => Promise<string>>) {}

  schemas(): ToolSchema[] {
    // A stable order (Ask's own first, then what was turned on) keeps the cached prefix valid.
    const byName = new Map(COMPUTERLESS_TOOL_SCHEMAS.map((tool) => [tool.name, tool]));
    const added = COMPUTERLESS_TOOL_SCHEMAS.filter((tool) => this.on.has(tool.name) && !ASK_TOOL_NAMES.includes(tool.name));
    return [...ASK_TOOL_NAMES.map((name) => byName.get(name)!), ...added, this.moreTools()];
  }

  private moreTools(): ToolSchema {
    return {
      name: 'more_tools',
      description: 'Your tools are the ones most requests need. Call with no names to list the others '
        + '(sub-tasks, credentials, payments, cloud providers, GitHub Actions, events, mail, skills, generating media…), '
        + 'or with names to turn those on for the rest of this turn.',
      parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: 'Tools to turn on.' } } },
    };
  }

  /** name → handler for every tool this turn may call (offered or not), as the API rails look them up. */
  asHandlers(): Record<string, (args: any) => Promise<string>> {
    return Object.fromEntries([...Object.keys(this.handlers), 'more_tools'].map((name) => [name, (args: any) => this.call(name, args)]));
  }

  async call(name: string, args: any): Promise<string> {
    if (name === 'more_tools') {
      const names: string[] = Array.isArray(args?.names) ? args.names.map(String) : [];
      if (!names.length) {
        return COMPUTERLESS_TOOL_SCHEMAS.filter((tool) => !this.on.has(tool.name))
          .map((tool) => `${tool.name}: ${firstSentence(tool.description)}`).join('\n');
      }
      const known = new Set(COMPUTERLESS_TOOL_SCHEMAS.map((tool) => tool.name));
      const added = names.filter((n) => known.has(n));
      const unknown = names.filter((n) => !known.has(n));
      for (const n of added) this.on.add(n);
      return [added.length ? `Turned on: ${added.join(', ')}.` : '',
        unknown.length ? `Not tools of a task without a computer: ${unknown.join(', ')}.` : ''].filter(Boolean).join(' ');
    }
    const handler = this.handlers[name];
    if (!handler) throw new Error(`unknown tool ${name}: a task without a computer has only tavya's own tools`);
    return handler(args ?? {});
  }
}

/**
 * OpenRouter routing for one host-side turn: the organization's own
 * (`modelOptions.provider`: zero data retention, no 4-bit builds) with the
 * cheapest provider first — the same model costs up to 6× more on another
 * (ask-eval 2026-11-19: MiMo-V2.6-Pro $0.0037 an Ask on DeepInfra, $0.022 on
 * PrimaLabs) — and, once one has answered, that one first for the rest of the
 * turn, so the prefix it cached keeps being read. Others stay as fallbacks.
 */
export function openRouterRouting(base: Record<string, unknown> | undefined, served: string | undefined): Record<string, unknown> {
  return { ...base, sort: 'price', ...(served ? { order: [served], allow_fallbacks: true } : {}) };
}

/** OpenRouter/OpenAI reasoning effort from a profile's (low…max). */
function reasoningBody(vendor: string, effort: string | undefined): Record<string, unknown> {
  if (!effort || effort === 'none') return {};
  const level = ['minimal', 'low', 'medium', 'high'].includes(effort) ? effort : 'high';
  if (vendor === 'openrouter') return { reasoning: { effort: level } };
  if (vendor === 'openai') return { reasoning_effort: level };
  return {};
}

/**
 * The host-side tool-use loop over an OpenAI-compatible Chat Completions
 * endpoint, for OpenCode models on a task without a computer. Stateless like
 * the Messages API rail: every round sends the whole exchange, and follow-ups
 * that arrive mid-turn are folded in when the model goes idle (SPEC §5.6).
 */
export async function runChatCompletionsTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
  ctx.emitActivity ??= () => {};
  const endpoint = chatCompletionsEndpoint(input.profile.model);
  if (!endpoint) throw new ComputerlessModelUnsupported(computerlessModelGap(input.profile, { apiKey: true }) ?? NEEDS_API);
  // Only the key the activity resolved for this organization (computerlessApiKey).
  const apiKey = input.resolvedAuth?.apiKey;
  if (!apiKey) throw loginNeedsComputer('opencode');
  const label = `${endpoint.vendor} Chat Completions`;
  (await (await currentTiming())?.mark('provider.selected', { provider: input.profile.provider, model: input.profile.model }));
  const toolset = new AskToolset(computerlessToolHandlers(input.world, ctx));
  const tools = () => toolset.schemas().map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  const openRouter = endpoint.vendor === 'openrouter';
  let served: string | undefined;
  // OpenRouter caches an Anthropic model's prefix only up to a marked block (ask-eval 2026-11-19: 0% cached without it).
  const marksCache = openRouter && endpoint.model.startsWith('anthropic/');
  const messages: any[] = [{ role: 'system', content: marksCache
    ? [{ type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } }] : input.systemPrompt }];
  const conversation = input.messages.filter((m) => m.role !== 'system');
  for (const m of conversation) messages.push(m.role === 'agent' ? { role: 'assistant', content: m.text } : { role: 'user', content: chatUserContent(m) });
  if (!conversation.length) messages.push({ role: 'user', content: 'Begin the task described in the instructions.' });

  const reportedUsage = new ReportedUsage();
  const maxIters = input.maxTurns ?? input.profile.maxTurns ?? RUNAWAY_BACKSTOP;
  let finalText = '';
  let terminal: { status: string; reason?: string } | undefined;
  let deliveredIndex = input.messages.length;
  const injectFollowUps = async (): Promise<number> => {
    if (!ctx.pullFollowUps) return 0;
    let added = 0;
    try {
      for (const m of await ctx.pullFollowUps(deliveredIndex)) {
        if (m.role !== 'system' && m.role !== 'agent') {
          messages.push({ role: 'user', content: chatUserContent(m) });
          added++;
        }
        deliveredIndex++;
        ctx.followUpsDelivered?.(deliveredIndex);
      }
    } catch { /* a failed poll must never break the turn */ }
    return added;
  };

  try {
    for (let i = 0; i < maxIters; i++) {
      if (ctx.signal?.aborted) break;
      ctx.heartbeat?.();
      const data = await timed('provider.roundtrip', () => readStreamOnceMore(label, async () => {
        const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: endpoint.model,
            messages,
            tools: tools(),
            ...reasoningBody(endpoint.vendor, input.profile.effort),
            // tavya's included model routes only to providers that keep no prompts.
            ...input.resolvedAuth?.modelOptions,
            ...(openRouter ? { provider: openRouterRouting(input.resolvedAuth?.modelOptions?.provider as Record<string, unknown> | undefined, served) } : {}),
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: ctx.signal,
        });
        if (!res.ok) {
          const message = `${label} ${res.status}: ${(await res.text()).slice(0, 500)}`;
          throw providerErrorFromMessage('opencode', message, 'structured', apiThrottle(res));
        }
        const read = await readChatCompletion(res, (text) => ctx.emit(text, 'assistant'), label);
        (await (await currentTiming())?.markOnce('first.output'));
        return read;
      }));
      if (openRouter && typeof data?.provider === 'string') served ??= data.provider;
      const usage = data?.usage;
      // Usage accounting is required even when timing collection is absent.
      const roundUsage = reportedUsage.add({ input_tokens: usage?.prompt_tokens, output_tokens: usage?.completion_tokens,
        input_tokens_details: { cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0 } }, 'codex');
      (await (await currentTiming())?.mark('provider.usage', roundUsage));
      const choice = data?.choices?.[0];
      const message = choice?.message ?? {};
      const calls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const text = typeof message.content === 'string' ? message.content : '';
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (text) {
        finalText = text;
        ctx.emit(text, 'assistant');
        ctx.emitActivity({ id: `message-${i}`, kind: 'message', phase: 'completed', title: text });
      }
      if (!calls.length) {
        // Cut off by its output cap: not a finished turn (see the Messages rail).
        if (choice?.finish_reason === 'length') { messages.push({ role: 'user', content: 'Continue.' }); continue; }
        if (choice?.finish_reason !== 'stop')
          throw new Error(`${label} turn did not complete successfully (finish_reason=${String(choice?.finish_reason ?? 'missing')})`);
        if (await injectFollowUps()) continue;
        terminal = { status: 'stop', reason: 'stop' };
        break;
      }
      let completed = false;
      for (const call of calls) {
        const name = String(call?.function?.name ?? '');
        let args: unknown = {};
        let result: unknown;
        let failed = false;
        try {
          args = call?.function?.arguments ? JSON.parse(String(call.function.arguments)) : {};
        } catch {
          failed = true;
          result = `invalid JSON arguments for ${name}`;
        }
        const block = { id: call?.id, name, input: args };
        ctx.emitActivity(claudeToolActivity(block, 'started'));
        if (!failed) {
          try {
            result = await toolset.call(name, args);
          } catch (error) {
            failed = true;
            result = error instanceof Error ? error.message : String(error);
          }
        }
        ctx.emitActivity(claudeToolActivity(block, 'completed', result));
        messages.push({ role: 'tool', tool_call_id: call?.id, content: `${failed ? 'error: ' : ''}${typeof result === 'string' ? result : JSON.stringify(result)}` });
        if (!failed && name === 'signal_completion') completed = true;
      }
      if (completed) { terminal = { status: 'tool_calls', reason: 'signal_completion' }; break; }
    }
    if (ctx.signal?.aborted) throw new Error(`${label} turn cancelled`);
    if (!terminal) throw new Error(`${label} turn exceeded its ${maxIters}-iteration backstop without a successful terminal response`);
    return {
      termination: { kind: 'success', ...terminal },
      session: input.session,
      output: finalText,
      delivered: deliveredIndex,
      usage: reportedUsage.total(),
    };
  } finally {
    ctx.reportUsage?.(reportedUsage.total());
  }
}
