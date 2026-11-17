/**
 * Providers `generate` can use besides OpenRouter (wiki features/generate §
 * Other providers): model catalogues whose every model takes its own `input`
 * object and runs as a job — fal.ai (music, sound effects, 3D, upscaling,
 * lip-sync, background removal… ~1,500 endpoints) and Unifically (Suno among
 * others). The operator saves each provider's key (installation scope) and
 * switches it on; organizations use it on their compute credit, and agents
 * never see the key: the control plane submits, polls and downloads.
 *
 * Every provider gives a price before the request (fal: its pricing API;
 * Unifically: a dry run), so the quote → hold → settle of generation.ts
 * carries over. What a job actually cost is read back after it ends (fal:
 * billing events; Unifically: the task's cost) and booked as managed
 * `agent.cost` under the provider's id; when a provider will not say, the
 * quote is booked.
 *
 * Unifically is off until the operator switches it on: its Suno models show
 * every sign of driving Suno's consumer web app, which Suno's terms forbid
 * (owner's decision, 2026-11-16: available, off by default).
 */
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../autonomy/vault-keys.js';
import type { Store } from '../store/db.js';
import { QUOTE_CEILING_USD, type Quote } from './generation-price.js';

export const TASK_PROVIDERS = ['fal', 'unifically'] as const;
export type TaskProviderId = typeof TASK_PROVIDERS[number];

export interface TaskProviderInfo { id: TaskProviderId; name: string; enabledByDefault: boolean; models: string; tip: string }
export const TASK_PROVIDER_INFO: Readonly<Record<TaskProviderId, TaskProviderInfo>> = {
  fal: { id: 'fal', name: 'fal.ai', enabledByDefault: true, models: 'https://fal.ai/models',
    tip: 'Music, sound effects, 3D, upscaling, lip-sync, background removal and more: about 1,500 models, priced per request.' },
  unifically: { id: 'unifically', name: 'Unifically', enabledByDefault: false, models: 'https://docs.unifically.com/llms.txt',
    tip: 'Suno and other models. Its Suno access appears to use Suno’s consumer app, which Suno’s terms forbid: you answer for that, and commercial rights to the songs are unclear.' },
};

const CONFIG_KEY = 'generation-providers:config';
export const taskProviderKeyHandle = (id: TaskProviderId) => `generation-provider:installation:${id}:key`;

interface ProviderSettings { enabled: boolean }
type Settings = Partial<Record<TaskProviderId, ProviderSettings>>;

async function readSettings(store: Store): Promise<Settings> {
  try { return JSON.parse((await store.kvGet(CONFIG_KEY)) ?? '{}') as Settings; } catch { return {}; }
}

export interface TaskProviderView extends TaskProviderInfo { enabled: boolean; keyConfigured: boolean; costMicros: number; chargedMicros: number }

/** The operator's view: each provider, on or off, with this month's use. */
export async function taskProvidersView(store: Store, broker: CredentialBroker, month: { from: number; to: number }): Promise<TaskProviderView[]> {
  const settings = await readSettings(store);
  const rows = await store.managedComputeCosts(month.from, month.to);
  return Promise.all(TASK_PROVIDERS.map(async (id) => {
    const mine = rows.filter((row) => row.provider === id);
    return { ...TASK_PROVIDER_INFO[id], enabled: settings[id]?.enabled ?? false, keyConfigured: await broker.hasHandle(taskProviderKeyHandle(id)),
      costMicros: mine.reduce((total, row) => total + row.costMicros, 0), chargedMicros: mine.reduce((total, row) => total + row.chargedMicros, 0) };
  }));
}

/** Save a provider's key and switch (operator; PUT /api/settings/generation-providers/:id). A
 * first key switches fal on and leaves Unifically off. */
