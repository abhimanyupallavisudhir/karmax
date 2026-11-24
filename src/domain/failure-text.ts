/**
 * What went wrong, from a failure's cause chain: Temporal's wrappers say only
 * "Activity task failed" or "Child Workflow execution failed" around it. A
 * world the provider cannot start says so in people's words; under it is the
 * provider's raw answer (pramana#79: Hetzner's JSON), never shown.
 *
 * Pure and duck-typed: the workflow (sandbox) and the reconciler (Node) both
 * use it, and they load different copies of Temporal's failure classes.
 */
/**
 * A failure's cause chain as one line, `outer → inner`, each message once.
 * Temporal says only "Activity task timed out" over a timeout as generic as
 * "activity Heartbeat timeout", and every Do-stage activity heartbeats: such a
 * line named nothing to look at (tavya-error 33f6295a8ac41d4a). A timed-out
 * activity is named; a failed one keeps "Activity task failed", which people's
 * error text strips, since its cause says what went wrong.
 */
export function describeFailure(err: unknown): string {
  const parts: string[] = [];
  for (let e: any = err, depth = 0; e && depth < 6; depth++, e = e.cause) {
    const message = e.message === 'Activity task timed out' && typeof e.activityType === 'string' && e.activityType
      ? `Activity ${e.activityType} timed out` : e.message;
    if (message && !parts.includes(message)) parts.push(message);
  }
  return parts.join(' → ') || String(err);
}

export function innermostMessage(err: unknown): string {
  let message = '';
  for (let e: any = err, depth = 0; e && depth < 8; depth++, e = e.cause) {
    if (typeof e.message === 'string' && e.message.trim()) message = e.message.trim();
    if (e.type === 'world-infra' || e.type === 'world-capacity') break;
  }
  return message || String(err);
}
