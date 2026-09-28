import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';

/**
 * `runWorkflowChecks` is the merge gate for `propose_workflow_edit` (SPEC §4.4):
 * run the repo's tests, then replay every running history against the candidate
 * workflow bundle. Two things about it are easy to get wrong, so they are pinned
 * here:
 *
 *  1. The replay half only applies to a repo that CARRIES a karmax workflow
 *     bundle. `propose_workflow_edit` also targets external workflow *package*
 *     repos, which have their own entrypoint and no `src/workflows/index.ts`.
 *  2. The candidate bundle must be located inside the WORLD, not on the host. A
 *     remote (e2b/Daytona) world's `root` is a path in the provider sandbox, so
 *     an `fs` probe against it always misses.
 */

/** A world provider whose `exec` answers the probes `runWorkflowChecks` makes. */
function registerFakeWorld(opts: { kind: string; remote: boolean; hasBundle: boolean; execs: string[] }) {
  const worlds = new WorldRegistry();
  const world = {
    handle: { kind: opts.kind, id: 'task', root: '/workspace', branch: 'tavya/task', base: 'main' },
    async exec(_cmd: string, argv: string[]) {
      const script = argv[argv.length - 1] ?? '';
      opts.execs.push(script);
      if (script.includes('test -f package.json')) return { code: 0, stdout: 'yes', stderr: '' };
      if (script.includes('npm test')) return { code: 0, stdout: '', stderr: '' };
      if (script.includes('src/workflows/index.ts')) return { code: 0, stdout: opts.hasBundle ? 'yes' : 'no', stderr: '' };
      // An empty archive: enough to prove the mirror path ran without paying for
      // a real Temporal replay bundle in a unit test.
      if (script.includes('tar czf')) return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async destroy() {},
  };
  worlds.register({
    kind: opts.kind,
    capabilities: { remote: opts.remote },
    async create() { return world; },
    async open() { return world; },
    async destroy() {},
  } as any);
  return worlds;
}

async function coreFor(worlds: WorldRegistry, contentDir: string) {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('owner'));
  return {
    store,
    core: makeCoreActivities({
      store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'),
      contentDir,
      // Only needs to be present: every assertion here returns before it is used.
      client: {} as any,
    } as any),
  };
}

describe('workflow-edit merge checks', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wfchecks-'));
    dirs.push(dir);
    return dir;
  };

  /**
   * The gate hard-coded karmax's own layout, so an external workflow package —
   * the documented target of `propose_workflow_edit` — failed with "candidate
   * workflow bundle is missing" and could never be merged.
   */
  it('does not block a repo that carries no karmax workflow bundle', async () => {
    const execs: string[] = [];
    const worlds = registerFakeWorld({ kind: 'pkg-world', remote: false, hasBundle: false, execs });
    const { store, core } = (await coreFor(worlds, tmp()));
    try {
      const result = await core.runWorkflowChecks({
        taskId: 'task', worldHandle: { kind: 'pkg-world', id: 'task', root: '/workspace', branch: 'b', base: 'main' } as any,
      });
      expect(result.passed).toBe(true);
      expect(result.detail).toMatch(/replay gate does not apply/);
      expect(result.detail).not.toMatch(/missing/);
    } finally {
      (await store.close());
    }
  });

  /**
   * The bundle probe must run inside the world. Against a remote world the old
   * `fs.existsSync(handle.root + '/src/workflows/index.ts')` always missed, so
   * every hosted workflow edit failed the gate with a misleading message.
   */
  it('locates the candidate bundle inside a remote world instead of on the host', async () => {
    const execs: string[] = [];
    const worlds = registerFakeWorld({ kind: 'cloud-world', remote: true, hasBundle: true, execs });
    const { store, core } = (await coreFor(worlds, tmp()));
    const leaked = () => fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith('karmax-replay-')).length;
    const before = leaked();
    try {
      const result = await core.runWorkflowChecks({
        taskId: 'task', worldHandle: { kind: 'cloud-world', id: 'task', root: '/workspace', branch: 'b', base: 'main' } as any,
      });
      // The bundle was found in the sandbox and its sources were mirrored out…
      expect(execs.some((s) => s.includes('test -f src/workflows/index.ts'))).toBe(true);
      expect(execs.some((s) => s.includes('tar czf - src package.json'))).toBe(true);
      // …so the host-path miss can no longer be the reported reason.
      expect(result.detail).not.toMatch(/candidate workflow bundle is missing/);
      // The scripted empty archive fails to unpack, which is the mirror path.
      expect(result.detail).toMatch(/could not be unpacked/);
      // A failed mirror must not leave a temp tree behind.
      expect(leaked()).toBe(before);
    } finally {
      (await store.close());
    }
  });

  /** A local world still resolves the candidate straight off the host path. */
  it('keeps reporting a genuinely missing bundle on a local world', async () => {
    const execs: string[] = [];
    const worlds = registerFakeWorld({ kind: 'local-world', remote: false, hasBundle: true, execs });
    const { store, core } = (await coreFor(worlds, tmp()));
    try {
      const result = await core.runWorkflowChecks({
        taskId: 'task', worldHandle: { kind: 'local-world', id: 'task', root: '/does-not-exist', branch: 'b', base: 'main' } as any,
      });
      expect(execs.some((s) => s.includes('tar czf'))).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.detail).toMatch(/candidate workflow bundle is missing/);
    } finally {
      (await store.close());
    }
  });
});
