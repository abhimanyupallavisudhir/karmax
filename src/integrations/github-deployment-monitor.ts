import type { Repository } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { GithubActionsApi } from './github-actions.js';
import type { GithubProjectWebhookEvent, GitHubRepositoryFileStatus } from './github-app.js';

export const DEPLOYMENT_SOURCE_WORKFLOW = 'CI';
export const DEPLOYMENT_WORKFLOW = 'Deploy';
export const DEPLOYMENT_WORKFLOW_FILE = '.github/workflows/deploy.yml';
export const DEPLOYMENT_RUN_GRACE_MS = 5 * 60_000;
const EXPECTATION_PREFIX = 'github:deployment-expectation:';
const MONITORED_REPOSITORY_PREFIX = 'github:deployment-monitored:';

export interface DeploymentRunExpectation {
  version: 1;
  repositoryId: string;
  repository: string;
  branch: string;
  headSha: string;
  sourceWorkflow: string;
  sourceRunId: number;
  sourceRunUrl: string;
  sourceCompletedAt?: string;
  expectedWorkflow: string;
  expectedWorkflowFile: string;
  observedAt: number;
  deadlineAt: number;
}

export interface MissingDeploymentFinding {
  key: string;
  expectation: DeploymentRunExpectation;
  events: GithubProjectWebhookEvent[];
}

export interface DeploymentMonitorGithub {
  actions(repository: Repository): GithubActionsApi | Promise<GithubActionsApi>;
  repositoryFileStatus(repository: Repository, filePath: string): Promise<GitHubRepositoryFileStatus>;
}

function expectationKey(repositoryId: string, headSha: string): string {
  return `${EXPECTATION_PREFIX}${repositoryId}:${headSha}`;
}

/**
 * Turn the successful prerequisite run into a durable expectation. Seeing the
 * deployment run in any state clears it immediately: waiting for an environment
 * approval is a run, and must not be misreported as "GitHub never made one".
 * `kvClaim` deliberately preserves the first deadline across webhook duplicates.
 */
export async function observeDeploymentWorkflowRun(store: Store, repository: Repository, workflowRun: any,
  options: { now?: number; graceMs?: number } = {}): Promise<void> {
  const branch = String(workflowRun?.head_branch ?? '');
  const headSha = String(workflowRun?.head_sha ?? '');
  const name = String(workflowRun?.name ?? '');
  if (!headSha || branch !== repository.defaultBranch) return;
  const key = expectationKey(repository.id, headSha);
  if (name === DEPLOYMENT_WORKFLOW) {
    (await store.kvSet(`${MONITORED_REPOSITORY_PREFIX}${repository.id}`, '1'));
    (await store.kvDelete(key));
    return;
  }
  if (name !== DEPLOYMENT_SOURCE_WORKFLOW
    || String(workflowRun?.status ?? 'completed') !== 'completed'
    || String(workflowRun?.conclusion ?? '').toLowerCase() !== 'success') return;
  const runId = Number(workflowRun?.id);
  if (!Number.isSafeInteger(runId) || runId <= 0) return;
  const now = options.now ?? Date.now();
  const expectation: DeploymentRunExpectation = {
    version: 1,
    repositoryId: repository.id,
    repository: `${repository.owner}/${repository.name}`,
    branch,
    headSha,
    sourceWorkflow: DEPLOYMENT_SOURCE_WORKFLOW,
    sourceRunId: runId,
    sourceRunUrl: String(workflowRun?.html_url ?? ''),
    ...(workflowRun?.updated_at ? { sourceCompletedAt: String(workflowRun.updated_at) } : {}),
    expectedWorkflow: DEPLOYMENT_WORKFLOW,
    expectedWorkflowFile: DEPLOYMENT_WORKFLOW_FILE,
    observedAt: now,
    deadlineAt: now + (options.graceMs ?? DEPLOYMENT_RUN_GRACE_MS),
  };
  (await store.kvClaim(key, JSON.stringify(expectation)));
}

