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

export const SIG = {
  followUp: 'followUp',
  confirm: 'confirm',
  cancel: 'cancel',
  retry: 'retry',
} as const;

export const QRY = { view: 'view' } as const;
export const UPD = { setTarget: 'setTarget' } as const;
