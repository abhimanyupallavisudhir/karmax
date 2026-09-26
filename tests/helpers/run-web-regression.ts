import { execFileSync } from 'node:child_process';

export function runWebRegression(file: string, timeoutMs = 20_000): void {
  execFileSync(process.execPath, [file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}
