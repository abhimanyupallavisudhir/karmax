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
export { agentQueue } from '../coordinators/agent-queue.js';
export { resourcePublishCoordinator } from '../coordinators/resource-publish.js';
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
 * Bundled workflow versions with live/replayable histories remain explicit
 * exports here. A version string is an immutable code contract, not an alias to
 * whatever implementation is current. The probe pair proves two versions of
 * one type coexist in a single worker.
 */
export { softwareDevV1 as 'softwareDev@1.0.0' } from './software-dev.js';
export { softwareDev as 'softwareDev@1.1.0' } from './software-dev.js';
export { softwareDevV1_2 as 'softwareDev@1.2.0' } from './software-dev.js';
export { softwareDevV1_3 as 'softwareDev@1.3.0' } from './software-dev.js';
export { softwareDevV1_4 as 'softwareDev@1.4.0' } from './software-dev.js';
export { softwareDevV1_5 as 'softwareDev@1.5.0' } from './software-dev.js';
export { softwareDevV1_6 as 'softwareDev@1.6.0' } from './software-dev.js';
export { justDoV1 as 'justDo@1.0.0' } from './just-do.js';
export { justDo as 'justDo@1.1.0' } from './just-do.js';
export { justDoV1_2 as 'justDo@1.2.0' } from './just-do.js';
export { justDoV1_3 as 'justDo@1.3.0' } from './just-do.js';
export { scriptExec as 'scriptExec@1.0.0' } from './script-exec.js';
export { goalV1 as 'goal@1.0.0' } from './goal.js';
export { goal as 'goal@1.1.0' } from './goal.js';
export { goalV1_2 as 'goal@1.2.0' } from './goal.js';
export { goalV1_3 as 'goal@1.3.0' } from './goal.js';
export { goalV1_4 as 'goal@1.4.0' } from './goal.js';
export { goalV1_5 as 'goal@1.5.0' } from './goal.js';
export { goalV1_6 as 'goal@1.6.0' } from './goal.js';
export { mergeOnlyV1 as 'mergeOnly@1.0.0' } from './merge-only.js';
export { mergeOnly as 'mergeOnly@1.1.0' } from './merge-only.js';
export { mergeOnlyV1_2 as 'mergeOnly@1.2.0' } from './merge-only.js';
export { mergeOnlyV1_3 as 'mergeOnly@1.3.0' } from './merge-only.js';
export { versionedProbeV1 as 'versionedProbe@1.0.0' } from './versioned-probe.js';
export { versionedProbeV2 as 'versionedProbe@2.0.0' } from './versioned-probe.js';
