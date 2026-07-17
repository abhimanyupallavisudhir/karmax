import { afterEach, describe, expect, it } from 'vitest';
import { provisionGitRepos, type ProvisionTarget } from '../src/world/provision-git.js';

function fakeTarget(handler: (command: string) => { stdout?: string; stderr?: string; code?: number } | undefined) {
  const commands: string[] = [];
  const target: ProvisionTarget = {
    async run(command) {
      commands.push(command);
      const result = handler(command) ?? {};
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
    },
    async writeFile() {},
  };
  return { target, commands };
}

const OPTIONS = { root: '/w', home: '/home/u', sshUrlError: 'ssh only', copyGlobsWarning: 'no globs' };

describe('shared cloud world git provisioning', () => {
  afterEach(() => {
    delete process.env.KARMAX_WORLD_CLONE_RETRIES;
    delete process.env.KARMAX_WORLD_CLONE_RETRY_MS;
  });

  it('retries a transient clone failure after clearing the partial checkout', async () => {
    process.env.KARMAX_WORLD_CLONE_RETRY_MS = '0';
    let cloneAttempts = 0;
    const { target, commands } = fakeTarget((command) => {
      if (command.includes('git clone')) return { code: ++cloneAttempts === 1 ? 128 : 0, stderr: 'early EOF' };
      if (command.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n` };
      return undefined;
    });
    const { repos } = await provisionGitRepos(target, { taskId: 't1', base: 'main', repo: 'git@github.com:acme/app.git' }, OPTIONS);
    expect(cloneAttempts).toBe(2);
    expect(commands.some((command) => command.startsWith("rm -rf '/w'"))).toBe(true);
    expect(repos[0]).toMatchObject({ repo: 'git@github.com:acme/app.git', baseSha: 'a'.repeat(40) });
  });

  it('gives up after the configured retry budget with the underlying error', async () => {
    process.env.KARMAX_WORLD_CLONE_RETRIES = '1';
    process.env.KARMAX_WORLD_CLONE_RETRY_MS = '0';
    let cloneAttempts = 0;
    const { target } = fakeTarget((command) => {
      if (command.includes('git clone')) { cloneAttempts++; return { code: 128, stderr: 'connection reset' }; }
      return undefined;
    });
    await expect(provisionGitRepos(target, { taskId: 't1', base: 'main', repo: 'git@github.com:acme/app.git' }, OPTIONS))
      .rejects.toThrow(/connection reset/);
    expect(cloneAttempts).toBe(2);
  });

  it('rejects non-SSH sources with the provider message before running any command', async () => {
    const { target, commands } = fakeTarget(() => undefined);
    await expect(provisionGitRepos(target, { taskId: 't1', base: 'main', repo: 'https://github.com/acme/app.git' }, OPTIONS))
      .rejects.toThrow('ssh only');
    expect(commands).toHaveLength(0);
  });
});
