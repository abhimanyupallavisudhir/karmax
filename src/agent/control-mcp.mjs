#!/usr/bin/env node
/**
 * Child half of the turn-local control bridge (see `control-bridge.ts` for the
 * full rationale and the rail table).
 *
 * A stdio MCP server that owns no logic at all: it asks the karmax activity that
 * spawned it — over the unix socket named in `KARMAX_CONTROL_SOCKET` — which
 * turn-local control tools exist, advertises exactly those, and forwards every
 * call back over the same socket. The handlers run in the activity, so
 * `confirm_decision`/`resolve_decision`/`create_review_info`/… mutate the turn
 * result exactly as they do on the in-process rails.
 *
 * This exists so harnesses that only accept stdio MCP servers (`codex exec`, any
 * ACP agent such as OpenCode) can reach the Resolve/Confirm gates at all. Before
 * it, a Codex-subscription or OpenCode agent structurally could not produce a
 * verdict even though the prompt advertised the tools.
 *
 * Deliberate choices:
 *   · The low-level `Server` API is used, not `McpServer`, so the parent's JSON
 *     Schemas are forwarded verbatim — no lossy JSON-Schema→zod→JSON-Schema round
 *     trip (that round trip is exactly what once flattened `create_review_info`'s
 *     nested `actions` items to `{}`).
 *   · We NEVER exit during startup. A bare `process.exit(1)` kills the stdio
 *     transport mid-handshake, which CLIs report as the opaque JSON-RPC
 *     `-32000 ConnectionClosed` (the same lesson as `src/mcp/stdio.ts`). If the
 *     socket is unreachable the handshake still completes and individual calls
 *     return a clear error.
 *   · A credential IS carried. `KARMAX_CONTROL_TOKEN` is the per-turn secret the
 *     activity minted next to the socket path, and it goes on every frame. The
 *     socket is same-uid reachable by any other agent on this host, and these
 *     tools are not harmless (`request_spend`, `fill_payment_card`,
 *     `create_sub_task`) — see the security section of `control-bridge.ts`.
 */
import net from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SOCKET = process.env.KARMAX_CONTROL_SOCKET;
const TOKEN = process.env.KARMAX_CONTROL_TOKEN;

/** NDJSON request/response client over the activity's unix socket. */
function connect() {
  return new Promise((resolve, reject) => {
    if (!SOCKET) {
      reject(new Error('KARMAX_CONTROL_SOCKET is not set — karmax did not spawn this bridge'));
      return;
    }
    if (!TOKEN) {
      reject(new Error('KARMAX_CONTROL_TOKEN is not set — karmax did not spawn this bridge'));
      return;
    }
    const pending = new Map();
    let nextId = 1;
    let buffer = '';
    const socket = net.createConnection(SOCKET);
    const fail = (error) => {
      for (const [, entry] of pending) entry.reject(error);
      pending.clear();
      client.dead = error;
    };
    const client = {
      dead: undefined,
      request(body) {
        if (client.dead) return Promise.reject(client.dead);
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          // Every frame is authenticated, `list` included — the parent refuses
          // (and hangs up on) anything else.
          socket.write(`${JSON.stringify({ id, token: TOKEN, ...body })}\n`);
        });
      },
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const entry = pending.get(message?.id);
        if (!entry) continue;
        pending.delete(message.id);
        entry.resolve(message);
      }
    });
    socket.on('error', (error) => { fail(error); reject(error); });
    // The activity closes the socket when the turn ends; any in-flight call is
    // then answered with a real error instead of hanging the harness forever.
    socket.on('close', () => fail(new Error('karmax control bridge closed (the turn ended)')));
    socket.on('connect', () => resolve(client));
  });
}

let connection;
const client = async () => {
  // Cache the CONNECTED client, never a rejected attempt. `connection ??= connect()`
  // stored the rejected promise, so a single transient ECONNREFUSED/ENOENT on the
  // first call poisoned every later call for the whole harness lifetime — and
  // because `tools/list` answers an unreachable bridge with an empty list, the
  // control tools then silently vanished mid-turn with nothing reported.
  connection ??= connect().catch((error) => { connection = undefined; throw error; });
  return connection;
};

async function main() {
  const server = new Server(
    { name: 'karmax_control', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const reply = await (await client()).request({ op: 'list' });
      const tools = reply?.ok && Array.isArray(reply.tools) ? reply.tools : [];
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters ?? { type: 'object', properties: {} },
        })),
      };
    } catch {
      // An unreachable activity means no turn-local tools this turn; an empty
      // list keeps the connection healthy rather than failing the harness boot.
      return { tools: [] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name ?? '';
    try {
      const reply = await (await client()).request({ op: 'call', name, args: request.params?.arguments ?? {} });
      if (reply?.ok) return { content: [{ type: 'text', text: String(reply.text ?? '') }] };
      return { content: [{ type: 'text', text: `error: ${String(reply?.error ?? 'karmax control call failed')}` }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `error: ${String(error?.message ?? error)}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`karmax-control-mcp: ${String(error?.message ?? error)}\n`);
  process.exit(1);
});
