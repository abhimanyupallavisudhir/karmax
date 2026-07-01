/**
 * Workflow bundle entry. The Temporal worker bundles this module into the
 * deterministic sandbox and registers the exported workflow functions. Only the
 * functions are exported here (signal/query defs are imported directly by the
 * gateway/tests) to avoid same-name collisions across workflows. Every side
 * effect goes through an activity (SPEC §3.1).
 */
export { pingWorkflow } from './ping.js';
export { softwareDev } from './software-dev.js';
export { justDo } from './just-do.js';
export { scriptExec } from './script-exec.js';
export { goal } from './goal.js';
export { mergeOnly } from './merge-only.js';
export { mergeQueue } from '../coordinators/merge-queue.js';
export { accountCoordinator } from '../coordinators/account.js';
export { budgetCoordinator } from '../coordinators/budget.js';

/**
 * Version-qualified exports (PLAN-dynamic-repos §21b). Temporal registers a
 * workflow under its export name, so exporting a function as `type@version`
 * makes that a distinct, independently-startable workflow type. An execution
 * started as `softwareDev@1.0.0` records that type in its history and replays it
 * forever, even once `softwareDev@2.0.0` is also registered — that is the
 * per-execution version pin. The bare names above stay for back-compat with
 * in-flight executions started before versioning and with unversioned callers.
 *
 * Bundled workflows only ever ship their current manifest version here; older
 * pins and third-party versions arrive as separate packages (§21c). The probe
 * pair proves two versions of one type coexist in a single worker.
 */
export { softwareDev as 'softwareDev@1.0.0' } from './software-dev.js';
export { justDo as 'justDo@1.0.0' } from './just-do.js';
export { scriptExec as 'scriptExec@1.0.0' } from './script-exec.js';
export { goal as 'goal@1.0.0' } from './goal.js';
export { mergeOnly as 'mergeOnly@1.0.0' } from './merge-only.js';
export { versionedProbeV1 as 'versionedProbe@1.0.0' } from './versioned-probe.js';
export { versionedProbeV2 as 'versionedProbe@2.0.0' } from './versioned-probe.js';
