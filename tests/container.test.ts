import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContainerWorldProvider, dockerAvailable } from '../src/world/container.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { buildEnvironment } from '../src/world/environment-build.js';
import { requireDocker } from './helpers/docker-gate.js';
import { platformToolHandlers } from '../src/agent/tools.js';

const pexec = promisify(execFile);

let DOCKER = false;
beforeAll(async () => {
  DOCKER = await dockerAvailable();
  if (process.env.KARMAX_SKIP_DOCKER !== '1') requireDocker(DOCKER);
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
    const provider = new ContainerWorldProvider(home);
    const world = await provider.create({ taskId: 'cw1', repo, base: 'main' });
    try {
      // a world write is what commands in the container see
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

  it('resolves file paths inside the container, never through symlinks to host files (WD-32)', async () => {
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cw-host-'));
    const secret = path.join(hostDir, 'vault.key');
    fs.writeFileSync(secret, 'host-only secret');
    const provider = new ContainerWorldProvider(home);
    const world = await provider.create({ taskId: 'cw-symlink', repo, base: 'main' });
    try {
      // What an agent's bash tool can do inside its own container (handed back
      // to the host user so the host-side cleanup can remove it).
      expect((await world.exec('sh', ['-c', 'ln -s "$1" leak && mkdir nested && ln -s "$2" nested/hostdir && chown -hR "$3" leak nested',
        'sh', secret, hostDir, `${process.getuid!()}:${process.getgid!()}`])).code).toBe(0);
      const tools = platformToolHandlers(world, { emit: () => undefined } as any);

      expect(await tools.read_file!({ path: 'leak' })).not.toContain('host-only secret');
      await expect(world.readFile('leak')).rejects.toThrow();
      await expect(world.readFileBuffer('leak')).rejects.toThrow();
      await expect(world.readFilePrefix!('leak', 1024)).rejects.toThrow();
      await expect(world.readFile('nested/hostdir/vault.key')).rejects.toThrow();

      await tools.write_file!({ path: 'leak', content: 'overwritten by write_file' }).catch(() => undefined);
      await world.writeFile('leak', 'overwritten by writeFile').catch(() => undefined);
      await world.writeFileBuffer!('nested/hostdir/vault.key', Buffer.from('overwritten')).catch(() => undefined);
      await world.writeFile('nested/hostdir/planted', 'planted').catch(() => undefined);
      expect(fs.readFileSync(secret, 'utf8')).toBe('host-only secret');
      expect(fs.readdirSync(hostDir)).toEqual(['vault.key']);

      // Symlinked directories are listed as entries, never walked.
      const files = await world.listFiles();
      expect(files).toEqual(expect.arrayContaining(['README.md', 'leak', 'nested/hostdir']));
      expect(files.some((file) => file.includes('vault.key'))).toBe(false);
    } finally {
      await world.destroy();
      fs.rmSync(hostDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('reads and writes text, binary and nested files through the container', async () => {
    const provider = new ContainerWorldProvider(home);
    const world = await provider.create({ taskId: 'cw-files', repo, base: 'main' });
    try {
      const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      await world.writeFile('a/b/c/text.txt', 'héllo\nworld\n');
      await world.writeFileBuffer!('bin/all-bytes.bin', binary);
      expect(await world.readFile('a/b/c/text.txt')).toBe('héllo\nworld\n');
      expect((await world.readFileBuffer('bin/all-bytes.bin')).equals(binary)).toBe(true);
      expect((await world.exec('cat', ['a/b/c/text.txt'])).stdout).toBe('héllo\nworld\n');
      // Files the platform writes stay the host user's, as on a host write.
      expect(fs.statSync(path.join(world.handle.root, 'a/b/c/text.txt')).uid).toBe(process.getuid!());
      expect(fs.statSync(path.join(world.handle.root, 'a/b')).uid).toBe(process.getuid!());
      expect(await world.listFiles()).toEqual(expect.arrayContaining(['README.md', 'a/b/c/text.txt', 'bin/all-bytes.bin']));

      expect((await world.exec('sh', ['-c', 'head -c 5000000 /dev/zero | tr "\\0" x > big.txt'])).code).toBe(0);
      const prefix = await world.readFilePrefix!('big.txt', 1000);
      expect(prefix.length).toBe(1000);
      expect(prefix.toString()).toBe('x'.repeat(1000));
      expect((await world.readFilePrefix!('bin/all-bytes.bin', 10_000)).equals(binary)).toBe(true);
      await expect(world.readFilePrefix!('a/b', 10)).rejects.toThrow();
      await expect(world.readFile('missing.txt')).rejects.toThrow();
    } finally { await world.destroy(); }
  }, 120_000);

  it('builds an immutable environment image and uses it for new worlds', async () => {
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
