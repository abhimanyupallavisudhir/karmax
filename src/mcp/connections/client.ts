import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AgentMcpServer } from '../../contrib/manifests.js';
import type { World } from '../../world/types.js';
import { RemoteSpawnedProcess, isRemoteAgentWorld } from '../../agent/remote-process.js';
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

/** The shared host only parses bounded MCP data. Custom executables are spawned
 * inside World; self-hosted local worlds retain their existing execution model. */
export async function connectWorldMcp(world: World, server: AgentMcpServer, signal?: AbortSignal) {
  if (process.env.KARMAX_DEPLOYMENT === 'hosted' && !isRemoteAgentWorld(world)) throw new Error('Hosted MCP requires a remote world');
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...server.env };
  const child = isRemoteAgentWorld(world)
    ? new RemoteSpawnedProcess(world, `stty raw -echo; printf '\\036KARMAX_AGENT_READY\\036'; exec ${[server.command, ...(server.args ?? [])].map(quote).join(' ')} 2>/dev/null`, world.handle.root, server.env ?? {}, signal)
    : spawn(server.command, server.args ?? [], { cwd: world.handle.root, env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buffered = ''; let bufferedBytes = 0; const decoder = new StringDecoder('utf8');
  const transport: Transport = {
    async start() {
      child.on('error', (e) => transport.onerror?.(e));
      child.on('close', () => transport.onclose?.());
      child.stdin?.on('error', (error) => { child.kill(); transport.onerror?.(error); });
      child.stdout?.on('error', (error) => { child.kill(); transport.onerror?.(error); });
      child.stdout!.on('data', (chunk: Buffer) => {
        const decoded = decoder.write(chunk); buffered += decoded; bufferedBytes += Buffer.byteLength(decoded);
        try {
          let end: number;
          while ((end = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, end); const bytes = Buffer.byteLength(line);
            if (bytes > 2 * 1024 * 1024) throw new Error('MCP response exceeds 2 MiB');
            buffered = buffered.slice(end + 1); bufferedBytes -= bytes + 1;
            if (line.trim()) transport.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
          }
          if (bufferedBytes > 2 * 1024 * 1024) throw new Error('MCP response exceeds 2 MiB');
        } catch { child.kill(); transport.onerror?.(new Error('Invalid or oversized MCP response')); }

      });
    },
    async send(message) { const data = serializeMessage(message); if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error('MCP request exceeds 2 MiB'); child.stdin!.write(data); },
    async close() { signal?.removeEventListener('abort', abort); child.kill(); },
  };
  const abort = () => { void transport.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  // The sandbox relay validates server-provided output schemas. Never compile
  // arbitrary JSON Schema/regular expressions in Tavya's shared process.
  const client = new Client({ name: 'tavya', version: '1' }, { capabilities: {},
    jsonSchemaValidator: { getValidator<T>() { return (data: unknown): import('@modelcontextprotocol/sdk/validation/types.js').JsonSchemaValidatorResult<T> => ({ valid: true, data: data as T, errorMessage: undefined }); } },
  });
  try { await client.connect(transport, { timeout: 60_000 }); return client; }
  catch { await transport.close(); throw new Error(`MCP connection ${server.name} could not start. Check its settings and credentials.`); }
}
export async function apiMcpTools(world: World, servers: AgentMcpServer[] = [], signal?: AbortSignal) {
  const clients: Client[] = []; const tools: { name: string; description: string; parameters: any }[] = [];
  const handlers: Record<string, (input: any) => Promise<any>> = {};
  let catalogBytes = 0;
  const close = async () => { await Promise.allSettled(clients.map((c) => c.close())); };
  try {
    for (const server of servers) {
      const client = await connectWorldMcp(world, server, signal); clients.push(client);
      const capabilities = client.getServerCapabilities();
      const protocolTool = (operation: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: any) => Promise<any>) => {
        const name = `mcp_${crypto.createHash('sha256').update(server.name + '\0protocol:' + operation).digest('hex').slice(0, 24)}`;
        tools.push({ name, description: `${server.name}: ${description}`, parameters: { type: 'object', properties, required } });
        handlers[name] = run;
      };
      if (capabilities?.resources) {
        protocolTool('resources/list', 'List resources', { cursor: { type: 'string' } }, [], (args) => client.listResources(args));
        protocolTool('resources/templates/list', 'List resource templates', { cursor: { type: 'string' } }, [], (args) => client.listResourceTemplates(args));
        protocolTool('resources/read', 'Read a resource by URI', { uri: { type: 'string' } }, ['uri'], (args) => client.readResource(args));
      }
      if (capabilities?.prompts) {
        protocolTool('prompts/list', 'List prompts', { cursor: { type: 'string' } }, [], (args) => client.listPrompts(args));
        protocolTool('prompts/get', 'Get a prompt', { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: { type: 'string' } } }, ['name'], (args) => client.getPrompt(args));
      }
      if (tools.length > 200) throw new Error('Too many MCP tools; select fewer connections');
      if (!capabilities?.tools) continue;
      let cursor: string | undefined; let pages = 0;
      do {
        if (++pages > 10) throw new Error('MCP tool catalog has too many pages');
        const page = await client.listTools(cursor ? { cursor } : undefined);
        catalogBytes += Buffer.byteLength(JSON.stringify(page));
        if (catalogBytes > 1024 * 1024) throw new Error('Selected MCP tool descriptions exceed 1 MiB; select fewer connections');
        for (const tool of page.tools) {
          if (tools.length >= 200) throw new Error('Selected MCP connections expose more than 200 tools; select fewer connections');
          const name = `mcp_${crypto.createHash('sha256').update(server.name + '\0' + tool.name).digest('hex').slice(0, 24)}`;
          if (handlers[name]) throw new Error('MCP server returned duplicate tool names');
          tools.push({ name, description: `${server.name}: ${tool.name}\n${tool.description ?? ''}`.slice(0, 8000), parameters: tool.inputSchema });
          handlers[name] = (args) => client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: 60_000 });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return { tools, handlers, close };
  } catch (e) { await close(); throw e; }
}
