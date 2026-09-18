import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectEnvironment, parseDevcontainer, proposeEnvironment, stripJsonComments } from '../src/store/project-environment.js';
import { buildEnvironment, bootCommands, environmentDockerfile, environmentArtifactName, setupCommands, type BuilderSandbox } from '../src/world/environment-build.js';
import { ProjectServices, composeServiceProposals } from '../src/store/project-services.js';
import { launchWorldServices } from '../src/world/services.js';

function memoryKv() {
  const values = new Map<string, string>();
  return { kvGet: (key: string) => values.get(key), kvSet: (key: string, value: string) => void values.set(key, value) };
}

describe('project environment proposals and builds', () => {
  it('stores build-relevant recipes and tracks immutable provider artifacts', () => {
    const environment = new ProjectEnvironment(memoryKv());
    const spec = environment.setSpec('p', { image: 'node:22', setup: ['npm ci', ''], boot: ['echo boot'] });
    const digest = environment.digest(spec);
    expect(environment.digest({ ...spec, boot: ['changed'] })).toBe(digest);
    expect(environment.digest({ ...spec, setup: ['changed'] })).not.toBe(digest);
    environment.recordBuild('p', { provider: 'container', digest, status: 'building' });
    expect(environment.readyBuild('p', 'container', digest)).toBeUndefined();
    environment.recordBuild('p', { provider: 'container', digest, status: 'ready', ref: 'image:tag' });
    expect(environment.readyBuild('p', 'container', digest)?.ref).toBe('image:tag');
  });

  it('parses JSONC devcontainers and proposes setup from tracked declarations', () => {
    const parsed = parseDevcontainer(`{
      // comment-like text inside strings must survive
      "image": "example.invalid/http://node",
      "onCreateCommand": ["npm", "install", "--some flag"],
      "postCreateCommand": { "db": "npm run db:setup" },
      "dockerComposeFile": "compose.yaml",
    }`);
    expect(parsed.setup).toEqual(["npm install '--some flag'", 'npm run db:setup']);
    expect(JSON.parse(stripJsonComments('{"url":"http://x", /* c */ "ok":true,}'))).toEqual({ url: 'http://x', ok: true });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-env-proposal-'));
    try {
      fs.mkdirSync(path.join(dir, '.devcontainer'));
      fs.writeFileSync(path.join(dir, '.devcontainer/devcontainer.json'),
        '{"image":"node:22","postCreateCommand":"npm run setup","dockerComposeFile":"compose.yaml"}');
      fs.writeFileSync(path.join(dir, '.devcontainer/compose.yaml'), 'services: {}');
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      const proposal = proposeEnvironment([dir], { hasPerWorldServices: true });
      expect(proposal.spec).toMatchObject({ image: 'node:22', setup: ['npm run setup', 'npm ci'], includeDocker: true });
      expect(proposal.composeFiles).toEqual([path.join(dir, '.devcontainer/compose.yaml')]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('realizes host and fake-E2B builds and includes Docker when requested', async () => {
    expect(await buildEnvironment({ provider: 'worktree', projectId: 'p', digest: 'd', spec: {} })).toEqual({ ref: 'host' });
    const dockerfile = environmentDockerfile({ image: 'node:22-slim', setup: ['npm ci'], includeDocker: true });
    expect(dockerfile).toContain('get.docker.com');
    expect(dockerfile).toContain('RUN npm ci');
    expect(setupCommands({ includeDocker: true })[0]).toContain('get.docker.com');
    expect(bootCommands({ includeDocker: true })[0]).toContain('dockerd');

    const calls: string[] = [];
    let builderBase: string | undefined;
    let killed = false;
    const builder: BuilderSandbox = {
      async run(command) { calls.push(command); return { exitCode: 0, stderr: '', stdout: '' }; },
      async createSnapshot(name) { calls.push(name); return { snapshotId: 'snapshot-1' }; },
      async kill() { killed = true; },
    };
    expect(await buildEnvironment({ provider: 'e2b', projectId: 'p', digest: 'd', buildId: 'attempt-1',
      spec: { image: 'node:22-slim', setup: ['npm ci'] }, connection: { template: 'compute-template' },
      createBuilderSandbox: async (base) => { builderBase = base; return builder; } })).toEqual({ ref: 'snapshot-1' });
    expect(builderBase).toBe('compute-template');
    expect(calls).toContain('npm ci');
    expect(calls).toContain(environmentArtifactName('p', 'd', 'attempt-1'));
    expect(killed).toBe(true);
  });

  it('always kills a failed remote builder and identifies the setup command', async () => {
    let killed = false;
    const builder: BuilderSandbox = {
      async run(command) {
        return command === 'bad setup' ? { exitCode: 1, stderr: 'boom', stdout: '' }
          : { exitCode: 0, stderr: '', stdout: '' };
      },
      async createSnapshot() { throw new Error('must not snapshot a failed build'); },
      async kill() { killed = true; },
    };
    await expect(buildEnvironment({ provider: 'e2b', projectId: 'p', digest: 'd',
      spec: { setup: ['good setup', 'bad setup'] }, createBuilderSandbox: async () => builder }))
      .rejects.toThrow(/"bad setup" failed: boom/);
    expect(killed).toBe(true);
  });
});

describe('service proposals', () => {
  it('validates external connections and per-world service shapes', () => {
    const services = new ProjectServices(memoryKv());
    expect(() => services.save('p', { name: 'bad name', kind: 'per-world', image: 'postgres:16' }))
      .toThrow(/alphanumeric/);
    expect(() => services.save('p', { name: 'external', kind: 'external' }))
      .toThrow(/secret resource/);
    expect(() => services.save('p', { name: 'seed', kind: 'per-world', image: 'postgres:16',
      seedResourceId: 'resource-1' })).toThrow(/container path/);
  });

  it('derives isolated service recipes from Compose and stores typed resource references', () => {
    const proposals = composeServiceProposals(`
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
    ports: ["15432:5432"]
  built:
    build: .
`);
    expect(proposals).toEqual([expect.objectContaining({
      name: 'postgres', kind: 'per-world', containerPort: 5432, urlEnv: 'DATABASE_URL',
      urlTemplate: 'postgres://app:secret@{host}:{port}/app',
    })]);
    const services = new ProjectServices(memoryKv());
    expect(services.save('p', { ...proposals[0]!, seedResourceId: 'resource-1',
      seedContainerPath: '/docker-entrypoint-initdb.d/seed.sql' }).seedResourceId).toBe('resource-1');
    expect(composeServiceProposals('metadata: only')).toEqual([]);
    expect(() => composeServiceProposals('services: {db: {image: [}')).toThrow(/parse/);
  });

  it('provisions through the world contract and mounts an existing typed resource as its seed', async () => {
    const calls: string[][] = [];
    const world: any = {
      handle: { kind: 'e2b', id: 'world-1', root: '/workspace/project', branch: 'task', base: 'main' },
      async exec(command: string, args: string[]) {
        calls.push([command, ...args]);
        if (args[0] === 'version') return { code: 0, stdout: '27.0', stderr: '' };
        if (args[0] === 'inspect') return { code: 0, stdout: '172.17.0.5\n', stderr: '' };
        return { code: 0, stdout: 'container-id\n', stderr: '' };
      },
    };
    const resources = new Map([['seed-resource', {
      id: 'seed-resource', target: { kind: 'path', path: 'resources/database-seed' },
    } as any]]);
    const launched = await launchWorldServices(world, 'task-1', [{
      name: 'database', kind: 'per-world', image: 'postgres:16', containerPort: 5432,
      urlEnv: 'DATABASE_URL', urlTemplate: 'postgres://app@{host}:{port}/app',
      seedResourceId: 'seed-resource', seedContainerPath: '/docker-entrypoint-initdb.d',
    }], resources);
    expect(launched.env.DATABASE_URL).toBe('postgres://app@172.17.0.5:5432/app');
    const run = calls.find((call) => call[0] === 'docker' && call[1] === 'run')!;
    expect(run).toContain('/workspace/project/resources/database-seed:/docker-entrypoint-initdb.d:ro');
    expect(run.join(' ')).toContain('karmax.task=task-1');
  });

  it('degrades to a clear warning when the selected world has no Docker', async () => {
    const world: any = {
      handle: { kind: 'daytona', id: 'world-2', root: '/workspace', branch: 'task', base: 'main' },
      async exec() { return { code: 127, stdout: '', stderr: 'docker: not found' }; },
    };
    const launched = await launchWorldServices(world, 'task-2',
      [{ name: 'database', kind: 'per-world', image: 'postgres:16' }], new Map());
    expect(launched.containers).toEqual([]);
    expect(launched.env).toEqual({});
    expect(launched.warnings.join(' ')).toMatch(/need Docker inside this world/);
  });
});
