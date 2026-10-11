import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Memory caps (deploy/README.md, "Memory caps"): every container's cap comes
// from .turnkey.env with the original 8 GB host's value as its default, and
// PostgreSQL sizes itself to its own cap (deploy/postgres/postgres-memory.sh).
// CI's deploy-artifacts job renders both with `docker compose config` and
// boots the stack; this checks the files and the script without Docker.
const deployDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy');
const read = (file: string) => fs.readFileSync(path.join(deployDir, file), 'utf8');
type Service = { mem_limit?: string; entrypoint?: string[]; command?: string[]; environment?: Record<string, string> };
const services = (file: string) => (parse(read(file)) as { services: Record<string, Service> }).services;

describe('container memory caps', () => {
  it('reads every turnkey cap from .turnkey.env, defaulting to the 8 GB host\'s', () => {
    const caps = Object.fromEntries(Object.entries(services('compose.turnkey.yml')).map(([name, s]) => [name, s.mem_limit]));
    expect(caps).toEqual({
      postgresql: '${KARMAX_POSTGRES_MEM_LIMIT:-768m}',
      'pg-backup': '${KARMAX_PG_BACKUP_MEM_LIMIT:-512m}',
      'temporal-schema': '${KARMAX_TEMPORAL_SCHEMA_MEM_LIMIT:-512m}',
      'karmax-database': '${KARMAX_DATABASE_ROLE_MEM_LIMIT:-256m}',
      temporal: '${KARMAX_TEMPORAL_MEM_LIMIT:-2g}',
      'temporal-namespace': '${KARMAX_TEMPORAL_NAMESPACE_MEM_LIMIT:-512m}',
      app: '${KARMAX_APP_MEM_LIMIT:-4g}',
      caddy: '${KARMAX_CADDY_MEM_LIMIT:-512m}',
    });
    const hosted = services('compose.hosted.yml');
    expect([hosted.app?.mem_limit, hosted.caddy?.mem_limit]).toEqual(['${KARMAX_APP_MEM_LIMIT:-4g}', '${KARMAX_CADDY_MEM_LIMIT:-512m}']);
    // No CPU limits anywhere: the app's concurrency derives from the host's cores.
    for (const file of ['compose.turnkey.yml', 'compose.hosted.yml']) expect(read(file)).not.toMatch(/^\s+(cpus|cpu_quota|cpuset):/m);
  });

  it('starts PostgreSQL through the sizing script the image installs', () => {
    const postgresql = services('compose.turnkey.yml').postgresql!;
    expect(postgresql.entrypoint).toEqual(['/usr/local/bin/karmax-postgres']);
    expect(postgresql.command?.[0]).toBe('postgres');
    expect(postgresql.environment?.KARMAX_POSTGRES_MAX_CONNECTIONS).toBe('${KARMAX_POSTGRES_MAX_CONNECTIONS:-100}');
    expect(read('Postgres.Dockerfile')).toContain('COPY --chmod=755 postgres/postgres-memory.sh /usr/local/bin/karmax-postgres');
  });

  // Rendering needs only the Compose CLI, not a daemon; CI always has it.
  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!compose)('renders with the defaults and with overrides', () => {
    const env = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-compose-')), 'ci.env');
    const render = (extra: string) => {
      fs.writeFileSync(env, `KARMAX_DOMAIN=karmax.example.com\nKARMAX_PREVIEW_DOMAIN=preview.karmax.example.com\nPOSTGRES_PASSWORD=ci\n${extra}`);
      const result = spawnSync('docker', ['compose', '--project-directory', deployDir, '--env-file', env,
        '-f', path.join(deployDir, 'compose.turnkey.yml'), 'config', '--format', 'json'], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return (JSON.parse(result.stdout) as { services: Record<string, Service> }).services;
    };
    const GiB = 1024 ** 3;
    const defaults = render('');
    expect(Number(defaults.app!.mem_limit)).toBe(4 * GiB);
    expect(Number(defaults.postgresql!.mem_limit)).toBe(768 * 1024 ** 2);
    const sized = render('KARMAX_APP_MEM_LIMIT=7g\nKARMAX_POSTGRES_MEM_LIMIT=3g\nKARMAX_POSTGRES_MAX_CONNECTIONS=150\n');
    expect(Number(sized.app!.mem_limit)).toBe(7 * GiB);
    expect(Number(sized.postgresql!.mem_limit)).toBe(3 * GiB);
    expect(Number(sized.temporal!.mem_limit)).toBe(2 * GiB);
    expect(sized.postgresql!.environment?.KARMAX_POSTGRES_MAX_CONNECTIONS).toBe('150');
    fs.rmSync(path.dirname(env), { recursive: true, force: true });
  });
});