function parseExpectation(value: string): DeploymentRunExpectation | undefined {
  try {
    const parsed = JSON.parse(value) as DeploymentRunExpectation;
    if (parsed?.version !== 1 || !parsed.repositoryId || !parsed.headSha
      || !Number.isFinite(parsed.deadlineAt)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Polls GitHub's API rather than relying on webhook arrival, which cleanly
 * distinguishes a delayed webhook from a run that does not exist at all. */
export class GitHubDeploymentMonitor {
  constructor(private store: Store, private github: DeploymentMonitorGithub) {}

  async reconcile(now = Date.now()): Promise<MissingDeploymentFinding[]> {
    const findings: MissingDeploymentFinding[] = [];
    for (const entry of (await this.store.kvEntries(EXPECTATION_PREFIX))) {
      const expectation = parseExpectation(entry.value);
      if (!expectation) { (await this.store.kvDelete(entry.key)); continue; }
      if (expectation.deadlineAt > now) continue;
      const repository = (await this.store.getRepository(expectation.repositoryId));
      if (!repository) { (await this.store.kvDelete(entry.key)); continue; }

      const file = await this.github.repositoryFileStatus(repository, expectation.expectedWorkflowFile);
      // Auto-discover the convention without imposing Deploy on every connected
      // repository that happens to name its validation workflow CI. Once seen,
      // the durable marker remains so deleting deploy.yml is itself reported.
      const monitoredKey = `${MONITORED_REPOSITORY_PREFIX}${repository.id}`;
      const previouslyMonitored = (await this.store.kvGet(monitoredKey)) === '1';
      if (file.status === 'present') (await this.store.kvSet(monitoredKey, '1'));
      if (file.status === 'missing' && !previouslyMonitored) {
        (await this.store.kvDelete(entry.key));
        continue;
      }

      let query: Record<string, unknown>;
      let appeared = false;
      try {
        const result = await (await this.github.actions(repository)).listRuns(expectation.repository, {
          branch: expectation.branch,
          workflow: 'deploy.yml',
          perPage: 100,
        });
        const matching = result.runs.find((run) => run.headSha === expectation.headSha);
        appeared = Boolean(matching);
        query = {
          status: 'ok', total: result.total, runsChecked: result.runs.length,
          ...(matching ? { matchingRun: {
            id: matching.id, status: matching.status, conclusion: matching.conclusion,
            url: matching.url, createdAt: matching.createdAt,
          } } : {}),
        };
      } catch (error) {
        query = { status: 'error', error: error instanceof Error ? error.message : String(error) };
        // An invalid workflow may not be registered at the workflow-specific
        // endpoint. The repository-wide endpoint can still prove that a delayed
        // run exists, including one waiting for environment approval.
        try {
          const fallback = await (await this.github.actions(repository)).listRuns(expectation.repository, {
            branch: expectation.branch,
            perPage: 100,
          });
          const matching = fallback.runs.find((run) =>
            run.name === expectation.expectedWorkflow && run.headSha === expectation.headSha);
          appeared = Boolean(matching);
          query.fallback = {
            status: 'ok', total: fallback.total, runsChecked: fallback.runs.length,
            ...(matching ? { matchingRun: {
              id: matching.id, status: matching.status, conclusion: matching.conclusion,
              url: matching.url, createdAt: matching.createdAt,
            } } : {}),
          };
        } catch (error2) {
          query.fallback = { status: 'error', error: error2 instanceof Error ? error2.message : String(error2) };
        }
      }
      if (appeared) { (await this.store.kvDelete(entry.key)); continue; }

      const evidence = {
        kind: 'missing_deployment_run',
        prerequisite: {
          workflow: expectation.sourceWorkflow,
          runId: expectation.sourceRunId,
          url: expectation.sourceRunUrl,
          conclusion: 'success',
          completedAt: expectation.sourceCompletedAt,
        },
        expected: {
          workflow: expectation.expectedWorkflow,
          file: expectation.expectedWorkflowFile,
          branch: expectation.branch,
          headSha: expectation.headSha,
        },
        grace: { observedAt: expectation.observedAt, deadlineAt: expectation.deadlineAt, checkedAt: now,
          milliseconds: expectation.deadlineAt - expectation.observedAt },
        workflowFile: file,
        actionsQuery: query,
        interpretation: file.status === 'present'
          ? 'The deployment workflow file exists, but GitHub exposed no run for the validated revision after the grace period. Invalid workflow schema or trigger/configuration rejection is likely; a delayed webhook is ruled out by the direct Actions API query.'
          : file.status === 'missing'
            ? 'This repository previously exposed the deployment workflow, but its workflow file is now missing and GitHub exposed no run for the validated revision.'
            : 'Karmax could not read the expected deployment workflow file. Repository/App permissions or GitHub API availability may be preventing both workflow registration and monitoring.',
      };
      const incidentKey = `missing:${expectation.headSha}:${expectation.expectedWorkflowFile}`;
      const base = {
        repository: expectation.repository,
        repositoryId: expectation.repositoryId,
        workflow: expectation.expectedWorkflow,
        runId: expectation.sourceRunId,
        attempt: 1,
        conclusion: 'missing',
        headSha: expectation.headSha,
        branch: expectation.branch,
        url: expectation.sourceRunUrl,
        source: 'deployment_monitor' as const,
        incidentKey,
        evidence,
      };
      findings.push({
        key: entry.key,
        expectation,
        events: (await this.store.projectIdsForRepository(repository.id)).map((projectId) => ({
          projectId,
          type: 'github.workflow.failed' as const,
          payload: base,
        })),
      });
    }
    return findings;
  }

  /** Call only after all project recovery events were dispatched. A crash before
   * this point safely re-polls; downstream incident keys suppress duplicates. */
  async markReported(finding: MissingDeploymentFinding): Promise<void> {
    (await this.store.kvDelete(finding.key));
  }
}
