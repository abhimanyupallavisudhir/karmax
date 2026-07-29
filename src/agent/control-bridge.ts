import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SDK_CONTROL_TOOL_SCHEMAS, type ToolSchema } from './tools.js';

/**
 * Turn-local control-tool bridge (SPEC §5.2 gates).
 *
 * The ten `SDK_CONTROL_TOOL_NAMES` tools (`resolve_decision`, `confirm_decision`,
 * `create_review_info`, `signal_completion`, `raise_to_parent`, …) are
 * **turn-local**: they mutate the `AdapterTurn` result of the activity that is
 * running right now, so — unlike every durable platform operation — they cannot
 * be served by the gateway-backed `karmax` stdio MCP. Each rail must host them
 * itself, and the mechanism differs by rail:
 *
 *   rail                     mechanism                              where
 *   ─────────────────────────────────────────────────────────────────────────
 *   Claude Messages API      function tools in the tool-use loop    claude.ts
 *   Claude Agent SDK         in-process SDK MCP `karmax_control`    claude.ts
 *   Codex Responses API      function tools in the tool-use loop    codex.ts
 *   Codex app-server         `dynamicTools` + `item/tool/call`      codex.ts
 *   Codex exec ────┐
 *   ACP (OpenCode) ┴─────────  THIS BRIDGE (stdio MCP over a socket)
 *
 * The last two rails run the harness as a subprocess that owns its own model
 * loop; the only tool surface they accept is *stdio MCP servers they spawn
 * themselves*. Nothing they spawn can see this activity's in-memory context, so
 * the tools have to travel over IPC:
 *
 *   parent (this activity)                    child (spawned by the harness)
 *   ┌───────────────────────┐   unix socket   ┌────────────────────────────┐
 *   │ startControlBridge()  │◄────────────────│ control-mcp.mjs (stdio MCP)│
 *   │  · tool schemas       │  NDJSON RPC     │  · advertises the schemas  │
 *   │  · platform handlers  │                 │  · forwards every call     │
 *   └───────────────────────┘                 └────────────────────────────┘
 *
 * Both halves are driven by the SAME `platformToolHandlers()` map the in-process
 * rails use, so behaviour is identical across providers by construction — there
 * is no second implementation to drift.
 *
 * Security posture: this socket is authenticated, and it has to be.
 *
 * An earlier version of this comment claimed these tools "carry no durable
 * authority and no credential — they can only mutate the current turn's result"
 * and used that to justify carrying no token at all. That was wrong, and it is
 * why the hole below existed. Read `SDK_CONTROL_TOOL_NAMES` in `tools.ts`: at
 * least three of the ten reach well past this turn's result —
 *
 *   · `request_spend`      allocates real budget against the account,
 *   · `fill_payment_card`  types a real card PAN/CVC into a browser over CDP,
 *   · `create_sub_task`    creates a durable task on the list.
 *
 * Nor do the file permissions isolate anything that matters. The socket sits in
 * a 0700 `mkdtemp` directory and is chmod 0600, which excludes other **unix
 * users** — but every karmax agent runs as the SAME uid on the host (worktree
 * and container worlds both spawn the `codex exec`/ACP harness host-side). So
 * agent A's ordinary `bash` tool can list `/tmp`, glob `kx-ctl-*`, connect to
 * agent B's live bridge and speak this NDJSON protocol at it — driving B's
 * `confirm_decision`, `request_spend` or `fill_payment_card`. Mode bits are not
 * a boundary between peers who share a uid.
 *
 * What makes this a genuinely per-turn PRIVATE channel is the token: 32 random
 * bytes minted when the bridge starts, handed to the child alongside the socket
 * path (`KARMAX_CONTROL_TOKEN`, same env channel as `KARMAX_CONTROL_SOCKET`) and
 * required on EVERY frame — `list` as much as `call`, so an unauthorized peer
 * cannot even enumerate the tool surface. The comparison is constant-time with a
 * length guard, and a rejection never echoes the expected value. Knowing the
 * socket path is therefore not enough; you must have been given the token, and
 * only the harness this turn spawned was.
 *
 * The lifetime guarantee still holds on top of that: `close()` destroys every
 * connection and removes the directory in the adapter's `finally`, so the token
 * and its listener both die with the turn.
 *
 * What this does NOT claim (the previous comment's mistake was overclaiming):
 * the token rides the child's environment, and a same-uid peer can read
 * `/proc/<pid>/environ` of a running harness. Same-uid is not a security
 * boundary in the kernel's eyes, and the honest fix for that is per-agent uids
 * or a real sandbox. The token closes the *enumerable* hole — an idle
 * `ls /tmp` + connect is no longer enough — which is the difference between a
 * one-line attack any agent can stumble into and one that requires targeting a
 * specific live pid.
 *
 * Windows has no unix-domain sockets in the POSIX sense, so `available()` is
 * false there and those two rails behave as before. karmax is not supported on
 * Windows anyway (`bash -lc` worlds, systemd Temporal units, node:sqlite), so
 * this is a documented floor rather than a live gap.
 */

export const CONTROL_SOCKET_ENV = 'KARMAX_CONTROL_SOCKET';
/** Sibling of `CONTROL_SOCKET_ENV`: the per-turn bearer token every frame needs.
 *  Travels the same env channel, so any rail that already plumbs the socket path
 *  plumbs this too. */
