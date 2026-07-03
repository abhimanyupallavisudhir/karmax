import {
  proxyActivities,
  defineSignal,
  defineUpdate,
  defineQuery,
  setHandler,
  condition,
  workflowInfo,
  ApplicationFailure,
  log,
} from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { SIG_MERGE_GRANTED } from '../coordinators/names.js';
import { editableInFlight } from '../platform/mutability.js';
import { TaskInput, TaskView, Stage, Message, ReviewInfo, DeclaredAction, WorldHandleLike } from './contract.js';

const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
const long = proxyActivities<coreActivities>({ startToCloseTimeout: '45 minutes', retry: { maximumAttempts: 1 } });
const coord = proxyActivities<coordinatorActivities>({ startToCloseTimeout: '30s' });

export const confirmSignal = defineSignal('confirm');
export const followUpSignal = defineSignal<[Message]>('followUp');
export const cancelSignal = defineSignal('cancel');
export const mergeGrantedSignal = defineSignal(SIG_MERGE_GRANTED);
/** In-flight param edit (SPEC §4.5/§5.5). merge-only exposes only `target` as
 *  editable — until it's committed to the merge queue. */
export const updateParamsUpdate = defineUpdate<{ applied: string[] }, [Record<string, unknown>]>('updateParams');
export const viewQuery = defineQuery<TaskView>('view');

export interface MergeOnlyInput extends TaskInput {
  /** Run workflow-repo edit checks (tests + replay-compat) before merge (SPEC §4.4). */
  workflowEdit?: boolean;
  autoConfirm?: boolean;
}

/**
 * merge-only (SPEC §4.7): the review-and-merge half of software-dev (no Do
 * stage). Starts at the Review gate, then optional PR, then merge under the
 * queue. Used to review agents' PRs, including edits to workflow repos — so the
 * PR-test-approve gate (§4.4) is dogfooded, not separate machinery.
 */
