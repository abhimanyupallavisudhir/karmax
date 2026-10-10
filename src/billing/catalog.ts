import type { Store } from '../store/db.js';
import type { SubscriptionCatalogConfig } from './subscriptions.js';

/** Retired prices still identify subscriptions that were sold under them. */
export async function rememberSubscriptionCatalog(store: Pick<Store, 'db' | 'kvGet' | 'kvSet'>, provider: string,
  input: Partial<SubscriptionCatalogConfig>): Promise<SubscriptionCatalogConfig[]> {
  const key = `billing:catalog-history:${provider}`;
  return store.db.transaction(async () => {
    await store.db.lock(`kv:${key}`);
    const history = JSON.parse(await store.kvGet(key) ?? '[]') as SubscriptionCatalogConfig[];
    if (!input.individualPriceId || !input.teamBasePriceId || !input.teamSeatPriceId) return history;
    const catalog: SubscriptionCatalogConfig = {
      individualPriceId: input.individualPriceId, teamBasePriceId: input.teamBasePriceId, teamSeatPriceId: input.teamSeatPriceId,
      ...(input.individualProductId ? { individualProductId: input.individualProductId } : {}),
      ...(input.teamProductId ? { teamProductId: input.teamProductId } : {}),
      ...(input.storagePackPriceId ? { storagePackPriceId: input.storagePackPriceId } : {}),
      ...(input.storagePackProductId ? { storagePackProductId: input.storagePackProductId } : {}),
    };
    if (!history.some((entry) => JSON.stringify(entry) === JSON.stringify(catalog))) {
      history.unshift(catalog);
      await store.kvSet(key, JSON.stringify(history));
    }
    return history;
  });
}
