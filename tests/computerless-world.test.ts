import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { WorldRegistry } from '../src/world/registry.js';
import { NoComputerError, computerlessRoot } from '../src/world/none.js';
import { assertInFlightComputerEdit, HOST_WORLD_KINDS, isComputerless, LOCAL_WORLD_KINDS, NO_COMPUTER, runsOnHost } from '../src/domain/computer.js';
import { isRemoteWorldKind } from '../src/world/types.js';
import { remoteWorldProvider, releaseWorldOnCompletion } from '../src/workflows/contract.js';
import { costMicrosPerSecond } from '../src/world/runners.js';
import { computerFlags } from '../src/cli/commands/tasks.js';
import { applyComputer, isCloudProvider } from '../src/domain/computer.js';
import { cloudProviders } from '../src/domain/computer-limits.js';
import { assembleTaskInput } from '../src/platform/params.js';
import { manifest } from '../src/contrib/manifests.js';

describe('the none world provider (a task without a computer)', () => {
  it('is registered, local, unbillable and runs nothing on the host', async () => {
    const registry = new WorldRegistry();
    const provider = registry.get('none');
    expect(provider.parkable).toBe(false);
    expect(provider.capabilities).toMatchObject({ remote: false, snapshots: false, pty: false, ports: false });
    expect(isRemoteWorldKind('none')).toBe(false);
    expect(remoteWorldProvider('none')).toBe(false);
    expect(costMicrosPerSecond('none', 2, 2048, 0)).toBe(0);
    expect(runsOnHost('none')).toBe(false);
    expect(LOCAL_WORLD_KINDS).toContain(NO_COMPUTER);
    expect(HOST_WORLD_KINDS).not.toContain(NO_COMPUTER);
    expect(isComputerless('none')).toBe(true);
    expect(isComputerless('e2b')).toBe(false);
  });

  it('refuses exec, processes, terminals, ports, previews and checkouts with a clear error', async () => {
    const registry = new WorldRegistry();
    const world = await registry.create('none', { taskId: 'task_none_refusals', base: 'main' });
    expect(world.handle).toMatchObject({ kind: 'none', id: 'task_none_refusals', repos: [] });
    const refusals: Array<() => Promise<unknown>> = [
      () => world.exec('bash', ['-lc', 'echo hi']),
      () => world.startProcess({ command: 'sleep', args: ['1'] } as never),
      () => world.openPty(),
      () => world.fetchPort!(3000, '/'),
      () => world.previewSocketTarget!(3000, '/'),
      () => world.desktopSession!(),
      () => world.addCheckout!({ name: 'x' } as never),
    ];
    for (const refuse of refusals) {
      const error = await refuse().then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(NoComputerError);
      expect((error as Error).message).toMatch(/this task has no computer/);
    }
    await world.destroy();
  });

  it('keeps the platform bookkeeping in a private directory, removed with the world', async () => {
    const registry = new WorldRegistry();
    const world = await registry.create('none', { taskId: 'task_none_files', base: 'main' });
    expect(world.handle.root).toBe(computerlessRoot('task_none_files'));
    await world.writeFile('.karmax-injection/attachments/a.txt', 'hello');
    const reopened = await registry.open(world.handle);
    expect(await reopened.readFile('.karmax-injection/attachments/a.txt')).toBe('hello');
    // tavya's own files are never the task's work (src/domain/changed-files.ts).
    expect(await reopened.listFiles()).toEqual([]);
    await reopened.writeFile('answer.md', 'done');
    expect(await reopened.listFiles()).toEqual(['answer.md']);
    await expect(reopened.writeFile('../escape.txt', 'x')).rejects.toThrow();
    await reopened.destroy();
    expect(fs.existsSync(world.handle.root)).toBe(false);
  });

  it('never deletes a directory it did not make', async () => {
    const registry = new WorldRegistry();
    const elsewhere = fs.mkdtempSync('/tmp/not-computerless-');
    const world = await registry.open({ kind: 'none', id: 'task_x', root: elsewhere, branch: 'b', base: 'main' });
    await world.destroy();
    expect(fs.existsSync(elsewhere)).toBe(true);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('a running task neither gains nor loses its computer', () => {
    expect(() => assertInFlightComputerEdit({ provider: 'none' }, { provider: 'e2b' })).toThrow(/can't gain or lose its computer/);
    expect(() => assertInFlightComputerEdit({ provider: 'e2b' }, { provider: 'none' })).toThrow(/can't gain or lose its computer/);
    expect(() => assertInFlightComputerEdit({ provider: 'any' }, { provider: 'none' })).toThrow(/can't gain or lose its computer/);
    expect(() => assertInFlightComputerEdit({ provider: 'none' }, { provider: 'none' })).not.toThrow();
  });

  it('is never where provider "Any" routes a task', () => {
    expect(cloudProviders()).not.toContain('none');
    expect(isCloudProvider('none')).toBe(false);
  });

  it('is released like a local world on completion', () => {
    expect(releaseWorldOnCompletion({ kind: 'none', id: 't', root: '/x', branch: 'b', base: 'main' } as never)).toBe(false);
  });

  it('has no checkouts, whether the task or its project chose it', () => {
    expect(applyComputer({ repos: ['/r'], worldProvider: 'e2b' }, { provider: 'none' })).toMatchObject({ repos: [], worldProvider: 'none' });
    const input = assembleTaskInput(manifest('software-dev')!, { prompt: 'x' },
      { taskId: 't', projectId: 'p', title: 'T', project: { repos: ['/r'], worldProvider: 'none' } as never });
    expect(input.project.repos).toEqual([]);
  });

  it('is `tavya task new --computer none`, with no size', () => {
    expect(computerFlags({ computer: 'none' })).toEqual({ provider: 'none' });
    expect(() => computerFlags({ computer: 'none', cpu: '2' })).toThrow(/has no machine/);
  });
});
