import type http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPlatformMcpServer, httpOps } from './mcp.js';
import { BRAND } from '../domain/brand.js';

/**
 * tavya as a remote MCP server: `https://tavya.io/mcp` (Streamable HTTP,
 * stateless, JSON responses). Clients add it with
 * `claude mcp add --transport http tavya https://tavya.io/mcp` and sign in with
 * OAuth (`oauth-routes.ts`), or send `Authorization: Bearer $TAVYA_TOKEN`.
 *
 * The tools are the platform MCP's own definitions, minus those bound to a
 * calling task. Every call goes through the gateway's `/api` with the caller's
 * own bearer, so a tool can do exactly what that person's (or token's)
 * capabilities allow there, checked by the same route bindings as the console.
 */
export const REMOTE_MCP_TOOLS: ReadonlySet<string> = new Set([
  'create_task', 'list_tasks', 'get_task', 'search_tasks', 'find_task', 'list_tags', 'tag_task', 'set_task_priority',
  'signal_task', 'message_agent', 'get_conversation', 'list_agents', 'fork_agent', 'list_events', 'reorder_queue',
  'read_wiki', 'search_wiki', 'describe_platform', 'platform_request', 'list_connections', 'verify_resource_revision',
  'list_world_providers', 'connect_world_provider', 'test_world_provider', 'disconnect_world_provider',
  'get_execution_policy', 'set_execution_policy',
]);

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function serveRemoteMcp(req: http.IncomingMessage, res: http.ServerResponse, options: {
  /** The verified bearer the client sent. */
  bearer: string;
  /** Where this gateway answers its own `/api`. */
  apiBaseUrl: string;
  /** Headers that mark the loopback calls as this gateway's own. */
  internalHeaders: Record<string, string>;
}): Promise<void> {
  if (req.method !== 'POST') {
    // Stateless: no server-initiated stream and no session to delete.
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
  }
  let body: unknown;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: e instanceof Error ? e.message : 'Parse error' }, id: null }));
  }
  const server = createPlatformMcpServer(httpOps(options.apiBaseUrl, options.bearer, options.internalHeaders),
    { tools: REMOTE_MCP_TOOLS, name: BRAND });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.once('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
