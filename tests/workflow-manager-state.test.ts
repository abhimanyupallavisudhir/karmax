import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowManager } from '../src/packages/manager.js';
import { WorkflowRepoLoader } from '../src/packages/repo.js';

const manifest = { name: 'example', version: '1.0.0', description: '', requires: [], events: [],
  capabilities: [], ui: [], commands: [], params: [] };
const pkg = { manifest, sha: 'a'.repeat(40), ref: 'main', dir: '/unused', workflowEntry: '/unused/workflow.mjs' };

describe('workflow package activation', () => {
  it('does not acknowledge a duplicate install until the first activation succeeds', async () => {
    let reject!: (error: Error) => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
    const loader = { load: vi.fn().mockResolvedValue(pkg) } as unknown as WorkflowRepoLoader;
    const manager = new WorkflowManager({ refresh }, loader);
    const first = manager.install({ url: 'first' });
    const failed = expect(first).rejects.toThrow('bundle failed');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const second = manager.install({ url: 'second' });
    let acknowledged = false;
    void second.then(() => { acknowledged = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    const premature = acknowledged;
    reject(new Error('bundle failed'));
    await failed;
    await second;
    expect(premature).toBe(false);
    expect(manager.resolveStart(manifest.name)).toBeDefined();
    expect(refresh).toHaveBeenCalledTimes(2); // failed activation, second activation
  });

  it('does not advertise restored packages when their bundle fails', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-state-'));
    const dir = path.join(home, 'example', pkg.sha);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(home, 'installed.json'), JSON.stringify([{ ...pkg, dir, name: manifest.name, version: manifest.version }]));
    const loader = { inspect: vi.fn().mockResolvedValue({ manifest, workflowEntry: path.join(dir, 'workflow.mjs') }) } as unknown as WorkflowRepoLoader;
    const refresh = vi.fn().mockRejectedValue(new Error('bundle failed'));
    const manager = new WorkflowManager({ refresh }, loader, undefined, home);
    try {
      await expect(manager.restore()).rejects.toThrow('bundle failed');
      expect(manager.list().some(item => item.name === manifest.name)).toBe(false);
      expect(manager.resolveStart(manifest.name)).toBeUndefined();
      refresh.mockResolvedValue(undefined);
      expect(await manager.restore()).toBe(1);
      expect(manager.resolveStart(manifest.name)).toBeDefined();
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