export async function saveTaskProvider(store: Store, broker: CredentialBroker, id: string, input: { apiKey?: string; enabled?: boolean }): Promise<void> {
  if (!(TASK_PROVIDERS as readonly string[]).includes(id)) throw Object.assign(new Error(`no generation provider ${id}`), { status: 404 });
  const provider = id as TaskProviderId;
  const key = input.apiKey?.trim();
  if (key) await broker.registerHandle(taskProviderKeyHandle(provider), key, INSTALLATION_SCOPE);
  const settings = await readSettings(store);
  const enabled = input.enabled ?? settings[provider]?.enabled ?? (key ? TASK_PROVIDER_INFO[provider].enabledByDefault : false);
  if (enabled && !key && !(await broker.hasHandle(taskProviderKeyHandle(provider)))) throw new Error(`${TASK_PROVIDER_INFO[provider].name} needs an API key`);
  await store.kvSet(CONFIG_KEY, JSON.stringify({ ...settings, [provider]: { enabled } }));
}

/** Remove a provider's key and switch it off. */
export async function removeTaskProvider(store: Store, broker: CredentialBroker, id: TaskProviderId): Promise<void> {
  await broker.deleteHandle(taskProviderKeyHandle(id)).catch(() => undefined);
  const settings = await readSettings(store);
  await store.kvSet(CONFIG_KEY, JSON.stringify({ ...settings, [id]: { enabled: false } }));
}

/** The provider's key when it is on, else why it cannot be used. */
export async function taskProviderKey(store: Store, broker: CredentialBroker | undefined, id: TaskProviderId): Promise<string> {
  const name = TASK_PROVIDER_INFO[id].name;
  if (!(await readSettings(store))[id]?.enabled) throw new TaskProviderUnavailable(`${name} is not offered on this installation: an operator turns it on in Installation → Managed compute`);
  const key = broker && await broker.resolve(taskProviderKeyHandle(id), { caps: [`use-credential:${taskProviderKeyHandle(id)}`] }).catch(() => undefined);
  if (!key) throw new TaskProviderUnavailable(`${name} has no API key on this installation`);
  return key;
}

export class TaskProviderUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'TaskProviderUnavailable'; }
}
/** The provider refused the request as given (status 400/404) or for money (402: the operator's balance). */
export class TaskProviderError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'TaskProviderError'; }
}

export type JobStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export interface Submitted { ref: string; status: JobStatus; urls?: { status: string; response: string } }
export interface Polled { status: JobStatus; output?: unknown; error?: string }

export interface TaskProvider {
  quote(key: string, model: string, input: Record<string, unknown>): Promise<Quote>;
  submit(key: string, model: string, input: Record<string, unknown>): Promise<Submitted>;
  poll(key: string, model: string, job: Submitted): Promise<Polled>;
  /** What the job cost, USD, when the provider says. */
  cost(key: string, model: string, job: Submitted): Promise<number | undefined>;
}

const base = (env: string, fallback: string) => (process.env[env] ?? fallback).replace(/\/$/, '');
async function request(url: string, init: RequestInit & { timeoutMs?: number }, provider: string): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 300) }; }
  if (!response.ok || body?.success === false) {
    const status = response.ok ? Number(body?.code) || 400 : response.status;
    const detail = body?.data?.message ?? body?.error?.message ?? body?.detail ?? body?.message ?? response.statusText;
    const message = `${provider}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`;
    if (status === 402) throw new TaskProviderError(message, 402);
    if (status >= 400 && status < 500) throw new TaskProviderError(message, status === 404 ? 404 : 400);
    throw new Error(`${message} (${status})`);
  }
  return body;
}

// ── fal.ai: a queue per model; pricing and billing APIs (fal.ai/docs) ──
const falQueue = () => base('KARMAX_FAL_QUEUE_URL', 'https://queue.fal.run');
const falApi = () => base('KARMAX_FAL_API_URL', 'https://api.fal.ai/v1');
const falHeaders = (key: string) => ({ authorization: `Key ${key}`, 'content-type': 'application/json' });
const falStatus = (value: unknown): JobStatus => value === 'COMPLETED' ? 'completed' : value === 'IN_PROGRESS' ? 'in_progress' : value === 'FAILED' || value === 'ERROR' ? 'failed' : 'pending';
const number = (value: unknown) => { const n = parseFloat(String(value ?? '')); return Number.isFinite(n) && n > 0 ? n : undefined; };

