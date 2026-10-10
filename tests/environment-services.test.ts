import { memoryTransaction } from './helpers/memory-transaction.js';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectEnvironment, localRepositoryFiles, parseDevcontainer, proposeEnvironment, stripJsonComments,
  type RepositoryFiles } from '../src/store/project-environment.js';
import { activateProjectRuntime } from '../src/world/project-runtime.js';
import type { World } from '../src/world/types.js';
import { sizedTemplateName } from '../src/world/e2b-template.js';
import { buildEnvironment, bootCommands, environmentDockerfile, environmentArtifactName, setupCommands, type BuilderSandbox } from '../src/world/environment-build.js';
import { ProjectServices, composeServiceProposals } from '../src/store/project-services.js';
import { DEFAULT_E2B_TEMPLATE } from '../src/world/e2b-template.js';
import { launchWorldServices } from '../src/world/services.js';

function memoryKv() {
  const values = new Map<string, string>();
  return { transaction: memoryTransaction(values), kvGet: (key: string) => values.get(key), kvSet: (key: string, value: string) => void values.set(key, value) };
}

describe('project environment proposals and builds', () => {
  it('stores build-relevant recipes and tracks immutable provider artifacts', async () => {
    const environment = new ProjectEnvironment(memoryKv());
    const spec = (await environment.setSpec('p', { image: 'node:22', setup: ['apt-get install -y jq', ''], boot: ['echo boot'],
      install: { app: [' npm ci ', ''], empty: [''] } }));
    expect(spec.install).toEqual({ app: ['npm ci'] });
    const digest = environment.digest(spec);
    expect(environment.digest({ ...spec, boot: ['changed'] })).toBe(digest);
    // Repository installs run in every world after checkout, never in the snapshot.
    expect(environment.digest({ ...spec, install: { app: ['changed'] } })).toBe(digest);
    expect(environment.digest({ ...spec, setup: ['changed'] })).not.toBe(digest);
    (await environment.recordBuild('p', { provider: 'container', digest, status: 'building' }));
    expect((await environment.readyBuild('p', 'container', digest))).toBeUndefined();
    (await environment.recordBuild('p', { provider: 'container', digest, status: 'ready', ref: 'image:tag' }));
    expect((await environment.readyBuild('p', 'container', digest))?.ref).toBe('image:tag');
  });

  it('parses JSONC devcontainers and proposes repository installs from tracked declarations', async () => {
    const parsed = parseDevcontainer(`{
      // comment-like text inside strings must survive
      "image": "example.invalid/http://node",
      "onCreateCommand": ["npm", "install", "--some flag"],
      "postCreateCommand": { "db": "npm run db:setup" },
      "dockerComposeFile": "compose.yaml",
    }`);
    expect(parsed.commands).toEqual(["npm install '--some flag'", 'npm run db:setup']);
    expect(JSON.parse(stripJsonComments('{"url":"http://x", /* c */ "ok":true,}'))).toEqual({ url: 'http://x', ok: true });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-env-proposal-'));
    try {
      fs.mkdirSync(path.join(dir, '.devcontainer'));
      fs.writeFileSync(path.join(dir, '.devcontainer/devcontainer.json'),
        '{"image":"node:22","postCreateCommand":"npm run setup","dockerComposeFile":"compose.yaml"}');
      fs.writeFileSync(path.join(dir, '.devcontainer/compose.yaml'), 'services: {}');
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      const proposal = await proposeEnvironment([localRepositoryFiles(dir, 'app')], { hasPerWorldServices: true });
      // Dependency installs need the checkout, so they are never snapshot setup.
      expect(proposal.spec).toEqual({ image: 'node:22', install: { app: ['npm run setup', 'npm ci'] }, includeDocker: true });
      expect(proposal.composeFiles).toEqual([path.join(dir, '.devcontainer/compose.yaml')]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('adds the browser download that Playwright dependencies need, per repository', async () => {
    const repository = (name: string, files: Record<string, string>): RepositoryFiles => ({
      name, files: Object.keys(files), read: async (file) => files[file],
    });
    const proposal = await proposeEnvironment([
      repository('web', { 'package-lock.json': '{}',
        'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '1.63.0' } }) }),
      repository('api', { 'uv.lock': '', 'pyproject.toml': '[project]\ndependencies = [\n  "playwright>=1.50",\n]\n' }),
      repository('worker', { 'requirements.txt': 'requests==2\npytest-playwright==0.5\n' }),
      repository('scraper', { 'requirements.txt': 'playwright-stealth==1\n' }),
      repository('lib', { 'package.json': JSON.stringify({ dependencies: { 'playwright-core': '1.63.0' } }), 'yarn.lock': '' }),
      repository('docs', { 'README.md': '# docs' }),
    ]);
    expect(proposal.spec).toEqual({ install: {
      web: ['npm ci', 'npx playwright install --with-deps chromium'],
      api: ['uv sync', 'uv run playwright install --with-deps chromium'],
      worker: ['pip install -r requirements.txt', 'python -m playwright install --with-deps chromium'],
      scraper: ['pip install -r requirements.txt', 'python -m playwright install --with-deps chromium'],
      // playwright-core ships no browser download of its own.
      lib: ['corepack enable && yarn install --frozen-lockfile'],
    } });
    expect(proposal.evidence).toContain('web: "npx playwright install --with-deps chromium" (package.json)');
  });

  it('hands repository installs to the agent instead of blocking world start on them', async () => {
    const calls: string[] = [];
    const world = {
      handle: { id: 'w', kind: 'e2b', root: '/world', branch: 'b', base: 'x', target: 'main',
        repos: [
          { name: 'app', repo: 'git@github.com:acme/app.git', root: '/world/app', branch: 'b', base: 'x', target: 'main', targetPinned: false },
          { name: 'wiki', role: 'project-wiki', repo: 'git@github.com:acme/wiki.git', root: '/world/wiki', branch: 'b', base: 'x', target: 'main', targetPinned: false },
        ] },
      async exec(_cmd: string, args: string[]) { calls.push(args[1]!); return { code: 0, stdout: '', stderr: '' }; },
    } as unknown as World;
    const store = { listResourceAttachments: async () => [] } as any;
    const runtime = await activateProjectRuntime({ world, store, projectId: 'p', taskId: 't', services: [], runSetupIfUnbuilt: true,
      selection: { built: false, spec: { setup: ['apt-get install -y jq'], boot: ['npm run migrate'],
        install: { app: ['npm ci', 'npx playwright install --with-deps chromium'], missing: ['npm ci'] } } } });
    // Installs cost ~45 s for a typical Node project; only tasks that build or test pay it.
    expect(calls).toEqual(['apt-get install -y jq', 'npm run migrate']);
    expect(runtime.handle.meta?.environmentInstall).toEqual([
      { repository: 'app', root: '/world/app', commands: ['npm ci', 'npx playwright install --with-deps chromium'] },
    ]);
    expect(runtime.warnings).toContain('environment install for "missing" skipped: this world has no repository with that name');
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
      createBuilderSandbox: async (base) => { builderBase = base; return builder; } })).toEqual({ ref: 'snapshot-1', base: 'compute-template' });
    expect(builderBase).toBe('compute-template');
    expect(calls).toContain('npm ci');
    expect(calls).toContain(environmentArtifactName('p', 'd', 'attempt-1'));
    expect(killed).toBe(true);
  });

  // Snapshots keep the size of the sandbox they were taken from, so a project
  // whose Computer is larger builds its environment at that size.
  it('builds an E2B environment at the project\'s computer size', async () => {
    const shape = { cpu: 4, memoryMb: 8192, diskGb: 40 };
    const ensured: unknown[] = [];
    let builderBase: string | undefined;
    const builder: BuilderSandbox = {
      async run() { return { exitCode: 0, stderr: '', stdout: '' }; },
      async createSnapshot() { return { snapshotId: 'snapshot-sized' }; },
      async kill() {},
    };
    const sized = sizedTemplateName('compute-template', shape);
    expect(await buildEnvironment({ provider: 'e2b', projectId: 'p', digest: 'd', spec: { setup: ['true'] },
      connection: { template: 'compute-template', apiKey: 'k' }, resources: { ...shape },
      ensureTemplate: async (...args) => { ensured.push(args); },
      createBuilderSandbox: async (base) => { builderBase = base; return builder; } })).toEqual({ ref: 'snapshot-sized', base: sized });
    expect(ensured).toEqual([['compute-template', sized, shape, { apiKey: 'k' }]]);
    expect(builderBase).toBe(sized);
  });

  // With no template under Compute, E2B would start the builder from its stock
  // 512 MiB `base` image, without the baked browser or overcommit that task
  // worlds rely on, and every world made from the snapshot inherits that
  // (2026-09-30: "MCP connections could not start: chrome-devtools" on each
  // resumed turn, in 478 MiB sandboxes). Build on what task worlds boot from.
  it.each([
    ['the default task-world template', undefined, DEFAULT_E2B_TEMPLATE],
    ['the installation template', ' installation-template ', 'installation-template'],
  ])('builds an E2B environment on %s when Compute names none', async (_case, installation, expected) => {
    const saved = process.env.KARMAX_E2B_TEMPLATE;
    if (installation === undefined) process.env.KARMAX_E2B_TEMPLATE = ''; else process.env.KARMAX_E2B_TEMPLATE = installation;
    try {
      let builderBase: string | undefined;
      const builder: BuilderSandbox = {
        async run() { return { exitCode: 0, stderr: '', stdout: '' }; },
        async createSnapshot() { return { snapshotId: 'snapshot-2' }; },
        async kill() {},
      };
      expect(await buildEnvironment({ provider: 'e2b', projectId: 'p', digest: 'd', spec: { setup: ['true'] },
        connection: {}, createBuilderSandbox: async (base) => { builderBase = base; return builder; } }))
        .toEqual({ ref: 'snapshot-2', base: expected });
      expect(builderBase).toBe(expected);
    } finally {
      if (saved === undefined) delete process.env.KARMAX_E2B_TEMPLATE; else process.env.KARMAX_E2B_TEMPLATE = saved;
    }
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
  it('validates external connections and per-world service shapes', async () => {
    const services = new ProjectServices(memoryKv());
    await expect((async () => (await services.save('p', { name: 'bad name', kind: 'per-world', image: 'postgres:16' })))()).rejects.toThrow(/alphanumeric/);
    await expect((async () => (await services.save('p', { name: 'external', kind: 'external' })))()).rejects.toThrow(/secret resource/);
    await expect((async () => (await services.save('p', { name: 'seed', kind: 'per-world', image: 'postgres:16',
      seedResourceId: 'resource-1' })))()).rejects.toThrow(/container path/);
  });

  it('derives isolated service recipes from Compose and stores typed resource references', async () => {
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
    expect((await services.save('p', { ...proposals[0]!, seedResourceId: 'resource-1',
      seedContainerPath: '/docker-entrypoint-initdb.d/seed.sql' })).seedResourceId).toBe('resource-1');
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
