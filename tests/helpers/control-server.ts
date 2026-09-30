import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/** An MCP client connected to an in-process `{ type: 'sdk', instance }` server —
 * the tools the harness sees, and calls as the harness makes them. */
export async function controlClient(server: { instance: { connect(transport: unknown): Promise<void> } }) {
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(theirs);
  const client = new Client({ name: 'test-harness', version: '1.0.0' });
  await client.connect(ours);
  return {
    names: async () => (await client.listTools()).tools.map((t) => t.name),
    tools: async () => (await client.listTools()).tools,
    call: async (name: string, args: Record<string, unknown>) => {
      const result: any = await client.callTool({ name, arguments: args });
      const text = result.content?.[0]?.text ?? '';
      if (result.isError) throw new Error(text);
      return text as string;
    },
    close: () => client.close(),
  };
}
