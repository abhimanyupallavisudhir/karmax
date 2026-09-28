// A browser MCP server as the API-key rails start it: it launches "Chrome"
// (a process listening on its --remote-debugging-port), then serves MCP.
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const port = Number(process.argv[2]);
spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000)`,
  '--', `--remote-debugging-port=${port}`], { stdio: 'ignore' });
const server = new Server({ name: 'fake-browser', version: '1' }, { capabilities: {} });
await server.connect(new StdioServerTransport());