export const CONTROL_TOKEN_ENV = 'KARMAX_CONTROL_TOKEN';
/** The MCP server name the harness sees. Deliberately distinct from `karmax`
 *  (the durable gateway bridge) — a shared name let the two shadow each other. */
export const CONTROL_SERVER_NAME = 'karmax_control';

export interface ControlBridge {
  /** Path to pass to the child as `KARMAX_CONTROL_SOCKET`. */
  socketPath: string;
  /** Per-turn secret to pass as `KARMAX_CONTROL_TOKEN`. Required on every frame;
   *  the socket path alone authorizes nothing. */
  token: string;
  /** Absolute path of the stdio MCP entrypoint the child should run under node. */
  entry: string;
  /** The tools actually served (schemas whose handler exists in this turn). */
  tools: ToolSchema[];
  close(): void;
}

/** Unix-domain sockets only; on Windows the rails keep their previous behaviour. */
export function controlBridgeAvailable(): boolean {
  return process.platform !== 'win32';
}

/** Absolute path to the child-side stdio MCP script. */
export function controlMcpEntry(): string {
  return fileURLToPath(new URL('./control-mcp.mjs', import.meta.url));
}

/** The control tools this turn can actually serve — a schema is only advertised
 *  when the bound handler map really has it, so a partially-wired context can
 *  never show the model a tool that would fail. */
export function controlBridgeTools(
  handlers: Record<string, (args: any) => Promise<string>>,
  schemas: ToolSchema[] = SDK_CONTROL_TOOL_SCHEMAS,
): ToolSchema[] {
  return schemas.filter((schema) => typeof handlers[schema.name] === 'function');
}

/**
 * The stdio-MCP server entry a harness needs in order to reach the bridge.
 * Shaped like every other karmax MCP spec (`command`/`args`/`env`) so it drops
 * straight into ACP's `session/new` `mcpServers` and Codex's `mcp_servers.*`
 * config overrides.
 */
export function controlMcpServerSpec(bridge: ControlBridge): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: [bridge.entry],
    env: { [CONTROL_SOCKET_ENV]: bridge.socketPath, [CONTROL_TOKEN_ENV]: bridge.token },
  };
}

/**
 * Start the parent half. `handlers` is the same `platformToolHandlers()` map the
 * in-process rails use. Returns `undefined` when the bridge cannot run (Windows)
 * or has nothing to serve — callers then simply omit the MCP server.
 */
export async function startControlBridge(
  handlers: Record<string, (args: any) => Promise<string>>,
  schemas: ToolSchema[] = SDK_CONTROL_TOOL_SCHEMAS,
): Promise<ControlBridge | undefined> {
  if (!controlBridgeAvailable()) return undefined;
  const available = controlBridgeTools(handlers, schemas);
  if (!available.length) return undefined;

  // Keep the path SHORT: a unix socket path is capped near 104 bytes and macOS
  // temp dirs (/var/folders/…/T/) already eat half of that.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-ctl-'));
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  const socketPath = path.join(dir, `${crypto.randomBytes(4).toString('hex')}.sock`);
  // The actual access control (see the header). Same-uid peers can reach the
  // socket; only the child we hand this to can use it.
  const token = crypto.randomBytes(32).toString('hex');

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void handleLine(line, socket, handlers, available, token);
      }
    });
  });
  server.on('error', () => { /* a dead listener must never crash the turn */ });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {
    /* best effort */
  }

  let closed = false;
  return {
    socketPath,
    token,
    entry: controlMcpEntry(),
    tools: available,
    close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
      sockets.clear();
      try { server.close(); } catch { /* already closed */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Constant-time bearer check. Length is compared first because
 *  `timingSafeEqual` throws on a length mismatch — and an unequal length is
 *  already public information (the token's length is fixed), so leaking it costs
 *  nothing while a byte-by-byte `===` would leak the prefix. */
function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handleLine(
  line: string,
  socket: net.Socket,
  handlers: Record<string, (args: any) => Promise<string>>,
  schemas: ToolSchema[],
  token: string,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: any;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return; // a malformed frame must never take down a turn
  }
  const reply = (body: Record<string, unknown>) => {
    try { socket.write(`${JSON.stringify({ id: request?.id, ...body })}\n`); }
    catch { /* the child went away mid-turn */ }
  };
  // Authenticate BEFORE looking at `op`: an unauthorized peer must not be able to
  // enumerate the tool surface with `list` either. The error names no expected
  // value and does not distinguish "absent" from "wrong", and the connection is
  // dropped so a peer cannot sit on the socket grinding guesses.
  if (!tokenMatches(request?.token, token)) {
    reply({ ok: false, error: 'unauthorized: this control socket is private to one turn' });
    socket.end();
    return;
  }
  if (request?.op === 'list') {
    reply({ ok: true, tools: schemas });
    return;
  }
  if (request?.op !== 'call') {
    reply({ ok: false, error: `unknown control op ${String(request?.op)}` });
    return;
  }
  // Only the advertised turn-local controls are reachable. The handler map also
  // holds gateway-backed tools (and bash/read_file/write_file); those belong to
  // the durable `karmax` MCP and must not gain a second, token-less door.
  const name = String(request.name ?? '');
  const handler = schemas.some((schema) => schema.name === name) ? handlers[name] : undefined;
  if (!handler) {
    reply({ ok: false, error: `unknown control tool ${name}` });
    return;
  }
  try {
    reply({ ok: true, text: await handler(request.args ?? {}) });
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
