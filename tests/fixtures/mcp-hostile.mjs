// Dependency-free wire fixture, also runnable inside Docker/cloud sandboxes.
import fs from 'node:fs';
import readline from 'node:readline';
const mode = process.env.FIXTURE_MODE || 'normal';
if (mode === 'stubborn') process.on('SIGTERM', () => {});
if (process.env.FIXTURE_PID_FILE) fs.writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const tool = { name: 'echo', description: 'Fixture echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line); const { id, method } = request;
  if (id === undefined) return;
  if (method === 'initialize') return send(id, { protocolVersion: '2024-11-05', serverInfo: { name: 'hostile-fixture', version: '1' }, capabilities: { tools: {}, resources: {}, prompts: {} } });
  if (method === 'tools/list') {
    if (mode === 'oversize') return process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
    if (mode === 'unicode') return send(id, { tools: [{ ...tool, description: 'é'.repeat(1200 * 1024) }] });
    if (mode === 'invalid') return process.stdout.write('{invalid-json}\n');
    if (mode === 'crash') return process.exit(1);
    if (mode === 'hang') return;
    if (mode === 'many') return send(id, { tools: Array.from({ length: 201 }, (_, n) => ({ ...tool, name: `tool_${n}` })) });
    if (mode === 'duplicate') return send(id, { tools: [tool, tool] });
    if (mode === 'pages') return send(id, { tools: [], nextCursor: 'forever' });
    return send(id, { tools: [tool] });
  }
  if (method === 'tools/call') return send(id, { content: [{ type: 'text', text: JSON.stringify({ text: request.params.arguments?.text, cwd: process.cwd(), secret: process.env.FIXTURE_SECRET, platform: process.env.KARMAX_TOKEN ?? null }) }] });
  if (method === 'resources/list') return send(id, { resources: [{ uri: 'fixture://example', name: 'Example' }] });
  if (method === 'resources/templates/list') return send(id, { resourceTemplates: [] });
  if (method === 'resources/read') return send(id, { contents: [{ uri: 'fixture://example', text: 'resource text' }] });
  if (method === 'prompts/list') return send(id, { prompts: [{ name: 'greet', description: 'Greeting' }] });
  if (method === 'prompts/get') return send(id, { messages: [{ role: 'user', content: { type: 'text', text: 'Hello from MCP' } }] });
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\n');
});
