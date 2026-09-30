/**
 * The loopback Chrome DevTools port that karmax's browser MCP launcher
 * (`chrome-cdp-launcher.mjs`) opens Chrome on, so a zero-exposure credential,
 * card or passkey fill (wiki plans/PLAN-passwords §5B/§8) lands in the very
 * page the agent is driving. Which browser a fill uses is task-browser.ts's
 * decision, never the agent's. Override the port with KARMAX_CDP_PORT.
 */
export const DEFAULT_CDP_PORT = Number(process.env.KARMAX_CDP_PORT) || 9222;
