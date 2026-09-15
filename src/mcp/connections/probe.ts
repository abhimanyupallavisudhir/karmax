import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { publicStreamFetch } from './http.js';
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
  const client = new Client({ name: 'tavya-connection-test', version: '1' }, { capabilities: {},
    jsonSchemaValidator: { getValidator<T>() { return (data: unknown): import('@modelcontextprotocol/sdk/validation/types.js').JsonSchemaValidatorResult<T> => ({ valid: true, data: data as T, errorMessage: undefined }); } },
  });
  try {
    const headers = await connectionHeaders(service, c);
    const endpoint = new URL(c.transport.url);
    const fetcher: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== endpoint.origin) throw new Error('MCP endpoint changed origin');
      const merged = new Headers(request.headers);
      for (const [name, value] of Object.entries(headers)) merged.set(name, value);
      return publicStreamFetch(new Request(request, { headers: merged }));
    };
    const transport = c.transport.type === 'sse'
      ? new SSEClientTransport(endpoint, { fetch: fetcher, eventSourceInit: { fetch: fetcher } } as any)
      : new StreamableHTTPClientTransport(endpoint, { fetch: fetcher });
    await client.connect(transport, { timeout: 15_000 });
    const capabilities = client.getServerCapabilities();
    const tools = capabilities?.tools ? await client.listTools(undefined, { timeout: 15_000 }) : undefined;
    return { ok: true, tools: tools?.tools.length ?? 0, moreTools: !!tools?.nextCursor,
      resources: !!capabilities?.resources, prompts: !!capabilities?.prompts };
  } catch {
    throw new Error('Could not connect. Check the server URL and authentication; this server may require OAuth sign-in or an API key.');
  } finally { await client.close().catch(() => {}); active--; }
}
