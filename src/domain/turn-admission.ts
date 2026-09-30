/**
 * Usage-admission ids of agent turns. A retried activity attempt gets its own
 * admission, `<turn>:attempt:<n>`, so a completed attempt cannot be admitted
 * twice; task views and the agent queue only ever name the plain turn.
 */
export function usageAdmissionId(turnId: string, attempt: number): string {
  return attempt > 1 ? `${turnId}:attempt:${attempt}` : turnId;
}

/** The turn an admission belongs to (audit R-7). */
export function admissionTurnId(admissionId: string): string {
  return admissionId.replace(/:attempt:\d+$/, '');
}
