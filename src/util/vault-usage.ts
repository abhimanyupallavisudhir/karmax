/** Access and selection statistics are independent, both with a 30-day half-life.
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

/** Picker ranking is based only on saved task grants, never secret accesses. */
export interface VaultSelectionUsage {
  selectionCount: number;
  selectionFrecencyScore: number;
  selectionUpdatedAt: number;
  lastSelectedAt?: number;
}

export function credentialIds(capabilities: unknown): string[] {
  const prefix = 'use-credential:item:';
  return Array.isArray(capabilities) ? [...new Set(capabilities
    .filter((cap): cap is string => typeof cap === 'string' && cap.startsWith(prefix))
    .map((cap) => cap.slice(prefix.length)).filter((id) => id && !id.includes('*') && !id.includes(':')))] : [];
}

/** Missing history belongs to a legacy task: its creation date is the only
 * durable timestamp available. Keep removed grants in its selection history. */
export function taskSelectionTimes(stored: string | null, capabilities: unknown, createdAt: number): Record<string, number> {
  return stored !== null ? JSON.parse(stored) : Object.fromEntries(credentialIds(capabilities).map((id) => [id, createdAt]));
}
