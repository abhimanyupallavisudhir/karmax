/** The instance-wide brand icon. Each id is a directory under `web/brand/`
 * holding the same asset filenames, so switching the setting reskins the
 * favicon, the installed-app icon and the in-app mark from one place. */
export const BRAND_ICONS = ['diamond', 'knot', 'check', 'check-arrow', 'check-knot', 'clover'] as const;

export type BrandIcon = (typeof BRAND_ICONS)[number];

export const DEFAULT_BRAND_ICON: BrandIcon = 'diamond';

/** Human-facing name of an installation. Technical identifiers deliberately
 * remain `karmax` for compatibility with existing homes, env vars and tasks. */
export const DEFAULT_SITE_NAME = 'krmax';
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
