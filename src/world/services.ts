import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectService } from '../domain/types.js';
import type { World } from './types.js';
import { ensureWorldExcluded } from './secrets.js';
import { paths } from '../config/paths.js';

const pexec = promisify(execFile);

/**
 * Per-world service instances (PLAN-state.md §3.3): every task world gets a
 * private, known-state container per declared service — parallel attempts stop
 * trampling each other's data.
 *
 * Services launch THROUGH THE WORLD CONTRACT (`world.exec` docker), not on the
 * control-plane host: a worktree world's exec runs on the host (host Docker),
 * while a cloud sandbox whose environment includes Docker runs the service
 * NEXT TO the code — so `{host}` renders as 127.0.0.1 in the world's own
 * network namespace and is correct on every backend. A world without Docker
 * degrades to a warning pointing at external-via-Secret. Containers carry
 * karmax.task/karmax.home labels so teardown and the boot-time orphan sweep
 * find them by label, never by guessing names.
 */

export interface LaunchedServices {
  /** Connection env for world processes, e.g. DATABASE_URL → this world's db. */
  env: Record<string, string>;
  /** Container names, recorded on the handle for observability. */
  containers: string[];
  warnings: string[];
}

/** Distinguishes this karmax installation's containers on a shared Docker
 * daemon (two KARMAX_HOMEs on one host must never reap each other's). */
export function serviceHomeLabel(home = paths().home): string {
  return crypto.createHash('sha256').update(home).digest('hex').slice(0, 12);
}

export async function launchWorldServices(world: World, taskId: string, services: ProjectService[],
  seeds: Map<string, Buffer>): Promise<LaunchedServices> {
  const result: LaunchedServices = { env: {}, containers: [], warnings: [] };
  const perWorld = services.filter((s) => s.kind === 'per-world');
  if (!perWorld.length) return result;
  const probe = await world.exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
  if (probe.code !== 0) {
    result.warnings.push(`per-world services (${perWorld.map((s) => s.name).join(', ')}) need Docker inside this world — `
      + 'unavailable here; declare the service external (a connection Secret) or select an environment image with Docker');
    return result;
  }
  for (const service of perWorld) {
    const container = containerName(taskId, service.name);
    await world.exec('docker', ['rm', '-f', container], { timeoutMs: 60_000 }); // clear any stale instance
    const args = ['run', '-d', '--name', container,
      '--label', `karmax.task=${taskId}`, '--label', `karmax.home=${serviceHomeLabel()}`];
    for (const [key, value] of Object.entries(service.env ?? {})) args.push('-e', `${key}=${value}`);
    if (service.containerPort) args.push('-p', `127.0.0.1:0:${service.containerPort}`);
    if (service.seedObject && service.seedContainerPath) {
      const data = seeds.get(service.seedObject);
      if (data) {
        // The seed travels through the world's own filesystem (works on every
        // backend), git-excluded so status/merge/checkpoint never see it, and
        // bind-mounted read-only — each instance starts from the object
        // store's current version.
        const rel = `.karmax-services/${service.name}/${service.seedContainerPath.split('/').pop()}`;
        if (world.writeFileBuffer) await world.writeFileBuffer(rel, data);
        else await world.writeFile(rel, data.toString('utf8'));
        await ensureWorldExcluded(world, '.karmax-services');
        args.push('-v', `${posixJoin(world.handle.root, rel)}:${service.seedContainerPath}:ro`);
      } else result.warnings.push(`service ${service.name}: seed object ${service.seedObject} is not declared as a project object`);
    }
    args.push(service.image!);
    if (service.command?.length) args.push(...service.command);
    const run = await world.exec('docker', args, { timeoutMs: 10 * 60_000 }); // may pull the image
    if (run.code !== 0) {
      result.warnings.push(`service ${service.name} did not start: ${(run.stderr || run.stdout).slice(0, 300)}`);
      continue;
    }
    result.containers.push(container);
    if (service.containerPort && service.urlEnv && service.urlTemplate) {
      // In-sandbox daemons: prefer the container's bridge IP — the daemon runs
      // in the world's own network namespace, so it is always routable and
      // avoids docker-proxy/NAT entirely. Host daemons (worktree worlds) keep
      // the published 127.0.0.1 port: host→bridge routing is NOT reliable
      // there (rootless Docker, Docker Desktop VMs, and DOCKER-USER firewall
      // chains all break it — observed on a stock apparmor/nftables host).
      const address = await containerAddress(world, container, service.containerPort);
      if (address) result.env[service.urlEnv] = service.urlTemplate
        .replace(/\{host\}/g, address.host).replace(/\{port\}/g, String(address.port));
      else result.warnings.push(`service ${service.name}: could not resolve its address`);
    }
  }
  return result;
}

/** Tear down this task's service containers on the HOST daemon (worktree
 * worlds). In-sandbox containers die with their sandbox, so remote worlds need
 * nothing here. Cheap no-op without Docker or containers; keyed by labels, so
 * renames cannot orphan and sibling installations are untouched. */
export async function destroyWorldServices(taskId: string): Promise<void> {
  const listed = await hostDocker(['ps', '-aq',
    '--filter', `label=karmax.task=${taskId}`, '--filter', `label=karmax.home=${serviceHomeLabel()}`], 10_000);
  const ids = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (ids.length) await hostDocker(['rm', '-f', ...ids], 60_000);
}

/**
 * Boot-time sweep (mirrors reapOrphans for agent processes): a crash between
 * launch and destroyWorld leaves host containers running. Reap every container
 * this installation labeled whose world is released or unknown — and only this
 * installation's (karmax.home), so concurrent instances cannot kill each
 * other's live services.
 */
export async function sweepOrphanedServiceContainers(worldState: (taskId: string) => string | undefined): Promise<number> {
  const listed = await hostDocker(['ps', '-aq', '--filter', `label=karmax.home=${serviceHomeLabel()}`], 10_000);
  const ids = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  let reaped = 0;
  for (const id of ids) {
    const inspect = await hostDocker(['inspect', '--format', '{{index .Config.Labels "karmax.task"}}', id], 10_000);
    const taskId = inspect.stdout.trim();
    if (inspect.code !== 0 || !taskId) continue;
    const state = worldState(taskId);
    if (state && state !== 'released') continue; // its world is still alive
    if ((await hostDocker(['rm', '-f', id], 60_000)).code === 0) reaped++;
  }
  return reaped;
}

async function hostDocker(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await pexec('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: e.code ?? 1 };
  }
}

async function containerAddress(world: World, container: string, containerPort: number): Promise<{ host: string; port: number } | undefined> {
  const inWorldDaemon = world.handle.kind !== 'worktree'; // sandbox-local docker vs the host's
  if (inWorldDaemon) {
    const ip = await world.exec('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container], { timeoutMs: 10_000 });
    const host = ip.stdout.trim();
    if (ip.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(host)) return { host, port: containerPort };
  }
  const r = await world.exec('docker', ['port', container, String(containerPort)], { timeoutMs: 10_000 });
  const m = r.stdout.match(/:(\d+)\s*$/m);
  return m ? { host: '127.0.0.1', port: Number(m[1]) } : undefined;
}

function containerName(taskId: string, service: string): string {
  return `karmax-svc-${taskId}-${service}`.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 63);
}

/** Worlds address their filesystems with POSIX paths on every backend. */
function posixJoin(root: string, rel: string): string {
  return `${root.replace(/\/$/, '')}/${rel}`;
}

/** The service connection env a handle carries (per-world throwaway values). */
export function serviceEnvManifest(meta: Record<string, unknown> | undefined): Record<string, string> {
  const raw = meta?.serviceEnv;
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}
