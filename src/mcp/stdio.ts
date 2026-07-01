import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPlatformMcpServer, httpOps } from '../platform/mcp.js';

/**
 * Stdio entrypoint for the karmax platform MCP (SPEC §3.4). A CLI agent (Claude
 * or Codex) launches this from its config home's `mcpServers` baseline; it reads
 * the gateway URL + the agent's scoped token from the env karmax injects at spawn
 * (never baked into the static config), then forwards every tool call to the
 * gateway over HTTP under that token — so the same permission checks apply.
 *
 *   env: KARMAX_GATEWAY_URL, KARMAX_TOKEN
 */
async function main(): Promise<void> {
  const baseUrl = process.env.KARMAX_GATEWAY_URL;
  const token = process.env.KARMAX_TOKEN;
  if (!baseUrl || !token) {
    process.stderr.write('karmax-mcp: KARMAX_GATEWAY_URL and KARMAX_TOKEN are required\n');
    process.exit(1);
  }
  const server = createPlatformMcpServer(httpOps(baseUrl, token));
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`karmax-mcp: ${String((e as Error).message ?? e)}\n`);
  process.exit(1);
});
