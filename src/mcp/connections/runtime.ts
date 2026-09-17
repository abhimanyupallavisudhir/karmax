import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { World } from '../../world/types.js';
import type { AgentMcpServer } from '../../contrib/manifests.js';
import { isRemoteAgentWorld, ensureRemoteNode, ensureRemoteBrowser } from '../../agent/remote-process.js';
import { mcpServerMap } from '../../autonomy/config-homes.js';
import { McpConnections, validateMcpSelection } from './store.js';
import { connectionHeaders } from './oauth.js';
const quote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";
let bundle: Promise<string> | undefined;
async function runnerBundle() {
  bundle ??= build({ entryPoints: [fileURLToPath(new URL('./runner.ts', import.meta.url))], bundle: true,
    write: false, platform: 'node', format: 'esm', target: 'node22', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } })
    .then((result) => result.outputFiles![0]!.text).catch((e) => { bundle = undefined; throw e; });
  return bundle;
}
export async function prepareConnections(service: McpConnections, world: World, ids: string[], projectId: string, taskId: string, onCleanup: (cleanup: () => Promise<void>) => void): Promise<AgentMcpServer[]> {
  validateMcpSelection(ids);
  const remote = isRemoteAgentWorld(world);
  if (process.env.KARMAX_DEPLOYMENT === 'hosted' && !remote) throw new Error('Hosted MCP connections require a remote execution environment');
  const selected = service.selected(ids, projectId);
  const container = world.handle.kind === 'container';
  const root = container ? '/work' : world.handle.root;
  const bin = remote ? await ensureRemoteNode(world) : container ? '/usr/local/bin' : path.dirname(process.execPath);
  const node = remote || container ? path.posix.join(bin, 'node') : process.execPath;
  const out: AgentMcpServer[] = [];
  for (const browser of ['chrome-devtools', 'playwright'] as const) {
    if (!ids.includes(`browser:${browser}`)) continue;
    const servers = remote ? await ensureRemoteBrowser(world, browser, bin) : mcpServerMap({ browser });
    for (const [name, spec] of Object.entries(servers)) out.push({ name, ...spec });
  }
  if (!selected.length) return out;
  await world.exec('bash', ['-lc', "exclude=$(git rev-parse --git-path info/exclude 2>/dev/null) && { grep -qxF '.karmax-injection/' \"$exclude\" 2>/dev/null || printf '%s\\n' '.karmax-injection/' >> \"$exclude\"; } || true"]);
  const relative = `.karmax-injection/mcp/${crypto.randomBytes(12).toString('hex')}`;
  const absolute = path.posix.join(root, relative);
  // Never store secrets in tracked files, account config homes or Temporal input.
  // Injection directories are omitted from checkpoint/resource publication.
  const mkdir = await world.exec('mkdir', ['-p', absolute]);
  if (mkdir.code !== 0) throw new Error('Could not prepare MCP connection directory');
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<void> | undefined;
  onCleanup(async () => {
    clearInterval(timer); await refreshing;
    const result = await world.exec('rm', ['-rf', '--', absolute]);
    if (result.code !== 0) throw new Error('Could not remove temporary MCP credentials');
  });
  const projections: { connection: typeof selected[number]; file: string; transport: typeof selected[number]['transport'] }[] = [];
  const permissions = await world.exec('chmod', ['700', absolute]);
  if (permissions.code !== 0) throw new Error('Could not protect MCP directory');
  await world.writeFile(`${relative}/runner.mjs`, await runnerBundle());
  for (const c of selected) {
    const secrets = await connectionHeaders(service, c, taskId);
    const config = `${relative}/${c.id}.json`;
    let transport = c.transport;
    if (c.registry && transport.type === 'stdio' && transport.command === 'uvx') {
      const uvHome = path.posix.join(root, '.karmax-injection/mcp-python');
      const uv = await world.exec('bash', ['-lc', `test -x ${quote(uvHome + '/bin/uvx')} || { python3 -m venv ${quote(uvHome)} && ${quote(uvHome + '/bin/pip')} install --disable-pip-version-check uv==0.8.17; }`]);
      if (uv.code !== 0) throw new Error('Could not prepare Python MCP tools. The task environment needs Python 3 with venv support.');
      transport = { ...transport, command: path.posix.join(uvHome, 'bin/uvx') };
    }
    await world.writeFile(config, JSON.stringify({ transport, secrets, leaseExpiresAt: Date.now() + 120_000 }));
    const protectedFile = await world.exec('chmod', ['600', path.posix.join(root, config)]);
    if (protectedFile.code !== 0) throw new Error('Could not protect MCP credentials');
    projections.push({ connection: c, file: config, transport });
    const args = [path.posix.join(absolute, 'runner.mjs'), path.posix.join(root, config)];
    if (container) {
      const containerId = world.handle.meta?.container;
      if (typeof containerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerId)) throw new Error('Invalid task container');
      out.push({ name: c.id, command: 'docker', args: ['exec', '-i', '-w', '/work', containerId, node, ...args] });
    } else out.push({ name: c.id, command: node, args, env: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin` } });
  }
  // Refresh only access-token projections. Refresh tokens and OAuth clients
  // remain in the host vault. A lost host heartbeat expires the runner lease.
  if (projections.length) {
    const refresh = async () => {
      for (const { connection: c, file, transport } of projections) {
        let value: unknown = { revoked: true };
        try {
          const current = service.get(c.id, projectId);
          if (current.enabled && current.revision === c.revision)
            value = { transport, secrets: await connectionHeaders(service, current, taskId), leaseExpiresAt: Date.now() + 120_000 };
        } catch { /* removed/revoked credentials close the connection */ }
        const temporary = file + '.next';
        await world.writeFile(temporary, JSON.stringify(value));
        const protectedFile = await world.exec('chmod', ['600', path.posix.join(root, temporary)]);
        if (protectedFile.code !== 0) throw new Error('Could not protect refreshed MCP credentials');
        const moved = await world.exec('mv', ['--', path.posix.join(root, temporary), path.posix.join(root, file)]);
        if (moved.code !== 0) throw new Error('Could not refresh MCP credentials');
      }
    };
    timer = setInterval(() => { if (!refreshing) refreshing = refresh().catch(() => {}).finally(() => { refreshing = undefined; }); }, 30_000);
    timer.unref();
  }
  return out;
}
/** Codex command overrides are arguments, never shell text. Names are generated
 * IDs or validated manifest names. Codex splits override keys on dots and
 * treats quote characters literally, unlike a TOML document parser. */
export function codexMcpFlags(servers: AgentMcpServer[] = [], explicit = false): string[] {
  const flags: string[] = [];
  if (explicit) flags.push('-c', 'mcp_servers={}');
  for (const s of servers) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(s.name)) throw new Error('Invalid MCP server name');
    const key = `mcp_servers.${s.name}`;
    flags.push('-c', `${key}.command=${JSON.stringify(s.command)}`, '-c', `${key}.args=${JSON.stringify(s.args ?? [])}`, '-c', `${key}.enabled=true`);
    if ((s as any).forwardEnv?.length) flags.push('-c', `${key}.env_vars=${JSON.stringify((s as any).forwardEnv)}`);
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error('Invalid MCP environment name');
      flags.push('-c', `${key}.env.${k}=${JSON.stringify(v)}`);
    }
  }
  return flags;
}
