/**
 * Pure name constants for task workflows. Client/gateway/test code references
 * workflows and their signals/queries by string so it never imports a workflow
 * module (which runs `proxyActivities` at import time and throws outside the
 * deterministic sandbox).
 */
export const WF = {
  softwareDev: 'softwareDev',
  justDo: 'justDo',
  scriptExec: 'scriptExec',
  goal: 'goal',
  mergeOnly: 'mergeOnly',
} as const;

export type WorkflowName = (typeof WF)[keyof typeof WF];

/** Map a workflow definition name (as stored on a task) to its Temporal type. */
export const WORKFLOW_TYPE: Record<string, WorkflowName> = {
  'software-dev': WF.softwareDev,
  'just-do': WF.justDo,
  'script-exec': WF.scriptExec,
  goal: WF.goal,
  'merge-only': WF.mergeOnly,
};

/**
 * The Temporal workflow type for a specific version of a workflow (§21b). The
 * worker registers each version under `type@version` (see workflows/index.ts),
 * so starting an execution with this string pins it to that code version for the
 * life of the execution — Temporal replays the type recorded in history.
 */
export function qualifiedType(type: WorkflowName | string, version: string): string {
  return `${type}@${version}`;
}

/**
 * The version-qualified task-workflow types the bundled worker registers. MUST
 * mirror the `type@version` exports in workflows/index.ts (the Temporal bundler
 * needs static export syntax there, so this list can't be derived from it).
 */
export const BUNDLED_QUALIFIED = new Set<string>([
  qualifiedType(WF.softwareDev, '1.0.0'),
  qualifiedType(WF.justDo, '1.0.0'),
  qualifiedType(WF.scriptExec, '1.0.0'),
  qualifiedType(WF.goal, '1.0.0'),
  qualifiedType(WF.mergeOnly, '1.0.0'),
]);

/**
 * The Temporal type to start a task with: the version-pinned type when that
 * version is registered, else the bare type. The fallback keeps starts working
 * if a manifest version ever lacks a matching qualified export — an unpinned
 * execution, not a failed one. Externally-loaded package versions (§21c) resolve
 * through their own path; this covers the bundled workflows.
 */
export function pinnedType(type: WorkflowName, version: string): string {
  const q = qualifiedType(type, version);
  return BUNDLED_QUALIFIED.has(q) ? q : type;
}

export const SIG = {
  followUp: 'followUp',
  confirm: 'confirm',
  cancel: 'cancel',
  retry: 'retry',
} as const;

export const QRY = { view: 'view' } as const;
export const UPD = { setTarget: 'setTarget', updateParams: 'updateParams' } as const;
