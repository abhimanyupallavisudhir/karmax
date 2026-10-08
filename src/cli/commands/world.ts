import process from 'node:process';
import type { Api } from '../api.js';
import { CliError, EXIT, type Output } from '../util.js';
import { openUrl } from './tasks.js';

/** Run one command in the task's cloud world, streaming its output; exits
 * with the command's exit code. For an interactive shell use `tavya attach`. */
export async function exec(api: Api, taskId: string, argv: string[], out: Output, cwd?: string): Promise<number> {
  if (!argv.length) throw new CliError('usage: tavya exec [<task>] -- <command> [args…]', EXIT.usage);
  const command = argv.length === 1 ? argv[0]! : argv.map((part) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
  const response = await api.request<Response>('POST', `/api/tasks/${encodeURIComponent(taskId)}/exec`, { command, ...(cwd ? { cwd } : {}) }, { raw: true });
  if (!response.body) throw new CliError('the server sent no output');
  const decoder = new TextDecoder();
  let pending = '';
  let code: number | null = null;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n'); pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as { type: string; data?: string; code?: number | null; error?: string };
      if (frame.type === 'output' && frame.data) (out.json ? process.stderr : process.stdout).write(frame.data);
      else if (frame.type === 'error') throw new CliError(frame.error ?? 'the command failed to start');
      else if (frame.type === 'exit') code = frame.code ?? null;
    }
  }
  if (out.json) out.result({ code });
  return code ?? 1;
}

interface ReviewAction { label?: string; server?: boolean; openUrls?: string[] }

/** Open a port of the task's world: one a review action declared (the same
 * rule as the console's Preview). */
export async function preview(api: Api, taskId: string, out: Output, port?: string) {
  let chosen = port ? Number(port) : undefined;
  if (!chosen) {
    const view = await api.get<{ reviewInfo?: { actions?: ReviewAction[] }; lastView?: { reviewInfo?: { actions?: ReviewAction[] } } }>(
      `/api/tasks/${encodeURIComponent(taskId)}`);
    const actions = (view.reviewInfo ?? view.lastView?.reviewInfo)?.actions ?? [];
    // The ports the server accepts (reviewPorts in src/gateway/server.ts): loopback URLs a review action opens.
    const ports = [...new Set(actions.flatMap((action) => (action.openUrls ?? []).map((value) => {
      try {
        const url = new URL(value);
        return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(url.hostname) ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : 0;
      } catch { return 0; }
    })).filter((value) => value > 0))];
    if (ports.length !== 1) throw new CliError(ports.length ? `the task serves ${ports.join(', ')}; choose one with --port` : 'the task declares no preview port; start its server from Review first', EXIT.usage);
    chosen = ports[0]!;
  }
  const lease = await api.post<{ id: string; url: string; expiresAt: number }>(`/api/tasks/${encodeURIComponent(taskId)}/preview-leases`, { port: chosen });
  const url = new URL(lease.url, api.server).toString();
  openUrl(url);
  out.result({ ...lease, url }, url);
}
