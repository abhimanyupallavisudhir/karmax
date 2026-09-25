import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { publicStreamFetch } from './http.js';

export type RemoteMcpTransport = { type: 'http' | 'sse'; url: string };

/** A bounded MCP client for a remote server, used from the shared gateway. It
 * never follows the server to another origin, and never compiles server-provided
 * JSON Schema in the shared process. */
export async function openRemoteMcp(transport: RemoteMcpTransport, headers: Record<string, string>, timeout = 15_000): Promise<Client> {
  const client = new Client({ name: 'tavya', version: '1' }, { capabilities: {},
    jsonSchemaValidator: { getValidator<T>() { return (data: unknown): import('@modelcontextprotocol/sdk/validation/types.js').JsonSchemaValidatorResult<T> => ({ valid: true, data: data as T, errorMessage: undefined }); } },
  });
  const endpoint = new URL(transport.url);
  const fetcher: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== endpoint.origin) throw new Error('MCP endpoint changed origin');
    const merged = new Headers(request.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return publicStreamFetch(new Request(request, { headers: merged }));
  };
  const connection = transport.type === 'sse'
    ? new SSEClientTransport(endpoint, { fetch: fetcher, eventSourceInit: { fetch: fetcher } } as any)
    : new StreamableHTTPClientTransport(endpoint, { fetch: fetcher });
  try { await client.connect(connection, { timeout }); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}

/** Whether a remote server asks for OAuth sign-in (HTTP 401) before initialization. */
export async function remoteMcpAuth(transport: RemoteMcpTransport): Promise<'oauth' | 'none'> {
  const response = await publicStreamFetch(new Request(transport.url, transport.type === 'sse'
    ? { headers: { accept: 'text/event-stream' } }
    : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tavya', version: '1' } } }) }));
  await response.body?.cancel().catch(() => {});
  if (response.status === 401) return 'oauth';
  if (response.ok) return 'none';
  throw new Error(`The MCP server answered HTTP ${response.status}`);
}
