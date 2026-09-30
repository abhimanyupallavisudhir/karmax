// Public, package-only browser/runtime build; usable with each organization's
// own E2B key. Keep this release default aligned with environments/browser.
export const DEFAULT_E2B_TEMPLATE = 'uj125w982t7wflqad4ig';

/** The template an E2B sandbox starts from when nothing more specific is
 * chosen: the organization's Compute template, else the installation's, else
 * karmax's own. Task worlds and environment builders both start here, so a
 * project environment is built on exactly what its worlds would otherwise run. */
export function e2bTemplate(configured?: string): string {
  return configured?.trim() || process.env.KARMAX_E2B_TEMPLATE?.trim() || DEFAULT_E2B_TEMPLATE;
}
