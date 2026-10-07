#!/usr/bin/env node
/**
 * Sandbox half of a remote ACP agent (OpenCode in an E2B/Daytona world).
 *
 * The control plane drives the agent through ONE provider PTY. This relay is
 * the process that PTY runs: it starts the ACP harness on real pipes and
 * multiplexes a second channel, the turn-local control tools, over the same
 * stream, so the tools reach the activity without any connection from the
 * sandbox back to the control plane (see `remote-acp.ts`).
 *
 *   control plane (activity)          PTY            sandbox
 *   ┌─────────────────────────┐  ACP lines      ┌─────────────┐  pipes  ┌──────────┐
 *   │ AcpAdapter + PTY mux    │◄═══════════════►│ acp-relay   │◄═══════►│ opencode │
 *   │ control-bridge handler  │  \x1eKXC frames │  unix socket│         │   acp    │
 *   └─────────────────────────┘                 └──────▲──────┘         └────┬─────┘
 *                                                      │ NDJSON              │ stdio
 *                                                      └──── control-mcp.mjs ◄┘
 *
 * Framing. ACP is newline-delimited JSON, and JSON never contains a raw 0x1E
 * byte (it escapes control characters), so a line that starts with 0x1E is
 * unambiguously ours: `\x1eKXC {"c":<connection>,"m":"<NDJSON line>"}`.
 * Both directions are line-buffered, so a frame never lands inside an ACP
 * message. Everything else passes through untouched. A 0x04 byte from the
 * control plane ends the harness's stdin (the PTY has no other EOF).
 *
 * The relay holds no credential and authorizes nothing: every control frame
 * still carries the per-turn token, which the activity checks.
 *
 * Usage: node acp-relay.mjs <socket> <harness> [args...]
 */
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';

const FRAME = Buffer.from('\x1eKXC ');
const [socketPath, command, ...args] = process.argv.slice(2);
const traceFile = process.env.KARMAX_RELAY_TRACE;
const trace = (phase, extra = {}) => {
  if (!traceFile) return;
  try { fs.appendFileSync(traceFile, `${JSON.stringify({ phase, pid: process.pid, at: Math.floor(Date.now() / 1000), ...extra })}\n`); } catch {}
};
trace('relay-started');

/** Whole lines only: a frame must never split an ACP message. */
const out = (line) => process.stdout.write(line);
const frame = (body) => out(Buffer.concat([FRAME, Buffer.from(JSON.stringify(body)), Buffer.from('\n')]));

const connections = new Map();
let nextConnection = 1;
let server;
if (socketPath) {
  try { fs.rmSync(socketPath, { force: true }); } catch {}
  const previousMask = process.umask(0o077);
  server = net.createServer((socket) => {
    const id = nextConnection++;
    connections.set(id, socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) frame({ c: id, m: line });
      }
    });
    const gone = () => { if (connections.delete(id)) frame({ c: id, closed: true }); };
    socket.on('close', gone);
    socket.on('error', () => socket.destroy());
  });
  server.on('error', (error) => trace('socket-error', { code: error.code }));
  server.listen(socketPath, () => { process.umask(previousMask); trace('socket-ready'); });
}

const child = spawn(command, args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
child.on('spawn', () => trace('child-spawned', { child: child.pid }));
child.on('error', (error) => { trace('child-error', { code: error.code }); console.error(error); process.exitCode = 127; });
child.stdin.on('error', () => {});

// Harness → control plane, whole lines.
let pendingOut = Buffer.alloc(0);
child.stdout.on('data', (chunk) => {
  const data = pendingOut.length ? Buffer.concat([pendingOut, chunk]) : chunk;
  const end = data.lastIndexOf(10);
  if (end < 0) { pendingOut = data; return; }
  out(data.subarray(0, end + 1));
  pendingOut = Buffer.from(data.subarray(end + 1));
});
child.stdout.on('end', () => { if (pendingOut.length) out(Buffer.concat([pendingOut, Buffer.from('\n')])); pendingOut = Buffer.alloc(0); });

// Control plane → harness or a control connection.
let pendingIn = Buffer.alloc(0);
let received = false;
let inputEnded = false;
const endInput = () => {
  if (inputEnded) return;
  inputEnded = true;
  trace('stdin-ended');
  child.stdin.end();
};
const route = (line) => {
  if (line.subarray(0, FRAME.length).equals(FRAME)) {
    let body;
    try { body = JSON.parse(line.subarray(FRAME.length).toString('utf8')); } catch { return; }
    const socket = connections.get(body?.c);
    if (!socket) return;
    if (typeof body.m === 'string') socket.write(`${body.m}\n`);
    if (body.close) socket.end();
    return;
  }
  if (!inputEnded) child.stdin.write(Buffer.concat([line, Buffer.from('\n')]));
};
process.stdin.on('data', (chunk) => {
  if (!received) { received = true; trace('stdin-received'); }
  let data = pendingIn.length ? Buffer.concat([pendingIn, chunk]) : chunk;
  const eof = data.indexOf(4);
  if (eof >= 0) data = data.subarray(0, eof);
  let start = 0;
  for (let index = data.indexOf(10, start); index >= 0; index = data.indexOf(10, start)) {
    route(data.subarray(start, index));
    start = index + 1;
  }
  pendingIn = Buffer.from(data.subarray(start));
  if (eof >= 0) {
    if (pendingIn.length) route(pendingIn);
    pendingIn = Buffer.alloc(0);
    endInput();
  }
});
process.stdin.on('end', endInput);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  trace('child-exited', { exitCode: code });
  for (const socket of connections.values()) socket.destroy();
  try { server?.close(); } catch {}
  try { if (socketPath) fs.rmSync(socketPath, { force: true }); } catch {}
  const finish = () => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); };
  // Let the last protocol lines reach the PTY before the relay exits.
  if (process.stdout.writableLength) process.stdout.once('drain', finish); else finish();
});
