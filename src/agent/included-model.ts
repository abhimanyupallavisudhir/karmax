/**
 * tavya's included model (wiki features/included-model): an OpenCode model
 * tavya pays for, so a new organization can run tasks before it connects a
 * login or key of its own. What it uses is charged to the same credit as
 * tavya's computers (the plan's, packs, top-ups and the free trial), at
 * COMPUTE_PRICE_MULTIPLIER (or the organization's own markup) × what the
 * model's provider charged.
 *
 * It runs on OpenRouter. The operator saves an OpenRouter management key; each
 * organization gets its own OpenRouter key from it, whose spending limit
 * follows the organization's credit. That key is what the agent's harness sees
 * (the model's key is in the sandbox, readable by the agent, as for any API
 * key: wiki features/remote-acp-agents), so a key taken out of the sandbox can
 * spend no more than the organization's own credit. What it spent is read back
 * from OpenRouter (the key's own usage, in USD) and booked as `agent.cost`
 * usage, funding `managed`.
 */
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE, organizationScope } from '../autonomy/vault-keys.js';
import { COMPUTE_PRICE_MULTIPLIER } from '../domain/entitlements.js';
import type { AgentProfile } from '../domain/types.js';
import { EFFORTS, type Effort } from './effort.js';
import type { Store } from '../store/db.js';
import { ComputeCreditExhausted, computeCredit, outOfCompute } from '../world/managed-compute.js';

/** DeepSeek V4.1 Flash at max effort (2026-11-07). On tavya's model
 * evaluation (wiki features/included-model: OpenCode as tavya runs it, three
 * real karmax fixes and six new-user tasks, each graded by a hidden test, two
 * runs each) it passed 17 of 18 on INCLUDED_MODEL_OPTIONS' providers (the
 * miss: OpenCode's output cap, now raised: OPENCODE_OUTPUT_TOKEN_MAX) for $0.021 a
 * task at OpenRouter's prices. GPT-6.1 Terra (medium) and Sol (medium) passed
 * all 18 for 2.8× and 5.1× that: they spend 2–3× fewer tokens, at 7–20× the
 * price. Claude Haiku 5.5 (high) costs about as much, but needed that cap
 * raised more often, and costs 5× past 100k tokens of context; MiMo-V2.6-Pro,
 * the previous default, missed 4 of 14 and was the slowest. */
export const INCLUDED_MODEL_DEFAULT = 'deepseek/deepseek-v4.1-flash-1017';
export const INCLUDED_MODEL_DEFAULT_EFFORT = 'max';

/** OpenRouter routing every turn on tavya's key asks for, whichever model the
 * organization picked: only providers that keep no prompts (zero data
 * retention), and no 4-bit build of an open model (closed models' providers
 * report no quantization, "unknown"). An open model is served by dozens of
 * providers, and OpenRouter otherwise picks the cheapest. */
export const INCLUDED_MODEL_OPTIONS = { provider: { zdr: true, quantizations: ['fp8', 'bf16', 'fp16', 'fp32', 'unknown'] } };

/** Below this much credit (at tavya's prices) a turn on the included model
 * does not start. */
export const INCLUDED_MODEL_MIN_MICROS = 50_000;

