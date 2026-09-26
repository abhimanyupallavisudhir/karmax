import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-git-')); roots.push(root);
  await gitOrThrow(root, ['init', '-qb', 'main']); await ensureIdentity(root);
  fs.writeFileSync(path.join(root, 'file'), 'before');
  await gitOrThrow(root, ['add', '.']); await gitOrThrow(root, ['commit', '-qm', 'init']);
  return root;
}
it('never runs checkout hooks or fsmonitor on the host (RT-5)', async () => {
  const root = await fixture();
  const hook = path.join(root, 'hook'); const marker = path.join(root, 'ran');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await gitOrThrow(root, ['config', 'core.fsmonitor', hook]);
  await gitOrThrow(root, ['status', '--porcelain']);
  expect(fs.existsSync(marker)).toBe(false);
  const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks);
  fs.copyFileSync(hook, path.join(hooks, 'pre-commit'));
  await gitOrThrow(root, ['config', 'core.hooksPath', hooks]);
  await gitOrThrow(root, ['commit', '--allow-empty', '-qm', 'no hooks']);
  expect(fs.existsSync(marker)).toBe(false);
});
it('rejects a gitfile redirected to a foreign repository (RT-5)', async () => {
  const root = await fixture(), foreign = await fixture();
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${foreign}/.git\n`);
  expect((await git(root, ['status', '--porcelain'])).code).not.toBe(0);
});
it('ignores inherited Git directory and execution settings (RT-5)', async () => {
  const root = await fixture(), foreign = await fixture();
  vi.stubEnv('GIT_DIR', path.join(foreign, '.git'));
  vi.stubEnv('GIT_WORK_TREE', foreign);
  expect(await gitOrThrow(root, ['rev-parse', '--show-toplevel'])).toBe(root);
});
