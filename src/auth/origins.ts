/** Explicit operator hosts and loopback defaults for Better Auth. */
export function authHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const publicUrl = env.KARMAX_PUBLIC_URL;
  const publicHost = (() => { try { return publicUrl ? new URL(publicUrl).hostname : undefined; } catch { return undefined; } })();
  const configuredAuthHosts = [
    ...(env.KARMAX_AUTH_HOSTS ?? '127.0.0.1,localhost').split(',').map((x) => x.trim()).filter(Boolean),
    ...(publicHost ? [publicHost] : []),
  ];
  // Better Auth matches the request's Host header WITH its port against each
  // allowedHosts pattern, so a bare host (`localhost`) never matches a dev server
  // on a non-standard port (`localhost:4506`) — it silently fell back to the
  // hardcoded fallback URL, which made verification/reset links point at the
  // wrong port and made the password-reset origin check reject the redirect. Add
  // a scheme-qualified port-wildcard per host: Better Auth trusts those origins
  // verbatim AND (after stripping the scheme) matches them for base-URL
  // resolution, so links and origin checks track whatever host:port the user is
  // actually on. Loopback hosts get http; everything else https.
  const isLoopbackHost = (h: string) => /^(localhost|127\.|\[?::1\]?)/.test(h) || h.endsWith('.localhost');
  return [...new Set([
    ...configuredAuthHosts,
    ...configuredAuthHosts
      .filter((h) => !h.includes('://') && !/:\d/.test(h))
      .map((h) => `${isLoopbackHost(h) ? 'http' : 'https'}://${h}:*`),
  ])];
}
