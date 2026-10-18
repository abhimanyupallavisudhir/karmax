/** Shared settings are declared once and consumed by every workflow that has a
 * field with the same name; Task defaults save them in this row. */
export const COMMON_SETTINGS_WORKFLOW = '__common__';

/** The settings Task defaults save in the shared row. Only that row holds them:
 * Task defaults store a field only when it differs from what it inherits, so a
 * copy left in a workflow row (from before the field moved to Task defaults)
 * would win forever and the saved value would revert on reload. Reads ignore
 * such copies, writes to a workflow row route them into the shared row, and a
 * boot migration moved the old ones there. */
export const SHARED_SETTING_NAMES: ReadonlySet<string> = new Set([
  'base', 'target', 'repoBranches', 'multiPr', 'copyGlobs', 'remote', 'landingAuthority', 'otherAttempts', 'responder', 'confirm',
]);

/** Settings rows that are not a workflow's: their keys are never shared fields. */
const NON_WORKFLOW_SETTINGS = new Set([COMMON_SETTINGS_WORKFLOW, 'agent-queue', 'appearance', 'authorization', 'explanation',
  'github-deployment-monitor', 'mcp', 'payments', 'timing', 'vault']);

export const isWorkflowSettings = (workflow: string): boolean => !NON_WORKFLOW_SETTINGS.has(workflow);

/** A workflow row's values split into its own and the shared ones. */
export function splitSharedSettings(workflow: string, values: Record<string, unknown>): { own: Record<string, unknown>; shared: Record<string, unknown> } {
  if (!isWorkflowSettings(workflow)) return { own: values, shared: {} };
  const own: Record<string, unknown> = {};
  const shared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) (SHARED_SETTING_NAMES.has(key) ? shared : own)[key] = value;
  return { own, shared };
}
