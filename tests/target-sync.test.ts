import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import { syncLocalTarget } from '../src/world/target-sync.js';

describe('provider-owned target mirror', () => {
  let tmp: string;
  let repo: string;
  let writer: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-target-sync-'));
    repo = path.join(tmp, 'checkout');
    writer = path.join(tmp, 'writer');
    const origin = path.join(tmp, 'origin.git');
    await gitOrThrow(tmp, ['init', '-q', '--bare', '-b', 'main', origin]);
    await gitOrThrow(tmp, ['clone', '-q', origin, repo]);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    await gitOrThrow(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
    await gitOrThrow(repo, ['push', '-q', 'origin', 'main']);
    await gitOrThrow(tmp, ['clone', '-q', origin, writer]);
    await ensureIdentity(writer);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  async function advance(directory: string, name: string, contents = `${name}\n`) {
    fs.writeFileSync(path.join(directory, name), contents);
    await gitOrThrow(directory, ['add', '-A']);
    await gitOrThrow(directory, ['commit', '-q', '-m', name]);
    return (await gitOrThrow(directory, ['rev-parse', 'HEAD'])).trim();
  }

  it('fast-forwards the checked-out local target after the provider advances it', async () => {
    const providerSha = await advance(writer, 'provider.txt');
    await gitOrThrow(writer, ['push', '-q', 'origin', 'main']);
    await gitOrThrow(repo, ['fetch', '-q', 'origin', 'main:refs/remotes/origin/main']);

    await expect(syncLocalTarget(repo, 'main')).resolves.toMatchObject({
      coherent: true, updated: true, target: 'main', sha: providerSha, checkout: repo,
    });
    expect((await gitOrThrow(repo, ['rev-parse', 'main'])).trim()).toBe(providerSha);
    expect(fs.readFileSync(path.join(repo, 'provider.txt'), 'utf8')).toBe('provider.txt\n');
  });

  it('preserves both histories and reports a local/provider divergence', async () => {
    const localSha = await advance(repo, 'local-only.txt');
    const providerSha = await advance(writer, 'provider-only.txt');
    await gitOrThrow(writer, ['push', '-q', 'origin', 'main']);
    await gitOrThrow(repo, ['fetch', '-q', 'origin', 'main:refs/remotes/origin/main']);

    await expect(syncLocalTarget(repo, 'main')).resolves.toMatchObject({
      coherent: false, target: 'main', sha: providerSha,
      detail: expect.stringMatching(/diverged.*preserving both histories/i),
    });
    expect((await gitOrThrow(repo, ['rev-parse', 'main'])).trim()).toBe(localSha);
    expect((await gitOrThrow(repo, ['rev-parse', 'origin/main'])).trim()).toBe(providerSha);
  });

  it('does not modify a dirty target checkout', async () => {
    const localSha = (await gitOrThrow(repo, ['rev-parse', 'main'])).trim();
    const providerSha = await advance(writer, 'provider.txt');
    await gitOrThrow(writer, ['push', '-q', 'origin', 'main']);
    await gitOrThrow(repo, ['fetch', '-q', 'origin', 'main:refs/remotes/origin/main']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'uncommitted local edit\n');

    await expect(syncLocalTarget(repo, 'main')).resolves.toMatchObject({
      coherent: false, target: 'main', sha: providerSha, checkout: repo,
      detail: expect.stringMatching(/uncommitted changes/i),
    });
    expect((await gitOrThrow(repo, ['rev-parse', 'main'])).trim()).toBe(localSha);
    expect(fs.readFileSync(path.join(repo, 'base.txt'), 'utf8')).toBe('uncommitted local edit\n');
  });
});
