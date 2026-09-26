/** Only control-plane status or a typed SDK error proves deletion. Network
 * failures (including ENOTFOUND) must never authorize recovery or reaping. */
export function isMissingSandbox(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: number; statusCode?: number; response?: { status?: number }; name?: string };
  return value.status === 404 || value.statusCode === 404 || value.response?.status === 404
    || value.name === 'SandboxNotFoundError' || value.name === 'DaytonaNotFoundError';
}
