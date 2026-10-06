import process from 'node:process';
import { parseArgs } from 'node:util';
import { Api, resolveServer } from './api.js';
import { Credentials } from './config.js';
import { parseRef } from './refs.js';
import { CliError, EXIT, interactive, output, readStdin, type Output } from './util.js';
import { Workspace } from './workspace.js';
import { login, logout, token, whoami } from './commands/auth.js';
import { clone, diff, pull, push, status } from './commands/sync.js';
import { env, run, secrets, setup } from './commands/env.js';
import { attach, resolveTask, resume, task } from './commands/tasks.js';
import { importProject } from './commands/import.js';
import { exec, preview } from './commands/world.js';
import { gitCredential } from './commands/git-credential.js';

export const VERSION = '1.0.0';

const HELP = `tavya — work on tavya projects and tasks from your own machine

Usage: tavya <command> [options]

Workspaces (a project or task, assembled as its cloud world is)
  clone <org>/<project>[#<task>] [dir]   Repositories, the wiki, data and secret files
                                         (--git-via-tavya: no GitHub account needed, if your organization allows it)
  pull                                   Bring repositories, data and secrets up to date
  push                                   Push commits and changed data (into the task's world, in a task)
  status                                 Repositories, data and secrets at a glance
  diff [resource]                        Files changed in data since the last pull or push
  run -- <command>                       Run with the project's secrets in the environment
  env [--format dotenv|shell|json]       Print the environment secrets
  setup                                  Run the project's install commands
  secrets list|set|import|rm             Manage project secrets (values are write-only)
  import [dir]                           Make a local folder a tavya project (repositories, secrets, data)

Tasks
  task new <title> [--prompt <text>]     Start a task (in the workspace's project, or --project)
  task list|show|open|logs [-f]|say      Follow and steer tasks
  task confirm|cancel|retry [<task>]
  attach [<task>]                        A terminal in the task's cloud world
  exec [<task>] -- <command>             Run one command in the task's cloud world
  preview [<task>] [--port <n>]          Open a port of the task's world in the browser
  resume [<task>] [--fork]               Continue the task's agent conversation here (Claude Code, Codex)

Account
  login [--url <server>] | logout | whoami
  token create|list|revoke               Tokens for CI and scripts (--level, --project, --expires <days>)
  api <METHOD> <path> [-d <json>|@file]  Any API call (--list prints the catalog)
  git-credential                         Git credential helper (organizations that allow it)

Options: --url <server>  --json  --help  --version
Inside a task world, KARMAX_GATEWAY_URL and KARMAX_TOKEN already sign tavya in.
`;

