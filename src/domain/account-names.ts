/**
 * User and organization names share one human-facing namespace. Keep the
 * comparison independent of SQLite's ASCII-only NOCASE collation so names that
 * differ only by Unicode compatibility forms or letter case cannot slip through
 * different creation paths.
 */
export function canonicalAccountName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}


/** Names with a meaning of their own: `for:me` searches for whoever is signed in. */
const RESERVED_ACCOUNT_NAMES = new Set(['me']);

/** Throw a user-facing error for a reserved user or organization name. */
export function assertAccountNameAllowed(value: string): void {
  const key = canonicalAccountName(value);
  if (RESERVED_ACCOUNT_NAMES.has(key))
    throw new Error(`"${key}" is reserved — in searches it means whoever is signed in. Please choose another name.`);
}
