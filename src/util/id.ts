import crypto from 'node:crypto';

/** Short, URL-safe, sortable-ish id: time prefix + random suffix. */
export function newId(prefix = ''): string {
  const time = Date.now().toString(36);
  const rand = crypto.randomBytes(5).toString('hex');
  const id = `${time}${rand}`;
  return prefix ? `${prefix}_${id}` : id;
}

/** A deterministic, filesystem-safe slug. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';
}
