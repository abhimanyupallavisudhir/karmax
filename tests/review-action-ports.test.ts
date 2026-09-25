import { spawn, execFile, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewActionRunner } from '../src/gateway/review-actions.js';
import { reclaimPorts } from '../src/world/reclaim-ports.js';

// Task 364: the agent verified its landing-page server on :4173 and left it
// running. "Live preview" then started a second copy, which died with
// EADDRINUSE; its preview lease was revoked and the tab showed a TLS error.

function fakeRunner(kind: string, remote: boolean) {
  const calls: string[] = [];
  const frames: { data: string; stream?: string }[] = [];
  const world = {
    exec: vi.fn(async (cmd: string, args: string[]) => {
      calls.push(`exec ${cmd} ${args.slice(2).join(' ')}`);
      return { code: 0, stderr: '', stdout: '4173 2414 node scripts/preview-landing.mjs\n' };
    }),
    startProcess: vi.fn(async () => {
      calls.push('start');
      return { onOutput: () => () => {}, onExit: () => () => {}, kill: async () => {} };
    }),
  };
  const store = {
    getTask: async () => ({ projectId: 'project' }), getProject: async () => ({ id: 'project', organizationId: 'org' }),
    createExecution: async () => {}, setExecutionRunning: async () => {}, finishExecution: async () => {},
    appendExecutionFrame: async (_id: string, data: string, stream?: string) => { frames.push({ data, stream }); },
    createPreviewLease: async (lease: any) => lease, revokePreviewLease: async () => undefined,
    heartbeatExecution: async () => {}, execution: async () => ({}),
  };
  const worlds = { get: () => ({ capabilities: { remote } }), open: async () => world };
  const runner = new ReviewActionRunner(worlds as any, store as any);
  const start = (server: boolean) => runner.start({ taskId: 'task', world: { id: 'world', kind } as any,
    label: 'Live preview', command: 'npm run preview:landing', server, openUrls: ['http://localhost:4173/'] });
  return { calls, frames, world, runner, start };
}

describe('review server ports', () => {
  it('stops a stale listener on its declared port before starting in an isolated world', async () => {
    const { calls, frames, runner, start } = fakeRunner('e2b', true);
    try {
      const rec = await start(true);
      expect(calls).toEqual(['exec sh reclaim-ports 4173', 'start']);
      const notice = 'Stopped an earlier process on port 4173: node scripts/preview-landing.mjs\n';
      expect(frames).toEqual([{ data: notice, stream: 'system' }]);
      expect(rec.output).toBe(notice);
    } finally { await runner.stopAll(); }
  });

  it('never stops processes for one-shot commands or on a host shared with other work', async () => {
    for (const [kind, remote, server] of [['e2b', true, false], ['worktree', false, true]] as const) {
      const { calls, runner, start } = fakeRunner(kind, remote);
      try {
        await start(server);
        expect(calls).toEqual(['start']);
      } finally { await runner.stopAll(); }
    }
  });
});

const run = promisify(execFile);
const local = { exec: async (cmd: string, args: string[]) => {
  const { stdout, stderr } = await run(cmd, args);
  return { stdout, stderr, code: 0 };
} };
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); });

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listener(port: number, ignoreTerm = false): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    require('node:http').createServer((q, r) => r.end('stale')).listen(${port}, () => console.log('ready'));`],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise((resolve) => child.stdout!.once('data', resolve));
  return child;
}

const exited = (child: ChildProcess) => new Promise<NodeJS.Signals | null>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
  else child.once('exit', (_code, signal) => resolve(signal));
});

describe.skipIf(process.platform !== 'linux')('reclaim-ports.sh against real processes', () => {
  it('frees a port held by a stale server (IPv6 dual-stack) and reports what it stopped', async () => {
    const port = await freePort();
    const stale = await listener(port);
    const stopped = await reclaimPorts(local, [port]);
    expect(stopped).toEqual([{ port, pid: stale.pid, command: expect.stringContaining('createServer') }]);
    expect(await exited(stale)).toBe('SIGTERM');
    const next = net.createServer();
    await new Promise<void>((resolve, reject) => { next.once('error', reject); next.listen(port, resolve); });
    await new Promise((resolve) => next.close(resolve));
  });

  it('escalates to SIGKILL when the listener ignores SIGTERM, and leaves other ports alone', async () => {
    const [port, other] = [await freePort(), await freePort()];
    const stubborn = await listener(port, true);
    const bystander = await listener(other);
    expect((await reclaimPorts(local, [port])).map((entry) => entry.pid)).toEqual([stubborn.pid]);
    expect(await exited(stubborn)).toBe('SIGKILL');
    expect(bystander.exitCode).toBeNull();
    expect(bystander.signalCode).toBeNull();
    expect(await reclaimPorts(local, [await freePort()])).toEqual([]);
  }, 20_000);
});