describe('PostgreSQL sized to its cap', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  /** Runs the script against a fake cgroup and a 16 GiB host; a fake
   * docker-entrypoint.sh prints the arguments it would start with. */
  function start(memoryMax: string | undefined, args: string[], env: Record<string, string> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pg-memory-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'cgroup'));
    if (memoryMax !== undefined) fs.writeFileSync(path.join(root, 'cgroup', 'memory.max'), `${memoryMax}\n`);
    fs.writeFileSync(path.join(root, 'meminfo'), 'MemTotal:       16777216 kB\nMemFree:         1000 kB\n');
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'docker-entrypoint.sh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    return spawnSync('sh', [path.join(deployDir, 'postgres', 'postgres-memory.sh'), ...args], { encoding: 'utf8',
      env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, KARMAX_CGROUP_ROOT: path.join(root, 'cgroup'),
        KARMAX_MEMINFO: path.join(root, 'meminfo'), ...env } });
  }
  const settings = (memoryMax: string | undefined, env: Record<string, string> = {}) => {
    const result = start(memoryMax, ['--print'], env);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const MiB = 1024 ** 2;

  it('derives shared_buffers, effective_cache_size, work_mem and maintenance_work_mem from the cap', () => {
    // The default 768m: a quarter for buffers (stock is 128 MB whatever the
    // cap), the defaults' 4 MB and 64 MB as floors.
    expect(settings(String(768 * MiB))).toBe('max_connections=100 shared_buffers=192MB effective_cache_size=576MB work_mem=4MB maintenance_work_mem=64MB');
    // The 16 GB host's 3g.
    expect(settings(String(3072 * MiB))).toBe('max_connections=100 shared_buffers=768MB effective_cache_size=2304MB work_mem=7MB maintenance_work_mem=192MB');
    // More allowed connections leave each less work_mem.
    expect(settings(String(3072 * MiB), { KARMAX_POSTGRES_MAX_CONNECTIONS: '150' }))
      .toBe('max_connections=150 shared_buffers=768MB effective_cache_size=2304MB work_mem=5MB maintenance_work_mem=192MB');
    // Tiny caps keep PostgreSQL's own defaults.
    expect(settings(String(256 * MiB))).toBe('max_connections=100 shared_buffers=128MB effective_cache_size=192MB work_mem=4MB maintenance_work_mem=64MB');
  });

  it('uses the host\'s memory when the container has no cap, and caps work_mem and maintenance_work_mem', () => {
    expect(settings('max')).toBe('max_connections=100 shared_buffers=4096MB effective_cache_size=12288MB work_mem=40MB maintenance_work_mem=1024MB');
    expect(settings(undefined)).toBe(settings('max'));
    // A cap above the host's memory is the host's memory.
    expect(settings(String(64 * 1024 * MiB))).toBe(settings('max'));
    expect(settings(String(256 * 1024 * MiB), { KARMAX_POSTGRES_MAX_CONNECTIONS: '10' })).toContain('work_mem=64MB');
  });

  it('starts the server with the settings ahead of its own, so the command still wins', () => {
    const result = start(String(3072 * MiB), ['postgres', '-c', 'wal_level=replica', '-c', 'work_mem=16MB']);
    expect(result.status, result.stderr).toBe(0);
    const argv = result.stdout.trim().split('\n');
    expect(argv[0]).toBe('postgres');
    expect(argv.slice(-4)).toEqual(['-c', 'wal_level=replica', '-c', 'work_mem=16MB']);
    expect(argv).toContain('shared_buffers=768MB');
    expect(argv.indexOf('work_mem=7MB')).toBeLessThan(argv.indexOf('work_mem=16MB'));
    // Anything but the server passes through untouched.
    expect(start(String(3072 * MiB), ['bash', '-c', 'true']).stdout.trim().split('\n')).toEqual(['bash', '-c', 'true']);
  });

  it('refuses a max_connections that is not a sensible whole number', () => {
    for (const value of ['lots', '5', '-1']) {
      const result = start(String(3072 * MiB), ['--print'], { KARMAX_POSTGRES_MAX_CONNECTIONS: value });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('KARMAX_POSTGRES_MAX_CONNECTIONS');
    }
  });
});
