import type { AdoptedRepositories, KeptWorkspace, ProjectConfig } from './types.js';

/** Workflow patch: a task that began without repositories adopts the ones
 * attached to its project since, at the top of its next Do turn. */
export const ADOPT_ATTACHED_REPOSITORIES = 'adopt-attached-repositories-v1';
/** Workflow patch: a task without repositories keeps a final checkpoint at Confirm. */
export const KEEP_FINAL_WORKSPACE = 'keep-final-workspace-v1';

/** What the agent is told when its world gains a repository mid-task. */
export function adoptedRepositoriesNote(adopted: Pick<AdoptedRepositories, 'checkouts'>, opensPullRequests = true): string {
  const where = adopted.checkouts.map((checkout) => `\`${checkout.path}/\` (${repositoryLabel(checkout.source)}, branch \`${checkout.branch}\`)`);
  const one = adopted.checkouts.length === 1;
  return `${one ? 'A repository was' : 'Repositories were'} attached to this project and ${one ? 'is' : 'are'} now checked out in your world: ${where.join(', ')}. `
    + `Move what this task made that belongs in ${one ? 'it' : 'them'} there and commit. `
    + (opensPullRequests ? '`open_pr` now opens a pull request of what you commit. ' : 'What you commit is saved on that branch. ')
    + 'Files outside a checkout are not part of it.';
}

/** The task's project snapshot once its world adopted repositories: the task's
 * own settings stay; the repository facts are the world's and the project's. */
export function adoptedProjectConfig(project: ProjectConfig, adopted: Pick<AdoptedRepositories, 'project'>): ProjectConfig {
  const live = adopted.project;
  return {
    ...project,
    repos: live.repos,
    ...(live.defaultBase ? { defaultBase: live.defaultBase } : {}),
    ...(live.defaultTarget ? { defaultTarget: live.defaultTarget } : {}),
    ...(project.remote === undefined && project.openGithubPr === undefined
      ? { ...(live.remote ? { remote: live.remote } : {}), ...(live.openGithubPr !== undefined ? { openGithubPr: live.openGithubPr } : {}) }
      : {}),
    ...(project.landingAuthority === undefined && live.landingAuthority ? { landingAuthority: live.landingAuthority } : {}),
  };
}

/** The line a finished task without repositories adds to its summary. */
export function keptWorkspaceNote(kept: KeptWorkspace | undefined): string {
  if (!kept) return '';
  if (!kept.destroy) return ' Its world is kept.';
  if (!kept.checkpointId || !kept.files) return '';
  return ` Saved its ${kept.files} file${kept.files === 1 ? '' : 's'}${kept.keptDays ? ` for ${kept.keptDays} days` : ''}: Continue starts from them.`;
}

function repositoryLabel(source: string): string {
  const match = source.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return match?.[1] ?? source;
}
