import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import release from './restic-release.json' with { type: 'json' };

/** The pinned restic (restic-release.json, installed by `npm ci`). */
export const RESTIC_VERSION: string = release.version;
const binaries = release.binaries as Record<string, { archive: string; binary?: string }>;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The Linux binary a world of this architecture runs, and its digest. */
export function worldResticBinary(arch: string): { file: string; sha256: string } | undefined {
  const platform = `linux-${arch}`;
  const digest = binaries[platform]?.binary;
  const file = path.join(root, 'node_modules/.cache/restic', RESTIC_VERSION, `restic-${platform}`);
  return digest && fs.existsSync(file) ? { file, sha256: digest } : undefined;
}

/** restic for commands the server itself runs. */
export function hostResticBinary(): string {
  const configured = process.env.KARMAX_RESTIC?.trim();
  if (configured) return configured;
  const arch = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[process.arch];
  const file = path.join(root, 'node_modules/.cache/restic', RESTIC_VERSION, `restic-${process.platform}-${arch}`);
  if (fs.existsSync(file)) return file;
  throw new Error(`restic ${RESTIC_VERSION} is not installed: run \`npm ci\` (or \`node scripts/fetch-restic.mjs\`), or set KARMAX_RESTIC`);
}

export interface ResticRun { code: number; stdout: string; stderr: string }

/** Run restic on this host. `env` carries the repository and its credentials,
 * never the command line, which other users of the host can read. */
export function runHostRestic(args: string[], env: Record<string, string>, options: { cwd?: string; signal?: AbortSignal;
  onLine?: (line: string) => void } = {}): Promise<ResticRun> {
  return new Promise<ResticRun>((resolve, reject) => {
    const child = spawn(hostResticBinary(), args, { cwd: options.cwd, signal: options.signal,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (!options.onLine) { stdout += text; return; }
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) { if (line.trim()) options.onLine(line); }
      stdout += text;
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (options.onLine && pending.trim()) options.onLine(pending);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** restic's own words for a failed command: its JSON errors, else stderr. */
export function resticFailure(run: ResticRun, what: string): Error {
  const messages: string[] = [];
  for (const line of `${run.stdout}\n${run.stderr}`.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value.message_type === 'exit_error' || value.message_type === 'error')
        messages.push([value.item, value.error?.message ?? value.message].filter(Boolean).join(': '));
    } catch { /* not a JSON line */ }
  }
  const text = messages.length ? messages.slice(0, 3).join('; ')
    : run.stderr.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('{')).slice(-3).join('; ');
  // The repository server's own refusals, which restic reports by status only.
  if (/\(507\)/.test(text)) return new Error(`${what} failed: storage quota exceeded (the organization's storage is full)`);
  return new Error(`${what} failed (restic exit ${run.code})${text ? `: ${text}` : ''}`);
}
