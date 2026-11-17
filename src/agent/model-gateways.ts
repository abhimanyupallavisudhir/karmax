/**
 * Model gateways (wiki features/model-gateways): how a Claude Code or Codex
 * agent runs on the organization's compute credit when it has no login or key
 * of its own for that harness.
 *
 * In order, a turn uses: the organization's own login or key (unchanged, and
 * decided before anything here); else an **operator gateway** that serves the
 * model and is on, cheapest first; else **OpenRouter**, through the included
 * model's account (src/agent/included-model.ts); else nothing, and the task
 * says what login it needs.
 *
 * - **Operator gateways** are Anthropic-compatible (Claude Code) or OpenAI
 *   Responses-compatible (Codex) endpoints the installation's operator adds:
 *   LiteLLM, a company proxy, a Bedrock gateway. Each is off until the
 *   operator turns it on. Its key never leaves the control plane: the agent's
 *   harness talks to tavya's proxy (`/api/model-gateway`, src/gateway/
 *   model-gateway-proxy.ts) with a token good for one turn, and the proxy
 *   forwards each request with the real key, reads the tokens the gateway
 *   reports, and books them as managed `agent.cost` at the gateway's price —
 *   `priceMultiplier` × the model's API list price (src/agent/model-prices.ts)
 *   — which the credit charges at the organization's compute multiplier.
 * - **OpenRouter** serves Claude Code at its Anthropic-compatible endpoint and
 *   Codex at its Responses endpoint with the organization's own OpenRouter key
 *   (the included model's: its limit follows the credit, what it spends is read
 *   back and booked), so no proxy is needed.
 */
import crypto from 'node:crypto';
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../autonomy/vault-keys.js';
import type { AgentProfile } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { includedModel, isIncludedModel } from './included-model.js';
import { catalogueModelId, modelListPrice, openRouterApiBase, openRouterPrices, type ModelPrice } from './model-prices.js';
import { defaultModel } from './profiles.js';

/** The harnesses a gateway can serve: Claude Code speaks Anthropic's Messages
 * API, Codex OpenAI's Responses API. */
export const GATEWAY_HARNESSES = ['claude', 'codex'] as const;
export type GatewayHarness = typeof GATEWAY_HARNESSES[number];

export interface ModelGateway {
  id: string;
  name: string;
  harnesses: GatewayHarness[];
  /** The address before `/v1` (`https://litellm.example.com`): Claude Code
   * calls `<base>/v1/messages`, Codex `<base>/v1/responses`. */
  baseUrl: string;
  /** The models it serves, as the harness names them (`claude-opus-5-5`, `gpt-6.1-sol`). */
  models: string[];
  /** What a turn costs: this × the model's API list price. */
  priceMultiplier: number;
  /** Off until the operator turns it on. */
  enabled: boolean;
}

export interface ModelGatewayInput extends Partial<Omit<ModelGateway, 'id'>> { apiKey?: string }

export interface ModelGatewayView extends ModelGateway {
  keyConfigured: boolean;
  /** Listed models with no known list price: the gateway is not used for them. */
  unpriced: string[];
  /** This month: at the gateway's price, and what organizations were charged. */
  costMicros: number;
  chargedMicros: number;
}

const CONFIG_KEY = 'model-gateways:config';
const keyHandle = (id: string) => `model-gateway:installation:${id}:key`;
export const gatewayUsageProvider = (id: string) => `gateway:${id}`;
/** Where the agent's harness reaches a gateway through tavya. */
export const GATEWAY_PROXY_PATH = '/api/model-gateway';

export async function modelGateways(store: Store): Promise<ModelGateway[]> {
  try {
    const value = JSON.parse((await store.kvGet(CONFIG_KEY)) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is ModelGateway => !!entry && typeof entry.id === 'string') : [];
  } catch { return []; }
}

const MODEL_ID = /^[\w.:~/@-]+(?:\[[\w.]+\])?$/;

