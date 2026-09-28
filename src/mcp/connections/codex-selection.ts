import { spawn } from 'node:child_process';
import type { World } from '../../world/types.js';
import type { AgentMcpServer } from '../../contrib/manifests.js';
import { isRemoteAgentWorld, spawnRemoteAgentProcess } from '../../agent/remote-process.js';
import { codexMcpFlags } from './runtime.js';

/** Codex merges table overrides with lower config layers: mcp_servers={} does
 * not clear an account's servers. Ask its own data-only config loader for the
 * effective names, explicitly disable them, then enable the selected servers.
 * `mcp list` does not start servers or make a model call. Its output may contain
 * account secrets, so keep it bounded, in memory, and out of diagnostics.
 * `configured` is the complete set of names when the caller already knows it
 * (a remote home whose config karmax wrote itself): no process is started. */
export async function selectedCodexMcpFlags(world: World, command: string, cwd: string,
  env: Record<string, string>, servers: AgentMcpServer[], explicit: boolean, signal?: AbortSignal,
  configured?: readonly string[]): Promise<string[]> {
  if (!explicit) return codexMcpFlags(servers);
  if (signal?.aborted) throw new Error('MCP configuration check cancelled');
  if (configured) return disableAndSelect(configured.map((name) => ({ name })), servers);
  const child = isRemoteAgentWorld(world)
    ? spawnRemoteAgentProcess({ world, provider: 'codex', command, args: ['mcp', 'list', '--json'], cwd, env, signal })
    : spawn(command, ['mcp', 'list', '--json'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
  const raw = await new Promise<string>((resolve, reject) => {
    let output = ''; let bytes = 0; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(output);
    };
    const abort = () => finish(new Error('MCP configuration check cancelled'));
    const timer = setTimeout(() => finish(new Error('MCP configuration check timed out')), 60_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) finish(new Error('MCP configuration is too large')); else output += chunk.toString(); });
    child.stderr?.resume();
    child.on('error', () => finish(new Error('Could not inspect Codex MCP configuration')));
    child.on('close', (code) => finish(code === 0 ? undefined : new Error('Could not inspect Codex MCP configuration')));
    if (signal?.aborted) abort();
  });
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { throw new Error('Codex returned invalid MCP configuration'); }
  if (!Array.isArray(entries) || entries.length > 200) throw new Error('Codex MCP configuration is too large or invalid');
  return disableAndSelect(entries, servers);
}

function disableAndSelect(entries: unknown[], servers: AgentMcpServer[]): string[] {
  const flags = codexMcpFlags([], true);
  for (const entry of entries as Array<{ name?: unknown }>) {
    if (typeof entry?.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) throw new Error('Rename legacy Codex MCP servers to use letters, numbers, hyphens or underscores before selecting Agent tools');
    flags.push('-c', `mcp_servers.${entry.name}.enabled=false`);
  }
  return [...flags, ...codexMcpFlags(servers)];
}
