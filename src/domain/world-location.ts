import type { ResourceTarget, WorldLocation } from './types.js';

/** World checkout name for a repository source (its basename). */
export function remoteName(remote: string): string {
  const raw = remote.replace(/\/$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') || 'repo';
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  return !safe || /^\.+$/.test(safe) ? 'repo' : safe;
}

/** The folders a world checks repository sources out into: basenames, with
 * `-2`, `-3`… when two share one. */
export function worldCheckoutNames(sources: string[]): string[] {
  const seen = new Map<string, number>();
  return sources.map(remoteName).map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count ? `${name}-${count + 1}` : name;
  });
}

/** Where a task works, relative to its world: the only development checkout,
 * else the root. An unpinned location is relative to it. */
export function workingFolder(checkouts: string[]): string {
  return checkouts.length === 1 ? checkouts[0]! : '.';
}

/**
 * A stored location pinned to the checkout it lies in, as it resolves while the
 * project's development checkouts are `checkouts`: with one, everything is in
 * it; with several, a path's first folder names its checkout. Pinned, it stays
 * put when the working folder moves (a second repository added, or all but one
 * removed). A root-level path in a multi-repository project has no checkout to
 * pin to and is returned as it is.
 */
export function pinLocation<T extends WorldLocation>(location: T, checkouts: string[]): T {
  if (location.repository !== undefined || !checkouts.length) return location;
  const normalized = location.path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (checkouts.length === 1) return { ...location, path: normalized, repository: checkouts[0]! };
  const [first, ...rest] = normalized.split('/');
  return rest.length && checkouts.includes(first!) ? { ...location, path: rest.join('/'), repository: first! } : location;
}

/** `pinLocation` for a resource's target (a path, or the .env file a variable is a line of). */
export function pinTarget(target: ResourceTarget, checkouts: string[]): ResourceTarget {
  if (target.kind === 'path') return pinLocation(target, checkouts);
  if (target.kind === 'environment' && target.dotenv) {
    const dotenv = pinLocation(target.dotenv, checkouts);
    return dotenv === target.dotenv ? target : { ...target, dotenv };
  }
  return target;
}