function validated(input: ModelGatewayInput, previous?: ModelGateway): Omit<ModelGateway, 'id'> {
  const name = (input.name ?? previous?.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('a gateway needs a name of at most 80 characters');
  let url: URL;
  try { url = new URL((input.baseUrl ?? previous?.baseUrl ?? '').trim()); } catch { throw new Error('baseUrl must be an http(s) URL'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('baseUrl must be an http(s) URL with no credentials, query or fragment');
  const baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '').replace(/\/v1$/, '');
  const harnesses = [...new Set(input.harnesses ?? previous?.harnesses ?? [])];
  if (!harnesses.length || harnesses.some((harness) => !(GATEWAY_HARNESSES as readonly string[]).includes(harness)))
    throw new Error(`harnesses must name one or both of ${GATEWAY_HARNESSES.join(', ')}`);
  const models = [...new Set((input.models ?? previous?.models ?? []).map((model) => String(model).trim()).filter(Boolean))];
  if (!models.length || models.length > 100 || models.some((model) => model.length > 120 || !MODEL_ID.test(model)))
    throw new Error('models must list the model ids the gateway serves (at most 100)');
  const priceMultiplier = Number(input.priceMultiplier ?? previous?.priceMultiplier);
  if (!Number.isFinite(priceMultiplier) || priceMultiplier <= 0 || priceMultiplier > 100)
    throw new Error('priceMultiplier must be a number above 0 and at most 100 (× the model\'s API list price)');
  return { name, harnesses, baseUrl, models, priceMultiplier, enabled: input.enabled ?? previous?.enabled ?? false };
}

/** Add (no `id`) or change a gateway (operator; PUT /api/settings/model-gateways).
 * A new one is off unless `enabled` is given; its key is required, write-only. */
export async function saveModelGateway(store: Store, broker: CredentialBroker, id: string | undefined,
  input: ModelGatewayInput): Promise<ModelGateway> {
  const all = await modelGateways(store);
  const previous = id ? all.find((gateway) => gateway.id === id) : undefined;
  if (id && !previous) throw Object.assign(new Error(`no model gateway ${id}`), { status: 404 });
  const gateway: ModelGateway = { id: previous?.id ?? `gw_${crypto.randomBytes(5).toString('hex')}`, ...validated(input, previous) };
  const apiKey = input.apiKey?.trim();
  if (!apiKey && !(await broker.hasHandle(keyHandle(gateway.id)))) throw new Error('the gateway\'s API key is required');
  if (apiKey) await broker.registerHandle(keyHandle(gateway.id), apiKey, INSTALLATION_SCOPE);
  await store.kvSet(CONFIG_KEY, JSON.stringify(previous ? all.map((entry) => entry.id === gateway.id ? gateway : entry) : [...all, gateway]));
  return gateway;
}

export async function deleteModelGateway(store: Store, broker: CredentialBroker, id: string): Promise<boolean> {
  const all = await modelGateways(store);
  if (!all.some((gateway) => gateway.id === id)) return false;
  await store.kvSet(CONFIG_KEY, JSON.stringify(all.filter((gateway) => gateway.id !== id)));
  await broker.deleteHandle(keyHandle(id)).catch(() => undefined);
  return true;
}

/** The operator's view: every gateway, without its key, with this month's use. */
export async function modelGatewaysView(store: Store, broker: CredentialBroker, month: { from: number; to: number }): Promise<ModelGatewayView[]> {
  const gateways = await modelGateways(store);
  if (!gateways.length) return [];
  const rows = await store.managedComputeCosts(month.from, month.to);
  return Promise.all(gateways.map(async (gateway) => {
    const own = rows.filter((row) => row.provider === gatewayUsageProvider(gateway.id));
    const unpriced: string[] = [];
    for (const model of gateway.models) if (!(await modelListPrice(model))) unpriced.push(model);
    return { ...gateway, keyConfigured: await broker.hasHandle(keyHandle(gateway.id)), unpriced,
      costMicros: own.reduce((total, row) => total + row.costMicros, 0),
      chargedMicros: own.reduce((total, row) => total + row.chargedMicros, 0) };
  }));
}

/** The model a profile runs, as matched against what a gateway serves. */
export function harnessModel(profile: Pick<AgentProfile, 'provider' | 'model'>): string | undefined {
  return profile.model ?? defaultModel(profile.provider);
}

const bare = (model: string) => model.replace(/\[[^\]]*\]$/, '');

/** The operator gateways that can run `profile`, cheapest first: on, with a
 * key, serving its harness and model, and the model's list price known. */
export async function servingGateways(store: Store, broker: CredentialBroker | undefined,
  profile: Pick<AgentProfile, 'provider' | 'model'>): Promise<ModelGateway[]> {
  const harness = profile.provider as GatewayHarness;
  if (!(GATEWAY_HARNESSES as readonly string[]).includes(harness) || !broker) return [];
  const model = harnessModel(profile);
  if (!model) return [];
  const candidates = (await modelGateways(store)).filter((gateway) => gateway.enabled && gateway.harnesses.includes(harness)
    && gateway.models.some((served) => served === model || bare(served) === bare(model)));
  if (!candidates.length || !(await modelListPrice(model))) return [];
  const keyed = [];
  for (const gateway of candidates) if (await broker.hasHandle(keyHandle(gateway.id))) keyed.push(gateway);
  return keyed.sort((a, b) => a.priceMultiplier - b.priceMultiplier || a.name.localeCompare(b.name));
}

/** OpenRouter's id for what a Claude Code or Codex profile runs: an Anthropic
 * model for Claude Code, an OpenAI one for Codex (OpenRouter serves others on
 * both endpoints, but Claude Code is only made for Claude). A context suffix
 * (`[1m]`) is kept for Claude Code, which reads it itself. */
export function openRouterHarnessModel(provider: AgentProfile['provider'], model: string | undefined): string | undefined {
  const id = catalogueModelId(model);
  if (!id) return undefined;
  const lab = id.replace(/^~/, '').split('/')[0];
  if (provider === 'claude' && lab === 'anthropic') return `${id}${model?.match(/\[[^\]]*\]$/)?.[0] ?? ''}`;
  if (provider === 'codex' && lab === 'openai') return id;
  return undefined;
}

/** How a turn with nothing of the organization's own runs on its credit:
 * the included model (OpenCode, `openrouter/…`), an operator gateway, or a
 * Claude/Codex model through OpenRouter. */
export type CreditRail =
  | { kind: 'included' }
  | { kind: 'gateway'; gateway: ModelGateway; model: string }
  | { kind: 'openrouter'; model: string };

export async function creditRail(store: Store, broker: CredentialBroker | undefined,
  profile: Pick<AgentProfile, 'provider' | 'model'>): Promise<CreditRail | undefined> {
  if (profile.provider === 'opencode')
    return broker && isIncludedModel(profile, await includedModel(store, broker)) ? { kind: 'included' } : undefined;
  if (profile.provider !== 'claude' && profile.provider !== 'codex') return undefined;
  const model = harnessModel(profile)!;
  const [gateway] = await servingGateways(store, broker, profile);
  if (gateway) return { kind: 'gateway', gateway, model };
  if (!broker || !(await includedModel(store, broker))) return undefined;
  const id = openRouterHarnessModel(profile.provider, model);
  if (!id || !(await openRouterPrices().catch(() => undefined))?.has(bare(id))) return undefined;
  return { kind: 'openrouter', model: id };
}

/** What the harness is given for a turn on a gateway: where to send model
 * requests, the credential to send, the model as the gateway names it, and
 * (Claude Code) its family aliases, so a sub-agent or background call on
 * `haiku` reaches a model the gateway serves. */
export interface GatewayAuth { baseUrl: string; apiKey: string; model: string; env?: Record<string, string> }

const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

function claudeAliases(pick: (family: typeof CLAUDE_FAMILIES[number]) => string): Record<string, string> {
  return Object.fromEntries(CLAUDE_FAMILIES.map((family) => [`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`, pick(family)]));
}

/** OpenRouter's Anthropic-compatible root (Claude Code adds `/v1/messages`)
 * and Responses base (Codex adds `/responses`). */
export function openRouterTurnAuth(harness: GatewayHarness, model: string, key: string): GatewayAuth {
  const v1 = openRouterApiBase();
  return harness === 'claude'
    ? { baseUrl: v1.replace(/\/v1$/, ''), apiKey: key, model, env: claudeAliases((family) => `~anthropic/claude-${family}-latest`) }
    : { baseUrl: v1, apiKey: key, model };
}

/** A turn through an operator gateway reaches tavya's proxy at `root`. */
export function proxyTurnAuth(gateway: ModelGateway, harness: GatewayHarness, model: string, token: string, root: string): GatewayAuth {
  return harness === 'claude'
    ? { baseUrl: root, apiKey: token, model, env: claudeAliases((family) =>
      gateway.models.find((served) => served.includes(family)) ?? model) }
    : { baseUrl: `${root}/v1`, apiKey: token, model };
}

/** The proxy's address as the agent's harness sees it: the public URL from a
 * computer in the cloud, the gateway's own from this machine. Undefined when
 * a cloud computer could not reach it. */
export function proxyRoot(remote: boolean): string | undefined {
  const base = remote ? process.env.KARMAX_PUBLIC_URL
    : process.env.KARMAX_GATEWAY_URL ?? process.env.KARMAX_PUBLIC_URL ?? 'http://127.0.0.1:4505';
  return base ? `${base.replace(/\/+$/, '')}${GATEWAY_PROXY_PATH}` : undefined;
}

// ── One turn's proxy token ───────────────────────────────────────────────────

/** What a proxy token lets its holder do: send one organization's model
 * requests through one gateway, for one turn (revoked when it ends; a turn
 * that never ends cleanly loses it after `GATEWAY_TOKEN_TTL_MS`). */
export interface GatewayGrant { gatewayId: string; harness: GatewayHarness; organizationId: string; projectId?: string; taskId?: string; expiresAt: number }

export const GATEWAY_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;
const TOKEN_PREFIX = 'model-gateway:token:';
const tokenKey = (token: string) => `${TOKEN_PREFIX}${crypto.createHash('sha256').update(token).digest('hex')}`;

export async function issueGatewayToken(store: Store, grant: Omit<GatewayGrant, 'expiresAt'>, now = Date.now()): Promise<string> {
  const token = `tmg_${crypto.randomBytes(24).toString('base64url')}`;
  await store.kvSet(tokenKey(token), JSON.stringify({ ...grant, expiresAt: now + GATEWAY_TOKEN_TTL_MS } satisfies GatewayGrant));
  return token;
}

export async function gatewayGrant(store: Store, token: string, now = Date.now()): Promise<GatewayGrant | undefined> {
  if (!token.startsWith('tmg_')) return undefined;
  const raw = await store.kvGet(tokenKey(token));
  if (!raw) return undefined;
  try {
    const grant = JSON.parse(raw) as GatewayGrant;
    if (grant.expiresAt > now) return grant;
  } catch { /* unreadable: refuse */ }
  await store.kvDelete(tokenKey(token));
  return undefined;
}

export async function revokeGatewayToken(store: Store, token: string): Promise<void> {
  await store.kvDelete(tokenKey(token));
}

/** Drop tokens of turns that never ended cleanly (the lifecycle sweep). */
export async function pruneGatewayTokens(store: Store, now = Date.now()): Promise<void> {
  for (const { key, value } of await store.kvEntries(TOKEN_PREFIX)) {
    let expiresAt = 0;
    try { expiresAt = Number((JSON.parse(value) as GatewayGrant).expiresAt) || 0; } catch { /* drop */ }
    if (expiresAt <= now) await store.kvDelete(key);
  }
}

/** The key the proxy sends on: only the proxy reads it. */
export async function gatewayKey(broker: CredentialBroker, gatewayId: string): Promise<string> {
  return broker.resolve(keyHandle(gatewayId), { caps: [`use-credential:${keyHandle(gatewayId)}`] });
}

// ── Metering ─────────────────────────────────────────────────────────────────

/** Tokens one model request used, as the gateway reported them. `inputTokens`
 * excludes cache reads and writes. */
export interface MeteredUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string }

