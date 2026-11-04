export interface WatchedCli { id: string; name: string; repository: string; tag: RegExp; arg: string }
export interface GitHubRelease { tag_name: string; html_url: string; published_at: string; prerelease: boolean; draft: boolean }
export interface ReleaseEvent {
  type: string;
  key: string;
  payload: { cli: string; name: string; version: string; pinned: string; repository: string; url: string; publishedAt: string };
}
export const EVENT_TYPE: string;
export const WATCHED_CLIS: WatchedCli[];
export function pinnedVersions(dockerfile: string): Record<string, string>;
export function newReleases(cli: WatchedCli, pinned: string, releases: GitHubRelease[]): ReleaseEvent[];