export async function mergeOnly(input: MergeOnlyInput): Promise<{ stage: Stage; sha?: string }> {
  const taskId = input.taskId;
  let stage: Stage = 'setup';
  let status: TaskView['status'] = 'active';
  const msgs: Message[] = input.prompt ? [{ id: 'm0', role: 'user', text: input.prompt, ts: 0 }] : [];
  const base = input.base ?? input.project.defaultBase ?? 'main';
  let target = input.target ?? input.project.defaultTarget ?? base;
  let confirmed = false;
  let cancelled = false;
  let world: WorldHandleLike | undefined;
  let reviewInfo: ReviewInfo | undefined;
  let mergeGranted = false;
  let checks: { passed: boolean; detail?: string } | undefined;
  let pointOfNoReturnPassed = false;
  // `target` is editable in-flight until committed to the merge queue / a PR opens.
  let targetLocked = false;
  const paramEditable = (name: string): boolean =>
    !cancelled && editableInFlight(input.paramWindows?.[name], { consumed: name === 'target' ? targetLocked : false, pointOfNoReturnPassed });
  const editableParamsNow = (): string[] => Object.keys(input.paramWindows ?? {}).filter(paramEditable);
  function validateParamPatch(patch: Record<string, unknown>): void {
    const names = Object.keys(patch);
    if (!names.length) throw ApplicationFailure.nonRetryable('no params to edit', 'ParamEditEmpty');
    for (const name of names)
      if (!paramEditable(name))
        throw ApplicationFailure.nonRetryable(`"${name}" can't be edited now — frozen after queue, in use, or past the point of no return`, 'ParamLocked', name);
  }
  function applyParamPatch(patch: Record<string, unknown>): { applied: string[] } {
    const applied: string[] = [];
    if (typeof patch.target === 'string' && patch.target) {
      target = patch.target;
      applied.push('target');
    }
    return { applied };
  }

  function actions(): DeclaredAction[] {
    const cancel: DeclaredAction = { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: !pointOfNoReturnPassed, danger: true };
    if (stage === 'review') return [{ name: 'confirm', kind: 'signal', label: 'Approve & merge', enabled: true }, { name: 'followUp', kind: 'signal', label: 'Request changes', enabled: true, args: [{ name: 'text', type: 'text', required: true }] }, cancel];
    if (stage === 'merge' || stage === 'pr') return [cancel];
    return [cancel];
  }
  function view(): TaskView {
    return {
      taskId, title: input.title, workflow: 'merge-only', stage, status, messages: msgs, reviewInfo,
      actions: actions(), state: { checks, mergeGranted, targetLocked }, branch: world?.branch, base, targetBranch: target,
      worldPath: world?.root, parentTaskId: input.parentTaskId, pointOfNoReturnPassed,
      editableParams: editableParamsNow(),
      updatedAt: workflowInfo().historyLength,
    };
  }
  const publish = async () => core.publishView(taskId, view());

  setHandler(viewQuery, view);
  setHandler(confirmSignal, () => {
    confirmed = true;
  });
  setHandler(followUpSignal, (m) => {
    msgs.push({ ...m, ts: msgs.length });
  });
  setHandler(cancelSignal, () => {
    if (!pointOfNoReturnPassed) cancelled = true;
  });
  setHandler(mergeGrantedSignal, () => {
    mergeGranted = true;
  });
  setHandler(updateParamsUpdate, (patch) => applyParamPatch(patch), { validator: validateParamPatch });

  await publish();
  // Open a world on the EXISTING branch under review.
  world = (await core.createWorld({ taskId, repo: input.project.repos?.[0], base: target, branch: input.branch, kind: 'worktree' })) as WorldHandleLike;

  // Workflow-repo edits must pass tests + replay-compat before they can merge.
  if (input.workflowEdit) {
    stage = 'review';
    checks = await long.runWorkflowChecks({ taskId, worldHandle: world as any });
    reviewInfo = { summary: `Checks ${checks.passed ? 'passed' : 'FAILED'}.${checks.detail ? ' ' + checks.detail : ''}` };
    if (!checks.passed) {
      log.warn('workflow-edit checks failed; blocking merge');
    }
  }

  stage = 'review';
  status = 'waiting';
  if (input.autoConfirm && (checks?.passed ?? true)) confirmed = true;
  await publish();
  await condition(() => confirmed || cancelled);
  if (cancelled || (input.workflowEdit && !checks?.passed && !confirmed)) {
    stage = 'cancelled';
    status = 'cancelled';
    await publish();
    if (world) await core.destroyWorld(world as any);
    return { stage };
  }

  if (input.project.openGithubPr) {
    targetLocked = true; // opening a PR binds it to `target` (SPEC §2)
    const opened = await core.openPr(world as any, target);
    if (opened) reviewInfo = { ...reviewInfo, links: [...(reviewInfo?.links ?? []), { label: 'PR', url: opened.url }] };
  }

  stage = 'merge';
  await publish();
  // Commit `target` to the merge-queue domain — no await between locking and
  // reading it, so a queued edit can't desync the domain (SPEC §5.5).
  targetLocked = true;
  const domain = `${world!.repo ?? input.projectId}:${target}`;
  await coord.enqueueMerge(domain, taskId);
  while (!mergeGranted && !cancelled) {
    await condition(() => mergeGranted || cancelled, '5s');
  }
  if (cancelled && !mergeGranted) {
    await coord.cancelMerge(domain, taskId);
    stage = 'cancelled';
    status = 'cancelled';
    await publish();
    return { stage };
  }
  const result = await long.finalizeMergeActivity(world as any, target);
  await coord.releaseMerge(domain, taskId);
  if (!result.merged) {
    stage = 'failed';
    status = 'failed';
    reviewInfo = { ...reviewInfo, summary: `Merge failed: ${result.conflict ?? result.note}` };
    await publish();
    return { stage };
  }
  pointOfNoReturnPassed = true;
  stage = 'done';
  status = 'done';
  reviewInfo = { ...reviewInfo, summary: `Merged into ${target} as ${result.sha?.slice(0, 8)}.` };
  await publish();
  await core.destroyWorld(world as any);
  return { stage, sha: result.sha };
}
