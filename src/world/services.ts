import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectService } from '../domain/types.js';

const pexec = promisify(execFile);

/**
 * Per-world service instances (PLAN-state.md §3.3): every task world gets a
 * private, known-state container per declared service — parallel attempts stop
 * trampling each other's data. Launched on the host's Docker with the service
 * port published on a 127.0.0.1 ephemeral port; the rendered connection env
 * ({host}/{port} filled in) is what world processes receive. Instances are
 * labeled karmax.task=<taskId> so teardown (and orphan sweeps) find them by
 * label, never by guessing names.
 */

export interface LaunchedServices {
  /** Connection env for world processes, e.g. DATABASE_URL → this world's db. */
  env: Record<string, string>;
  /** Container names, recorded on the handle for observability. */
  containers: string[];
  warnings: string[];
}

async function docker(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await pexec('docker', args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: e.code ?? 1 };
  }
}

export async function servicesDockerAvailable(): Promise<boolean> {
  return (await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 })).code === 0;
}

export async function launchWorldServices(taskId: string, services: ProjectService[],
  seeds: Map<string, Buffer>): Promise<LaunchedServices> {
  const result: LaunchedServices = { env: {}, containers: [], warnings: [] };
  const perWorld = services.filter((s) => s.kind === 'per-world');
  if (!perWorld.length) return result;
  if (!(await servicesDockerAvailable())) {
    result.warnings.push(`per-world services (${perWorld.map((s) => s.name).join(', ')}) need Docker, which is not available`);
    return result;
  }
  for (const service of perWorld) {
    const container = containerName(taskId, service.name);
    await docker(['rm', '-f', container]); // clear any stale instance
    const args = ['run', '-d', '--name', container, '--label', `karmax.task=${taskId}`];
    for (const [key, value] of Object.entries(service.env ?? {})) args.push('-e', `${key}=${value}`);
    if (service.containerPort) args.push('-p', `127.0.0.1:0:${service.containerPort}`);
    let seedDir: string | undefined;
    if (service.seedObject && service.seedContainerPath) {
      const data = seeds.get(service.seedObject);
      if (data) {
        // The seed rides a private host temp file bind-mounted read-only —
        // each instance starts from the object store's current version.
        seedDir = fs.mkdtempSync(path.join(os.tmpdir(), `karmax-seed-${taskId}-`));
        const seedFile = path.join(seedDir, path.basename(service.seedContainerPath));
        fs.writeFileSync(seedFile, data, { mode: 0o644 });
        args.push('-v', `${seedFile}:${service.seedContainerPath}:ro`);
      } else result.warnings.push(`service ${service.name}: seed object ${service.seedObject} is not declared as a project object`);
    }
    args.push(service.image!);
    if (service.command?.length) args.push(...service.command);
    const run = await docker(args, { timeoutMs: 10 * 60_000 }); // may pull the image
    if (run.code !== 0) {
      result.warnings.push(`service ${service.name} did not start: ${(run.stderr || run.stdout).slice(0, 300)}`);
      if (seedDir) fs.rmSync(seedDir, { recursive: true, force: true });
      continue;
    }
    result.containers.push(container);
    if (service.containerPort && service.urlEnv && service.urlTemplate) {
      const port = await publishedPort(container, service.containerPort);
      if (port) result.env[service.urlEnv] = service.urlTemplate.replace(/\{host\}/g, '127.0.0.1').replace(/\{port\}/g, String(port));
      else result.warnings.push(`service ${service.name}: could not resolve its published port`);
    }
  }
  return result;
}

/** Tear down every service container this task's worlds started. Cheap no-op
 * without Docker or containers; keyed by label, so renames cannot orphan. */
export async function destroyWorldServices(taskId: string): Promise<void> {
  const listed = await docker(['ps', '-aq', '--filter', `label=karmax.task=${taskId}`], { timeoutMs: 10_000 });
  const ids = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (ids.length) await docker(['rm', '-f', ...ids], { timeoutMs: 60_000 });
}

async function publishedPort(container: string, containerPort: number): Promise<number | undefined> {
  const r = await docker(['port', container, String(containerPort)], { timeoutMs: 10_000 });
  const m = r.stdout.match(/:(\d+)\s*$/m);
  return m ? Number(m[1]) : undefined;
}

function containerName(taskId: string, service: string): string {
  return `karmax-svc-${taskId}-${service}`.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 63);
}

/** The service connection env a handle carries (per-world throwaway values). */
export function serviceEnvManifest(meta: Record<string, unknown> | undefined): Record<string, string> {
  const raw = meta?.serviceEnv;
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}
