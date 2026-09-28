/** The instance-wide brand icon. Each id is a directory under `web/brand/`
 * holding the same asset filenames, so switching the setting reskins the
 * favicon, the installed-app icon and the in-app mark from one place. */
export const BRAND_ICONS = ['diamond', 'knot', 'check', 'check-arrow', 'check-knot', 'check-knot-tilted', 'check-knot-purple', 'check-knot-purple-arrow', 'gold-check', 'gold-arrow', 'bold-gold-check', 'bold-gold-arrow', 'royal-gold-check', 'royal-gold-arrow', 'clover'] as const;

export type BrandIcon = (typeof BRAND_ICONS)[number];

export const DEFAULT_BRAND_ICON: BrandIcon = 'diamond';

/** The product brand, in everything that leaves the platform or that people
 * see: Git branches, commits and PR text, local checkout commands, UI copy and
 * the names third-party services record. Internal identifiers (env vars, state
 * files, storage and lookup keys, MCP server ids) deliberately remain `karmax`
 * for compatibility with existing homes, sandboxes and tasks. */
export const BRAND = 'tavya';

/** Human-facing name of an installation; the admin can override it. */
export const DEFAULT_SITE_NAME = BRAND;
export const MAX_SITE_NAME_LENGTH = 48;

/** Files served under `/brand/`. Not every variant has every file, and a miss
 * falls through to the next `<link>`. */
export const BRAND_FILES = ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'] as const;

export function isBrandIcon(value: unknown): value is BrandIcon {
  return BRAND_ICONS.includes(value as BrandIcon);
}

/** Falls back to the default rather than throwing: an unknown id in the store
 * (hand-edited, or a variant removed by a downgrade) must not break the UI. */
export function brandIconOf(settings: Record<string, unknown> | undefined): BrandIcon {
  return isBrandIcon(settings?.icon) ? settings.icon : DEFAULT_BRAND_ICON;
}

export function siteNameError(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return 'Site name is required';
  if ([...value.trim()].length > MAX_SITE_NAME_LENGTH)
    return `Site name must be ${MAX_SITE_NAME_LENGTH} characters or fewer`;
  if (/\p{Cc}|\p{Cf}/u.test(value)) return 'Site name cannot contain control characters';
  return undefined;
}

/** Stored settings may have been hand-edited or written by a newer release.
 * Read them defensively so public pages always retain a usable name. */
export function siteNameOf(settings: Record<string, unknown> | undefined): string {
  return siteNameError(settings?.siteName) ? DEFAULT_SITE_NAME : String(settings!.siteName).trim();
}

/** Branch namespaces that mark a task branch. New tasks use the first; the
 * rest are earlier names still carried by existing tasks and open PRs. */
const TASK_BRANCH_NAMESPACES = [BRAND, 'karmax'] as const;

/** The branch a task works on unless it asks for a specific one. */
export function taskBranch(taskId: string): string {
  return `${BRAND}/${taskId}`;
}

/** The task a task branch belongs to, for correlating GitHub back to a task. */
export function taskIdOfBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const namespace = TASK_BRANCH_NAMESPACES.find((name) => branch.startsWith(`${name}/`));
  return namespace ? branch.slice(namespace.length + 1) || undefined : undefined;
}