const OPTIONS = {
  url: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  resources: { type: 'boolean' }, secrets: { type: 'boolean' }, git: { type: 'boolean' }, force: { type: 'boolean' },
  overwrite: { type: 'boolean' }, name: { type: 'string' }, browser: { type: 'boolean' }, format: { type: 'string' },
  file: { type: 'string' }, value: { type: 'string' }, level: { type: 'string' }, project: { type: 'string', multiple: true },
  organization: { type: 'string' }, expires: { type: 'string' }, prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
  workflow: { type: 'string' }, draft: { type: 'boolean' }, all: { type: 'boolean' }, follow: { type: 'boolean', short: 'f' },
  role: { type: 'string' }, ticket: { type: 'string' }, token: { type: 'string' }, fork: { type: 'boolean' }, print: { type: 'boolean' },
  data: { type: 'string', short: 'd' }, list: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, port: { type: 'string' },
  cwd: { type: 'string' }, 'git-via-tavya': { type: 'boolean' },
} as const;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // Everything after `--` belongs to the command `run`/`exec` runs.
  const separator = argv.indexOf('--');
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  const passthrough = separator >= 0 ? argv.slice(separator + 1) : [];
  let parsed;
  try { parsed = parseArgs({ args: own, options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true }); }
  catch (error) { throw new CliError(`${(error as Error).message}\nRun \`tavya --help\`.`, EXIT.usage); }
  const flags = parsed.values as Record<string, any>;
  const [command, ...args] = parsed.positionals;
  const out = output(Boolean(flags.json));
  if (flags.version) { out.result({ version: VERSION }, VERSION); return 0; }
  if (!command || flags.help || command === 'help') { process.stdout.write(HELP); return command || flags.help ? 0 : EXIT.usage; }

  const workspace = Workspace.find();
  // A pasted console URL names its server; a workspace remembers its own.
  const refServer = args[0] && /^https?:\/\//.test(args[0]) ? parseRef(args[0]).server : undefined;
  const server = resolveServer(flags.url ?? refServer ?? (workspace && !process.env.TAVYA_URL ? workspace.server : undefined));
  const token = flags.token ?? (process.env.TAVYA_TOKEN || process.env.KARMAX_TOKEN || undefined);
  const plainApi = () => new Api(server, new Credentials(), token);
  // The first command on a terminal signs in, instead of failing with "run tavya login".
  const api = async () => {
    const client = plainApi();
    if (client.signedIn || !interactive()) return client;
    process.stderr.write(`Sign in to ${server} first.\n`);
    await login(server, output(true), { browser: flags.browser !== false });
    return plainApi();
  };

  switch (command) {
    case 'login': await login(server, out, { ...(flags.name ? { name: flags.name } : {}), browser: flags.browser !== false }); return 0;
    case 'logout': await logout(server, out); return 0;
    case 'whoami': await whoami(await api(), out); return 0;
    case 'token': case 'tokens': await token(await api(), args, out, flags); return 0;
    case 'clone':
      if (!args[0]) throw new CliError('usage: tavya clone <organization>/<project>[#<task>] [directory]', EXIT.usage);
      await clone(await api(), args[0], args[1], out, { resources: flags.resources !== false, secrets: flags.secrets !== false,
        gitViaTavya: Boolean(flags['git-via-tavya']) });
      return 0;
    case 'pull': await pull(await api(), Workspace.require(), out, { force: Boolean(flags.force), resources: flags.resources !== false, secrets: flags.secrets !== false }); return 0;
    case 'push': await push(await api(), Workspace.require(), out, { overwrite: Boolean(flags.overwrite), git: flags.git !== false, resources: flags.resources !== false }); return 0;
    case 'status': case 'st': {
      const local = Workspace.require();
      const client = plainApi();
      await status(client.signedIn ? client : undefined, local, out);
      return 0;
    }
    case 'diff': await diff(Workspace.require(), out, args[0]); return 0;
    case 'run': {
      const local = Workspace.require();
      return run(await api(), local, passthrough.length ? passthrough : args, out);
    }
    case 'env': await env(await api(), Workspace.require(), out, flags.format ?? 'dotenv'); return 0;
    case 'setup': return setup(Workspace.require(), out);
    case 'secrets': case 'secret': {
      const client = await api();
      const projectId = flags.project?.[0] ? (await resolveTarget(client, flags.project[0])).project.id : Workspace.require().manifest.project.id;
      await secrets(client, projectId, args, out, flags);
      return 0;
    }
    case 'import': await importProject(await api(), args[0] ?? '.', out, flags); return 0;
    case 'task': case 'tasks': return task(await api(), args, out, { ...flags, project: flags.project?.[0] }, workspace);
    case 'attach': {
      const client = await api();
      if (flags.ticket) {
        if (!args[0]) throw new CliError('usage: tavya attach <task-id> --ticket <ticket>', EXIT.usage);
        return attach(server, args[0], { ticket: flags.ticket });
      }
      const taskId = args[0] && /^task[_-]/.test(args[0]) ? args[0] : (await resolveTask(client, args[0], workspace)).taskId;
      return attach(server, taskId, { token: await client.token() });
    }
    case 'exec': {
      const client = await api();
      const target = await resolveTask(client, args[0], workspace);
      return exec(client, target.taskId, passthrough, out, flags.cwd);
    }
    case 'preview': {
      const client = await api();
      const target = await resolveTask(client, args[0], workspace);
      await preview(client, target.taskId, out, flags.port);
      return 0;
    }
    case 'resume': {
      const client = await api();
      const target = await resolveTask(client, args[0], workspace);
      return resume(client, target, workspace?.manifest.task?.id === target.taskId ? workspace.workdir : process.cwd(), out,
        { ...(flags.role ? { role: flags.role } : {}), fork: Boolean(flags.fork), print: Boolean(flags.print) });
    }
    case 'api': return apiCommand(await api(), args, flags, out);
    case 'git-credential': return gitCredential(plainApi, args[0] ?? 'get');
    default: throw new CliError(`unknown command "${command}"\nRun \`tavya --help\`.`, EXIT.usage);
  }
}

async function resolveTarget(api: Api, ref: string) { return (await import('./refs.js')).resolveTarget(api, ref); }

async function apiCommand(api: Api, args: string[], flags: Record<string, any>, out: Output): Promise<number> {
  if (flags.list) {
    const platform = await api.get<Record<string, unknown>>('/api/platform');
    out.result(platform.api ?? platform, JSON.stringify(platform.api ?? platform, null, 2));
    return 0;
  }
  let [method, path] = args;
  if (method && !path && method.startsWith('/')) { path = method; method = 'GET'; }
  if (!method || !path) throw new CliError('usage: tavya api <METHOD> <path> [-d <json> | -d @file | -d @-]', EXIT.usage);
  if (!path.startsWith('/')) path = `/${path}`;
  if (!path.startsWith('/api/') && !path.startsWith('/oauth/')) path = `/api${path}`;
  let body: unknown;
  if (flags.data !== undefined) {
    const raw = flags.data === '@-' ? await readStdin() : String(flags.data).startsWith('@')
      ? (await import('node:fs')).readFileSync(String(flags.data).slice(1), 'utf8') : String(flags.data);
    try { body = JSON.parse(raw); } catch { throw new CliError('-d must be JSON', EXIT.usage); }
  }
  const result = await api.request(method.toUpperCase(), path, body);
  process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n`);
  return 0;
}

export async function cli(argv?: string[]): Promise<never> {
  let code: number;
  try { code = await main(argv); }
  catch (error) {
    const failure = error instanceof CliError ? error : new CliError((error as Error)?.stack ?? String(error));
    process.stderr.write(`tavya: ${failure.message}\n`);
    code = failure.code;
  }
  process.exit(code);
}
