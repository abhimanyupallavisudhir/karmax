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
/** What a client is told about a tool before it calls it (MCP tool annotations):
 * a name for people, and whether it only reads, changes things, or can undo or
 * remove work. Directories of MCP servers (Claude's among them) require both of
 * every tool, and clients ask the person before a call accordingly. */
export interface RemoteToolNote { title: string; readOnly?: true; destructive?: true }

const reads = (title: string): RemoteToolNote => ({ title, readOnly: true });
const changes = (title: string): RemoteToolNote => ({ title });
const removes = (title: string): RemoteToolNote => ({ title, destructive: true });

/** The tools `/mcp` offers: the platform's, minus those bound to a calling task. */
export const REMOTE_MCP_TOOL_NOTES: Readonly<Record<string, RemoteToolNote>> = {
  create_task: changes('Create a task'),
  list_tasks: reads('List a project’s tasks'),
  get_task: reads('Read a task'),
  search_tasks: reads('Search tasks'),
  find_task: reads('Find a task by its number'),
  list_tags: reads('List tags'),
  tag_task: changes('Tag a task'),
  set_task_priority: changes('Set a task’s priority'),
  // Confirm lands work and Cancel abandons it.
  signal_task: removes('Act on a task (confirm, cancel, follow up)'),
  stop_agent: removes('Stop an agent'),
  message_agent: changes('Message a task’s agent'),
  get_conversation: reads('Read a task’s conversation'),
  list_agents: reads('List a task’s agents'),
  fork_agent: changes('Fork an agent into a task'),
  list_events: reads('Read a task’s events'),
  reorder_queue: changes('Reorder a queue'),
  read_wiki: reads('Read a wiki'),
  search_wiki: reads('Search a wiki'),
  describe_platform: reads('Describe the API'),
  // Any /api route the caller is authorized for, deletions included.
  platform_request: removes('Call the API'),
  list_connections: reads('List connected apps'),
  verify_resource_revision: reads('Verify a version of project data'),
  list_world_providers: reads('List cloud computer providers'),
  connect_world_provider: changes('Connect a cloud computer provider'),
  test_world_provider: reads('Test a cloud computer provider'),
  disconnect_world_provider: removes('Disconnect a cloud computer provider'),
  get_execution_policy: reads('Read the execution policy'),
  set_execution_policy: changes('Set the execution policy'),
};

export const REMOTE_MCP_TOOLS: ReadonlySet<string> = new Set(Object.keys(REMOTE_MCP_TOOL_NOTES));

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
    { tools: REMOTE_MCP_TOOLS, notes: REMOTE_MCP_TOOL_NOTES, name: BRAND });
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
