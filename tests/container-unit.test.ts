import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContainerWorldProvider } from '../src/world/container.js';
import { isRemoteAgentWorld } from '../src/agent/remote-process.js';
import { gitOrThrow, ensureIdentity } from '../src/world/git.js';

vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} })) }));

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

it('runs native agents in container worlds (WD-6)', () => {
  expect(isRemoteAgentWorld({ handle: { kind: 'container' } } as any)).toBe(true);
});

it('mounts the recorded checkout and Git admin directory at their real paths (WD-6)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'container-contract-')); roots.push(root);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const log = path.join(root, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CONTAINER_TEST_LOG"\ncase "$1" in version) echo 26;; run) echo fake;; inspect) echo true;; esac\n', { mode: 0o700 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`); vi.stubEnv('CONTAINER_TEST_LOG', log);
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-qb', 'main']); await ensureIdentity(repo);
  await gitOrThrow(repo, ['commit', '--allow-empty', '-qm', 'base']);
  const world = await new ContainerWorldProvider(path.join(root, 'worlds')).create({ taskId: 'container', repo, base: 'main' });
  const calls = fs.readFileSync(log, 'utf8');
  expect(calls).toContain(`${world.handle.root}:${world.handle.root}`);
  expect(calls).toContain(`${repo}/.git:${repo}/.git`);
  expect(calls).toContain('git\n--version');
  await world.exec('node', ['--version'], { env: { TEST_PRIVATE: 'private-not-in-argv' } });
  expect(fs.readFileSync(log, 'utf8')).not.toContain('private-not-in-argv');
  await world.openPty!({ command: 'exec sh /work/launch.sh', env: { TEST_PRIVATE: 'private-not-in-argv' } });
  const pty = await import('node-pty');
  const call = vi.mocked(pty.spawn).mock.calls.at(-1)!;
  expect(call[1]).toContain('exec sh /work/launch.sh');
  expect(call[1]?.join(' ')).not.toContain('private-not-in-argv');
  expect(call[2]?.env?.TEST_PRIVATE).toBe('private-not-in-argv');
  await world.destroy();
});
