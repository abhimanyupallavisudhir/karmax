import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectEnvironmentSpec } from '../domain/types.js';

const pexec = promisify(execFile);
const DOCKER_SETUP = 'command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)';
export const DOCKER_BOOT = 'command -v dockerd >/dev/null 2>&1 && { docker info >/dev/null 2>&1 || '
  + '{ nohup dockerd >/tmp/karmax-dockerd.log 2>&1 & for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; }; } || true';

export interface EnvironmentBuildResult { ref: string }
export interface EnvironmentBuildInput {
  provider: string;
  projectId: string;
  digest: string;
  spec: ProjectEnvironmentSpec;
  connection?: { apiKey?: string; apiUrl?: string; target?: string };
  createBuilderSandbox?: (base: string | undefined, options: { apiKey?: string }) => Promise<BuilderSandbox>;
}
export interface BuilderSandbox {
  run(command: string, options: { timeoutMs: number }): Promise<{ exitCode: number; stderr: string; stdout: string }>;
  createSnapshot(name: string): Promise<{ snapshotId: string }>;
  kill(): Promise<void>;
}

export function setupCommands(spec: ProjectEnvironmentSpec): string[] {
  return [...(spec.includeDocker ? [DOCKER_SETUP] : []), ...(spec.setup ?? [])];
}
export function bootCommands(spec: ProjectEnvironmentSpec): string[] {
  return [...(spec.includeDocker ? [DOCKER_BOOT] : []), ...(spec.boot ?? [])];
}
export function environmentArtifactName(projectId: string, digest: string): string {
  return `karmax-env-${projectId.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${digest}`.toLowerCase();
}
export function environmentDockerfile(spec: ProjectEnvironmentSpec): string {
  return `${[`FROM ${spec.image ?? 'node:22-slim'}`, ...setupCommands(spec).map((command) => `RUN ${command}`)].join('\n')}\n`;
}

export async function buildEnvironment(input: EnvironmentBuildInput): Promise<EnvironmentBuildResult> {
  if (input.provider === 'worktree' || input.provider === 'memory') return { ref: 'host' };
  if (input.provider === 'container') return buildContainer(input);
  if (input.provider === 'e2b') return buildE2b(input);
  if (input.provider === 'daytona') return buildDaytona(input);
  throw new Error(`environment builds are not supported for provider "${input.provider}"`);
}

async function buildContainer(input: EnvironmentBuildInput): Promise<EnvironmentBuildResult> {
  const tag = environmentArtifactName(input.projectId, input.digest);
  const context = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-envbuild-'));
  try {
    fs.writeFileSync(path.join(context, 'Dockerfile'), environmentDockerfile(input.spec));
    await pexec('docker', ['build', '-t', tag, context], { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return { ref: tag };
  } catch (error: any) {
    throw new Error(`docker build failed: ${(error.stderr || error.message || String(error)).slice(-800)}`);
  } finally { fs.rmSync(context, { recursive: true, force: true }); }
}

async function buildE2b(input: EnvironmentBuildInput): Promise<EnvironmentBuildResult> {
  const create = input.createBuilderSandbox ?? (async (base, options) => {
    const { Sandbox } = await import('e2b');
    const sandbox: any = base
      ? await (Sandbox as any).create(base, { ...options, timeoutMs: 45 * 60_000 })
      : await (Sandbox as any).create({ ...options, timeoutMs: 45 * 60_000 });
    return {
      async run(command: string, runOptions: { timeoutMs: number }) {
        const result = await sandbox.commands.run(`bash -lc ${quote(command)}`, runOptions);
        return { exitCode: result.exitCode ?? 0, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
      },
      async createSnapshot(name: string) {
        const snapshot = await sandbox.createSnapshot({ name });
        return { snapshotId: String(snapshot.snapshotId ?? name) };
      },
      async kill() { await sandbox.kill().catch(() => undefined); },
    } satisfies BuilderSandbox;
  });
  const builder = await create(input.spec.image,
    { ...(input.connection?.apiKey ? { apiKey: input.connection.apiKey } : {}) });
  try {
    for (const command of setupCommands(input.spec)) {
      const result = await builder.run(command, { timeoutMs: 30 * 60_000 });
      if (result.exitCode !== 0) throw new Error(`setup "${command}" failed: ${(result.stderr || result.stdout).slice(-500)}`);
    }
    return { ref: (await builder.createSnapshot(environmentArtifactName(input.projectId, input.digest))).snapshotId };
  } finally { await builder.kill(); }
}

async function buildDaytona(input: EnvironmentBuildInput): Promise<EnvironmentBuildResult> {
  const sdk: any = await import('@daytona/sdk').catch(() => undefined);
  if (!sdk?.Daytona || !sdk.Image?.base) throw new Error('this Daytona SDK cannot build snapshots declaratively');
  const daytona = new sdk.Daytona({
    ...(input.connection?.apiKey ? { apiKey: input.connection.apiKey } : {}),
    ...(input.connection?.apiUrl ? { apiUrl: input.connection.apiUrl } : {}),
    ...(input.connection?.target ? { target: input.connection.target } : {}),
  });
  if (!daytona.snapshot?.create) throw new Error('this Daytona SDK cannot create snapshots');
  let image = sdk.Image.base(input.spec.image ?? 'ubuntu:22.04');
  const commands = setupCommands(input.spec);
  if (commands.length) image = image.runCommands(...commands);
  const name = environmentArtifactName(input.projectId, input.digest);
  await daytona.snapshot.create({ name, image }, { timeout: 45 * 60_000 });
  return { ref: name };
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
