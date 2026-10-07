import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import release from '../world/restic-release.json' with { type: 'json' };
import { cacheDir } from './config.js';
import { CliError } from './util.js';

export const RESTIC_VERSION: string = release.version;

/** restic's options for a save, identical to a world's (src/world/restic-engine.ts),
 * so a laptop's snapshot and a world's deduplicate against each other. */
export function backupArgs(parent?: string): string[] {
  return ['backup', '--json', '--host', 'tavya', '--ignore-inode', '--exclude', '.git', '--exclude', '.karmax-injection',
    '-o', 'rest.connections=32', ...(parent ? ['--parent', parent] : [])];
}

/**
 * The pinned restic: `TAVYA_RESTIC`, else a cached copy, else downloaded from
 * restic's GitHub release and checked against the digest tavya pins.
 * Unpacking uses the system's `bzip2` (macOS, Linux) or `tar` (Windows 10+).
 */
export async function resticBinary(log?: (message: string) => void): Promise<string> {
  if (process.env.TAVYA_RESTIC) return process.env.TAVYA_RESTIC;
  const arch = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[process.arch];
  const platform = arch ? `${process.platform === 'win32' ? 'windows' : process.platform}-${arch}` : undefined;
  const pinned = platform ? (release.binaries as Record<string, { archive: string; binary?: string }>)[platform] : undefined;
  if (!platform || !pinned) throw new CliError(`restic is not available for ${process.platform}-${process.arch}; set TAVYA_RESTIC to a restic ${RESTIC_VERSION} binary`);
  const windows = platform.startsWith('windows');
  const dir = path.join(cacheDir(), 'restic', RESTIC_VERSION);
  const binary = path.join(dir, windows ? 'restic.exe' : 'restic');
  if (fs.existsSync(binary)) return binary;
  fs.mkdirSync(dir, { recursive: true });
  const name = `restic_${RESTIC_VERSION}_${platform.replace('-', '_')}.${windows ? 'zip' : 'bz2'}`;
  const url = `https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${name}`;
  log?.(`Downloading restic ${RESTIC_VERSION}…`);
  const response = await fetch(url).catch((error) => { throw new CliError(`downloading restic: ${(error as Error).message}`); });
  if (!response.ok) throw new CliError(`downloading ${url}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(archive).digest('hex') !== pinned.archive) throw new CliError(`${url} does not match its pinned digest`);
  const temporary = path.join(dir, `.${name}.${process.pid}`);
  fs.writeFileSync(temporary, archive);
  try {
    if (windows) {
      const unpacked = spawnSync('tar', ['-xf', temporary, '-C', dir], { stdio: 'ignore' });
      if (unpacked.status !== 0) throw new CliError('could not unpack restic (needs tar, built into Windows 10 and later)');
      const exe = fs.readdirSync(dir).find((file) => /^restic.*\.exe$/.test(file));
      if (!exe) throw new CliError('the restic archive held no restic.exe');
      if (exe !== 'restic.exe') fs.renameSync(path.join(dir, exe), binary);
    } else {
      const unpacked = spawnSync('bzip2', ['-dc', temporary], { maxBuffer: 256 * 1024 * 1024 });
      if (unpacked.status !== 0 || !unpacked.stdout?.length)
        throw new CliError(`could not unpack restic: install bzip2, or set TAVYA_RESTIC to a restic ${RESTIC_VERSION} binary`);
      if (pinned.binary && crypto.createHash('sha256').update(unpacked.stdout).digest('hex') !== pinned.binary)
        throw new CliError('the unpacked restic does not match its pinned digest');
      fs.writeFileSync(`${binary}.tmp`, unpacked.stdout, { mode: 0o755 });
      fs.renameSync(`${binary}.tmp`, binary);
    }
  } finally { fs.rmSync(temporary, { force: true }); }
  return binary;
}

export interface ResticResult { code: number; stdout: string; stderr: string }

/** Run restic with a grant's environment; `progress` gets restic's status lines. */
export async function restic(args: string[], env: Record<string, string>, options: { cwd?: string;
  progress?: (status: { percent: number; bytesDone: number; totalBytes: number }) => void } = {}): Promise<ResticResult> {
  const binary = await resticBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--no-cache', ...args], { cwd: options.cwd,
      env: { ...process.env, ...env, RESTIC_PROGRESS_FPS: '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      pending += text;
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('{"message_type":"status"')) {
          try {
            const status = JSON.parse(line);
            options.progress?.({ percent: Number(status.percent_done ?? 0), bytesDone: Number(status.bytes_done ?? status.bytes_restored ?? 0),
              totalBytes: Number(status.total_bytes ?? 0) });
          } catch { /* partial */ }
        } else stdout += `${line}\n`;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: stdout + pending, stderr }));
  });
}

export function summaryOf(stdout: string): Record<string, unknown> {
  for (const line of stdout.split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try { const value = JSON.parse(line); if (value.message_type === 'summary') return value; } catch { /* partial */ }
  }
  throw new CliError('restic did not report a summary');
}

export function resticError(result: ResticResult, what: string): CliError {
  const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).slice(-3).join('; ');
  return new CliError(`${what} failed (restic exit ${result.code})${detail ? `: ${detail}` : ''}`);
}
