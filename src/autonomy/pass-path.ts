/**
 * Pure helpers for turning a unix `pass` entry path into credential metadata.
 * Kept dependency-free (no store, no broker) so both the `pass` connector and
 * the boot-time metadata backfill migration can share it without an import
 * cycle (PLAN-passwords.md §9).
 */

export function hostOf(value?: string): string {
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname;
  } catch {
    return '';
  }
}

/**
 * `pass` has no schema: folders are commonly followed by a hostname and then
 * a username (`software/www.overleaf.com/alice@example.com`). Treating the
 * whole store path as a URL makes the first folder look like the host, which
 * produces unusable and unsafe domain metadata. Find the first DNS-looking
 * path component instead and use the final component as the username when it
 * follows that host.
 */
export function passEntryMetadata(entry: string): { domain?: string; username?: string } {
  const parts = entry.split('/').map((part) => part.trim()).filter(Boolean);
  const domainIndex = parts.findIndex((part) => {
    if (part.includes('@') || part.startsWith('.') || !part.includes('.')) return false;
    const host = hostOf(part);
    return host === part.toLowerCase()
      && host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  });
  if (domainIndex < 0) return {};
  const domain = hostOf(parts[domainIndex]);
  const username = domainIndex < parts.length - 1 ? parts.at(-1) : undefined;
  return { domain, ...(username ? { username } : {}) };
}
