#!/usr/bin/env node
// Reproduces "connect to karmax MCP from a CLI agent" — the case that used to
// fail with `Failed to reconnect to karmax: -32000`. Spawns the stdio bridge
// EXACTLY as a config-home `.claude.json` does (only KARMAX_GATEWAY_URL, NO
// KARMAX_TOKEN), drives a full MCP handshake, and checks the process stays alive.
//
//   node scripts/verify-karmax-mcp.mjs            # uses http://localhost:4505
//   KARMAX_GATEWAY_URL=http://host:port node scripts/verify-karmax-mcp.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'mcp', 'stdio.ts');
const gateway = process.env.KARMAX_GATEWAY_URL || 'http://localhost:4505';

const env = { ...process.env, KARMAX_GATEWAY_URL: gateway };
delete env.KARMAX_TOKEN; // the manually-launched-CLI case

// Match platformMcpSpec(): launch one Node process through karmax's own loader,
// without npx/shell/tsx wrapper processes resolved from the caller's worktree.
const loader = import.meta.resolve('tsx');
const child = spawn(process.execPath, ['--import', loader, entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
let buf = '';
const responses = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.id != null) responses.set(o.id, o); } catch { /* ignore */ }
  }
});
child.stderr.on('data', (d) => process.stderr.write('bridge stderr: ' + d));

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } });
setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 300);
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 500);

setTimeout(() => {
  const init = responses.get(1);
  const tools = responses.get(2)?.result?.tools ?? [];
  const alive = child.exitCode === null;
  child.kill();
  const ok = alive && init?.result?.serverInfo?.name === 'karmax-platform' && tools.length > 0;
  console.log(`handshake:     ${init ? 'ok (' + init.result.serverInfo.name + ')' : 'FAILED'}`);
  console.log(`tools listed:  ${tools.length} (${tools.map((t) => t.name).join(', ')})`);
  console.log(`process alive: ${alive ? 'yes' : 'no — exited ' + child.exitCode}`);
  console.log(ok ? '\nPASS: karmax MCP connects from a CLI agent (no -32000).' : '\nFAIL: bridge did not stay connected.');
  process.exit(ok ? 0 : 1);
}, 2500);
