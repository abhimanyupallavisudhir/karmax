import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectServices, composeServiceProposals } from '../src/store/project-services.js';
import { launchWorldServices, destroyWorldServices, sweepOrphanedServiceContainers, serviceEnvManifest } from '../src/world/services.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

const pexec = promisify(execFile);

function memoryKv() {
  const kv = new Map<string, string>();
  return { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: string) => void kv.set(k, v) };
}

describe('ProjectServices registry', () => {
  it('validates and stores external and per-world services', () => {
    const services = new ProjectServices(memoryKv());
    services.save('p1', { name: 'staging-db', kind: 'external', connectionSecret: 'DATABASE_URL' });
    services.save('p1', { name: 'postgres', kind: 'per-world', image: 'postgres:16', containerPort: 5432,
      urlEnv: 'DATABASE_URL', urlTemplate: 'postgres://postgres@{host}:{port}/dev' });
    expect(services.list('p1').map((s) => s.name).sort()).toEqual(['postgres', 'staging-db']);
    expect(() => services.save('p1', { name: 'bad name!', kind: 'external', connectionSecret: 'X' })).toThrow(/alphanumeric/);
    expect(() => services.save('p1', { name: 'nosecret', kind: 'external' })).toThrow(/Secret/);
    expect(() => services.save('p1', { name: 'noimage', kind: 'per-world' })).toThrow(/image/);
    expect(() => services.save('p1', { name: 'seedy', kind: 'per-world', image: 'x', seedObject: 'db.sql' })).toThrow(/seedContainerPath/);
    services.delete('p1', 'staging-db');
    expect(services.list('p1').map((s) => s.name)).toEqual(['postgres']);
  });
});

describe('composeServiceProposals', () => {
  it('imports image services with ports, environment, and db connection defaults', () => {
    const proposals = composeServiceProposals(`
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: appdb
    ports: ["127.0.0.1:5433:5432"]
  cache:
    image: redis:7
    environment:
      - MAXMEMORY=64mb
  web:
    build: .
`);
    expect(proposals.map((s) => s.name).sort()).toEqual(['cache', 'db']); // build-only "web" is the Environment's job
    const db = proposals.find((s) => s.name === 'db')!;
    expect(db).toMatchObject({ kind: 'per-world', image: 'postgres:16', containerPort: 5432,
      urlEnv: 'DATABASE_URL', urlTemplate: 'postgres://app:dev@{host}:{port}/appdb' });
    const cache = proposals.find((s) => s.name === 'cache')!;
    expect(cache).toMatchObject({ containerPort: 6379, urlEnv: 'REDIS_URL', urlTemplate: 'redis://{host}:{port}',
      env: { MAXMEMORY: '64mb' } });
  });

  it('tolerates invalid yaml and missing services', () => {
    expect(composeServiceProposals('just: a\nscalar: doc')).toEqual([]);
    expect(() => composeServiceProposals('services: {db: {image: [}')).toThrow(/parse/);
  });
});

describe('serviceEnvManifest', () => {
  it('filters non-string values from handle meta', () => {
    expect(serviceEnvManifest({ serviceEnv: { DATABASE_URL: 'x', BAD: 42 } })).toEqual({ DATABASE_URL: 'x' });
    expect(serviceEnvManifest(undefined)).toEqual({});
  });
});

describe('launch goes through the world contract', () => {
  it('execs docker in-world and seeds through the world filesystem (the cloud-sandbox path)', async () => {
    const calls: string[][] = [];
    const files: Record<string, Buffer> = {};
    const world: any = {
      handle: { kind: 'e2b', id: 'sbx1', root: '/workspace/repo', branch: 'b', base: 'main' },
      exec: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        if (cmd === 'docker' && args[0] === 'version') return { stdout: '27.0\n', stderr: '', code: 0 };
        if (cmd === 'docker' && args[0] === 'inspect') return { stdout: '172.17.0.5\n', stderr: '', code: 0 };
        if (cmd === 'docker' && args[0] === 'port') return { stdout: '127.0.0.1:45678\n', stderr: '', code: 0 };
        return { stdout: 'cid\n', stderr: '', code: 0 };
      },
      writeFile: async (p: string, c: string) => { files[p] = Buffer.from(c); },
      writeFileBuffer: async (p: string, c: Buffer) => { files[p] = c; },
    };
    const launched = await launchWorldServices(world, 'sbx1', [{
      name: 'db', kind: 'per-world', image: 'postgres:16', containerPort: 5432,
      urlEnv: 'DATABASE_URL', urlTemplate: 'postgres://u@{host}:{port}/d',
      seedObject: 'init.sql', seedContainerPath: '/docker-entrypoint-initdb.d/init.sql',
    }], new Map([['init.sql', Buffer.from('CREATE TABLE x;')]]));
    expect(launched.warnings).toEqual([]);
    // Bridge-IP routing: the world's own network namespace, no docker-proxy.
    expect(launched.env.DATABASE_URL).toBe('postgres://u@172.17.0.5:5432/d');
    // Seed traveled through the world's own filesystem, not a host temp dir.
    expect(files['.karmax-services/db/init.sql']!.toString()).toBe('CREATE TABLE x;');
    const run = calls.find((c) => c[0] === 'docker' && c[1] === 'run')!;
    expect(run).toContain('/workspace/repo/.karmax-services/db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro');
    expect(run.join(' ')).toContain('karmax.task=sbx1');
  });

  it('warns (and injects nothing) when the world has no Docker', async () => {
    const world: any = {
      handle: { kind: 'daytona', id: 'sbx2', root: '/w', branch: 'b', base: 'main' },
      exec: async () => ({ stdout: '', stderr: 'docker: not found', code: 127 }),
    };
    const launched = await launchWorldServices(world, 'sbx2',
      [{ name: 'db', kind: 'per-world', image: 'postgres:16' }], new Map());
    expect(launched.containers).toEqual([]);
    expect(launched.warnings.join(' ')).toMatch(/need Docker inside this world/);
  });
});

