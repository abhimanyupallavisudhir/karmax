#!/usr/bin/env node

import process from 'node:process';
import { WebSocket } from 'ws';

const [, , command, ...argv] = process.argv;
if (command !== 'attach') usage();

const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const optionNames = new Set(['--url', '--ticket', '--token']);
let taskId;
for (let index = 0; index < argv.length; index++) {
  if (optionNames.has(argv[index])) { index++; continue; }
  if (!argv[index].startsWith('--')) { taskId = argv[index]; break; }
}
const gateway = option('--url') ?? process.env.KARMAX_GATEWAY_URL ?? 'http://127.0.0.1:4505';
const ticket = option('--ticket') ?? process.env.KARMAX_TERMINAL_TICKET;
const token = option('--token') ?? process.env.KARMAX_TOKEN;
if (!taskId || (!ticket && !token)) usage('A one-time --ticket (from the Karmax UI) or KARMAX_TOKEN is required.');

const url = new URL('/ws/terminal', gateway);
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
url.searchParams.set('taskId', taskId);
if (ticket) url.searchParams.set('ticket', ticket);

const ws = new WebSocket(url, ticket ? {} : { headers: { authorization: `Bearer ${token}` } });
let raw = false;
const restore = () => {
  if (raw && process.stdin.isTTY) process.stdin.setRawMode(false);
  raw = false;
};
const resize = () => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }));
};
ws.on('open', () => {
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); raw = true; }
  process.stdin.resume();
  process.stdin.on('data', (data) => ws.send(JSON.stringify({ type: 'input', data: data.toString() })));
  process.stdout.on('resize', resize);
  resize();
});
ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    if (message.type === 'data') process.stdout.write(message.data);
  } catch { /* ignore malformed server frames */ }
});
ws.on('close', (code, reason) => {
  restore();
  process.stdout.off('resize', resize);
  if (code !== 1000 && reason) process.stderr.write(`\ntavya attach: ${reason.toString()}\n`);
  process.exit(code === 1000 || code === 1005 ? 0 : 1);
});
ws.on('error', (error) => { restore(); process.stderr.write(`tavya attach: ${error.message}\n`); });
process.on('SIGINT', () => ws.close());
process.on('SIGTERM', () => ws.close());
process.on('exit', restore);

function usage(error) {
  if (error) process.stderr.write(`${error}\n\n`);
  process.stderr.write('Usage: tavya attach <task-id> --url <tavya-url> --ticket <one-time-ticket>\n');
  process.exit(error ? 1 : 0);
}
