import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectService, ResourceAttachment } from '../domain/types.js';
import type { ExecResult, World } from './types.js';
import { paths } from '../config/paths.js';

const pexec = promisify(execFile);
export interface LaunchedServices { env: Record<string, string>; containers: string[]; warnings: string[] }

export function serviceHomeLabel(home = paths().home): string {
  return crypto.createHash('sha256').update(home).digest('hex').slice(0, 12);
}

export async function launchWorldServices(world: World, taskId: string, services: ProjectService[],
  resources: Map<string, ResourceAttachment>): Promise<LaunchedServices> {
  const result: LaunchedServices = { env: {}, containers: [], warnings: [] };
  const perWorld = services.filter((service) => service.kind === 'per-world');
  if (!perWorld.length) return result;
  if ((await world.exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 })).code !== 0) {
    result.warnings.push(`per-world services (${perWorld.map((service) => service.name).join(', ')}) need Docker inside this world`);
    return result;
  }
  for (const service of perWorld) {
    const container = containerName(taskId, service.name);
    await world.exec('docker', ['rm', '-f', container], { timeoutMs: 60_000 });
    const args = ['run', '-d', '--name', container, '--label', `karmax.task=${taskId}`,
      '--label', `karmax.home=${serviceHomeLabel()}`];
    for (const [key, value] of Object.entries(service.env ?? {})) args.push('-e', `${key}=${value}`);
    if (service.containerPort) args.push('-p', `127.0.0.1:0:${service.containerPort}`);
    if (service.seedResourceId && service.seedContainerPath) {
      const resource = resources.get(service.seedResourceId);
      if (resource?.target.kind === 'path') args.push('-v',
        `${join(world.handle.root, resource.target.path)}:${service.seedContainerPath}:ro`);
      else result.warnings.push(`service ${service.name}: seed resource is unavailable or not path-shaped`);
    }
    args.push(service.image!);
    if (service.command?.length) args.push(...service.command);
    const started = await world.exec('docker', args, { timeoutMs: 10 * 60_000 });
    if (started.code !== 0) {
      result.warnings.push(`service ${service.name} did not start: ${(started.stderr || started.stdout).slice(0, 300)}`);
      continue;
    }
    result.containers.push(container);
    if (service.containerPort && service.urlEnv && service.urlTemplate) {
      const address = await containerAddress(world, container, service.containerPort);
      if (address) result.env[service.urlEnv] = service.urlTemplate
        .replace(/\{host\}/g, address.host).replace(/\{port\}/g, String(address.port));
      else result.warnings.push(`service ${service.name}: could not resolve its address`);
    }
  }
  return result;
}

/**
 * Tear down a task's per-world service containers. `launchWorldServices` starts
 * them with `world.exec('docker', …)` — INSIDE the sandbox for a remote world —
 * so teardown has to speak to the same Docker daemon. Running it on the host
 * (the only thing this function could do before `world` was threaded through)
 * is a silent no-op against the wrong daemon: it lists nothing and removes
 * nothing. Callers that no longer have a live world (a destroyed sandbox takes
 * its containers with it) may omit it and get the host path.
 */
export async function destroyWorldServices(taskId: string, world?: World): Promise<void> {
  const run = dockerFor(world);
  const listed = await run(['ps', '-aq', '--filter', `label=karmax.task=${taskId}`,
    '--filter', `label=karmax.home=${serviceHomeLabel()}`], 10_000);
  const ids = listed.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
  if (ids.length) await run(['rm', '-f', ...ids], 60_000);
}

/** Docker command channel for a world: the world's own daemon when we have a
 *  world (that is where its service containers were started), the host's when
 *  the world is already gone. */
function dockerFor(world: World | undefined): (args: string[], timeout: number) => Promise<ExecResult> {
  // Mirrors `launchWorldServices`, which ALWAYS starts containers through
  // `world.exec('docker', …)`. Routing teardown by world *kind* instead sent
  // `container` worlds to the HOST daemon even though their containers had been
  // started inside the world — launch and teardown addressed different daemons,
  // so the removal matched nothing and said nothing. If a world is available,
  // speak to that world's daemon; kind does not come into it.
  if (!world) return hostDocker;
  return async (args, timeout) => world.exec('docker', args, { timeoutMs: timeout });
}

/** Host-side reaper for service containers whose world is gone. Deliberately
 * host-only: a remote world's service containers live and die inside its
 * sandbox, which the world orphan sweep in `WorldLifecycleManager` destroys as
 * a unit — there is nothing on this host to find for them. */
export async function sweepOrphanedServiceContainers(worldState: (taskId: string) => string | undefined | Promise<string | undefined>): Promise<number> {
  const listed = await hostDocker(['ps', '-aq', '--filter', `label=karmax.home=${serviceHomeLabel()}`], 10_000);
  let reaped = 0;
  for (const id of listed.stdout.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const inspected = await hostDocker(['inspect', '--format', '{{index .Config.Labels "karmax.task"}}', id], 10_000);
    const taskId = inspected.stdout.trim();
    if (!taskId || ((await worldState(taskId)) && (await worldState(taskId)) !== 'released')) continue;
    if ((await hostDocker(['rm', '-f', id], 60_000)).code === 0) reaped++;
  }
  return reaped;
}

async function hostDocker(args: string[], timeout: number): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await pexec('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (error: any) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message ?? error), code: error.code ?? 1 };
  }
}
async function containerAddress(world: World, container: string, port: number) {
  if (world.handle.kind !== 'worktree') {
    const inspected = await world.exec('docker', ['inspect', '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container], { timeoutMs: 10_000 });
    if (inspected.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(inspected.stdout.trim()))
      return { host: inspected.stdout.trim(), port };
  }
  const published = await world.exec('docker', ['port', container, String(port)], { timeoutMs: 10_000 });
  const match = published.stdout.match(/:(\d+)\s*$/m);
  return match ? { host: '127.0.0.1', port: Number(match[1]) } : undefined;
}
function containerName(taskId: string, service: string): string {
  return `karmax-svc-${taskId}-${service}`.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 63);
}
function join(root: string, rel: string): string { return `${root.replace(/\/$/, '')}/${rel.replace(/^\//, '')}`; }
