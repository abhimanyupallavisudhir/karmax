/**
 * User and organization names share one human-facing namespace. Keep the
 * comparison independent of SQLite's ASCII-only NOCASE collation so names that
 * differ only by Unicode compatibility forms or letter case cannot slip through
 * different creation paths.
 */
export function canonicalAccountName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

