import fs from 'node:fs';
import type { Api } from '../api.js';
import { CliError, EXIT, readStdin, type Output } from '../util.js';
import type { Workspace } from '../workspace.js';
import { resolveProject } from './tasks.js';

/**
 * `tavya emit <type>`: record a project event. Tasks waiting on a matching event
 * trigger start runs that receive it. In a task's world (no workspace, a task
 * token) the event goes to that task's project; a repeated `--key` does nothing,
 * so a poller can report everything it sees on every run.
 */
export async function emit(api: Api, args: string[], out: Output, flags: Record<string, any>, workspace?: Workspace): Promise<number> {
  const [type, extra] = args;
  if (!type || extra) throw new CliError('usage: tavya emit <type> [-d <json> | -d @file | -d @-] [--key <key>] [--subject <link>]', EXIT.usage);
  let payload: unknown;
  if (flags.data !== undefined) {
    const data = String([flags.data].flat().at(-1));
    const raw = data === '@-' ? await readStdin() : data.startsWith('@') ? fs.readFileSync(data.slice(1), 'utf8') : data;
    try { payload = JSON.parse(raw); } catch { throw new CliError('-d must be a JSON object', EXIT.usage); }
  }
  const body = { type, ...(flags.key ? { key: String(flags.key) } : {}), ...(flags.subject ? { subject: String(flags.subject) } : {}),
    ...(payload !== undefined ? { payload } : {}) };
  const path = flags.project || workspace
    ? `/api/projects/${encodeURIComponent((await resolveProject(api, flags.project, workspace)).project.id)}/events`
    : '/api/events';
  const result = await api.post<{ event: { id: string; type: string }; duplicate: boolean }>(path, body);
  out.result(result, result.duplicate ? `${type}: already recorded (${result.event.id})` : `${type}: recorded (${result.event.id})`);
  return 0;
}
