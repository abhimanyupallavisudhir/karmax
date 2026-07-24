import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectEnvironment, parseDevcontainer, proposeEnvironment, stripJsonComments } from '../src/store/project-environment.js';
import { buildEnvironment, environmentDockerfile, setupCommands, bootCommands, environmentArtifactName, type BuilderSandbox } from '../src/world/environment-build.js';

const pexec = promisify(execFile);

function memoryKv() {
  const kv = new Map<string, string>();
  return { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: string) => void kv.set(k, v) };
}

describe('ProjectEnvironment registry', () => {
  it('stores the spec, digests only the build-relevant half, and tracks build slots', () => {
    const env = new ProjectEnvironment(memoryKv());
    const spec = env.setSpec('p1', { image: 'node:22-slim', setup: ['npm ci', ''], boot: ['echo up'] });
    expect(spec).toEqual({ image: 'node:22-slim', setup: ['npm ci'], boot: ['echo up'] });
    const digest = env.digest(spec);
    expect(env.digest({ ...spec, boot: ['something else'] })).toBe(digest); // boot never invalidates
    expect(env.digest({ ...spec, setup: ['npm ci', 'extra'] })).not.toBe(digest);

    env.recordBuild('p1', { provider: 'container', digest, status: 'building' });
    expect(env.readyBuild('p1', 'container', digest)).toBeUndefined();
    env.recordBuild('p1', { provider: 'container', digest, ref: 'img:tag', status: 'ready' });
    expect(env.readyBuild('p1', 'container', digest)?.ref).toBe('img:tag');
    expect(env.readyBuild('p1', 'container', 'other-digest')).toBeUndefined(); // stale spec ⇒ no build
    expect(env.builds('p1').length).toBe(1); // upsert per (provider, digest)
  });
});

describe('devcontainer.json parsing', () => {
  it('handles comments, trailing commas, argv commands, and named command maps', () => {
    const parsed = parseDevcontainer(`{
      // the dev image
      "image": "mcr.microsoft.com/devcontainers/typescript-node:22",
      /* several setup shapes */
      "onCreateCommand": ["npm", "install", "--some flag"],
      "postCreateCommand": { "deps": "npm ci", "db": "npm run db:setup" },
      "dockerComposeFile": ".devcontainer/compose.yaml",
    }`);
    expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/typescript-node:22');
    expect(parsed.setup).toEqual(["npm install '--some flag'", 'npm ci', 'npm run db:setup']);
    expect(parsed.composeFiles).toEqual(['.devcontainer/compose.yaml']);
  });

  it('strips comments outside strings only', () => {
    expect(JSON.parse(stripJsonComments('{"a": "http://x", /* c */ "b": 1, }'))).toEqual({ a: 'http://x', b: 1 });
  });
});

describe('proposeEnvironment', () => {
  it('merges devcontainer image/setup with lockfile heuristics and the services docker flag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-envprop-'));
    try {
      fs.mkdirSync(path.join(dir, '.devcontainer'));
      fs.writeFileSync(path.join(dir, '.devcontainer/devcontainer.json'),
        '{ "image": "node:22", "postCreateCommand": "npm run setup", "dockerComposeFile": "compose.yaml" }');
      fs.writeFileSync(path.join(dir, '.devcontainer/compose.yaml'), 'services: {}');
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      const proposal = proposeEnvironment([dir], { hasPerWorldServices: true });
      expect(proposal.spec.image).toBe('node:22');
      expect(proposal.spec.setup).toEqual(['npm run setup', 'npm ci']);
      expect(proposal.spec.includeDocker).toBe(true);
      expect(proposal.composeFiles).toEqual([path.join(dir, '.devcontainer/compose.yaml')]);
      expect(proposal.evidence.join(' ')).toContain('devcontainer');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildEnvironment', () => {
  it('is a no-op for host-backed worlds', async () => {
    expect(await buildEnvironment({ provider: 'worktree', projectId: 'p', digest: 'd', spec: {} })).toEqual({ ref: 'host' });
  });

  it('generates a Dockerfile with docker baked in when services need it', () => {
    const spec = { image: 'node:22-slim', setup: ['npm ci'], includeDocker: true };
    const dockerfile = environmentDockerfile(spec);
    expect(dockerfile).toContain('FROM node:22-slim');
    expect(dockerfile).toContain('get.docker.com');
    expect(dockerfile).toContain('RUN npm ci');
    expect(setupCommands(spec)[0]).toContain('get.docker.com');
    expect(bootCommands({ includeDocker: true, boot: ['echo x'] })[0]).toContain('dockerd');
  });

  it('drives the e2b path through a builder sandbox: setup, snapshot, kill', async () => {
    const calls: string[] = [];
    let killed = false;
    const builder: BuilderSandbox = {
      async run(command) { calls.push(command); return { exitCode: 0, stderr: '', stdout: '' }; },
      async createSnapshot(name) { calls.push(`snapshot:${name}`); return { snapshotId: 'snap_123' }; },
      async kill() { killed = true; },
    };
    const result = await buildEnvironment({ provider: 'e2b', projectId: 'proj_x', digest: 'abcd1234',
      spec: { setup: ['npm ci'], includeDocker: true },
      createBuilderSandbox: async () => builder });
    expect(result.ref).toBe('snap_123');
    expect(calls.some((c) => c.includes('get.docker.com'))).toBe(true);
    expect(calls).toContain('npm ci');
    expect(calls).toContain(`snapshot:${environmentArtifactName('proj_x', 'abcd1234')}`);
    expect(killed).toBe(true);
  });

  it('kills the builder and reports the failing command on setup failure', async () => {
    let killed = false;
    const builder: BuilderSandbox = {
      async run(command) { return command === 'bad' ? { exitCode: 1, stderr: 'boom', stdout: '' } : { exitCode: 0, stderr: '', stdout: '' }; },
      async createSnapshot() { throw new Error('must not snapshot after failure'); },
      async kill() { killed = true; },
    };
    await expect(buildEnvironment({ provider: 'e2b', projectId: 'p', digest: 'd',
      spec: { setup: ['ok', 'bad'] }, createBuilderSandbox: async () => builder })).rejects.toThrow(/"bad" failed: boom/);
    expect(killed).toBe(true);
  });
});

let DOCKER = false;
beforeAll(async () => {
  DOCKER = await pexec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 })
    .then(() => true).catch(() => false);
});

describe.skipIf(process.env.KARMAX_SKIP_DOCKER === '1')('container environment build (Docker)', () => {
  it('bakes setup into an image that worlds can boot from', async () => {
    if (!DOCKER) return; // self-skip without Docker
    const digest = Date.now().toString(36);
    const tag = environmentArtifactName('proj-envtest', digest);
    try {
      const result = await buildEnvironment({ provider: 'container', projectId: 'proj-envtest', digest,
        spec: { image: 'node:22-slim', setup: ['echo baked-at-build > /karmax-marker'] } });
      expect(result.ref).toBe(tag);
      // The baked artifact carries the setup's result — no per-world re-run.
      const check = await pexec('docker', ['run', '--rm', tag, 'cat', '/karmax-marker']);
      expect(check.stdout.trim()).toBe('baked-at-build');
    } finally {
      await pexec('docker', ['rmi', '-f', tag]).catch(() => undefined);
    }
  }, 300_000);
});
