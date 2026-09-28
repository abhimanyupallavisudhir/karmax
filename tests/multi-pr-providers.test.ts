import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { addCheckoutViaExec } from '../src/world/checkout.js';
import { finalizeMerge } from '../src/world/merge.js';
import { ExecOptions, World, WorldHandle, worldRepos } from '../src/world/types.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

const pexec = promisify(execFile);

/**
 * Provider parity for `addCheckout`. Container/E2B/Daytona worlds all hold real
 * clones inside the sandbox and all expose `exec`, so one exec-driven
 * implementation serves every one of them — the ONLY thing that differs between
 * them is where `exec` runs. These tests drive that shared implementation with a
 * world whose `exec` runs locally, against real git: same code path a remote
 * world takes, no Docker and no provider credentials.
 */

/** The minimum of the World contract `addCheckoutViaExec` actually uses. */
function execWorld(handle: WorldHandle): World {
  return {
    handle,
    async exec(cmd: string, args: string[], opts: ExecOptions = {}) {
      try {
        const { stdout, stderr } = await pexec(cmd, args, { cwd: opts.cwd ?? handle.root, timeout: 60_000 });
        return { stdout, stderr, code: 0 };
      } catch (e: any) {
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: e.code ?? 1 };
      }
    },
  } as unknown as World;
}

describe('addCheckout parity across container/remote backends (exec-driven)', () => {
  let sandbox: string;
  let clone: string;
  let origin: string;
  let handle: WorldHandle;

  beforeEach(async () => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-origin-'));
    await gitOrThrow(origin, ['init', '-q', '-b', 'main']);
    await ensureIdentity(origin);
    fs.writeFileSync(path.join(origin, 'a.js'), 'export const a = 1;\n');
    await git(origin, ['add', '-A']);
    await git(origin, ['commit', '-q', '-m', 'init']);

    // What provisioning leaves in a sandbox: the world root is a parent dir and
    // each repo is a real CLONE (not a worktree) in a subdirectory, on the task
    // branch. Nesting is what leaves room for the branches added later.
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-sandbox-'));
    clone = path.join(sandbox, 'alpha');
    await gitOrThrow(sandbox, ['clone', '-q', origin, clone]);
    await ensureIdentity(clone);
    await gitOrThrow(clone, ['checkout', '-q', '-b', 'tavya/t-remote', 'main']);

    // Inside the sandbox the CLONE is the repository every git command sees;
    // `origin` is only where the broker later carries the branch to.
    handle = {
      kind: 'e2b', id: 't-remote', root: sandbox, workdir: clone,
      branch: 'tavya/t-remote', base: 'main', repo: clone, target: 'main',
      repos: [{ name: 'alpha', repo: clone, root: clone, branch: 'tavya/t-remote', base: 'main', target: 'main' }],
    };
  });
  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(origin, { recursive: true, force: true });
  });

  it('adds a branch inside the sandbox using only exec', async () => {
    const world = execWorld(handle);
    const next = await addCheckoutViaExec(world, { name: 'docs' });

    const repos = worldRepos(next);
    expect(repos).toHaveLength(2);
    expect(repos[1]!.name).toBe('docs');
    expect(repos[1]!.branch).toBe('tavya/t-remote-docs');
    expect(repos[1]!.root).toBe(path.join(sandbox, 'docs'));
    // It is a real checkout on a real branch, made where the sandbox is.
    expect(fs.existsSync(path.join(sandbox, 'docs', 'a.js'))).toBe(true);
    const branch = await git(path.join(sandbox, 'docs'), ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branch.stdout.trim()).toBe('tavya/t-remote-docs');
    // The live world sees it too, so the next exec/PTY can target it.
    expect(worldRepos(world.handle)).toHaveLength(2);
  });

  it('stacks on a sibling checkout by name', async () => {
    const world = execWorld(handle);
    const next = await addCheckoutViaExec(world, { name: 'api', base: 'alpha' });
    expect(worldRepos(next)[1]!.base).toBe('tavya/t-remote');
  });

  it('applies the same guards as the local backend', async () => {
    const world = execWorld(handle);
    await expect(addCheckoutViaExec(world, { name: 'alpha' })).rejects.toThrow(/already/i);
    await expect(addCheckoutViaExec(world, { name: 'bad name' })).rejects.toThrow(/invalid/i);
    await expect(addCheckoutViaExec(world, { name: 'x', from: 'nope' })).rejects.toThrow(/no checkout named/i);
    await expect(addCheckoutViaExec(world, { name: 'y', base: 'refs/heads/absent' })).rejects.toThrow(/does not exist/i);
  });

  it('lands every added branch through the merge the broker drives in-sandbox', async () => {
    const world = execWorld(handle);
    await addCheckoutViaExec(world, { name: 'docs' });
    const [core, docs] = worldRepos(world.handle);

    fs.writeFileSync(path.join(core!.root, 'feature.js'), 'export const f = 1;\n');
    await git(core!.root, ['add', '-A']);
    await gitOrThrow(core!.root, ['commit', '-q', '-m', 'feat']);
    fs.writeFileSync(path.join(docs!.root, 'README.md'), '# docs\n');
    await git(docs!.root, ['add', '-A']);
    await gitOrThrow(docs!.root, ['commit', '-q', '-m', 'docs']);

    // The sandbox clones are the repos here, so this is the local-merge shape of
    // the same code the broker drives for a cloud world.
    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(true);
    expect(res.landedFiles).toContain('alpha/feature.js');
    expect(res.landedFiles).toContain('docs/README.md');
  });
});
