import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContainerWorldProvider, dockerAvailable } from '../src/world/container.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { buildEnvironment } from '../src/world/environment-build.js';

const pexec = promisify(execFile);

let DOCKER = false;
beforeAll(async () => {
  DOCKER = await dockerAvailable();
});

describe.skipIf(process.env.KARMAX_SKIP_DOCKER === '1')('container world (Docker)', () => {
  let home: string;
  let repo: string;
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cw-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cwrepo-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# cw\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('runs commands inside an isolated container over a host-mounted worktree', async () => {
    if (!DOCKER) return; // skipped if no docker
    const provider = new ContainerWorldProvider(home);
    const world = await provider.create({ taskId: 'cw1', repo, base: 'main' });
    try {
      // a host write is visible inside the container (bind mount)
      await world.writeFile('hello.txt', 'from host');
      const seen = await world.exec('cat', ['hello.txt']);
      expect(seen.stdout).toContain('from host');
      // exec really runs in the container image (node present, Debian-based)
      const node = await world.exec('node', ['--version']);
      expect(node.stdout).toMatch(/^v\d+/);
      const osr = await world.exec('cat', ['/etc/os-release']);
      expect(osr.stdout.toLowerCase()).toMatch(/debian|ubuntu/);
    } finally {
      await world.destroy();
      // container is gone
      const { execFile } = await import('node:child_process');
      const exists: string = await new Promise((r) =>
        execFile('docker', ['ps', '-a', '--filter', 'name=karmax-cw1', '--format', '{{.Names}}'], (_e, so) => r(String(so).trim())),
      );
      expect(exists).toBe('');
    }
  }, 120_000);

  it('builds an immutable environment image and uses it for new worlds', async () => {
    if (!DOCKER) return;
    const built = await buildEnvironment({
      provider: 'container',
      projectId: 'container-test',
      digest: 'recipe-test',
      spec: { image: 'node:22', setup: ['printf karmax-ready >/karmax-environment-built'] },
    });
    try {
      const provider = new ContainerWorldProvider(home);
      const world = await provider.create({
        taskId: 'cw-environment',
        repo,
        base: 'main',
        environment: { image: built.ref },
      });
      try {
        expect(world.handle.meta?.image).toBe(built.ref);
        expect((await world.exec('cat', ['/karmax-environment-built'])).stdout).toBe('karmax-ready');
      } finally { await world.destroy(); }
    } finally {
      await pexec('docker', ['image', 'rm', '-f', built.ref]).catch(() => undefined);
    }
  }, 10 * 60_000);
});
