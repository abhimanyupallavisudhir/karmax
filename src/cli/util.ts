import process from 'node:process';
import readline from 'node:readline/promises';

/** A failure the user can act on. `code` is the process exit code:
 * 1 failed, 2 usage, 3 not signed in, 4 conflict, 5 not found. */
export class CliError extends Error {
  constructor(message: string, readonly code = 1) { super(message); }
}

export const EXIT = { failed: 1, usage: 2, auth: 3, conflict: 4, notFound: 5 } as const;

export interface Output {
  json: boolean;
  /** Progress and notes for people; silent with --json. */
  info(message: string): void;
  warn(message: string): void;
  /** The command's result: JSON with --json, else `text`. */
  result(value: unknown, text?: string): void;
}

export function output(json: boolean, stdout = process.stdout, stderr = process.stderr): Output {
  return {
    json,
    info: (message) => { if (!json) stderr.write(`${message}\n`); },
    warn: (message) => { stderr.write(`warning: ${message}\n`); },
    result: (value, text) => {
      if (json) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      else if (text !== undefined) stdout.write(text.endsWith('\n') || !text ? text : `${text}\n`);
    },
  };
}

export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY) && process.env.CI !== 'true';
}

/** Ask yes/no on a terminal; elsewhere the answer is `fallback`. */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  if (!interactive()) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export function bytes(value: number | undefined): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0; let n = value;
  while (n >= 1000 && index < units.length - 1) { n /= 1000; index++; }
  return `${n >= 10 || index === 0 ? Math.round(n) : n.toFixed(1)} ${units[index]}`;
}

export function table(rows: string[][]): string {
  if (!rows.length) return '';
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
  return rows.map((row) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join('  ').trimEnd()).join('\n');
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
