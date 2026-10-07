import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { Api } from '../api.js';
import { environmentOf, secretValues, writeSecretFiles } from '../secrets.js';
import { CliError, EXIT, readStdin, shellQuote, table, type Output } from '../util.js';
import type { Workspace } from '../workspace.js';

/** Run a command with the project's secrets in its environment, as a world's
 * commands get them. Nothing is written to disk (file secrets come from pull). */
export async function run(api: Api, workspace: Workspace, argv: string[], out: Output): Promise<number> {
  if (!argv.length) throw new CliError('usage: tavya run -- <command> [args…]', EXIT.usage);
  const secrets = await secretValues(api, workspace.manifest.project.id);
  await writeSecretFiles(api, workspace, out);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', env: { ...process.env, ...environmentOf(secrets) },
      shell: process.platform === 'win32' });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward); process.on('SIGTERM', forward);
    child.on('error', (error) => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new CliError(`command not found: ${argv[0]}`, 127) : error));
    child.on('close', (code, signal) => {
      process.off('SIGINT', forward); process.off('SIGTERM', forward);
      resolve(code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9 } as Record<string, number>)[signal] ?? 1) : 1));
    });
  });
}

/** Print the environment secrets (only when asked: they are plaintext). */
export async function env(api: Api, workspace: Workspace, out: Output, format: string) {
  const values = environmentOf(await secretValues(api, workspace.manifest.project.id));
  if (format === 'json' || out.json) return out.result(values, JSON.stringify(values, null, 2));
  const lines = Object.entries(values).map(([name, value]) => format === 'shell' ? `export ${name}=${shellQuote(value)}`
    : `${name}=${/[\s#"'\\$]/.test(value) || value.includes('\n') ? JSON.stringify(value) : value}`);
  if (!['dotenv', 'shell'].includes(format)) throw new CliError(`unknown format "${format}" (dotenv, shell, json)`, EXIT.usage);
  out.result(values, lines.join('\n'));
}

/** Run the project's install commands (Project Settings → Environment) in
 * their repositories; not `setup`, which assumes the sandbox image. */
export async function setup(workspace: Workspace, out: Output): Promise<number> {
  const install = workspace.manifest.install;
  if (!install.length) { out.result({ ran: [] }, 'This project has no install commands.'); return 0; }
  const ran: string[] = [];
  for (const { repository, commands } of install) {
    const cwd = path.join(workspace.root, repository);
    if (!fs.existsSync(cwd)) { out.warn(`${repository} is not cloned; skipping its install commands`); continue; }
    for (const command of commands) {
      out.info(`[${repository}] $ ${command}`);
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(command, { cwd, shell: true, stdio: out.json ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
        child.on('error', reject);
        child.on('close', (exit) => resolve(exit ?? 1));
      });
      if (code !== 0) throw new CliError(`[${repository}] ${command} failed (exit ${code})`, code);
      ran.push(`${repository}: ${command}`);
    }
  }
  out.result({ ran }, `Ran ${ran.length} install command${ran.length === 1 ? '' : 's'}.`);
  return 0;
}

export async function secrets(api: Api, projectId: string, args: string[], out: Output, flags: { file?: string; value?: string }) {
  const [action = 'list', name] = args;
  const base = `/api/projects/${encodeURIComponent(projectId)}/secrets`;
  if (action === 'list' || action === 'ls') {
    const { secrets: list, suggestions } = await api.get<{ secrets: Array<{ name: string; variable?: string; file?: string; credentialConfigured?: boolean }>;
      suggestions: string[] }>(base);
    return out.result({ secrets: list, suggestions }, table([
      ...list.map((secret) => [secret.name, secret.file ? `file ${secret.file}` : `env ${secret.variable ?? secret.name}`,
        secret.credentialConfigured === false ? 'no value' : '']),
      ...suggestions.map((suggestion) => [suggestion, 'suggested (in .env.example)', 'no value'])]) || 'No secrets.');
  }
  if (action === 'set') {
    if (!name) throw new CliError('usage: tavya secrets set <NAME> [--file <path>] (value from stdin, or --value)', EXIT.usage);
    const value = flags.value ?? (process.stdin.isTTY ? undefined : (await readStdin()).replace(/\n$/, ''));
    if (value === undefined) throw new CliError('pipe the value on stdin (e.g. `pbpaste | tavya secrets set NAME`) or pass --value', EXIT.usage);
    await api.post(base, { name, value, ...(flags.file ? { file: flags.file } : {}) });
    return out.result({ set: name }, `Set ${name}.`);
  }
  if (action === 'import') {
    const source = name ?? '.env';
    const content = source === '-' ? await readStdin() : fs.readFileSync(source, 'utf8');
    const result = await api.post<{ imported: Array<{ name: string }> }>(base, { env: content });
    return out.result(result, `Imported ${result.imported.length} secret${result.imported.length === 1 ? '' : 's'}: ${result.imported.map((entry) => entry.name).join(', ')}`);
  }
  if (action === 'rm' || action === 'delete') {
    if (!name) throw new CliError('usage: tavya secrets rm <NAME>', EXIT.usage);
    await api.request('DELETE', `${base}/${encodeURIComponent(name)}`);
    return out.result({ deleted: name }, `Deleted ${name}.`);
  }
  throw new CliError(`unknown secrets command "${action}" (list, set, import, rm)`, EXIT.usage);
}