let DOCKER = false;
beforeAll(async () => {
  DOCKER = await pexec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 })
    .then(() => true).catch(() => false);
});

describe.skipIf(process.env.KARMAX_SKIP_DOCKER === '1')('per-world services (Docker via a real worktree world)', () => {
  it('launches a seeded service, keeps git clean, and the orphan sweep reaps it', async () => {
    if (!DOCKER) return; // self-skip without Docker
    // A private KARMAX_HOME isolates the karmax.home label: the sweep below
    // must never be able to see (let alone reap) a live installation's
    // service containers on this shared Docker daemon.
    const prevKarmaxHome = process.env.KARMAX_HOME;
    process.env.KARMAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-svchome-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-svcw-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-svcrepo-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'index.js'), '1\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    const taskId = `svc-test-${Date.now()}`;
    const world = await new WorktreeProvider(home).create({ taskId, repo, base: 'main', target: 'main' });
    try {
      const launched = await launchWorldServices(world, taskId, [{
        name: 'echo', kind: 'per-world', image: 'node:22-slim', containerPort: 8080,
        urlEnv: 'ECHO_URL', urlTemplate: 'http://{host}:{port}',
        env: { MARKER: 'hello-from-service' },
        seedObject: 'greeting.txt', seedContainerPath: '/seed/greeting.txt',
        command: ['node', '-e', `require('http').createServer((q,s)=>s.end(process.env.MARKER+':'+require('fs').readFileSync('/seed/greeting.txt','utf8'))).listen(8080)`],
      }], new Map([['greeting.txt', Buffer.from('seeded')]]));
      expect(launched.warnings).toEqual([]);
      const url = launched.env.ECHO_URL!;
      expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
      let body = '';
      for (let i = 0; i < 25 && !body; i++) {
        body = await fetch(url).then((r) => r.text()).catch(() => '');
        if (!body) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!body) {
        // Host→container routing can be wedged (e.g. after a host suspend,
        // until the Docker daemon restarts). A sibling container on the same
        // bridge still reaches the service — via the bridge IP, since the
        // published 127.0.0.1 port only exists on the host — which is what
        // proves the launcher: up, seeded, addressed.
        const ip = (await pexec('docker', ['inspect', '-f',
          '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', launched.containers[0]!])).stdout.trim();
        const sibling = await pexec('docker', ['run', '--rm', 'node:22-slim', 'node', '-e',
          `fetch('http://${ip}:8080').then((r)=>r.text()).then((t)=>console.log(t)).catch((e)=>{console.error(e);process.exit(1)})`],
          { timeout: 60_000 });
        body = sibling.stdout.trim();
        console.warn('host→container routing unavailable (restart the Docker daemon); verified via a sibling container');
      }
      expect(body).toBe('hello-from-service:seeded');
      // The seed lives in the worktree but git never sees it (world-scoped exclude).
      const status = await world.exec('git', ['status', '--porcelain']);
      expect(status.stdout.trim()).toBe('');
      // A crash would leave the container running — the boot sweep reaps it
      // once its world is gone, and only this installation's containers.
      const reaped = await sweepOrphanedServiceContainers(() => 'released');
      expect(reaped).toBeGreaterThanOrEqual(1);
      const left = await pexec('docker', ['ps', '-aq', '--filter', `label=karmax.task=${taskId}`]);
      expect(left.stdout.trim()).toBe('');
    } finally {
      await destroyWorldServices(taskId);
      await world.destroy().catch(() => undefined);
      fs.rmSync(process.env.KARMAX_HOME!, { recursive: true, force: true });
      if (prevKarmaxHome === undefined) delete process.env.KARMAX_HOME;
      else process.env.KARMAX_HOME = prevKarmaxHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 300_000);
});
