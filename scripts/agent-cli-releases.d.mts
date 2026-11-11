export interface WatchedCli {
  id: string; name: string; repository: string; package: string; tag: RegExp; arg: string;
  models: (notes: string) => string[];
}
export interface GitHubRelease {
  tag_name: string; html_url: string; published_at: string; prerelease: boolean; draft: boolean; body?: string | null;
}
export interface GitHubAdvisory {
  ghsa_id: string; severity: string;
  vulnerabilities?: { package?: { name?: string }; patched_versions?: string | null }[];
}
export interface ReleaseEvent {
  type: string;
  key: string;
  payload: {
    cli: string; name: string; version: string; pinned: string; repository: string; url: string; publishedAt: string;
    reasons: string[];
  };
}
export const EVENT_TYPE: string;
export const MAX_LAG_DAYS: number;
export const WATCHED_CLIS: WatchedCli[];
export function pinnedVersions(dockerfile: string): Record<string, string>;
export function knownModels(modelsTs: string): Set<string>;
export function newReleases(
  cli: WatchedCli,
  pinned: string,
  releases: GitHubRelease[],
  context: { knownModels: Set<string>; advisories: GitHubAdvisory[]; now: number },
): ReleaseEvent[];
export function releasesOf(
  cli: WatchedCli,
  pinned: string,
  fetchImpl?: typeof fetch,
  options?: { pageSize?: number; maxPages?: number; retryMs?: number },
): Promise<GitHubRelease[]>;
export function advisoriesOf(cli: WatchedCli, fetchImpl?: typeof fetch, options?: { retryMs?: number }): Promise<GitHubAdvisory[]>;
