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
  qualifiedType(WF.softwareDev, '1.1.0'),
  qualifiedType(WF.softwareDev, '1.2.0'),
  qualifiedType(WF.softwareDev, '1.3.0'),
  qualifiedType(WF.softwareDev, '1.4.0'),
  qualifiedType(WF.softwareDev, '1.5.0'),
  qualifiedType(WF.softwareDev, '1.6.0'),
  qualifiedType(WF.softwareDev, '1.7.0'),
  qualifiedType(WF.softwareDev, '1.8.0'),
  qualifiedType(WF.softwareDev, '1.9.0'),
  qualifiedType(WF.softwareDev, '1.10.0'),
  qualifiedType(WF.softwareDev, '1.11.0'),
  qualifiedType(WF.softwareDev, '1.12.0'),
  qualifiedType(WF.softwareDev, '1.13.0'),
  qualifiedType(WF.softwareDev, '1.14.0'),
  qualifiedType(WF.softwareDev, '1.15.0'),
  qualifiedType(WF.softwareDev, '1.16.0'),
  qualifiedType(WF.softwareDev, '1.17.0'),
  qualifiedType(WF.softwareDev, '1.18.0'),
  qualifiedType(WF.softwareDev, '1.19.0'),
  qualifiedType(WF.softwareDev, '1.20.0'),
  qualifiedType(WF.justDo, '1.0.0'),
  qualifiedType(WF.justDo, '1.1.0'),
  qualifiedType(WF.justDo, '1.2.0'),
  qualifiedType(WF.justDo, '1.3.0'),
  qualifiedType(WF.justDo, '1.4.0'),
  qualifiedType(WF.justDo, '1.5.0'),
  qualifiedType(WF.scriptExec, '1.0.0'),
  qualifiedType(WF.goal, '1.0.0'),
  qualifiedType(WF.goal, '1.1.0'),
  qualifiedType(WF.goal, '1.2.0'),
  qualifiedType(WF.goal, '1.3.0'),
  qualifiedType(WF.goal, '1.4.0'),
  qualifiedType(WF.goal, '1.5.0'),
  qualifiedType(WF.goal, '1.6.0'),
  qualifiedType(WF.goal, '1.7.0'),
  qualifiedType(WF.goal, '1.8.0'),
  qualifiedType(WF.goal, '1.9.0'),
  qualifiedType(WF.goal, '1.10.0'),
  qualifiedType(WF.goal, '1.11.0'),
  qualifiedType(WF.goal, '1.12.0'),
  qualifiedType(WF.goal, '1.13.0'),
  qualifiedType(WF.goal, '1.14.0'),
  qualifiedType(WF.goal, '1.15.0'),
  qualifiedType(WF.goal, '1.16.0'),
  qualifiedType(WF.goal, '1.17.0'),
  qualifiedType(WF.goal, '1.18.0'),
  qualifiedType(WF.goal, '1.19.0'),
  qualifiedType(WF.goal, '1.20.0'),
  qualifiedType(WF.mergeOnly, '1.0.0'),
  qualifiedType(WF.mergeOnly, '1.1.0'),
  qualifiedType(WF.mergeOnly, '1.2.0'),
  qualifiedType(WF.mergeOnly, '1.3.0'),
  qualifiedType(WF.mergeOnly, '1.4.0'),
  qualifiedType(WF.mergeOnly, '1.5.0'),
  qualifiedType(WF.mergeOnly, '1.6.0'),
]);

/**
 * The Temporal type to start a task with: the version-pinned type when that
 * version is registered. Missing registrations fail closed: silently falling
 * back to the mutable bare name would claim a task is pinned while recording an
 * entirely different Temporal type in its history.
 */
export function pinnedType(type: WorkflowName, version: string): string {
  const q = qualifiedType(type, version);
  if (!BUNDLED_QUALIFIED.has(q)) throw new Error(`bundled workflow type is not registered: ${q}`);
  return q;
}

export const SIG = {
  followUp: 'followUp',
  collaborationRequested: 'collaborationRequested',
  collaborationSettled: 'collaborationSettled',
  resourceResolved: 'resourceResolved',
  confirm: 'confirm',
  openPr: 'openPr',
  /** Approve ONE branch of a multi-PR task (SPEC §11.1). Records what has been
   *  reviewed so an untouched branch is not re-reviewed after a loop back to Do;
   *  `confirm` remains the only signal that passes the Review gate. */
  approveCheckout: 'approveCheckout',
  cancel: 'cancel',
  retry: 'retry',
} as const;

/** Activity → owning workflow transition after host agent-slot admission. */
export const SIG_AGENT_TURN_STATE = 'agentTurnState';

export const QRY = { view: 'view' } as const;
export const UPD = { setTarget: 'setTarget', updateParams: 'updateParams', changeWorkflow: 'changeWorkflow' } as const;
