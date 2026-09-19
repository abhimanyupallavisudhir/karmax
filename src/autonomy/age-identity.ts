import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node-pty';

/** Decrypt a passphrase-encrypted age identity without putting the passphrase in
 * argv, environment, logs, or an askpass script. The caller owns a private temp
 * directory and removes it even on failure. Only native identities are accepted
 * after decryption, so identity content cannot invoke age plugins. */
export async function unlockAgeIdentity(encoded: string, passphrase: string, home: string): Promise<string> {
  if (!encoded || encoded.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || !passphrase || /[\r\n\x00-\x1f\x7f]/.test(passphrase)) throw new Error('Invalid encrypted age identity or passphrase');
  const input = path.join(home, 'encrypted-identity');
  const output = path.join(home, 'unlocked-identity');
  fs.writeFileSync(input, Buffer.from(encoded, 'base64'), { mode: 0o600 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('age', ['--decrypt', '--output', output, input], {
      name: 'xterm', cols: 100, rows: 24, cwd: home,
      env: { PATH: process.env.PATH, HOME: home, LC_ALL: 'C', TERM: 'xterm' },
    });
    let prompt = ''; let sent = false; let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(timer); data.dispose(); ended.dispose();
      try { child.kill(); } catch { /* already exited */ }
      if (ok) resolve(); else reject(new Error('Could not unlock encrypted age identity; check its passphrase and format'));
    };
    const timer = setTimeout(() => finish(false), 30_000);
    const data = child.onData(chunk => {
      // Discard terminal output after the prompt; it must never reach logs.
      if (sent) return;
      prompt = (prompt + chunk).slice(-2048);
      if (/Enter passphrase:/i.test(prompt)) { sent = true; prompt = ''; child.write(passphrase + '\r'); }
    });
    const ended = child.onExit(({ exitCode }) => finish(exitCode === 0));
  });
  return fs.readFileSync(output, 'utf8');
}

export function validateNativeAgeIdentity(identity: string): void {
  const lines = identity.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (identity.length > 2 * 1024 * 1024 || !lines.length || lines.some(line => !/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(line))) {
    throw new Error('age identity must contain native AGE-SECRET-KEY-1 identities');
  }
}
