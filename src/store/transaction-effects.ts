import { AsyncLocalStorage } from 'node:async_hooks';

/** The attempt of the outermost Store transaction the caller runs in. */
export interface TransactionAttempt { active: boolean; external: boolean }
export const transactionAttempts = new AsyncLocalStorage<TransactionAttempt>();

/** Record that the running transaction attempt did something outside the
 * database (a vault, file or network write): a rollback cannot undo it, so a
 * deadlock or serialization failure is reported instead of re-run. Call it
 * before the effect. A no-op outside a transaction. */
export function noteExternalEffect(): void {
  const attempt = transactionAttempts.getStore();
  if (attempt?.active) attempt.external = true;
}
