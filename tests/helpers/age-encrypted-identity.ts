import { spawn } from 'node-pty';

/** Real age passphrase encryption for interoperability/browser fixtures. */
export function encryptIdentity(input: string, output: string, passphrase: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('age', ['-p', '-o', output, input], { name: 'xterm', cols: 100, rows: 24, env: { PATH: process.env.PATH, LC_ALL: 'C' } });
    let buffer = ''; let count = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('age encryption timed out')); }, 30_000);
    child.onData(data => {
      buffer += data;
      if ((count === 0 && /Enter passphrase/.test(buffer)) || (count === 1 && /Confirm passphrase/.test(buffer))) {
        count++; buffer = ''; child.write(passphrase + '\r');
      }
    });
    child.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error('age encryption failed')); });
  });
}
