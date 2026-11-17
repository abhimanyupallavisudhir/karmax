/**
 * Repositories tavya hosts itself (wiki features/hosted-repositories; the
 * server is world/hosted-git.ts). Pure: names, URLs and the stored state.
 */
import type { Repository } from './types.js';

export const HOSTED_GIT_ROUTE = '/git/';
export const HOSTED_GIT_SCHEME = 'tavya:';

export interface HostedPack { id: string; bytes: number; parts: number; sha256: string }
export interface HostedRepositoryState {
  repositoryId: string;
  organizationId: string;
  /** HEAD's branch: what a clone checks out. */
  head: string;
  /** `refs/...` → object id. */
  refs: Record<string, string>;
  /** In order: each holds the objects one push added (or all of them, after compaction). */
  packs: HostedPack[];
  /** Stored bytes, as the storage quota counts them. */
  bytes: number;
  version: number;
  updatedAt: number;
}

export const isHostedRepository = (repository: Pick<Repository, 'provider'> | undefined): boolean => repository?.provider === 'tavya';

/** The stable URL: projects, task worlds and the broker know the repository by it. */
export const hostedRepositoryUrl = (id: string, name: string): string => `${HOSTED_GIT_SCHEME}${id}/${name}.git`;

/** The repository a `tavya:` URL names. */
export function parseHostedUrl(url: string): { id: string; name: string } | undefined {
  const match = /^tavya:(repo_[a-z0-9]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? { id: match[1]!, name: match[2]! } : undefined;
}

/** Repositories that can only land by push: all of them tavya's. Pull requests
 * need GitHub, so on hosted this decides the remote policy over whatever a
 * project, its settings or a task names (tavya-error 5b7a123b7e52ac15). */
export const landsByPushOnTavya = (repos: readonly string[] | undefined): boolean =>
  Boolean(repos?.length) && repos!.every((repo) => parseHostedUrl(repo) !== undefined);

/** What `git clone` takes, at `base` (this installation's public URL). */
export const hostedCloneUrl = (base: string, repository: Pick<Repository, 'id' | 'name'>): string =>
  `${base.replace(/\/$/, '')}${HOSTED_GIT_ROUTE}${repository.id}/${repository.name}.git`;

/** A repository name as GitHub allows them, so one can move there unchanged. */
export const isValidHostedName = (name: string): boolean =>
  /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name) && !name.endsWith('.git') && name.length <= 100;
