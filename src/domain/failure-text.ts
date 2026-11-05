/**
 * What went wrong, from a failure's cause chain: Temporal's wrappers say only
 * "Activity task failed" or "Child Workflow execution failed" around it. A
 * world the provider cannot start says so in people's words; under it is the
 * provider's raw answer (pramana#79: Hetzner's JSON), never shown.
 *
 * Pure and duck-typed: the workflow (sandbox) and the reconciler (Node) both
 * use it, and they load different copies of Temporal's failure classes.
 */
export function innermostMessage(err: unknown): string {
  let message = '';
  for (let e: any = err, depth = 0; e && depth < 8; depth++, e = e.cause) {
    if (typeof e.message === 'string' && e.message.trim()) message = e.message.trim();
    if (e.type === 'world-infra' || e.type === 'world-capacity') break;
  }
  return message || String(err);
}
