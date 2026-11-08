import type { EventTrigger } from '../domain/triggers.js';
import { normalizeTriggers } from '../domain/triggers.js';
import { eventTypeMatches } from '../domain/project-events.js';
import { BRAND } from '../domain/brand.js';
import type { KarmaxApi } from './api.js';
import { ERROR_EVENT_SOURCE, ERROR_EVENT_TYPE, ERROR_REPORTS_KEY, errorReporter } from './error-reports.js';

/**
 * The task that fixes what error reports report (wiki features/error-reports):
 * a repeatable task in the error-report project, started by `tavya.error`
 * events from the platform itself. One run at a time: further errors are told
 * to the run at work, which fixes those of the same cause with it and hands
 * the rest to sub-tasks — so an outage that raises fifty errors starts one
 * agent, not fifty.
 */

export const ERROR_FIXER_TEMPLATE_ID = 'fix-errors';

export const ERROR_FIXER_TRIGGER: EventTrigger = {
  kind: 'event', type: ERROR_EVENT_TYPE, source: ERROR_EVENT_SOURCE, recurring: true,
  concurrency: { key: '', mode: 'tell' }, maxPerHour: 6,
};

export const ERROR_FIXER_TITLE = 'Fix: {{summary}}';

export const ERROR_FIXER_PROMPT = [
  `## Fix an error ${BRAND} could not recover from`,
  `${BRAND} reported an unexpected error of its own (the event below): a task stopped for a person by a failure, a request answered 500, a rejection nothing caught, or a failed lifecycle sweep step. It names the error's fingerprint, message, stack, where it happened, the task and project involved, and the revision that was running.`,
  '',
  '1. **Gather the evidence first.** Production\'s logs, database and the task\'s events are the ground truth: the project wiki\'s `ops/production-tavya` and `ops/diagnostics` say how to reach them (SSH included: fetch the key as that page says, never print it). Look at production read-only; change it only through a reviewed pull request and the deploy pipeline, or a runbook in the wiki that allows a direct step.',
  `2. **Decide whose it is.** If the cause is outside ${BRAND} (a customer's own code, a credential only they can renew, a provider outage that has passed and that ${BRAND} already rode out correctly), say so in a few lines and finish without a change.`,
  '3. **Fix the class of failure, not this occurrence.** Find the root cause and the most robust and clean fix: what an expert would do, in full generality. Read `incidents/lessons` for earlier fixes of the same kind and why they were not general enough.',
  '4. **Prove it.** Write a test that fails for this error first, then make it pass; run the related suites; verify end to end.',
  '5. **Leave it known.** Add a row to `incidents/lessons` (symptom, cause, fix, how to diagnose) and open the pull request.',
  '',
  'More errors may reach you as messages while you work. Fix those with the same cause here; give each unrelated one to a sub-task (start them in batches) or say why it needs nothing.',
].join('\n');

/** The marker of the fixer this installation made in a project. */
export const errorFixerKey = (projectId: string) => `error-reports:fixer:${projectId}`;

export interface ErrorReportSettings { projectId?: string; fixerTaskId?: string }

interface SettingsStore {
  kvGet(key: string): Promise<string | undefined>;
  kvSet(key: string, value: string): Promise<void> | void;
  kvDelete(key: string): Promise<void> | void;
  getTask(id: string): Promise<{ id: string; projectId: string } | undefined>;
  listArmedTasks(): Promise<Array<{ id: string; projectId: string; params: Record<string, unknown> }>>;
}

export async function errorReportSettings(store: SettingsStore): Promise<ErrorReportSettings> {
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
      params: { repeatable: true, triggers: [ERROR_FIXER_TRIGGER], template: ERROR_FIXER_TEMPLATE_ID } });
    fixerTaskId = task.id;
  }
  await store.kvSet(errorFixerKey(projectId), fixerTaskId);
  await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId }));
  errorReporter()?.invalidate();
  return { projectId, fixerTaskId };
}
