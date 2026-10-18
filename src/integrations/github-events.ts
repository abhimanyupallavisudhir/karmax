import type { Store } from '../store/db.js';
import type { KarmaxApi } from '../platform/api.js';
import type { TokenAuthority } from '../platform/tokens.js';
import { RECOVERY_PROMPT, RECOVERY_TITLE, RECOVERY_TRIGGER, REPAIR_TEMPLATE_ID } from '../domain/task-store.js';
import { normalizeTriggers } from '../domain/triggers.js';
import { eventTypeMatches } from '../domain/project-events.js';
import type { GithubProjectWebhookEvent, GithubWebhookResult } from './github-app.js';

/**
 * GitHub into the project event inbox (wiki features/events-and-automations).
 * Every delivery for an attached repository is a project event;
 * a default-branch workflow failure — or a deployment run GitHub never created
 * (the deployment monitor) — is `github.workflow.failed`.
 *
 * Repairing those failures used to be a rail hard-coded in the gateway. It is
 * now an ordinary repeatable task, "Repair GitHub workflow", that a project gets
 * the first time a failure arrives for it: people can read, edit, pause or
 * delete it like any other task, and a project that already has a task reacting
 * to workflow failures keeps its own. Deleting the seeded task is respected.
 */

/** The marker that a project has (or had, and deleted) its recovery task. */
export const recoverySeriesKey = (projectId: string) => `github:recovery-series:${projectId}`;

// The repair task is one of the task store's automations (src/domain/task-store.ts).
export { RECOVERY_PROMPT, RECOVERY_TITLE, RECOVERY_TRIGGER } from '../domain/task-store.js';

export class GithubEvents {
  constructor(private deps: { api: Pick<KarmaxApi, 'ingestProjectEvent' | 'createTask'>; store: Store; tokens: TokenAuthority }) {}

  /** Record one webhook result's deliveries and workflow failures; returns how many were new. */
  async ingest(result: Pick<GithubWebhookResult, 'inbox' | 'projectEvents'>): Promise<number> {
    let recorded = 0;
    for (const event of result.inbox ?? []) {
      const { duplicate } = await this.deps.api.ingestProjectEvent(
        { organizationId: event.organizationId, projectId: event.projectId, source: 'github', origin: event.origin, hops: 0 },
        { type: event.type, key: event.key, ...(event.subject ? { subject: event.subject } : {}), payload: event.payload });
      if (!duplicate) recorded++;
    }
    return recorded + await this.recordFailures(result.projectEvents ?? []);
  }

  /** Workflow failures from a delivery or the deployment monitor. The incident
   *  key collapses check_run/workflow_run deliveries and repeated monitor polls. */
  async recordFailures(events: GithubProjectWebhookEvent[]): Promise<number> {
    let recorded = 0;
    for (const event of events) {
      const incident = event.payload.incidentKey ?? String(event.payload.runId);
      // An incident the gateway's former recovery rail already handled.
      if ((await this.deps.store.kvGet(`github:workflow-recovery:${event.projectId}:${event.payload.repositoryId}:${incident}`))?.startsWith('task_')) continue;
      const project = await this.deps.store.getProject(event.projectId);
      if (!project) continue;
      const organizationId = project.organizationId ?? 'org_personal';
      await this.ensureRecoveryTask(event.projectId, organizationId);
      const { duplicate } = await this.deps.api.ingestProjectEvent(
        { organizationId, projectId: event.projectId, source: 'github', origin: 'external', hops: 0 },
        { type: event.type, key: `workflow:${event.payload.repositoryId}:${incident}`,
          ...(event.payload.url ? { subject: event.payload.url } : {}), payload: event.payload as unknown as Record<string, unknown> });
      if (!duplicate) recorded++;
    }
    return recorded;
  }

  private async ensureRecoveryTask(projectId: string, organizationId: string): Promise<void> {
    const key = recoverySeriesKey(projectId);
    if (await this.deps.store.kvGet(key)) return;
    const own = (await this.deps.store.listArmedTasks()).find((task) => task.projectId === projectId
      && normalizeTriggers(task.params).some((trigger) => trigger.kind === 'event' && eventTypeMatches(trigger.type, 'github.workflow.failed')));
    if (own) { await this.deps.store.kvSet(key, own.id); return; }
    if (!(await this.deps.store.kvClaim(key, 'creating'))) return;
    // The authority today's rail had: the whole project, as the system.
    const { token } = await this.deps.tokens.mintPrincipal('system:github-recovery', ['*'], projectId, 10 * 60_000, organizationId);
    try {
      const task = await this.deps.api.createTask(token, { projectId, title: RECOVERY_TITLE, prompt: RECOVERY_PROMPT,
        params: { repeatable: true, triggers: [RECOVERY_TRIGGER], template: REPAIR_TEMPLATE_ID } });
      await this.deps.store.kvSet(key, task.id);
    } catch (error) {
      await this.deps.store.kvDelete(key);
      throw error;
    } finally {
      await this.deps.tokens.revoke(token);
    }
  }
}
