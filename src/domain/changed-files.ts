/** What a task's "changed files" are, in one place (wiki incidents/lessons,
 * "Changed files listed .karmax-injection"). Pure: workflows import it too.
 *
 * tavya keeps its own files for a world (the agent's home and memory, Chrome's
 * profile, jobs, ballast, injected credentials) under `.karmax-injection/`, at
 * the world root and inside a checkout. They are never the task's work: no
 * list, count, summary, pull request or checkpoint may hold them. */

export const PLATFORM_DIR = '.karmax-injection';

/** A world-relative path tavya owns: `.karmax-injection` at the root or under
 * any directory (a nested checkout's). A trailing " (new)" marker is allowed. */
export function isPlatformPath(file: string): boolean {
  return file.replace(/ \(new\)$/, '').split('/').includes(PLATFORM_DIR);
}

/** The task's own files out of a listing. */
export function withoutPlatformPaths(files: string[]): string[] {
  return files.filter((file) => !isPlatformPath(file));
}

/** What buildReview derives for Review: the list (bounded), and the one count
 * every view shows (the rail's "Changed files", the review summary). */
export interface ChangedFilesReview {
  summary: string;
  changedFiles: string[];
  /** Every changed file, also those the bounded list leaves out. */
  changedFileCount: number;
}

/** The review summary buildReview writes when the agent wrote none. */
export function gitDerivedReviewSummary(changed: number, shown?: number): string {
  if (!changed) return 'No file changes detected.';
  return `${changed} file(s) changed.${shown != null ? ` Showing ${shown}; inspect the checkouts for the full list.` : ''}`;
}

/** The same for a world with no repository, whose files are all its work. */
export function workspaceReviewSummary(files: number, shown?: number): string {
  if (!files) return 'No file changes detected.';
  return `${files} file(s) in the task workspace.${shown != null ? ` Showing ${shown}; inspect the workspace for the full list.` : ''}`;
}

/** A summary that only counts files (one of the two above): a snapshot of the
 * changed files, replaced whenever they are rebuilt, and not repeated in the
 * conversation, where the rail's count is the one number shown. */
export function isGitDerivedReviewSummary(summary: string): boolean {
  return /^(?:\d+ file\(s\) changed\.(?: Showing \d+; inspect the checkouts for the full list\.)?|\d+ file\(s\) in the task workspace\.(?: Showing \d+; inspect the workspace for the full list\.)?|No file changes detected\.)$/
    .test(summary.trim());
}

interface ReviewFiles { summary?: string; changedFiles?: string[]; changedFileCount?: number }

/** Put a rebuilt list into a review: the list, its count, and the summary when
 * it is only a count (or missing), so the two always come from one build. */
export function withChangedFiles<T extends ReviewFiles>(info: T | undefined, review: ChangedFilesReview): T {
  const summary = info?.summary && !isGitDerivedReviewSummary(info.summary) ? info.summary : review.summary;
  return { ...info, summary, changedFiles: review.changedFiles, changedFileCount: review.changedFileCount } as T;
}

/** A stored view from before the fix: its list without platform paths, and a
 * count that no longer counts them. A summary that only counted them is
 * dropped: what it left out of a shortened list is unknown. */
export function cleanedReviewFiles<T extends ReviewFiles>(info: T | undefined): T | undefined {
  if (!info?.changedFiles?.some(isPlatformPath)) return info;
  const changedFiles = withoutPlatformPaths(info.changedFiles);
  const dropped = info.changedFiles.length - changedFiles.length;
  const { summary, ...rest } = info;
  return {
    ...rest, changedFiles,
    ...(info.changedFileCount !== undefined ? { changedFileCount: Math.max(changedFiles.length, info.changedFileCount - dropped) } : {}),
    ...(summary && !isGitDerivedReviewSummary(summary) ? { summary } : {}),
  } as T;
}
