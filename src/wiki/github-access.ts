/**
 * GitHub access to project wiki repositories is now one case of GitHub access
 * to every repository a project uses: see `src/integrations/project-github-access.ts`.
 * The wiki-era names stay so existing imports keep working.
 */
export {
  ProjectGithubAccess,
  ProjectGithubAccess as WikiGithubAccess,
  type RepositoryAccessGrant,
  type RepositoryAccessGrant as WikiAccessGrant,
  type RepositoryAccessOutcome,
  type RepositoryAccessOutcome as WikiAccessOutcome,
} from '../integrations/project-github-access.js';
