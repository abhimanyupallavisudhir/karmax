import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { Api } from '../api.js';
import { namesOrganization, resolveTarget, slug, type Target } from '../refs.js';
import { CliError, EXIT, readStdin, table, type Output } from '../util.js';
import type { Workspace } from '../workspace.js';

/** A task named on the command line, or the workspace's own task. `#12` and
 * `12` are task numbers in the workspace's project. */
export async function resolveTask(api: Api, ref: string | undefined, workspace?: Workspace): Promise<Target & { taskId: string }> {
  if (!ref) {
    if (workspace?.manifest.task) return { project: workspace.manifest.project, taskId: workspace.manifest.task.id,
      ...(workspace.manifest.task.number != null ? { taskNumber: workspace.manifest.task.number } : {}) };
    throw new CliError('name a task: <organization>/<project>#<number>, or #<number> inside a workspace', EXIT.usage);
  }
  const target = await resolveTarget(api, /^#?\d+$/.test(ref) ? `#${ref.replace(/^#/, '')}` : ref, workspace?.manifest.project.id);
  if (!target.taskId) throw new CliError(`"${ref}" names a project, not a task (add #<number>)`, EXIT.usage);
  return target as Target & { taskId: string };
}

export async function resolveProject(api: Api, ref: string | undefined, workspace?: Workspace): Promise<Target> {
  if (ref) return resolveTarget(api, ref);
  if (workspace) return { project: workspace.manifest.project };
  throw new CliError('name a project with --project <organization>/<project>, or run this inside a workspace', EXIT.usage);
}

export function taskUrl(server: string, target: Target, organization?: { name: string; slug?: string }): string {
  const org = target.organization ?? organization;
  const key = target.taskNumber ?? target.taskId;
  return org ? `${server}/${org.slug ?? slug(org.name)}/${slug(target.project.name)}/tasks/${key}` : `${server}/projects/${slug(target.project.name)}/tasks/${key}`;
}

export function projectUrl(server: string, project: { name: string }, organization?: { name: string; slug?: string }): string {
  return organization ? `${server}/${organization.slug ?? slug(organization.name)}/${slug(project.name)}` : `${server}/projects/${slug(project.name)}`;
}

/** The projects you can open, as `<organization>/<project>` (what clone and --project take). */
export async function projects(api: Api, args: string[], out: Output, flags: Record<string, any>): Promise<number> {
  if (args[0] && !['list', 'ls'].includes(args[0])) throw new CliError('usage: tavya projects [--organization <org>]', EXIT.usage);
  const [organizations, list] = await Promise.all([api.get<Array<{ id: string; name: string; slug?: string }>>('/api/organizations').catch(() => []),
    api.get<Array<{ id: string; name: string; organizationId?: string }>>('/api/projects')]);
  const orgOf = (id?: string) => organizations.find((entry) => entry.id === id);
  const wanted = flags.organization ? organizations.find((entry) => namesOrganization(entry, flags.organization!)) : undefined;
  if (flags.organization && !wanted) throw new CliError(`no organization "${flags.organization}" that you can access`, EXIT.notFound);
  const shown = list.filter((project) => !wanted || project.organizationId === wanted.id).map((project) => {
    const organization = orgOf(project.organizationId);
    return { ...project, ref: `${organization ? organization.slug ?? slug(organization.name) : project.organizationId ?? ''}/${slug(project.name)}` };
  });
  out.result(shown, table(shown.map((project) => [project.ref, project.name])) || 'No projects.');
  return 0;
}

interface TaskView { taskId?: string; id?: string; title: string; num?: number; status?: string; stage?: string;
  waitingFor?: { kind?: string; summary?: string }; branch?: string; lastView?: TaskView }

const describeStatus = (view: TaskView) => {
  const live = view.lastView ?? view;
  return [live.stage, live.status, live.waitingFor?.kind ? `waiting for ${live.waitingFor.kind}` : ''].filter(Boolean).join(' · ');
};

export async function task(api: Api, args: string[], out: Output, flags: Record<string, any>, workspace?: Workspace): Promise<number> {
  const [action, ...rest] = args;
  switch (action) {
    case 'new': case 'create': {
      const title = rest.join(' ').trim();
      if (!title) throw new CliError('usage: tavya task new <title> [--prompt <text> | --prompt-file <file> | stdin]', EXIT.usage);
      const target = await resolveProject(api, flags.project, workspace);
      const prompt = flags.prompt ?? (flags['prompt-file'] ? fs.readFileSync(flags['prompt-file'], 'utf8')
        : process.stdin.isTTY ? title : (await readStdin()).trim() || title);
      const created = await api.post<{ id: string; num?: number }>(`/api/projects/${encodeURIComponent(target.project.id)}/tasks`,
        { title, prompt, ...(flags.workflow ? { workflow: flags.workflow } : {}), ...(flags.draft ? { draft: true } : {}) });
      const url = taskUrl(api.server, { ...target, taskId: created.id, ...(created.num != null ? { taskNumber: created.num } : {}) }, workspace?.manifest.organization);
      out.result({ ...created, url }, `${created.num != null ? `#${created.num} ` : ''}${title}\n${url}`);
      return 0;
    }
    case 'list': case 'ls': {
      const target = await resolveProject(api, flags.project, workspace);
      const tasks = await api.get<TaskView[]>(`/api/projects/${encodeURIComponent(target.project.id)}/tasks`);
      const shown = flags.all ? tasks : tasks.filter((entry) => !['done', 'cancelled'].includes((entry.lastView ?? entry).status ?? ''));
      out.result(shown, table(shown.map((entry) => [entry.num != null ? `#${entry.num}` : (entry.id ?? ''), describeStatus(entry), entry.title])) || 'No open tasks.');
      return 0;
    }
    case 'show': case 'view': {
      const target = await resolveTask(api, rest[0], workspace);
      const view = await api.get<TaskView>(`/api/tasks/${encodeURIComponent(target.taskId)}`);
      const url = taskUrl(api.server, target, workspace?.manifest.organization);
      out.result({ ...view, url }, [`${target.taskNumber != null ? `#${target.taskNumber} ` : ''}${view.title}`, describeStatus(view),
        ...((view.lastView ?? view).waitingFor?.summary ? [(view.lastView ?? view).waitingFor!.summary!] : []), url].join('\n'));
      return 0;
    }
    case 'open': {
      const target = await resolveTask(api, rest[0], workspace);
      const url = taskUrl(api.server, target, workspace?.manifest.organization);
      openUrl(url);
      out.result({ url }, url);
      return 0;
    }
    case 'logs': case 'events': {
      const target = await resolveTask(api, rest[0], workspace);
      let since = 0;
      for (;;) {
        const events = await api.get<Array<{ seq?: number; ts: number; type: string; payload?: Record<string, unknown> }>>(
          `/api/tasks/${encodeURIComponent(target.taskId)}/events?since=${since}`);
        for (const event of events) {
          since = Math.max(since, Number(event.seq ?? since));
          if (out.json) process.stdout.write(`${JSON.stringify(event)}\n`);
          else process.stdout.write(`${new Date(event.ts).toISOString().slice(11, 19)}  ${event.type}${summary(event.payload)}\n`);
        }
        if (!flags.follow) return 0;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    case 'say': case 'message': {
      const [ref, ...words] = rest.length > 1 || /^#?\d+$|\//.test(rest[0] ?? '') ? rest : [undefined, ...rest];
      const target = await resolveTask(api, ref, workspace);
      const text = words.join(' ').trim() || (process.stdin.isTTY ? '' : (await readStdin()).trim());
      if (!text) throw new CliError('usage: tavya task say [<task>] <message>', EXIT.usage);
      await api.post(`/api/tasks/${encodeURIComponent(target.taskId)}/signal`, { signal: 'followUp', text, ...(flags.role ? { role: flags.role } : {}) });
      out.result({ sent: true }, 'Sent.');
      return 0;
    }
    case 'confirm': case 'cancel': case 'retry': {
      const target = await resolveTask(api, rest[0], workspace);
      await api.post(`/api/tasks/${encodeURIComponent(target.taskId)}/signal`, { signal: action });
      out.result({ signal: action }, `${action[0]!.toUpperCase()}${action.slice(1)} sent.`);
      return 0;
    }
    default:
      throw new CliError('usage: tavya task new|list|show|open|logs|say|confirm|cancel|retry', EXIT.usage);
  }
}

function summary(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  const text = payload.text ?? payload.message ?? payload.summary ?? payload.title ?? payload.error;
  return typeof text === 'string' && text ? `  ${text.replace(/\s+/g, ' ').slice(0, 160)}` : '';
}

export function openUrl(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(command as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref(); } catch { /* printed */ }
}

/** A terminal in the task's world (`/ws/terminal`). A signed-in CLI sends its
 * bearer; `--ticket` takes a one-time ticket copied from the console. */
export async function attach(server: string, taskId: string, credential: { token?: string; ticket?: string }): Promise<number> {
  const url = new URL('/ws/terminal', server);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('taskId', taskId);
  if (credential.ticket) url.searchParams.set('ticket', credential.ticket);
  const ws = new WebSocket(url, credential.ticket ? undefined : { headers: { authorization: `Bearer ${credential.token}` } });
  let raw = false;
  const restore = () => { if (raw && process.stdin.isTTY) process.stdin.setRawMode(false); raw = false; };
  const resize = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 })); };
  return new Promise((resolve) => {
    ws.addEventListener('open', () => {
      if (process.stdin.isTTY) { process.stdin.setRawMode(true); raw = true; }
      process.stdin.resume();
      process.stdin.on('data', (data) => ws.send(JSON.stringify({ type: 'input', data: data.toString() })));
      process.stdout.on('resize', resize);
      resize();
    });
    ws.addEventListener('message', (event) => {
      try { const message = JSON.parse(String(event.data)); if (message.type === 'data') process.stdout.write(message.data); } catch { /* ignore */ }
    });
    ws.addEventListener('close', (event) => {
      restore();
      process.stdout.off('resize', resize);
      process.stdin.pause();
      if (event.code !== 1000 && event.reason) process.stderr.write(`\ntavya attach: ${event.reason}\n`);
      resolve(event.code === 1000 || event.code === 1005 ? 0 : 1);
    });
    ws.addEventListener('error', (event) => { restore(); process.stderr.write(`tavya attach: ${(event as Event & { message?: string }).message ?? 'connection failed'}\n`); });
    process.on('SIGINT', () => ws.close());
    process.on('SIGTERM', () => ws.close());
    process.on('exit', restore);
  });
}