/** fal's price per unit × how many units this input asks for; a unit it
 * cannot count from the input (GPU seconds, megapixels) is quoted at the
 * ceiling. */
export function falQuote(prices: Array<{ unit_price?: unknown; unit?: unknown }> | undefined, input: Record<string, unknown>): Quote {
  const price = prices?.find((entry) => number(entry.unit_price) !== undefined);
  if (!price) return { usd: QUOTE_CEILING_USD.video, basis: 'ceiling' };
  const unit = String(price.unit ?? '').toLowerCase().replace(/s$/, '');
  const ms = number(input.music_length_ms);
  const seconds = number(input.duration) ?? number(input.duration_seconds) ?? number(input.seconds) ?? (ms !== undefined ? ms / 1000 : undefined);
  const quantity = /^(image|output_image)$/.test(unit) ? (number(input.num_images) ?? number(input.n) ?? 1)
    : /^(second|video_second|audio_second)$/.test(unit) ? seconds ?? 30
      : /^minute$/.test(unit) ? (seconds ?? 300) / 60
        : /^(video|request|call|generation|unit|clip|song|model)$/.test(unit) ? 1
          : undefined;
  if (quantity === undefined) return { usd: QUOTE_CEILING_USD.video, basis: 'ceiling' };
  return { usd: number(price.unit_price)! * quantity, basis: 'price-list' };
}

export const fal: TaskProvider = {
  async quote(key, model, input) {
    const body = await request(`${falApi()}/models/pricing?endpoint_id=${encodeURIComponent(model)}`, { headers: falHeaders(key) }, 'fal.ai')
      .catch((error) => { if (error instanceof TaskProviderError && error.status === 402) throw error; return undefined; });
    return falQuote(body?.prices, input);
  },
  async submit(key, model, input) {
    const body = await request(`${falQueue()}/${model}`, { method: 'POST', headers: { ...falHeaders(key), 'x-fal-store-io': '0' }, body: JSON.stringify(input) }, 'fal.ai');
    if (!body?.request_id) throw new Error('fal.ai did not return a request');
    return { ref: String(body.request_id), status: falStatus(body.status),
      urls: { status: String(body.status_url ?? `${falQueue()}/${model}/requests/${body.request_id}/status`),
        response: String(body.response_url ?? `${falQueue()}/${model}/requests/${body.request_id}`) } };
  },
  async poll(key, _model, job) {
    const state = await request(job.urls!.status, { headers: falHeaders(key) }, 'fal.ai');
    const status = falStatus(state?.status);
    if (status !== 'completed') return { status };
    try { return { status, output: await request(job.urls!.response, { headers: falHeaders(key) }, 'fal.ai') }; }
    catch (error) { return { status: 'failed', error: error instanceof Error ? error.message : String(error) }; }
  },
  async cost(key, _model, job) {
    const body = await request(`${falApi()}/models/billing-events?request_id=${encodeURIComponent(job.ref)}`, { headers: falHeaders(key) }, 'fal.ai').catch(() => undefined);
    const events: any[] = body?.billing_events ?? body?.events ?? body?.items ?? (Array.isArray(body) ? body : []);
    if (!events.length) return undefined;
    const eventCost = (event: any) => {
      const nano = number(event.cost_estimate_nano_usd);
      return number(event.cost_total) ?? (nano !== undefined ? nano / 1e9 : (number(event.quantity) ?? 0) * (number(event.unit_price) ?? 0));
    };
    const total = events.reduce((sum, event) => sum + eventCost(event), 0);
    return total > 0 ? total : undefined;
  },
};

// ── Unifically: one task API for every model (docs.unifically.com) ──
const unificallyApi = () => base('KARMAX_UNIFICALLY_API_URL', 'https://api.unifically.com');
const unificallyHeaders = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
const unificallyStatus = (value: unknown): JobStatus => value === 'completed' ? 'completed' : value === 'failed' ? 'failed' : 'in_progress';

