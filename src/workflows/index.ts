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
export { softwareDevV1_7 as 'softwareDev@1.7.0' } from './software-dev.js';
export { softwareDevV1_8 as 'softwareDev@1.8.0' } from './software-dev.js';
export { softwareDevV1_9 as 'softwareDev@1.9.0' } from './software-dev.js';
export { softwareDevV1_10 as 'softwareDev@1.10.0' } from './software-dev.js';
export { softwareDevV1_11 as 'softwareDev@1.11.0' } from './software-dev.js';
export { softwareDevV1_12 as 'softwareDev@1.12.0' } from './software-dev.js';
export { softwareDevV1_13 as 'softwareDev@1.13.0' } from './software-dev.js';
export { softwareDevV1_14 as 'softwareDev@1.14.0' } from './software-dev.js';
export { softwareDevV1_15 as 'softwareDev@1.15.0' } from './software-dev.js';
export { softwareDevV1_16 as 'softwareDev@1.16.0' } from './software-dev.js';
export { softwareDevV1_17 as 'softwareDev@1.17.0' } from './software-dev.js';
export { softwareDevV1_18 as 'softwareDev@1.18.0' } from './software-dev.js';
export { softwareDevV1_19 as 'softwareDev@1.19.0' } from './software-dev.js';
export { softwareDevV1_20 as 'softwareDev@1.20.0' } from './software-dev.js';
export { softwareDevV1_21 as 'softwareDev@1.21.0' } from './software-dev.js';
export { softwareDevV1_22 as 'softwareDev@1.22.0' } from './software-dev.js';
export { softwareDevV1_23 as 'softwareDev@1.23.0' } from './software-dev.js';
export { softwareDevV1_24 as 'softwareDev@1.24.0' } from './software-dev.js';
export { softwareDevV1_25 as 'softwareDev@1.25.0' } from './software-dev.js';
export { justDoV1 as 'justDo@1.0.0' } from './just-do.js';
export { justDo as 'justDo@1.1.0' } from './just-do.js';
export { justDoV1_2 as 'justDo@1.2.0' } from './just-do.js';
export { justDoV1_3 as 'justDo@1.3.0' } from './just-do.js';
export { justDoV1_4 as 'justDo@1.4.0' } from './just-do.js';
export { justDoV1_5 as 'justDo@1.5.0' } from './just-do.js';
export { scriptExec as 'scriptExec@1.0.0' } from './script-exec.js';
export { goalV1 as 'goal@1.0.0' } from './goal.js';
export { goal as 'goal@1.1.0' } from './goal.js';
export { goalV1_2 as 'goal@1.2.0' } from './goal.js';
export { goalV1_3 as 'goal@1.3.0' } from './goal.js';
export { goalV1_4 as 'goal@1.4.0' } from './goal.js';
export { goalV1_5 as 'goal@1.5.0' } from './goal.js';
export { goalV1_6 as 'goal@1.6.0' } from './goal.js';
export { goalV1_7 as 'goal@1.7.0' } from './goal.js';
export { goalV1_8 as 'goal@1.8.0' } from './goal.js';
export { goalV1_9 as 'goal@1.9.0' } from './goal.js';
export { goalV1_10 as 'goal@1.10.0' } from './goal.js';
export { goalV1_11 as 'goal@1.11.0' } from './goal.js';
export { goalV1_12 as 'goal@1.12.0' } from './goal.js';
export { goalV1_13 as 'goal@1.13.0' } from './goal.js';
export { goalV1_14 as 'goal@1.14.0' } from './goal.js';
export { goalV1_15 as 'goal@1.15.0' } from './goal.js';
export { goalV1_16 as 'goal@1.16.0' } from './goal.js';
export { goalV1_17 as 'goal@1.17.0' } from './goal.js';
export { goalV1_18 as 'goal@1.18.0' } from './goal.js';
export { goalV1_19 as 'goal@1.19.0' } from './goal.js';
export { goalV1_20 as 'goal@1.20.0' } from './goal.js';
export { goalV1_21 as 'goal@1.21.0' } from './goal.js';
export { goalV1_22 as 'goal@1.22.0' } from './goal.js';
export { goalV1_23 as 'goal@1.23.0' } from './goal.js';
export { goalV1_24 as 'goal@1.24.0' } from './goal.js';
export { goalV1_25 as 'goal@1.25.0' } from './goal.js';
export { mergeOnlyV1 as 'mergeOnly@1.0.0' } from './merge-only.js';
export { mergeOnly as 'mergeOnly@1.1.0' } from './merge-only.js';
export { mergeOnlyV1_2 as 'mergeOnly@1.2.0' } from './merge-only.js';
export { mergeOnlyV1_3 as 'mergeOnly@1.3.0' } from './merge-only.js';
export { mergeOnlyV1_4 as 'mergeOnly@1.4.0' } from './merge-only.js';
export { mergeOnlyV1_5 as 'mergeOnly@1.5.0' } from './merge-only.js';
export { mergeOnlyV1_6 as 'mergeOnly@1.6.0' } from './merge-only.js';
export { mergeOnlyV1_7 as 'mergeOnly@1.7.0' } from './merge-only.js';
export { versionedProbeV1 as 'versionedProbe@1.0.0' } from './versioned-probe.js';
export { versionedProbeV2 as 'versionedProbe@2.0.0' } from './versioned-probe.js';