interface Session { id?: string; exportId?: string; provider?: string; downloadable?: boolean; requiredCodexVersion?: string; filename?: string }

/** Continue (or fork) one of the task's agents on this machine: its native
 * history goes where the provider's CLI finds sessions, then that CLI starts
 * in the workspace. The cloud conversation is never changed. */
export async function resume(api: Api, target: { taskId: string }, cwd: string, out: Output, options: { role?: string; fork: boolean; print?: boolean }): Promise<number> {
  const sessions = await api.get<Record<string, Session>>(`/api/tasks/${encodeURIComponent(target.taskId)}/sessions`);
  const entries = Object.entries(sessions).filter(([, session]) => session?.id && session.downloadable && ['claude', 'codex'].includes(session.provider ?? ''));
  const chosen = options.role ? entries.find(([role]) => role === options.role) : entries.find(([role]) => role === 'do') ?? entries[0];
  if (!chosen) throw new CliError(options.role ? `no ${options.role} conversation to resume` : 'this task has no Claude or Codex conversation to resume', EXIT.notFound);
  const [role, session] = chosen;
  const response = await api.request<Response>('GET', `/api/tasks/${encodeURIComponent(target.taskId)}/conversation.jsonl?role=${encodeURIComponent(role)}`, undefined, { raw: true });
  const history = Buffer.from(await response.arrayBuffer());
  const sessionId = session.exportId ?? session.id!;
  const real = fs.realpathSync(cwd);
  let command: string; let args: string[]; let env: NodeJS.ProcessEnv = process.env;
  if (session.provider === 'claude') {
    const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    const dir = path.join(home, 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), history);
    command = 'claude'; args = ['--resume', sessionId, ...(options.fork ? ['--fork-session'] : [])];
  } else {
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const dir = path.join(home, 'sessions', 'tavya');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, (session.filename ?? `codex-${sessionId}.jsonl`).replace(/[^a-zA-Z0-9_.-]/g, '_')), history);
    command = 'npx'; args = ['--yes', `@openai/codex@${session.requiredCodexVersion ?? 'latest'}`, options.fork ? 'fork' : 'resume', sessionId];
    env = { ...process.env, CODEX_HOME: home };
  }
  if (options.print) { out.result({ provider: session.provider, role, sessionId, command: [command, ...args], cwd: real }, `cd ${real} && ${[command, ...args].join(' ')}`); return 0; }
  out.info(`${options.fork ? 'Forking' : 'Resuming'} the ${role} agent's ${session.provider} conversation in ${real}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: real, stdio: 'inherit', env });
    child.on('error', (error) => reject((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? new CliError(`${command} is not installed${session.provider === 'claude' ? ' (npm i -g @anthropic-ai/claude-code)' : ''}`) : error));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
