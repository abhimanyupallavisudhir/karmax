/**
 * The Git commit this process was built from. The release image records it
 * (deploy/Dockerfile's KARMAX_REVISION build argument), so readiness can say
 * which commit is serving: a deploy, the staging smoke suite and the
 * production check all compare it with the commit they expect.
 */
export function releaseRevision(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.KARMAX_REVISION?.trim().toLowerCase();
  return value && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}
