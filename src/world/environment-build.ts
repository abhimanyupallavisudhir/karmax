import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectEnvironmentSpec } from '../domain/types.js';

const pexec = promisify(execFile);

/**
 * Environment builds (PLAN-cloud): realize a project's environment spec ONCE
 * into an immutable per-provider artifact, so task worlds boot from a copy
 * instead of re-running setup:
 * - worktree/memory — the host is the environment; nothing to build.
 * - container — `docker build` a local image from the generated Dockerfile.
 * - e2b — boot a builder sandbox, run setup, `createSnapshot`; worlds pass the
 *   snapshot id as their create selector (e2b.ts already honors it).
 * - daytona — declarative snapshot build on their infrastructure
 *   (feature-detected; the SDK is an optional dependency).
 * `includeDocker` bakes Docker into cloud builders so per-world services stop
 * depending on template luck; the matching dockerd start rides `bootCommands`.
 */

export interface EnvironmentBuildResult {
  ref: string;
}

export interface EnvironmentBuildInput {
  provider: string;
  projectId: string;
  digest: string;
  spec: ProjectEnvironmentSpec;
  connection?: { apiKey?: string; apiUrl?: string; target?: string };
  /** Test seam: a fake builder-sandbox factory (e2b path). */
  createBuilderSandbox?: (base: string | undefined, opts: { apiKey?: string }) => Promise<BuilderSandbox>;
}

/** The minimal surface the e2b build needs from a sandbox. */
export interface BuilderSandbox {
  run(command: string, opts: { timeoutMs: number }): Promise<{ exitCode: number; stderr: string; stdout: string }>;
  createSnapshot(name: string): Promise<{ snapshotId: string }>;
  kill(): Promise<void>;
}

const DOCKER_SETUP = 'command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)';
export const DOCKER_BOOT = 'command -v dockerd >/dev/null 2>&1 && { docker info >/dev/null 2>&1 || '
  + '{ nohup dockerd >/tmp/karmax-dockerd.log 2>&1 & for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; }; } || true';

/** The full build-time command list (spec setup plus baked extras). */
export function setupCommands(spec: ProjectEnvironmentSpec): string[] {
  return [...(spec.includeDocker ? [DOCKER_SETUP] : []), ...(spec.setup ?? [])];
}

/** The per-world boot command list (dockerd start plus spec boot). */
export function bootCommands(spec: ProjectEnvironmentSpec): string[] {
  return [...(spec.includeDocker ? [DOCKER_BOOT] : []), ...(spec.boot ?? [])];
}

export function environmentArtifactName(projectId: string, digest: string): string {
  return `karmax-env-${projectId.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${digest}`.toLowerCase();
}

/** The Dockerfile a container build realizes (also useful to show the user). */
export function environmentDockerfile(spec: ProjectEnvironmentSpec): string {
  const lines = [`FROM ${spec.image ?? 'node:22-slim'}`];
  for (const cmd of setupCommands(spec)) lines.push(`RUN ${cmd}`);
  return `${lines.join('\n')}\n`;
}

export async function buildEnvironment(input: EnvironmentBuildInput): Promise<EnvironmentBuildResult> {
  switch (input.provider) {
    case 'worktree':
    case 'memory':
      return { ref: 'host' }; // the host is the environment
    case 'container':
      return buildContainerImage(input);
    case 'e2b':
      return buildE2bSnapshot(input);
    case 'daytona':
      return buildDaytonaSnapshot(input);
    default:
      throw new Error(`environment builds are not supported for provider "${input.provider}"`);
  }
}

async function buildContainerImage(input: EnvironmentBuildInput): Promise<EnvironmentBuildResult> {
  const tag = environmentArtifactName(input.projectId, input.digest);
  const context = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-envbuild-'));
  try {
    fs.writeFileSync(path.join(context, 'Dockerfile'), environmentDockerfile(input.spec));
    await pexec('docker', ['build', '-t', tag, context], { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return { ref: tag };
  } catch (e: any) {
    throw new Error(`docker build failed: ${(e.stderr || e.message || String(e)).slice(-800)}`);
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

async function buildE2bSnapshot(input: EnvironmentBuildInput): Promise<EnvironmentBuildResult> {
  const createBuilder = input.createBuilderSandbox ?? (async (base, opts) => {
    const { Sandbox } = await import('e2b');
    const sandbox: any = base
      ? await (Sandbox as any).create(base, { ...opts, timeoutMs: 45 * 60_000 })
      : await (Sandbox as any).create({ ...opts, timeoutMs: 45 * 60_000 });
    return {
      async run(command: string, runOpts: { timeoutMs: number }) {
        const result = await sandbox.commands.run(`bash -lc ${shq(command)}`, { timeoutMs: runOpts.timeoutMs });
        return { exitCode: result.exitCode ?? 0, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
      },
      async createSnapshot(name: string) {
        const info = await sandbox.createSnapshot({ name });
        return { snapshotId: String(info.snapshotId ?? name) };
      },
      async kill() { await sandbox.kill().catch(() => undefined); },
    } satisfies BuilderSandbox;
  });
  const builder = await createBuilder(input.spec.image, { ...(input.connection?.apiKey ? { apiKey: input.connection.apiKey } : {}) });
  try {
    for (const command of setupCommands(input.spec)) {
      const result = await builder.run(command, { timeoutMs: 30 * 60_000 });
      if (result.exitCode !== 0) throw new Error(`setup "${command}" failed: ${(result.stderr || result.stdout).slice(-500)}`);
    }
    const snapshot = await builder.createSnapshot(environmentArtifactName(input.projectId, input.digest));
    return { ref: snapshot.snapshotId };
  } finally {
    await builder.kill();
  }
}

async function buildDaytonaSnapshot(input: EnvironmentBuildInput): Promise<EnvironmentBuildResult> {
  let sdk: any;
  try {
    sdk = await import('@daytona/sdk');
  } catch {
    throw new Error('the Daytona SDK is not installed on this control plane');
  }
  const { Daytona, Image } = sdk;
  if (!Daytona || !Image?.base) throw new Error('this Daytona SDK version cannot build snapshots declaratively');
  const daytona = new Daytona({
    ...(input.connection?.apiKey ? { apiKey: input.connection.apiKey } : {}),
    ...(input.connection?.apiUrl ? { apiUrl: input.connection.apiUrl } : {}),
    ...(input.connection?.target ? { target: input.connection.target } : {}),
  });
  if (!daytona.snapshot?.create) throw new Error('this Daytona SDK version cannot create snapshots');
  let image: any = Image.base(input.spec.image ?? 'ubuntu:22.04');
  const commands = setupCommands(input.spec);
  if (commands.length) {
    if (typeof image.runCommands !== 'function') throw new Error('this Daytona SDK version cannot run build commands');
    image = image.runCommands(...commands);
  }
  const name = environmentArtifactName(input.projectId, input.digest);
  await daytona.snapshot.create({ name, image }, { timeout: 45 * 60_000 });
  return { ref: name };
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
