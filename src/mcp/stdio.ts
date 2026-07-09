import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPlatformMcpServer, httpOps } from '../platform/mcp.js';

/**
 * Stdio entrypoint for the karmax platform MCP (SPEC §3.4). A CLI agent (Claude
 * or Codex) launches this from its config home's `mcpServers` baseline; it reads
 * the gateway URL from the env karmax bakes into that config, resolves a gateway
 * session, then forwards every tool call to the gateway over HTTP under that
 * session — so the same permission checks apply.
 *
 * Auth (in priority order):
 *   1. KARMAX_TOKEN            — a session id injected by karmax at agent spawn.
 *   2. GET  /api/session       — an unauthenticated session when no password is set
 *                                (the same thing the web console does on load).
 *   3. POST /api/login         — with KARMAX_PASSWORD, when a password IS set.
 *
 * We DO NOT exit when no token can be resolved: a bare `process.exit(1)` at
 * startup kills the stdio transport mid-handshake, which the Claude CLI reports
 * as the opaque `Failed to reconnect to karmax: -32000` (JSON-RPC ConnectionClosed).
 * Instead we always complete the MCP handshake; if auth is unavailable, individual
 * tool calls surface a clear `unauthorized` error while the connection stays up.
 *
 *   env: KARMAX_GATEWAY_URL (default http://localhost:4505), KARMAX_TOKEN, KARMAX_PASSWORD
 */
const DEFAULT_GATEWAY_URL = 'http://localhost:4505';

/** Resolve a gateway Bearer (a session id). Returns undefined if none can be
 *  obtained (gateway unreachable, or a password is required but none is set). */
export async function resolveGatewayToken(baseUrl: string): Promise<string | undefined> {
  const injected = process.env.KARMAX_TOKEN;
  if (injected) return injected;
  try {
    const s = (await fetch(`${baseUrl}/api/session`).then((r) => r.json())) as { authRequired?: boolean; token?: string };
    if (s?.token) return s.token;
    if (s?.authRequired && process.env.KARMAX_PASSWORD) {
      const l = (await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: process.env.KARMAX_PASSWORD }),
      }).then((r) => r.json())) as { token?: string };
      if (l?.token) return l.token;
    }
  } catch {
    // Gateway unreachable — fall through; tool calls will error, the connection lives.
  }
  return undefined;
}

async function main(): Promise<void> {
  const baseUrl = process.env.KARMAX_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const server = createPlatformMcpServer(httpOps(baseUrl, () => resolveGatewayToken(baseUrl)));
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`karmax-mcp: ${String((e as Error).message ?? e)}\n`);
  process.exit(1);
});