const count = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0));

/** Reads the usage a response reports, from its bytes as they pass: an
 * Anthropic Messages response (`message_start` + `message_delta` when
 * streamed, `usage` otherwise) or an OpenAI Responses one (`response.completed`
 * and its failed/incomplete siblings when streamed). What a stream cut short
 * had already reported (a `message_start`'s input tokens) still counts. */
export class UsageMeter {
  private line = '';
  private raw = '';
  private rawOverflow = false;
  private usage: MeteredUsage | undefined;
  private readonly decoder = new TextDecoder();

  constructor(private readonly harness: GatewayHarness) {}

  push(chunk: Uint8Array | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (!this.rawOverflow) {
      this.raw += text;
      if (this.raw.length > 8 * 1024 * 1024) { this.rawOverflow = true; this.raw = ''; }
    }
    this.line += text;
    let newline: number;
    while ((newline = this.line.indexOf('\n')) >= 0) {
      this.event(this.line.slice(0, newline));
      this.line = this.line.slice(newline + 1);
    }
  }

  private event(line: string): void {
    const data = line.trim().match(/^data:\s*(.*)$/)?.[1];
    if (!data || data === '[DONE]') return;
    try { this.inspect(JSON.parse(data)); } catch { /* not JSON: a comment or keep-alive */ }
  }

