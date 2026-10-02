/**
 * A task-agent fork is stored on the NEW task as `resumeFrom.taskId`. Agent
 * specs appear in several parameter fields (Do/Merge overrides and nested
 * confirmation layers), so the relationship is discovered by shape rather than
 * by today's field names. A raw provider-session continuation has no taskId and
 * is not a fork. Mirrors `taskForkSourceIds` in web/app.js.
 */
export function taskForkSourceIds(params: unknown): string[] {
  const sources = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const resumeFrom = (value as { resumeFrom?: unknown }).resumeFrom;
    if (resumeFrom && typeof resumeFrom === 'object' && typeof (resumeFrom as { taskId?: unknown }).taskId === 'string')
      sources.add((resumeFrom as { taskId: string }).taskId);
    for (const child of Object.values(value)) visit(child);
  };
  visit(params);
  return [...sources];
}
