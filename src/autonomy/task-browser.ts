import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CUSTODY_ENV, custodyProcesses, taskCustodyIds } from '../agent/custody.js';
import { DEFAULT_CDP_PORT } from './cdp-endpoint.js';

/**
 * Which browser a task's credential, card and passkey fills drive (AU-14,
 * AU-32). Never an endpoint the agent names: a loopback URL from the agent
 * could be another task's browser, a person's own Chrome with debugging on, or
 * any local service speaking the protocol.
 *
 * A remote or container world runs one browser per task-isolated world, at the
 * port its launcher is given (`ensureRemoteBrowser`), so in-world fills use
 * that. A local world shares the host with every other local task; there the
 * browser is the Chrome that this task's own running agent launched, found by
 * the custody marker every descendant of that agent inherits (custody.ts).
 * The marked process must itself own the port's listening socket, so naming a
 * port on a command line cannot aim fills at another browser. Processes that
 * share the host user could still forge the marker; this pins the target
 * against mistakes and steering, not against a hostile local agent.
 */
export const WORLD_CDP_URL = `http://127.0.0.1:${DEFAULT_CDP_PORT}`;

const NO_BROWSER = 'this task has no browser of its own open. Open a page with the chrome-devtools browser tools first; '
  + 'fills only reach the browser this task started';

const debuggingPort = (commandLine: string) => Number(/(?:^|\s)--remote-debugging-port=(\d{1,5})(?:\s|$)/.exec(commandLine)?.[1] ?? 0);

/** Loopback-reachable listening sockets on `port` (the kernel's socket inodes):
 * IPv4 on 127.0.0.1 or any address, IPv6 on any address or mapped 127.0.0.1. */
function listeningInodes(port: number): Set<string> {
  const inodes = new Set<string>();
  const reachable = new Set(['0100007F', '00000000', '00000000000000000000000000000000', '0000000000000000FFFF00000100007F']);
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(table, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, hexPort] = fields[1]?.split(':') ?? [];
      if (fields[3] === '0A' && parseInt(hexPort ?? '', 16) === port && reachable.has(address ?? '')) inodes.add(fields[9]!);
    }
  }
  return inodes;
}

/** Does `pid` itself hold the socket listening on `port`? A process that only
 * names a port on its command line could point fills at another browser. */
function ownsPort(pid: number, port: number): boolean {
  if (process.platform === 'linux') {
    const inodes = listeningInodes(port);
    if (!inodes.size) return false;
    let fds: string[] = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { return false; }
    return fds.some((fd) => {
      try { return inodes.has(/^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1] ?? ''); }
      catch { return false; }
    });
  }
  try {
    return execFileSync('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 5000 }).split('\n').includes(String(pid));
  } catch { return false; } // no lsof, or no such socket: unproven
}

/** Browser processes carrying one of `custodyIds` and listening on their
 * debugging port, with that port. */
function markedPorts(custodyIds: string[]): number[] {
  const owned = (pid: number, port: number) => port > 0 && port < 65_536 && ownsPort(pid, port) ? port : 0;
  if (process.platform === 'linux') {
    return [...new Set(custodyIds.flatMap(custodyProcesses))].map((pid) => {
      try { return owned(pid, debuggingPort(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '))); }
      catch { return 0; }
    });
  }
  // BSD/macOS `ps e` appends each (own) process's environment to its command.
  let listing = '';
  try { listing = execFileSync('ps', ['axeww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 }); }
  catch { return []; }
  const marker = new RegExp(`(?:^|\\s)${CUSTODY_ENV}=(\\S+)`);
  return listing.split('\n').map((line) => {
    const chain = marker.exec(line)?.[1]?.split(',') ?? [];
    return chain.some((id) => custodyIds.includes(id)) ? owned(Number(/^\s*(\d+)/.exec(line)?.[1]), debuggingPort(line)) : 0;
  });
}

/** The loopback DevTools endpoint of the browser this local task's agent launched. */
export function localTaskBrowserUrl(taskId: string | undefined): string {
  const custodyIds = taskId ? taskCustodyIds(taskId) : [];
  if (!custodyIds.length) throw new Error(taskId ? `${NO_BROWSER} (no agent of this task is running)` : 'browser fills run in a task\'s own browser; call this from a task');
  const ports = [...new Set(markedPorts(custodyIds).filter((port) => port > 0 && port < 65_536))];
  if (ports.length > 1) throw new Error('this task has more than one browser with a DevTools port open; close all but one');
  if (!ports.length) throw new Error(NO_BROWSER);
  return `http://127.0.0.1:${ports[0]}`;
}
