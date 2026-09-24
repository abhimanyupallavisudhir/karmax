import { openRemoteMcp } from './remote.js';
import { connectionHeaders } from './oauth.js';
import { McpConnections, type McpConnection } from './store.js';
let active = 0;
/** A remote connection test runs only bounded protocol requests through the
 * public-network guard. Process connections are tested in their task world. */
export async function probeConnection(service: McpConnections, c: McpConnection) {
  if (!c.enabled) throw new Error('Enable the connection before testing it');
  if (c.transport.type === 'stdio') throw new Error('Process connections are checked when the agent starts in its task environment');
  if (active >= 8) throw new Error('Connection tests are busy. Retry shortly.');
  active++;
  let client: Awaited<ReturnType<typeof openRemoteMcp>> | undefined;
  try {
    client = await openRemoteMcp(c.transport, await connectionHeaders(service, c));
    const capabilities = client.getServerCapabilities();
    const tools = capabilities?.tools ? await client.listTools(undefined, { timeout: 15_000 }) : undefined;
    return { ok: true, tools: tools?.tools.length ?? 0, moreTools: !!tools?.nextCursor,
      resources: !!capabilities?.resources, prompts: !!capabilities?.prompts };
  } catch {
    throw new Error('Could not connect. Check the server URL and authentication; this server may require OAuth sign-in or an API key.');
  } finally { await client?.close().catch(() => {}); active--; }
}
