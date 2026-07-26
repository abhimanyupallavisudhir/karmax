import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeProvider } from '../src/world/worktree.js';
import { destroyWorldServices, launchWorldServices, sweepOrphanedServiceContainers } from '../src/world/services.js';
import { ensureWorldExcluded } from '../src/world/secret-exclude.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';

const pexec = promisify(execFile);
let docker = false;
beforeAll(async () => {
  docker = await pexec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5_000 })
    .then(() => true).catch(() => false);
});

describe.skipIf(process.env.KARMAX_SKIP_DOCKER === '1')('per-world services (real Docker)', () => {
  it('launches from a typed seed resource and the orphan sweep removes it', async () => {
    if (!docker) return;
    const previousHome = process.env.KARMAX_HOME;
    const installation = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-service-installation-'));
    const worldsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-service-worlds-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-service-repo-'));
    process.env.KARMAX_HOME = installation;
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'app.txt'), 'base\n');
    await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    const taskId = `service-test-${Date.now()}`;
    const world = await new WorktreeProvider(worldsHome).create({ taskId, repo, base: 'main' });
    try {
      await world.writeFile('resources/greeting/greeting.txt', 'seeded');
      await ensureWorldExcluded(world, 'resources/greeting');
      const resources = new Map([['seed-resource', {
        id: 'seed-resource', target: { kind: 'path', path: 'resources/greeting' },
      } as any]]);
      const launched = await launchWorldServices(world, taskId, [{
        name: 'echo', kind: 'per-world', image: 'node:22-slim', containerPort: 8080,
        urlEnv: 'ECHO_URL', urlTemplate: 'http://{host}:{port}',
        env: { MARKER: 'typed-service' }, seedResourceId: 'seed-resource', seedContainerPath: '/seed',
        command: ['node', '-e',
          "require('http').createServer((_q,s)=>s.end(process.env.MARKER+':'+require('fs').readFileSync('/seed/greeting.txt','utf8'))).listen(8080)"],
      }], resources);
      expect(launched.warnings).toEqual([]);
      let body = '';
      for (let attempt = 0; attempt < 30 && !body; attempt++) {
        body = await fetch(launched.env.ECHO_URL!).then((response) => response.text()).catch(() => '');
        if (!body) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!body) {
        const ip = (await pexec('docker', ['inspect', '-f',
          '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', launched.containers[0]!])).stdout.trim();
        body = (await pexec('docker', ['run', '--rm', 'node:22-slim', 'node', '-e',
          `fetch('http://${ip}:8080').then(r=>r.text()).then(console.log)`], { timeout: 60_000 })).stdout.trim();
      }
      expect(body).toBe('typed-service:seeded');
      expect((await world.exec('git', ['status', '--porcelain'])).stdout.trim()).toBe('');
      expect(await sweepOrphanedServiceContainers(() => 'released')).toBeGreaterThanOrEqual(1);
      expect((await pexec('docker', ['ps', '-aq', '--filter', `label=karmax.task=${taskId}`])).stdout.trim()).toBe('');
    } finally {
      await destroyWorldServices(taskId);
      await world.destroy().catch(() => undefined);
      if (previousHome === undefined) delete process.env.KARMAX_HOME;
      else process.env.KARMAX_HOME = previousHome;
      for (const target of [installation, worldsHome, repo])
        fs.rmSync(target, { recursive: true, force: true });
    }
  }, 5 * 60_000);
});
