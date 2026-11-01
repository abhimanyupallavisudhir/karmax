/**
 * What made a workflow run fail, in its own words: " in <activity>: <innermost
 * message>". Temporal's wrappers ("Activity task failed", "Child Workflow
 * execution failed") say nothing, so they only lend the activity's name.
 *
 * Pure and duck-typed: the workflow (sandbox) and the reconciler (Node) both
 * use it, and they load different copies of Temporal's failure classes.
 */
export function failureText(failure: unknown): string {
  let activity: string | undefined;
  let message = '';
  for (let e: any = failure, depth = 0; e && depth < 8; depth++, e = e.cause) {
    const wrapper = typeof e.activityType === 'string' || typeof e.workflowType === 'string';
    if (typeof e.activityType === 'string' && e.activityType) activity = e.activityType;
    if (!wrapper && typeof e.message === 'string' && e.message) message = e.message;
  }
  return `${activity ? ` in ${activity}` : ''}${message ? `: ${message.slice(0, 2_000)}` : ''}`;
}