  private inspect(value: any): void {
    if (!value || typeof value !== 'object') return;
    if (this.harness === 'claude') {
      const usage = value.type === 'message_start' ? value.message?.usage : value.usage;
      const model = value.type === 'message_start' ? value.message?.model : value.model;
      if (usage && typeof usage === 'object') this.merge({ inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
        cacheReadTokens: count(usage.cache_read_input_tokens), cacheWriteTokens: count(usage.cache_creation_input_tokens),
        ...(typeof model === 'string' ? { model } : {}) });
      return;
    }
    const response = /^response\.(completed|incomplete|failed|done)$/.test(String(value.type ?? '')) ? value.response : value;
    const usage = response?.usage;
    if (!usage || typeof usage !== 'object') return;
    const cached = count(usage.input_tokens_details?.cached_tokens);
    this.merge({ inputTokens: Math.max(0, count(usage.input_tokens) - cached), outputTokens: count(usage.output_tokens),
      cacheReadTokens: cached, cacheWriteTokens: 0, ...(typeof response.model === 'string' ? { model: response.model } : {}) });
  }

  /** A stream reports counts more than once (input at the start, output at
   * the end, sometimes both again): each is the largest seen. */
  private merge(next: MeteredUsage): void {
    const prev = this.usage;
    this.usage = prev ? { inputTokens: Math.max(prev.inputTokens, next.inputTokens), outputTokens: Math.max(prev.outputTokens, next.outputTokens),
      cacheReadTokens: Math.max(prev.cacheReadTokens, next.cacheReadTokens), cacheWriteTokens: Math.max(prev.cacheWriteTokens, next.cacheWriteTokens),
      ...((next.model ?? prev.model) ? { model: next.model ?? prev.model } : {}) } : next;
  }

