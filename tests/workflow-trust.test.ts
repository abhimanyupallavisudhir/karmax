import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowManager } from '../src/packages/manager.js';
import { WorkflowRepoLoader } from '../src/packages/repo.js';
import type { WorkerManager } from '../src/temporal/worker-pool.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';

describe('workflow code trust boundary', () => {
  it('blocks hosted installation and boot restore before fetching or inspecting code', async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-trust-'));
    try {
      const loader = new WorkflowRepoLoader(cache);
      const load = vi.spyOn(loader, 'load');
      const inspect = vi.spyOn(loader, 'inspect');
      const refresh = vi.fn();
      const manager = new WorkflowManager({ refresh } as unknown as WorkerManager, loader,
        undefined, cache, undefined, true);
      fs.writeFileSync(path.join(cache, 'installed.json'), JSON.stringify([{
        name: 'evil', version: '1.0.0', sha: 'abcdef0', dir: path.join(cache, 'evil', 'abcdef0'),
      }]));
      await expect(manager.install({ url: '/any/repo' })).rejects.toThrow(/disabled.*hosted/);
      const warn = vi.fn();
      expect(await manager.restore(warn)).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('require migration'));
      expect(load).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(manager.list().every((workflow) => workflow.source === 'bundled')).toBe(true);
    } finally { fs.rmSync(cache, { recursive: true, force: true }); }
  });

  it('rejects hosted API installation and edit proposals even with full capabilities', async () => {
    const store = (await Store.create(':memory:'));
    try {
      (await store.claimPersonalOrganization('owner'));
      const project = (await store.createProject('P', {}));
      const tokens = new TokenAuthority();
      const token = (await tokens.mint({ taskId: 't', profileId: 'do', principal: 'user:owner',
        ceiling: ['*'], grantorCaps: ['*'] })).token;
      const install = vi.fn();
      const start = vi.fn();
      const api = new KarmaxApi({ store, tokens, hosted: true, taskQueue: 'test',
        workflows: { install } as unknown as WorkflowManager,
        client: { workflow: { start } } as any });
      await expect(api.installWorkflow(token, { url: '/evil' })).rejects.toThrow(/disabled.*hosted/);
      await expect(api.proposeWorkflowEdit(token, { projectId: project.id, title: 'edit',
        repo: '/evil', branch: 'change', target: 'main' })).rejects.toThrow(/disabled.*hosted/);
      expect(install).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect((await store.listTasks(project.id))).toEqual([]);
    } finally { (await store.close()); }
  });

  it.each(['manifest.mjs', 'manifest.js', 'manifest.ts'])('never executes %s during inspection', async (name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-manifest-'));
    try {
      const marker = path.join(dir, 'executed');
      fs.writeFileSync(path.join(dir, name),
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); export default {};`);
      await expect(new WorkflowRepoLoader(dir).inspect(dir)).rejects.toThrow(/executable manifests are not supported/);
      expect(fs.existsSync(marker)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a manifest symlink', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-symlink-'));
    try {
      fs.writeFileSync(path.join(dir, 'data.json'), '{}');
      fs.symlinkSync('data.json', path.join(dir, 'manifest.json'));
      await expect(new WorkflowRepoLoader(dir).inspect(dir)).rejects.toThrow(/regular file/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
