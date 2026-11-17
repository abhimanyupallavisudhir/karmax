import type { EventTrigger } from '../domain/triggers.js';
import { normalizeTriggers } from '../domain/triggers.js';
import { eventTypeMatches } from '../domain/project-events.js';
import { AGENT_REVIEW, FIX_ERRORS_KEY_RULES, FIX_ERRORS_TEMPLATE_ID, FIX_ERRORS_TITLE, FIX_ERRORS_TRIGGER } from '../domain/task-store.js';
import { BRAND } from '../domain/brand.js';
import type { KarmaxApi } from './api.js';
import { DEPLOY_EVENT_TYPE, ERROR_EVENT_SOURCE, ERROR_EVENT_TYPE, ERROR_REPORTS_KEY, errorReporter } from './error-reports.js';

/**
 * The task that fixes what error reports report (wiki features/error-reports):
 * the store's "Fix reported errors" series, listening to the platform's own
 * errors instead of an app's. One task per bug, for good (the trigger's
 * `continue` mode, keyed by the error's fingerprint): repeats are counted on
 * the bug's event and reach its task; a few minutes after a bug first appears
 * the gate decides whether it is tavya's to fix at all; at most three bugs are
 * worked on at once, the most-seen first; and a bug that comes back after the
 * deploy that shipped its fix carries its task on.
 *
 * It is an ordinary series: its prompt, gate, limits, agent and authority are
 * edited in its task form. To let its runs reach production without asking,
 * fork an Avatār that holds that access (its "Fork a previous agent" field).
 */

export const ERROR_FIXER_TEMPLATE_ID = FIX_ERRORS_TEMPLATE_ID;

export const ERROR_FIXER_TRIGGER: EventTrigger = {
  ...FIX_ERRORS_TRIGGER, type: ERROR_EVENT_TYPE, source: ERROR_EVENT_SOURCE,
  concurrency: { key: '{{fingerprint}}', mode: 'continue', after: { type: DEPLOY_EVENT_TYPE, source: ERROR_EVENT_SOURCE } },
  gate: { prompt: [
    `Start a task for an error that is a defect in ${BRAND} itself: its own code, configuration or operations.`,
    `Skip one ${BRAND} handled as designed and whose cause is someone else's: a customer's own repository, code, credential, quota or settings (a repository that refuses writes, a login that expired, a limit that is full); a client that went away; an outage of an outside provider that has passed. When a person is left stuck with a message that does not tell them what to do, that is ${BRAND}'s defect: start.`,
    'An error a person reported (`kind: reported`) is worth a task unless it plainly describes their own mistake.',
    'Merge one whose cause is plainly the same as that of a task already listed.',
  ].join('\n') },
};

export const ERROR_FIXER_TITLE = FIX_ERRORS_TITLE;

export const ERROR_FIXER_PROMPT = [
  `## Fix an error ${BRAND} could not recover from`,
  `${BRAND} reported an unexpected error of its own (the event below): a task stopped for a person by a failure, a request answered 500, a rejection nothing caught, a failed lifecycle sweep step, or an error a person reported from the console. It names the error's fingerprint, message, stack, where it happened, the task and project involved, the revision that was running, and how often and for whom it has happened.`,
  '',
  '1. **Gather the evidence first.** Production\'s logs, database and the task\'s events are the ground truth: the project wiki\'s `ops/production-tavya` and `ops/diagnostics` say how to reach them (SSH included: fetch the key as that page says, never print it). Look at production read-only; change it only through a reviewed pull request and the deploy pipeline, or a runbook in the wiki that allows a direct step.',
  `2. **Decide whose it is.** If the cause is outside ${BRAND} (a customer's own code, a credential only they can renew, a provider outage that has passed and that ${BRAND} already rode out correctly), say so in a few lines and finish without a change.`,
  '3. **Fix the class of failure, not this occurrence.** Find the root cause and the most robust and clean fix: what an expert would do, in full generality. Read `incidents/lessons` for earlier fixes of the same kind and why they were not general enough.',
  '4. **Prove it.** Write a test that fails for this error first, then make it pass; run the related suites; verify end to end.',
  '5. **Leave it known.** Add a row to `incidents/lessons` (symptom, cause, fix, how to diagnose) and open the pull request.',
  '',
  FIX_ERRORS_KEY_RULES,
  `Your fix is out once a \`${DEPLOY_EVENT_TYPE}\` event lists your commit: only occurrences after that count against it.`,
].join('\n');

/** The marker of the fixer this installation made in a project. */
export const errorFixerKey = (projectId: string) => `error-reports:fixer:${projectId}`;

