import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { WorkflowRepoLoader } from '../src/packages/repo.js';
import { PackageStore } from '../src/packages/store.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

/** Build a bare-usable local workflow repo with an initial version. */
async function makePackageRepo(name: string): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `karmax-pkg-${name}-`));
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
  await ensureIdentity(repo);
  writeVersion(repo, name, '1.0.0');
  fs.writeFileSync(path.join(repo, 'workflow.ts'), `export async function ${name}() { return 'v1'; }\n`);
  await git(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'v1']);
  return repo;
}

function writeVersion(repo: string, name: string, version: string) {
  const manifest = {
    name, version, description: `${name} workflow`, requires: [], events: [], capabilities: [], ui: [], commands: [], params: [],
    roles: [{ name: 'do', label: 'Do', promptTemplate: '{{prompt}}' }],
    stages: [{ key: 'setup', label: 'Setup' }, { key: 'done', label: 'Done' }],
  };
  fs.writeFileSync(path.join(repo, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

describe('WorkflowRepoLoader (SPEC §4.2 — a workflow is a git repo of code)', () => {
  let cacheHome: string;
  let repo: string;
  const loader = () => new WorkflowRepoLoader(cacheHome);

  beforeAll(async () => {
    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pkgcache-'));
    repo = await makePackageRepo('greeter');
  });
  afterAll(() => {
    fs.rmSync(cacheHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('fetches a package, pins it to an exact commit, and validates its manifest', async () => {
    const pkg = await loader().load({ url: repo });
    expect(pkg.manifest.name).toBe('greeter');
    expect(pkg.manifest.version).toBe('1.0.0');
    expect(pkg.sha).toMatch(/^[0-9a-f]{40}$/); // the precise pin (§4.3)
    expect(pkg.workflowEntry).toMatch(/workflow\.ts$/);
    // snapshot is an immutable, .git-free checkout at the SHA
    expect(fs.existsSync(path.join(pkg.dir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(pkg.dir, '.git'))).toBe(false);
  });

  it('registers the loaded package into the store, resolvable by name@version', async () => {
    const store = new PackageStore();
    const pkg = await loader().load({ url: repo }, store);
    expect(pkg.manifest.name).toBe('greeter');
    expect(store.resolve('greeter')!.version).toBe('1.0.0');
    expect(store.resolve('greeter', '1.0.0')!.name).toBe('greeter');
  });

  it('pins to the commit behind a ref: an old tag keeps the old version', async () => {
    // tag v1, then publish a v2 on main
    await gitOrThrow(repo, ['tag', 'v1.0.0']);
    const v1Sha = await gitOrThrow(repo, ['rev-parse', 'HEAD']);
    writeVersion(repo, 'greeter', '2.0.0');
    fs.writeFileSync(path.join(repo, 'workflow.ts'), `export async function greeter() { return 'v2'; }\n`);
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'v2']);

    const atTag = await loader().load({ url: repo, ref: 'v1.0.0' });
    expect(atTag.manifest.version).toBe('1.0.0');
    expect(atTag.sha).toBe(v1Sha);

    const atHead = await loader().load({ url: repo, ref: 'main' });
    expect(atHead.manifest.version).toBe('2.0.0');
    expect(atHead.sha).not.toBe(v1Sha);
  });

  it('is idempotent: reloading the same SHA reuses the snapshot', async () => {
    const a = await loader().load({ url: repo, ref: 'v1.0.0' });
    const before = fs.statSync(a.dir).mtimeMs;
    const b = await loader().load({ url: repo, ref: 'v1.0.0' });
    expect(b.dir).toBe(a.dir);
    expect(fs.statSync(b.dir).mtimeMs).toBe(before); // not re-extracted
  });

  it('rejects a package whose manifest name disagrees with how it was loaded', async () => {
    await expect(loader().load({ url: repo, name: 'not-greeter' })).rejects.toThrow(/declares name/);
  });
  it('rejects an unresolved ref instead of silently installing HEAD', async () => {
    await expect(loader().load({ url: repo, ref: 'does-not-exist' }))
      .rejects.toThrow(/does not resolve to a commit/);
  });

  it('rejects another origin reusing an explicit cache name', async () => {
    const other = await makePackageRepo('greeter');
    try {
      await loader().load({ url: repo, name: 'greeter' });
      await expect(loader().load({ url: other, name: 'greeter' }))
        .rejects.toThrow(/different repository/);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('does not reuse stale code when fetching fails', async () => {
    const source = await makePackageRepo('unreachable');
    await loader().load({ url: source });
    fs.rmSync(source, { recursive: true, force: true });
    await expect(loader().load({ url: source })).rejects.toThrow();
  });

});
