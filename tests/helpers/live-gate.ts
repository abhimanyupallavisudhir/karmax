/** Real providers and GitHub fixtures are never part of an ordinary test run. */
export function liveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KARMAX_RUN_LIVE === '1';
}
