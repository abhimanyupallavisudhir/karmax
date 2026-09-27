import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { appendGitConfig } from '../src/world/git-credential.js';

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
it('validates the enclosing repository when Git runs in a subdirectory (RT-5)', async () => {
  const root = await fixture(), foreign = await fixture();
  const nested = path.join(root, 'nested'); fs.mkdirSync(nested);
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${foreign}/.git\n`);
  expect((await git(nested, ['status', '--porcelain'])).code).not.toBe(0);
});
it('refuses executable repository filters before host staging (RT-5)', async () => {
  const root = await fixture();
  const marker = path.join(root, 'filter-ran');
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=untrusted\n');
  fs.writeFileSync(path.join(root, 'file.txt'), 'content');
  await gitOrThrow(root, ['config', 'filter.untrusted.clean', `touch '${marker}'; cat`]);
  expect((await git(root, ['add', '.'])).code).not.toBe(0);
  expect(fs.existsSync(marker)).toBe(false);
});
it('refuses repository transport and prompt programs before a host fetch (RT-5)', async () => {
  const root = await fixture(), origin = await fixture();
  const marker = path.join(root, 'program-ran');
  await gitOrThrow(root, ['remote', 'add', 'origin', origin]);
  for (const [key, value] of [
    ['remote.origin.uploadpack', `touch '${marker}'; git-upload-pack`],
    ['core.askPass', `touch '${marker}'`],
    ['submodule.lib.update', `!touch '${marker}'`],
  ]) {
    await gitOrThrow(root, ['config', key!, value!]);
    expect((await git(root, ['fetch', '-q', 'origin'])).code).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    // karmax's own wrapper now refuses every command here, `config` included.
    execFileSync('git', ['config', '--unset', key!], { cwd: root });
  }
  await gitOrThrow(root, ['fetch', '-q', 'origin']);
});
it('refuses executable configuration pulled in through a repository include (RT-5)', async () => {
  const root = await fixture();
  const marker = path.join(root, 'filter-ran');
  const included = path.join(root, 'included.config');
  fs.writeFileSync(included, `[filter "untrusted"]\n\tclean = touch '${marker}'; cat\n`);
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=untrusted\n');
  fs.writeFileSync(path.join(root, 'file.txt'), 'content');
  await gitOrThrow(root, ['config', 'include.path', included]);
  expect((await git(root, ['add', '.'])).code).not.toBe(0);
  expect(fs.existsSync(marker)).toBe(false);
});
// The operator's own Git setup is trusted: global/system files (identity, LFS
// filters, credential helpers) and environment-supplied config chains. Only
// what an agent can write — the repository's config — is refused.
it('keeps the operator\'s global and environment Git configuration', async () => {
  const root = await fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-git-home-')); roots.push(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Operator\n[filter "lfs"]\n\tclean = cat\n\tsmudge = cat\n');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'karmax.operator');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'env');
  expect(await gitOrThrow(root, ['config', '--global', 'user.name'])).toBe('Operator');
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.bin filter=lfs\n');
  fs.writeFileSync(path.join(root, 'data.bin'), 'binary');
  await gitOrThrow(root, ['add', '.']);
  const env: Record<string, string> = {};
  appendGitConfig(env, 'karmax.appended', 'yes');
  expect(await gitOrThrow(root, ['config', 'karmax.operator'], { env })).toBe('env');
  expect(await gitOrThrow(root, ['config', 'karmax.appended'], { env })).toBe('yes');
});