export interface ErrorReportSettings { projectId?: string; fixerTaskId?: string }

interface SettingsStore {
  kvGet(key: string): Promise<string | undefined>;
  kvSet(key: string, value: string): Promise<void> | void;
  kvDelete(key: string): Promise<void> | void;
  getTask(id: string): Promise<{ id: string; projectId: string; title: string; params: Record<string, unknown> } | undefined>;
  listArmedTasks(): Promise<Array<{ id: string; projectId: string; params: Record<string, unknown> }>>;
  updateTaskParams(id: string, params: never): Promise<unknown>;
  setTaskTitle(id: string, title: string): Promise<unknown>;
}

export async function errorReportSettings(store: Pick<SettingsStore, 'kvGet' | 'getTask'>): Promise<ErrorReportSettings> {
  let projectId: string | undefined;
  try { projectId = (JSON.parse((await store.kvGet(ERROR_REPORTS_KEY)) ?? '{}') as { projectId?: string }).projectId; }
  catch { projectId = undefined; }
  if (!projectId) return {};
  const fixerTaskId = await store.kvGet(errorFixerKey(projectId));
  const fixer = fixerTaskId ? await store.getTask(fixerTaskId) : undefined;
  return { projectId, ...(fixer ? { fixerTaskId: fixer.id } : {}) };
}

/**
 * Send error reports to `projectId` (or nowhere: null), and give that project
 * its fixer unless one is there: a task of the project's own already armed
 * for `tavya.error` counts. It is made with the caller's token, so its runs act
 * with the authority of whoever turned reports on.
 */
export async function saveErrorReportSettings(store: SettingsStore, api: Pick<KarmaxApi, 'createTask'>, token: string,
  projectId: string | null): Promise<ErrorReportSettings> {
  if (!projectId) {
    await store.kvDelete(ERROR_REPORTS_KEY);
    errorReporter()?.invalidate();
    return {};
  }
  const existing = await errorReportSettings(store);
  const armed = (await store.listArmedTasks()).find((task) => task.projectId === projectId
    && normalizeTriggers(task.params).some((trigger) => trigger.kind === 'event' && eventTypeMatches(trigger.type, ERROR_EVENT_TYPE)));
  let fixerTaskId = existing.projectId === projectId ? existing.fixerTaskId : undefined;
  fixerTaskId ??= armed?.id;
  if (!fixerTaskId) {
    const task = await api.createTask(token, { projectId, title: ERROR_FIXER_TITLE, prompt: ERROR_FIXER_PROMPT,
      params: { repeatable: true, confirm: AGENT_REVIEW, triggers: [ERROR_FIXER_TRIGGER], template: ERROR_FIXER_TEMPLATE_ID } });
    fixerTaskId = task.id;
  }
  await store.kvSet(errorFixerKey(projectId), fixerTaskId);
  await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId }));
  errorReporter()?.invalidate();
  return { projectId, fixerTaskId };
}

/**
 * The fixer made before bugs had a task each told every error to one run at
 * work (`concurrency: {key: '', mode: 'tell'}`). At boot, one still saved that
 * way gets today's trigger, title and prompt, once: it would otherwise keep
 * piling unrelated errors onto one run. A fixer someone has since edited (any
 * other trigger) is theirs and stays, and so does who reviews its runs.
 */
export async function upgradeErrorFixer(store: SettingsStore, rearm: (taskId: string) => Promise<unknown>): Promise<boolean> {
  const { fixerTaskId } = await errorReportSettings(store);
  const fixer = fixerTaskId ? await store.getTask(fixerTaskId) : undefined;
  if (!fixer) return false;
  const triggers = normalizeTriggers(fixer.params);
  const old = triggers.length === 1 && triggers[0]!.kind === 'event' && triggers[0]!.type === ERROR_EVENT_TYPE
    && triggers[0]!.concurrency?.mode === 'tell' && (triggers[0]!.concurrency.key ?? '') === '';
  if (!old) return false;
  const wasOurs = typeof fixer.params.prompt === 'string' && fixer.params.prompt.startsWith(`## Fix an error ${BRAND} could not recover from`);
  await store.updateTaskParams(fixer.id, { ...fixer.params, triggers: [ERROR_FIXER_TRIGGER], template: ERROR_FIXER_TEMPLATE_ID,
    ...(wasOurs ? { prompt: ERROR_FIXER_PROMPT } : {}) } as never);
  if (fixer.title === 'Fix: {{summary}}') await store.setTaskTitle(fixer.id, ERROR_FIXER_TITLE);
  await rearm(fixer.id);
  return true;
}
