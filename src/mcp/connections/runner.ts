/** Runs ONLY in the task execution environment. Never import into the worker. */
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { publicStreamFetch } from './http.js';

function currentConfig() {
  const value = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8'));
  if (value.revoked || !Number.isFinite(value.leaseExpiresAt) || value.leaseExpiresAt < Date.now()) throw new Error('Connection lease ended');
  return value;
}
const config = currentConfig();
const authenticatedFetch: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).origin !== new URL(config.transport.url).origin) throw new Error('MCP endpoint changed origin');
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(currentConfig().secrets ?? {})) headers.set(name, String(value));
  return publicStreamFetch(new Request(request, { headers }));
};
const client = new Client({ name: 'tavya-connection', version: '1' }, { capabilities: {} });
const cleanEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp',
  ...(config.transport.env ?? {}), ...(config.secrets ?? {}) };
const transport = config.transport.type === 'stdio'
  ? new StdioClientTransport({ command: config.transport.command, args: config.transport.args.map((arg: string) => arg.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_: string, key: string) => { if (!(key in config.secrets)) throw new Error('Missing argument secret'); return config.secrets[key]; })), env: cleanEnv, stderr: 'ignore' })
  : config.transport.type === 'sse'
    ? new SSEClientTransport(new URL(config.transport.url), { fetch: authenticatedFetch, eventSourceInit: { fetch: authenticatedFetch } } as any)
    : new StreamableHTTPClientTransport(new URL(config.transport.url), { fetch: authenticatedFetch });
let inflight = 0;
async function bounded<T>(run: () => Promise<T>): Promise<T> {
  if (inflight >= 8) throw new Error('Connection is busy; retry shortly');
  inflight++;
  try {
    const value = await run();
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw new Error('MCP response exceeds 2 MiB');
    return value;
  } finally { inflight--; }
}
const startup = setTimeout(() => process.exit(1), 60_000);
try { await client.connect(transport); } catch { console.error('MCP connection failed. Check the connection settings and credentials.'); process.exit(1); }
clearTimeout(startup);
const caps = client.getServerCapabilities();
const server = new Server({ name: 'tavya-connection', version: '1' }, { capabilities: {
  ...(caps?.tools ? { tools: {} } : {}), ...(caps?.resources ? { resources: {} } : {}), ...(caps?.prompts ? { prompts: {} } : {}),
} });
if (caps?.tools) server.setRequestHandler(ListToolsRequestSchema, (r) => bounded(() => client.listTools(r.params)));
if (caps?.tools) server.setRequestHandler(CallToolRequestSchema, (r) => bounded(() => client.callTool(r.params, undefined, { timeout: 60_000 })));
if (caps?.resources) server.setRequestHandler(ListResourcesRequestSchema, (r) => bounded(() => client.listResources(r.params)));
if (caps?.resources) server.setRequestHandler(ReadResourceRequestSchema, (r) => bounded(() => client.readResource(r.params)));
if (caps?.resources) server.setRequestHandler(ListResourceTemplatesRequestSchema, (r) => bounded(() => client.listResourceTemplates(r.params)));
if (caps?.prompts) server.setRequestHandler(ListPromptsRequestSchema, (r) => bounded(() => client.listPrompts(r.params)));
if (caps?.prompts) server.setRequestHandler(GetPromptRequestSchema, (r) => bounded(() => client.getPrompt(r.params)));
await server.connect(new StdioServerTransport());
let closing = false;
async function close() { if (closing) return; closing = true; await client.close().catch(() => {}); await server.close().catch(() => {}); process.exit(); }
process.stdin.on('end', close);
process.on('SIGTERM', close); process.on('SIGINT', close);

const leaseCheck = setInterval(() => { try { currentConfig(); } catch { void close(); } }, 2000);
leaseCheck.unref();
