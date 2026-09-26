import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowManager } from '../src/packages/manager.js';
import { PackageStore } from '../src/packages/store.js';

const manifest = { name: 'fixture', version: '1.0.0', description: '', requires: [], events: [], capabilities: [], ui: [], commands: [], params: [] };
it('WF-20: failed restore leaves the package unselectable and can be retried', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'review-restore-'));
  const dir = path.join(home, 'abcdef1234'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(home, 'installed.json'), JSON.stringify([{ name: 'fixture', version: '1.0.0', sha: 'abcdef1234', dir }]));
  const refresh = vi.fn().mockRejectedValueOnce(new Error('invalid bundle')).mockResolvedValue(undefined);
  const manager = new WorkflowManager({ refresh }, { inspect: async () => ({ manifest, workflowEntry: path.join(dir, 'workflow.js') }) } as any,
    PackageStore.withBundled(), home);
  try {
    await expect(manager.restore()).rejects.toThrow('invalid bundle');
    expect(manager.list().some(item => item.name === 'fixture')).toBe(false);
    expect(await manager.restore()).toBe(1);
    expect(manager.list().some(item => item.name === 'fixture')).toBe(true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('WF-15: a rejected bundle does not roll the healthy worker again', async () => {
  const refresh = vi.fn().mockRejectedValue(new Error('invalid bundle'));
  const manager = new WorkflowManager({ refresh }, { load: async () => ({ manifest, workflowEntry: '/fixture/workflow.js', sha: 'abcdef1234' }) } as any);
  await expect(manager.install({ url: '/fixture' })).rejects.toThrow('invalid bundle');
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(manager.list().some(item => item.name === 'fixture')).toBe(false);
});