const CONFIG_KEY = 'included-model:config';
const MANAGEMENT_HANDLE = 'included-model:installation:openrouter:management-key';
const keyRecord = (organizationId: string) => `included-model:key:${organizationId}`;
const keyHandle = (organizationId: string) => `included-model:organization:${organizationId}:openrouter-key`;
const apiBase = () => (process.env.KARMAX_OPENROUTER_API_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');

export interface IncludedModelSettings {
  /** The OpenRouter model id, e.g. deepseek/deepseek-v4.1-flash-1017. */
  model: string;
  /** The reasoning effort Task defaults give it; none: the model's own. */
  effort?: string;
  enabled: boolean;
}

export interface IncludedModelView extends IncludedModelSettings {
  /** The OpenCode model the task form and Task defaults use. */
  agentModel: string;
  keyConfigured: boolean;
  /** Organizations with a key of their own, and what they used this month at
   * the provider's price (`costMicros`) and at tavya's (`chargedMicros`). */
  organizations: number;
  costMicros: number;
  chargedMicros: number;
}

interface KeyRecord { hash: string; limitUsd?: number }

/** `openrouter/<model>`: the model as an OpenCode agent names it. */
export const includedAgentModel = (settings: Pick<IncludedModelSettings, 'model'>) => `openrouter/${settings.model}`;

async function readSettings(store: Store): Promise<IncludedModelSettings | undefined> {
  try {
    const value = JSON.parse((await store.kvGet(CONFIG_KEY)) ?? 'null') as Partial<IncludedModelSettings> | null;
    return value?.model ? { model: String(value.model), ...(value.effort ? { effort: String(value.effort) } : {}),
      enabled: value.enabled !== false } : undefined;
  } catch { return undefined; }
}

/** The included model, when this hosted installation offers it. */
export async function includedModel(store: Store, broker?: CredentialBroker): Promise<IncludedModelSettings | undefined> {
  if (!store.hosted) return undefined;
  const settings = await readSettings(store);
  if (!settings?.enabled) return undefined;
  if (broker && !(await broker.hasHandle(MANAGEMENT_HANDLE))) return undefined;
  return settings;
}

/** Whether `profile` may run on the organization's credit: any OpenRouter
 * model, the included one being the default (another costs what it costs;
 * the task form says how much more: includedModelRelativeCost). */
export function isIncludedModel(profile: Pick<AgentProfile, 'provider' | 'model'>, settings: IncludedModelSettings | undefined): boolean {
  return !!settings && profile.provider === 'opencode' && /^openrouter\/[^/]+\/./.test(profile.model ?? '');
}

/** What a task cost on tavya's model evaluation (2026-11-07), USD at
 * OpenRouter's prices, averaged over the seven tasks every model ran twice;
 * keyed `<model>:<effort>`. A price alone misleads: GPT-6.1's tokens cost
 * 7–20× DeepSeek's, but it spends 2–3× fewer of them. */
export const MEASURED_TASK_USD: Readonly<Record<string, number>> = {
  'deepseek/deepseek-v4.1-flash-1017:max': 0.0209,
  'anthropic/claude-haiku-5.5:high': 0.0167,
  'openai/gpt-6-luna:max': 0.0208,
  'xiaomi/mimo-v2.6-pro:': 0.0413,
  'openai/gpt-6.1-terra:medium': 0.0582,
  'openai/gpt-6.1-terra:high': 0.0802,
  'openai/gpt-6.1-sol:medium': 0.1069,
};

/** Otherwise, the share of a task's tokens at each price, from the same
 * evaluation: per input token, 9% uncached and 91% read from the cache, and
 * 3.4% as many output tokens (reasoning included). */
const TASK_MIX = { prompt: 0.09, cache: 0.91, completion: 0.034 };
const PRICES_TTL_MS = 6 * 60 * 60_000;
let prices: { at: number; byId: Map<string, { prompt: number; completion: number; cache?: number }> } | undefined;

async function openRouterPrices(now = Date.now()) {
  if (prices && now - prices.at < PRICES_TTL_MS) return prices.byId;
  const response = await fetch(`${apiBase()}/models`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenRouter models: ${response.status}`);
  const byId = new Map<string, { prompt: number; completion: number; cache?: number }>();
  for (const model of ((await response.json()) as { data?: any[] }).data ?? []) {
    const p = model?.pricing ?? {};
    const prompt = Number(p.prompt), completion = Number(p.completion), cache = Number(p.input_cache_read);
    if (typeof model?.id === 'string' && Number.isFinite(prompt) && Number.isFinite(completion))
      byId.set(model.id, { prompt, completion, ...(Number.isFinite(cache) && p.input_cache_read !== undefined ? { cache } : {}) });
  }
  prices = { at: now, byId };
  return byId;
}

/** About how many times the included model's cost a typical task on
 * `agentModel` (`openrouter/<id>`) at `effort` costs: measured where both
 * were (MEASURED_TASK_USD), else from their prices; undefined when a price is
 * unknown. */
export async function includedModelRelativeCost(settings: IncludedModelSettings, agentModel: string, effort?: string): Promise<number | undefined> {
  const id = agentModel.replace(/^openrouter\//, '');
  if (id === settings.model && (effort ?? '') === (settings.effort ?? '')) return 1;
  const measured = (model: string, level?: string) => MEASURED_TASK_USD[`${model}:${level ?? ''}`];
  const base = measured(settings.model, settings.effort), other = measured(id, effort);
  if (base && other) return other / base;
  const byId = await openRouterPrices().catch(() => undefined);
  const cost = (price?: { prompt: number; completion: number; cache?: number }) => price
    && TASK_MIX.prompt * price.prompt + TASK_MIX.cache * (price.cache ?? price.prompt) + TASK_MIX.completion * price.completion;
  const baseCost = cost(byId?.get(settings.model)), otherCost = cost(byId?.get(id));
  return baseCost && otherCost !== undefined ? otherCost / baseCost : undefined;
}

/** Tests: forget cached prices. */
export function resetIncludedModelPrices(): void { prices = undefined; }

async function openRouter(broker: CredentialBroker, method: string, path: string, body?: unknown): Promise<any> {
  const key = await broker.resolve(MANAGEMENT_HANDLE, { caps: [`use-credential:${MANAGEMENT_HANDLE}`] });
  const response = await fetch(`${apiBase()}${path}`, { method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenRouter ${method} ${path.replace(/\/keys\/[^/]+/, '/keys/…')} failed (${response.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Save the installation's settings (operator; PUT /api/settings/included-model).
 * A new model or effort moves the Task defaults that named the old one along. */
export async function saveIncludedModel(store: Store, broker: CredentialBroker,
  input: { managementKey?: string; model?: string; effort?: string; enabled?: boolean }): Promise<IncludedModelSettings> {
  const previous = await readSettings(store);
  const model = (input.model ?? previous?.model ?? INCLUDED_MODEL_DEFAULT).trim();
  if (!/^[a-z0-9][\w.-]*\/[\w.:~-]+$/i.test(model)) throw new Error(`model must be an OpenRouter model id such as ${INCLUDED_MODEL_DEFAULT}`);
  // Effort: as given ('' for the model's own), else kept while the model is,
  // else the default model's.
  const effort = input.effort !== undefined ? input.effort.trim()
    : previous?.model === model ? previous.effort ?? '' : model === INCLUDED_MODEL_DEFAULT ? INCLUDED_MODEL_DEFAULT_EFFORT : '';
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
  const key = input.managementKey?.trim();
  if (key) await broker.registerHandle(MANAGEMENT_HANDLE, key, INSTALLATION_SCOPE);
  else if (!(await broker.hasHandle(MANAGEMENT_HANDLE))) throw new Error('an OpenRouter management key is required');
  const settings: IncludedModelSettings = { model, ...(effort ? { effort } : {}), enabled: input.enabled ?? previous?.enabled ?? true };
  await store.kvSet(CONFIG_KEY, JSON.stringify(settings));
  if (previous && (previous.model !== model || (previous.effort ?? '') !== effort)) {
    const from = includedAgentModel(previous), to = includedAgentModel(settings);
    for (const profile of await store.listProfiles())
      if (profile.provider === 'opencode' && profile.model === from && (profile.effort ?? '') === (previous.effort ?? '')
        && profile.id.startsWith('organization:')) {
        const { effort: _old, ...rest } = profile;
        await store.upsertProfile({ ...rest, model: to, ...(effort ? { effort: effort as Effort } : {}) });
      }
  }
  return settings;
}

/** The operator's view: settings, and this month's use across organizations. */
export async function includedModelView(store: Store, broker: CredentialBroker, month: { from: number; to: number }): Promise<IncludedModelView | null> {
  const settings = await readSettings(store);
  if (!settings) return null;
  const rows = (await store.managedComputeCosts(month.from, month.to)).filter((row) => row.provider === 'openrouter');
  const costMicros = rows.reduce((total, row) => total + row.costMicros, 0);
  return { ...settings, agentModel: includedAgentModel(settings), keyConfigured: await broker.hasHandle(MANAGEMENT_HANDLE),
    organizations: rows.length, costMicros, chargedMicros: rows.reduce((total, row) => total + row.chargedMicros, 0) };
}

async function record(store: Store, organizationId: string): Promise<KeyRecord | undefined> {
  try { return JSON.parse((await store.kvGet(keyRecord(organizationId))) ?? 'null') ?? undefined; } catch { return undefined; }
}

/** The most the organization's key may have spent, in USD at OpenRouter's
 * prices: what it spent so far plus what its credit has left (at tavya's
 * prices, `multiplier` × OpenRouter's). */
function limitFor(usageUsd: number, availableMicros: number, multiplier = COMPUTE_PRICE_MULTIPLIER): number {
  return Math.floor((usageUsd + Math.max(0, availableMicros) / multiplier / 1e6) * 10_000) / 10_000;
}

/** The organization's OpenRouter key for a turn on the included model, its
 * limit raised to what the credit has left (creating the key the first
 * time). Refused with ComputeCreditExhausted (an Out of compute wait) when
 * too little credit is left to start. */
export async function includedModelKey(store: Store, broker: CredentialBroker, organizationId: string, now = Date.now()): Promise<string> {
  const credit = await computeCredit(store, organizationId, now);
  if (credit.availableMicros != null && credit.availableMicros < INCLUDED_MODEL_MIN_MICROS)
    throw await outOfCompute(store, organizationId, 'openrouter', now);
  const available = credit.availableMicros ?? Number.MAX_SAFE_INTEGER;
  const multiplier = await store.computePriceMultiplier(organizationId, now);
  let existing = await record(store, organizationId);
  if (existing && !(await broker.hasHandle(keyHandle(organizationId)))) existing = undefined;
  if (!existing) {
    const created = await openRouter(broker, 'POST', '/keys', { name: `tavya ${organizationId}`, limit: limitFor(0, available, multiplier) });
    const hash = String(created?.data?.hash ?? ''), key = String(created?.key ?? '');
    if (!hash || !key) throw new Error('OpenRouter did not return the new key');
    await broker.registerHandle(keyHandle(organizationId), key, organizationScope(organizationId));
    await store.kvSet(keyRecord(organizationId), JSON.stringify({ hash, limitUsd: limitFor(0, available, multiplier) } satisfies KeyRecord));
    return key;
  }
  const current = (await openRouter(broker, 'GET', `/keys/${existing.hash}`))?.data ?? {};
  await bookUsage(store, organizationId, Number(current.usage) || 0, now);
  const limitUsd = limitFor(Number(current.usage) || 0, (await computeCredit(store, organizationId, now)).availableMicros ?? available, multiplier);
  if (limitUsd !== existing.limitUsd || current.disabled) {
    await openRouter(broker, 'PATCH', `/keys/${existing.hash}`, { limit: limitUsd, disabled: false });
    await store.kvSet(keyRecord(organizationId), JSON.stringify({ ...existing, limitUsd } satisfies KeyRecord));
  }
  return broker.resolve(keyHandle(organizationId), { caps: [`use-credential:${keyHandle(organizationId)}`] });
}

async function bookUsage(store: Store, organizationId: string, usageUsd: number, now: number, task?: { taskId: string; projectId?: string }) {
  return store.bookIncludedModelUsage({ organizationId, provider: 'openrouter', totalMicros: Math.round(usageUsd * 1e6), at: now, ...task });
}

/** Read what the organization's key has spent and book what is new, to
 * `task` when a turn on it just ended; with no credit left, close the key's
 * limit at what it has spent. Returns the micros booked. */
export async function syncIncludedModelUsage(store: Store, broker: CredentialBroker, organizationId: string,
  task?: { taskId: string; projectId?: string }, now = Date.now()): Promise<number> {
  const existing = await record(store, organizationId);
  if (!existing) return 0;
  const current = (await openRouter(broker, 'GET', `/keys/${existing.hash}`))?.data ?? {};
  const usageUsd = Number(current.usage) || 0;
  const booked = await bookUsage(store, organizationId, usageUsd, now, task);
  const available = (await computeCredit(store, organizationId, now)).availableMicros;
  if (available != null && available <= 0 && existing.limitUsd !== limitFor(usageUsd, 0)) {
    const limitUsd = limitFor(usageUsd, 0);
    await openRouter(broker, 'PATCH', `/keys/${existing.hash}`, { limit: limitUsd });
    await store.kvSet(keyRecord(organizationId), JSON.stringify({ ...existing, limitUsd } satisfies KeyRecord));
  }
  return booked;
}

/** Every organization's key, each sweep: what keys spent between turns (or
 * outside tavya) reaches the credit, and spent credit closes them. */
export async function syncAllIncludedModelUsage(store: Store, broker: CredentialBroker, now = Date.now()): Promise<void> {
  if (!store.hosted || !(await broker.hasHandle(MANAGEMENT_HANDLE))) return;
  for (const { key } of await store.kvEntries('included-model:key:')) {
    const organizationId = key.slice('included-model:key:'.length);
    await syncIncludedModelUsage(store, broker, organizationId, undefined, now).catch((error) =>
      console.warn(`[karmax] included model usage of ${organizationId}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** Delete the organization's key at OpenRouter (the organization is being deleted). */
export async function removeIncludedModelKey(store: Store, broker: CredentialBroker, organizationId: string): Promise<void> {
  const existing = await record(store, organizationId);
  if (!existing) return;
  await syncIncludedModelUsage(store, broker, organizationId).catch(() => 0);
  await openRouter(broker, 'DELETE', `/keys/${existing.hash}`).catch((error) => {
    if (!/\(404\)/.test(String(error))) throw error;
  });
  await broker.deleteHandle(keyHandle(organizationId));
  await store.kvDelete(keyRecord(organizationId));
}

/** A turn on the included model failed: when the credit is what ran out,
 * the task waits for more (Out of compute) instead of failing. */
export async function includedModelOutOfCredit(store: Store, broker: CredentialBroker, organizationId: string,
  task: { taskId: string; projectId?: string }, now = Date.now()): Promise<ComputeCreditExhausted | undefined> {
  await syncIncludedModelUsage(store, broker, organizationId, task, now).catch(() => 0);
  const credit = await computeCredit(store, organizationId, now);
  return credit.availableMicros != null && credit.availableMicros < INCLUDED_MODEL_MIN_MICROS
    ? outOfCompute(store, organizationId, 'openrouter', now) : undefined;
}

/** A new organization's Task defaults: every agent role on the included model,
 * so its first task runs without a login of its own. It changes them like any
 * Task default; connecting a login does not change them by itself. */
export async function seedIncludedModelDefaults(store: Store, broker: CredentialBroker | undefined, organizationId: string): Promise<boolean> {
  const settings = await includedModel(store, broker);
  if (!settings || !broker) return false;
  const { allRoles } = await import('../contrib/manifests.js');
  const { organizationProfileId, roleDefaultProfile, DEFAULT_MCP_CONNECTIONS } = await import('./profiles.js');
  for (const role of allRoles()) {
    const id = organizationProfileId(organizationId, role.name);
    if (await store.getProfile(id)) continue;
    const inherited = await roleDefaultProfile(store, role.name);
    await store.upsertProfile({ id, name: role.label, role: role.name, provider: 'opencode', model: includedAgentModel(settings),
      ...(settings.effort ? { effort: settings.effort as Effort } : {}),
      mcpConnections: inherited?.mcpConnections ?? [...DEFAULT_MCP_CONNECTIONS],
      ...(inherited?.maxTurns ? { maxTurns: inherited.maxTurns } : {}) });
  }
  return true;
}
