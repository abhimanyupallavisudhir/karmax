import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const DEFAULT_SERVER = 'https://tavya.io';

export interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent for tokens that do not expire soon (personal tokens). */
  expiresAt?: number;
  clientId?: string;
}

interface HostsFile {
  default?: string;
  hosts: Record<string, { user?: { id?: string; name?: string; email?: string }; keychain?: boolean;
    credential?: StoredCredential }>;
}

export function configDir(): string {
  if (process.env.TAVYA_CONFIG_DIR) return process.env.TAVYA_CONFIG_DIR;
  const base = process.platform === 'win32'
    ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'tavya');
}

export function cacheDir(): string {
  if (process.env.TAVYA_CACHE_DIR) return process.env.TAVYA_CACHE_DIR;
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches')
    : process.platform === 'win32' ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'tavya');
}

export function normalizeServer(url: string): string {
  const parsed = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
  return parsed.origin;
}

/**
 * Sign-ins per server. Tokens go to the OS keychain where one is usable
 * (macOS Keychain, libsecret's `secret-tool`); otherwise into this file, which
 * only its owner can read. `TAVYA_NO_KEYCHAIN=1` forces the file.
 */
export class Credentials {
  private file = path.join(configDir(), 'hosts.json');

  private read(): HostsFile {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as HostsFile; } catch { return { hosts: {} }; }
  }

  private write(value: HostsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  defaultServer(): string | undefined { return this.read().default; }

  servers(): string[] { return Object.keys(this.read().hosts); }

  user(server: string): HostsFile['hosts'][string]['user'] { return this.read().hosts[server]?.user; }

  get(server: string): StoredCredential | undefined {
    const entry = this.read().hosts[server];
    if (!entry) return undefined;
    if (entry.keychain) {
      const value = keychain.get(server);
      if (value) try { return JSON.parse(value) as StoredCredential; } catch { /* fall through */ }
    }
    return entry.credential;
  }

  save(server: string, credential: StoredCredential, user?: HostsFile['hosts'][string]['user']): void {
    const data = this.read();
    const inKeychain = keychain.set(server, JSON.stringify(credential));
    data.hosts[server] = { ...data.hosts[server], ...(user ? { user } : {}), keychain: inKeychain,
      ...(inKeychain ? { credential: undefined } : { credential }) };
    data.default ??= server;
    this.write(data);
  }

  setDefault(server: string): void { const data = this.read(); data.default = server; this.write(data); }

  /**
   * Run `fn` while no other tavya process is renewing this server's sign-in.
   * The server revokes a sign-in whose refresh token is presented twice, so two
   * processes must never renew from the same token. A lock older than 30 s
   * belongs to a process that died and is taken over.
   */
  async exclusive<T>(server: string, fn: () => Promise<T>): Promise<T> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = path.join(path.dirname(this.file), `renew-${crypto.createHash('sha256').update(server).digest('hex').slice(0, 16)}.lock`);
    for (;;) {
      try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let age = 0;
        try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (age > 30_000) { fs.rmSync(lock, { force: true }); continue; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
  }

  remove(server: string): void {
    const data = this.read();
    if (data.hosts[server]?.keychain) keychain.remove(server);
    delete data.hosts[server];
    if (data.default === server) data.default = Object.keys(data.hosts)[0];
    this.write(data);
  }
}

const SERVICE = 'tavya';

const keychain = {
  available(): 'security' | 'secret-tool' | undefined {
    if (process.env.TAVYA_NO_KEYCHAIN === '1') return undefined;
    if (process.platform === 'darwin') return 'security';
    if (process.platform === 'linux' && (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR)
      && spawnSync('secret-tool', ['--version'], { stdio: 'ignore' }).status === 0) return 'secret-tool';
    return undefined;
  },
  get(server: string): string | undefined {
    const tool = this.available();
    const run = tool === 'security' ? spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', server, '-w'], { encoding: 'utf8' })
      : tool === 'secret-tool' ? spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'server', server], { encoding: 'utf8' }) : undefined;
    return run?.status === 0 && run.stdout.trim() ? run.stdout.trim() : undefined;
  },
  set(server: string, value: string): boolean {
    const tool = this.available();
    if (tool === 'security')
      return spawnSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', server, '-w', value], { stdio: 'ignore' }).status === 0;
    if (tool === 'secret-tool')
      return spawnSync('secret-tool', ['store', '--label', `tavya (${server})`, 'service', SERVICE, 'server', server],
        { input: value, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;
    return false;
  },
  remove(server: string): void {
    const tool = this.available();
    if (tool === 'security') spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', server], { stdio: 'ignore' });
    if (tool === 'secret-tool') spawnSync('secret-tool', ['clear', 'service', SERVICE, 'server', server], { stdio: 'ignore' });
  },
};