export const unifically: TaskProvider = {
  async quote(key, model, input) {
    const body = await request(`${unificallyApi()}/v1/tasks`, { method: 'POST', headers: unificallyHeaders(key),
      body: JSON.stringify({ model, input, dry_run: true }) }, 'Unifically');
    const cost = Number(body?.data?.cost);
    if (!Number.isFinite(cost)) return { usd: QUOTE_CEILING_USD.video, basis: 'ceiling' };
    // A usage-priced model's dry run is an estimate: hold twice it.
    return { usd: body?.data?.estimated ? cost * 2 : cost, basis: 'price-list' };
  },
  async submit(key, model, input) {
    const body = await request(`${unificallyApi()}/v1/tasks`, { method: 'POST', headers: unificallyHeaders(key), body: JSON.stringify({ model, input }) }, 'Unifically');
    if (!body?.data?.task_id) throw new Error('Unifically did not return a task');
    return { ref: String(body.data.task_id), status: unificallyStatus(body.data.status) };
  },
  async poll(key, _model, job) {
    const data = (await request(`${unificallyApi()}/v1/tasks/${encodeURIComponent(job.ref)}`, { headers: unificallyHeaders(key) }, 'Unifically')
      .catch((error) => { if (error instanceof TaskProviderError && error.status === 400) return { data: { status: 'failed', error_message: error.message } }; throw error; }))?.data ?? {};
    const status = unificallyStatus(data.status);
    if (status === 'failed') return { status, error: String(data.error_message ?? 'the task failed') };
    if (status !== 'completed') return { status };
    const { input: _input, debug_response: _debug, callback_result: _callbacks, ...output } = data;
    return { status, output };
  },
  async cost(key, model, job) {
    const single = (await request(`${unificallyApi()}/v1/tasks/${encodeURIComponent(job.ref)}`, { headers: unificallyHeaders(key) }, 'Unifically').catch(() => undefined))?.data;
    if (Number.isFinite(Number(single?.cost)) && single?.cost !== null && single?.cost !== undefined) return Number(single.cost);
    const list = await request(`${unificallyApi()}/v1/tasks?model=${encodeURIComponent(model)}&page_size=100`, { headers: unificallyHeaders(key) }, 'Unifically').catch(() => undefined);
    const task = (list?.data ?? []).find((entry: any) => entry?.task_id === job.ref);
    return task && Number.isFinite(Number(task.cost)) ? Number(task.cost) : undefined;
  },
};

export const TASK_PROVIDER_IMPLS: Readonly<Record<TaskProviderId, TaskProvider>> = { fal, unifically };

const FILE_KEY = /(url|uri|file|audio|video|image|mesh|model_glb|glb|wav|mp3|mp4|png|jpg)$/i;
const FILE_EXT = /\.(png|jpe?g|webp|gif|svg|mp3|wav|flac|ogg|m4a|aac|mp4|webm|mov|glb|gltf|obj|fbx|usdz|ply|stl|zip|json|txt|srt|vtt|pdf)(\?|$)/i;

/** The https files a job's output names, in order, without repeats: values
 * under URL-like keys, or with a file extension (at most `max`). */
export function outputFiles(output: unknown, max = 8): string[] {
  const found: string[] = [];
  const walk = (value: unknown, key: string, depth: number) => {
    if (found.length >= max || depth > 6) return;
    if (typeof value === 'string') {
      if (/^https:\/\//i.test(value) && (FILE_KEY.test(key) || FILE_EXT.test(value)) && !found.includes(value)) found.push(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, key, depth + 1); return; }
    if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) walk(item, name, depth + 1);
  };
  walk(output, '', 0);
  return found;
}

/** Download a job's files (at most 300 MB together). */
export async function downloadOutputs(urls: string[], maxBytes = 300_000_000): Promise<Array<{ mediaType: string; base64: string; url: string }>> {
  const files: Array<{ mediaType: string; base64: string; url: string }> = [];
  let total = 0;
  for (const url of urls) {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`could not download ${new URL(url).hostname}${new URL(url).pathname} (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    total += bytes.length;
    if (total > maxBytes) throw new Error(`the outputs are larger than ${maxBytes / 1e6} MB`);
    files.push({ url, mediaType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream', base64: bytes.toString('base64') });
  }
  return files;
}
