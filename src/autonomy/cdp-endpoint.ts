/**
 * The single loopback Chrome DevTools endpoint that the agent's browser MCP and
 * karmax's host-side credential fill/passkey paths (wiki plans/PLAN-passwords §5B/§8)
 * both point at, so a zero-exposure fill lands in the very page the agent is
 * driving. `chrome-cdp-launcher.mjs` opens Chrome here; `fill`/`passkey`/card
 * default here. Override the port with KARMAX_CDP_PORT, or the whole URL with
 * KARMAX_CDP_URL (e.g. when the browser lives at a non-loopback host).
 */
export const DEFAULT_CDP_PORT = Number(process.env.KARMAX_CDP_PORT) || 9222;

export function defaultCdpUrl(): string {
  return process.env.KARMAX_CDP_URL || `http://127.0.0.1:${DEFAULT_CDP_PORT}`;
}
