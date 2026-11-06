/**
 * tavya's included model (wiki features/included-model): an OpenCode model
 * tavya pays for, so a new organization can run tasks before it connects a
 * login or key of its own. What it uses is charged to the same credit as
 * tavya's computers (the plan's, packs, top-ups and the free trial), at
 * COMPUTE_PRICE_MULTIPLIER × what the model's provider charged.
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
import type { Store } from '../store/db.js';
import { ComputeCreditExhausted, computeCredit, outOfCompute } from '../world/managed-compute.js';

/** Xiaomi MiMo-V2.6-Pro: the best intelligence per dollar on tavya's own
 * workload (2026-11-06). tavya's agents read far more than they write: 10.05 B
 * input tokens, nearly all cached, to 21.5 M output over 360 shipped tasks in
 * 30 days, so the cached-input price decides what a task costs, not the
 * output-heavy cost per task Artificial Analysis charts. At $0.435 / $0.87 /
 * $0.0036 per million input / output / cached tokens it scores 46.3 on the AA
 * Intelligence Index (Terminal-Bench 4.0: 34.9) for about $0.76 of such a task;
 * DeepSeek V4.1 Flash scores 39.5 for about $0.59, GPT-6.1 Sol 47.8 (medium)
 * for about $6 (its cached input is $0.10). */
export const INCLUDED_MODEL_DEFAULT = 'xiaomi/mimo-v2.6-pro';

/** Below this much credit (at tavya's prices) a turn on the included model
 * does not start. */
export const INCLUDED_MODEL_MIN_MICROS = 50_000;

const CONFIG_KEY = 'included-model:config';
const MANAGEMENT_HANDLE = 'included-model:installation:openrouter:management-key';
const keyRecord = (organizationId: string) => `included-model:key:${organizationId}`;
const keyHandle = (organizationId: string) => `included-model:organization:${organizationId}:openrouter-key`;
const apiBase = () => (process.env.KARMAX_OPENROUTER_API_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');

export interface IncludedModelSettings {
  /** The OpenRouter model id, e.g. xiaomi/mimo-v2.6-pro. */
  model: string;
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
    return value?.model ? { model: String(value.model), enabled: value.enabled !== false } : undefined;
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

/** The share of a typical tavya task's tokens at each price, from production
 * (see INCLUDED_MODEL_DEFAULT): per input token, 5% uncached and 95% read
 * from the cache, and 0.2% as many output tokens. */
const TASK_MIX = { prompt: 0.05, cache: 0.95, completion: 0.002 };
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

/** About how many times the included model's price a typical task on
 * `agentModel` (`openrouter/<id>`) costs; undefined when either price is unknown. */
export async function includedModelRelativeCost(settings: IncludedModelSettings, agentModel: string): Promise<number | undefined> {
  const id = agentModel.replace(/^openrouter\//, '');
  if (id === settings.model) return 1;
  const byId = await openRouterPrices().catch(() => undefined);
  const cost = (price?: { prompt: number; completion: number; cache?: number }) => price
    && TASK_MIX.prompt * price.prompt + TASK_MIX.cache * (price.cache ?? price.prompt) + TASK_MIX.completion * price.completion;
  const base = cost(byId?.get(settings.model)), other = cost(byId?.get(id));
  return base && other !== undefined ? other / base : undefined;
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
 * A new model moves Task defaults that named the old one along with it. */
export async function saveIncludedModel(store: Store, broker: CredentialBroker,
  input: { managementKey?: string; model?: string; enabled?: boolean }): Promise<IncludedModelSettings> {
  const previous = await readSettings(store);
  const model = (input.model ?? previous?.model ?? INCLUDED_MODEL_DEFAULT).trim();
  if (!/^[a-z0-9][\w.-]*\/[\w.:~-]+$/i.test(model)) throw new Error('model must be an OpenRouter model id such as xiaomi/mimo-v2.6-pro');
  const key = input.managementKey?.trim();
  if (key) await broker.registerHandle(MANAGEMENT_HANDLE, key, INSTALLATION_SCOPE);
  else if (!(await broker.hasHandle(MANAGEMENT_HANDLE))) throw new Error('an OpenRouter management key is required');
  const settings = { model, enabled: input.enabled ?? previous?.enabled ?? true };
  await store.kvSet(CONFIG_KEY, JSON.stringify(settings));
  if (previous && previous.model !== model) {
    const from = includedAgentModel(previous), to = includedAgentModel(settings);
    for (const profile of await store.listProfiles())
      if (profile.provider === 'opencode' && profile.model === from && profile.id.startsWith('organization:'))
        await store.upsertProfile({ ...profile, model: to });
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
    organizations: rows.length, costMicros, chargedMicros: costMicros * COMPUTE_PRICE_MULTIPLIER };
}

async function record(store: Store, organizationId: string): Promise<KeyRecord | undefined> {
  try { return JSON.parse((await store.kvGet(keyRecord(organizationId))) ?? 'null') ?? undefined; } catch { return undefined; }
}

/** The most the organization's key may have spent, in USD at OpenRouter's
 * prices: what it spent so far plus what its credit has left. */
function limitFor(usageUsd: number, availableMicros: number): number {
  return Math.floor((usageUsd + Math.max(0, availableMicros) / COMPUTE_PRICE_MULTIPLIER / 1e6) * 10_000) / 10_000;
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
  let existing = await record(store, organizationId);
  if (existing && !(await broker.hasHandle(keyHandle(organizationId)))) existing = undefined;
  if (!existing) {
    const created = await openRouter(broker, 'POST', '/keys', { name: `tavya ${organizationId}`, limit: limitFor(0, available) });
    const hash = String(created?.data?.hash ?? ''), key = String(created?.key ?? '');
    if (!hash || !key) throw new Error('OpenRouter did not return the new key');
    await broker.registerHandle(keyHandle(organizationId), key, organizationScope(organizationId));
    await store.kvSet(keyRecord(organizationId), JSON.stringify({ hash, limitUsd: limitFor(0, available) } satisfies KeyRecord));
    return key;
  }
  const current = (await openRouter(broker, 'GET', `/keys/${existing.hash}`))?.data ?? {};
  await bookUsage(store, organizationId, Number(current.usage) || 0, now);
  const limitUsd = limitFor(Number(current.usage) || 0, (await computeCredit(store, organizationId, now)).availableMicros ?? available);
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
      mcpConnections: inherited?.mcpConnections ?? [...DEFAULT_MCP_CONNECTIONS],
      ...(inherited?.maxTurns ? { maxTurns: inherited.maxTurns } : {}) });
  }
  return true;
}