  /** The request's usage, once the response has ended. */
  result(): MeteredUsage | undefined {
    if (this.line) { this.event(this.line); this.line = ''; }
    if (!this.usage && this.raw && !this.rawOverflow) {
      try { this.inspect(JSON.parse(this.raw)); } catch { /* a stream, or no usage */ }
    }
    return this.usage;
  }
}

/** What `usage` costs at `multiplier` × the model's list price, in micros. */
export function gatewayCostMicros(usage: MeteredUsage, price: ModelPrice, multiplier: number): number {
  const usd = usage.inputTokens * price.prompt + usage.outputTokens * price.completion
    + usage.cacheReadTokens * (price.cache ?? price.prompt) + usage.cacheWriteTokens * (price.cacheWrite ?? price.prompt);
  // Whole micros, rounding up, without float noise lifting an exact amount by one.
  return Math.ceil(Math.round(usd * multiplier * 1e9) / 1e3);
}

/** Book one request through `gateway` to the grant's organization (and task)
 * as managed `agent.cost`: what the credit pays. Returns the micros booked. */
export async function bookGatewayRequest(store: Store, grant: GatewayGrant, gateway: ModelGateway, usage: MeteredUsage,
  price: ModelPrice, model: string, at = Date.now()): Promise<number> {
  const costMicros = gatewayCostMicros(usage, price, gateway.priceMultiplier);
  await store.recordUsage({ id: `usage:gateway:${crypto.randomUUID()}`, organizationId: grant.organizationId,
    ...(grant.projectId ? { projectId: grant.projectId } : {}), ...(grant.taskId ? { taskId: grant.taskId } : {}),
    provider: gatewayUsageProvider(gateway.id), kind: 'agent.cost', quantity: 1, unit: 'request', costMicros,
    startedAt: at, endedAt: at, fundingSource: 'managed', costClassification: 'incurred',
    metadata: { costBasis: 'model-gateway-list-price', gateway: gateway.id, model, priceMultiplier: gateway.priceMultiplier,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens } });
  return costMicros;
}
