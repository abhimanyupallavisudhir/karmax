/** The tavya CLI names itself in every request's User-Agent as `tavya-cli/<version>`. */
export const CLI_USER_AGENT = 'tavya-cli';

const parts = (version: string): number[] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : undefined;
};

/** `a` is an older x.y.z version than `b`; false when either is not one. */
export function olderVersion(a: string, b: string): boolean {
  const left = parts(a); const right = parts(b);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! < right[index]!;
  return false;
}

/** The CLI version a User-Agent names, if it is the tavya CLI's. */
export function cliVersionOf(userAgent: string | undefined): string | undefined {
  return new RegExp(`^${CLI_USER_AGENT}/(\\d+\\.\\d+\\.\\d+)(?:\\s|$)`).exec(userAgent ?? '')?.[1];
}
