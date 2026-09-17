/** Each successful field access contributes one point, halving every 30 days.
 * Keep the browser's sortVaultItems decay interval in sync. */
export const VAULT_USAGE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export interface VaultUsage {
  useCount: number;
  frecencyScore: number;
  frecencyUpdatedAt: number;
  lastUsedAt?: number;
}

export function decayVaultUsage(score: number, at: number, now: number): number {
  return score * 2 ** (-Math.max(0, now - at) / VAULT_USAGE_HALF_LIFE_MS);
}
