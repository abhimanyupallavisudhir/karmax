import { describe, it, expect, beforeAll } from 'vitest';
import { ProjectServices, composeServiceProposals } from '../src/store/project-services.js';
import { launchWorldServices, destroyWorldServices, servicesDockerAvailable, serviceEnvManifest } from '../src/world/services.js';

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

let DOCKER = false;
beforeAll(async () => {
  DOCKER = await servicesDockerAvailable();
});

describe.skipIf(process.env.KARMAX_SKIP_DOCKER === '1')('per-world services (Docker)', () => {
  it('launches a seeded service, renders its connection env, and tears it down', async () => {
    if (!DOCKER) return; // self-skip without Docker
    const taskId = `svc-test-${Date.now()}`;
    try {
      const launched = await launchWorldServices(taskId, [{
        name: 'echo', kind: 'per-world', image: 'node:22-slim', containerPort: 8080,
        urlEnv: 'ECHO_URL', urlTemplate: 'http://{host}:{port}',
        env: { MARKER: 'hello-from-service' },
        seedObject: 'greeting.txt', seedContainerPath: '/seed/greeting.txt',
        command: ['node', '-e', `require('http').createServer((q,s)=>s.end(process.env.MARKER+':'+require('fs').readFileSync('/seed/greeting.txt','utf8'))).listen(8080)`],
      }], new Map([['greeting.txt', Buffer.from('seeded')]]));
      expect(launched.warnings).toEqual([]);
      expect(launched.containers.length).toBe(1);
      const url = launched.env.ECHO_URL!;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // The instance is private, seeded, and reachable at the rendered URL.
      let body = '';
      for (let i = 0; i < 50 && !body; i++) {
        body = await fetch(url).then((r) => r.text()).catch(() => '');
        if (!body) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(body).toBe('hello-from-service:seeded');
    } finally {
      await destroyWorldServices(taskId);
    }
    // Teardown by label leaves nothing behind.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const left = await promisify(execFile)('docker', ['ps', '-aq', '--filter', `label=karmax.task=${taskId}`]);
    expect(left.stdout.trim()).toBe('');
  }, 300_000);
});
