/** The instance-wide brand icon. Each id is a directory under `web/brand/`
 * holding the same asset filenames, so switching the setting reskins the
 * favicon, the installed-app icon and the in-app mark from one place. */
export const BRAND_ICONS = ['diamond', 'knot', 'check', 'clover'] as const;

export type BrandIcon = (typeof BRAND_ICONS)[number];

export const DEFAULT_BRAND_ICON: BrandIcon = 'diamond';

/** Files served under `/brand/`. Not every variant has every file — only the
 * diamond ships an SVG — and a miss falls through to the next `<link>`. */
export const BRAND_FILES = ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'] as const;

export function isBrandIcon(value: unknown): value is BrandIcon {
  return BRAND_ICONS.includes(value as BrandIcon);
}

/** Falls back to the default rather than throwing: an unknown id in the store
 * (hand-edited, or a variant removed by a downgrade) must not break the UI. */
export function brandIconOf(settings: Record<string, unknown> | undefined): BrandIcon {
  return isBrandIcon(settings?.icon) ? settings.icon : DEFAULT_BRAND_ICON;
}
