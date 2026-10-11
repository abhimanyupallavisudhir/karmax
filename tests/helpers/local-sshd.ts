import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateSshKeyPair, type SshEndpoint } from '../../src/world/vm/ssh.js';

/**
 * A real OpenSSH server, run unprivileged on a loopback port, standing in for
 * a VM: the VM world core is tested against real SSH, SFTP, PTYs (script(1))
 * and port forwarding, never a mock of them. Its "machine" is this one, as the
 * user running the tests. Self-skips where no sshd is installed.
 */
export interface LocalSshd {
  endpoint: SshEndpoint;
  /** The VM user's home (a temp directory standing in for the volume). */
  home: string;
  /** The authorized client key, for drivers that install their own. */
  hostKey: { privateKey: string; publicKey: string };
  clientKey: { privateKey: string; publicKey: string };
  /** Reconfigure which client key sshd accepts (a new world's key). */
  authorize(publicKey: string): void;
  stop(): Promise<void>;
}

export const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((candidate) => fs.existsSync(candidate));
export const sshdAvailable = Boolean(SSHD) && spawnSync('script', ['--version']).status === 0;

export async function startLocalSshd(options: { hostKey?: { privateKey: string; publicKey: string };
  clientKey?: { privateKey: string; publicKey: string } } = {}): Promise<LocalSshd> {
  if (!SSHD) throw new Error('no sshd on this machine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-sshd-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const hostKey = options.hostKey ?? generateSshKeyPair('host');
  const clientKey = options.clientKey ?? generateSshKeyPair('client');
  fs.writeFileSync(path.join(dir, 'host'), hostKey.privateKey, { mode: 0o600 });
  const authorized = path.join(dir, 'authorized_keys');
  const authorize = (publicKey: string) => fs.writeFileSync(authorized, `${publicKey}\n`, { mode: 0o600 });
  authorize(clientKey.publicKey);
  const port = await freePort();
  const config = path.join(dir, 'sshd_config');
  fs.writeFileSync(config, [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${path.join(dir, 'host')}`,
    `AuthorizedKeysFile ${authorized}`, `PidFile ${path.join(dir, 'sshd.pid')}`,
    'UsePAM no', 'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'MaxSessions 256', 'Subsystem sftp internal-sftp', 'AllowTcpForwarding yes', '',
  ].join('\n'));
  const child: ChildProcess = spawn(SSHD, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr?.on('data', (chunk) => { log += String(chunk); });
  await waitForPort(port, () => log);
  return {
    endpoint: { host: '127.0.0.1', port, hostKey: hostKey.publicKey, username: os.userInfo().username, privateKey: clientKey.privateKey },
    home, hostKey, clientKey, authorize,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => { if (child.exitCode !== null) resolve(undefined); else child.once('exit', resolve); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForPort(port: number, log: () => string): Promise<void> {
  const until = Date.now() + 10_000;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    if (open) return;
    if (Date.now() > until) throw new Error(`sshd did not start: ${log()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
