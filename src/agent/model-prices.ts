/**
 * Models' API list prices, from OpenRouter's public model catalogue (no key):
 * OpenRouter charges what each lab lists, so its catalogue is a maintained
 * mirror of Anthropic's and OpenAI's prices, cache reads and writes included.
 * The included model's relative cost (wiki features/included-model) and what a
 * turn through a model gateway costs (wiki features/model-gateways) both read
 * it; it is fetched at most every six hours.
 */

/** USD per token. `cacheRead`/`cacheWrite` absent: the model lists none. */
export interface ModelPrice { prompt: number; completion: number; cache?: number; cacheWrite?: number }

export const openRouterApiBase = () => (process.env.KARMAX_OPENROUTER_API_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');

const PRICES_TTL_MS = 6 * 60 * 60_000;
let prices: { at: number; byId: Map<string, ModelPrice> } | undefined;

/** Every model OpenRouter lists, by id, with its price. */
export async function openRouterPrices(now = Date.now()): Promise<Map<string, ModelPrice>> {
  if (prices && now - prices.at < PRICES_TTL_MS) return prices.byId;
  const response = await fetch(`${openRouterApiBase()}/models`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenRouter models: ${response.status}`);
  const byId = new Map<string, ModelPrice>();
  for (const model of ((await response.json()) as { data?: any[] }).data ?? []) {
    const p = model?.pricing ?? {};
    const prompt = Number(p.prompt), completion = Number(p.completion), cache = Number(p.input_cache_read), write = Number(p.input_cache_write);
    if (typeof model?.id === 'string' && Number.isFinite(prompt) && Number.isFinite(completion))
      byId.set(model.id, { prompt, completion,
        ...(p.input_cache_read != null && Number.isFinite(cache) ? { cache } : {}),
        ...(p.input_cache_write != null && Number.isFinite(write) ? { cacheWrite: write } : {}) });
  }
  prices = { at: now, byId };
  return byId;
}

/** Tests: forget cached prices. */
export function resetModelPrices(): void { prices = undefined; }

/** OpenRouter's id for a model as a harness names it: Claude Code's
 * `claude-opus-5-5` (or `claude-sonnet-4-5-20250929`) is
 * `anthropic/claude-opus-5.5`; its aliases (`opus`, `sonnet`, `haiku`, `fable`,
 * `default`) are OpenRouter's `~anthropic/claude-<family>-latest`; Codex's
 * `gpt-6.1-sol` is `openai/gpt-6.1-sol`. An id that already names its lab is
 * kept. A context suffix (`[1m]`) is not part of the id. Undefined for a model
 * of neither lab. */
export function catalogueModelId(model: string | undefined): string | undefined {
  const id = (model ?? '').replace(/\[[^\]]*\]$/, '').trim();
  if (!id) return undefined;
  if (id.includes('/')) return id;
  const alias = id === 'default' ? 'opus' : id;
  if (/^(opus|sonnet|haiku|fable)$/.test(alias)) return `~anthropic/claude-${alias}-latest`;
  if (id.startsWith('claude-')) return `anthropic/${id.replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
  if (/^(gpt-|o\d|codex-)/.test(id)) return `openai/${id}`;
  return undefined;
}

/** A model's list price, or undefined when the catalogue does not list it
 * (or cannot be read). */
export async function modelListPrice(model: string | undefined): Promise<ModelPrice | undefined> {
  const id = catalogueModelId(model);
  if (!id) return undefined;
  return (await openRouterPrices().catch(() => undefined))?.get(id);
}
