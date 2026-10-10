import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@temporalio/activity';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { startJob, stopJobs } from '../src/world/jobs.js';
import type { World } from '../src/world/types.js';

const GB = 2 ** 20;
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.reverse()) await step(); cleanup = []; vi.restoreAllMocks(); });

// pramana#3 (2026-10-09): the agent waited on a two-hour rebuild job while the
// job filled the disk; nobody was told until everything had failed.
describe('disk while an agent waits on a job', () => {
  it('wakes the agent when its disk passes 90%, naming the largest paths', async () => {
    process.env.KARMAX_DISK_WATCH_MS = '200';
    cleanup.push(() => { delete process.env.KARMAX_DISK_WATCH_MS; });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-diskwait-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-diskwait-repo-'));
    cleanup.push(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    const local = await new WorktreeProvider(home).create({ taskId: 'wait-task', repo, base: 'main', target: 'main' });
    cleanup.push(async () => { await stopJobs(local); });
    let usedGb = 10;
    // A cloud world for the disk guard; a real one for the job and its waiter.
    const handle = { ...local.handle, kind: 'e2b', version: 2 } as any;
    const world = new Proxy(local, { get(target, key) {
      if (key === 'handle') return handle;
      if (key === 'exec') return async (cmd: string, args: string[], opts: any) => cmd === 'sh' && args[2] === 'disk-guard'
        ? { code: 0, stderr: '', stdout: args[3] === 'check'
          ? `KARMAX_USAGE disk_total_kb=${22 * GB} disk_used_kb=${usedGb * GB} disk_avail_kb=${(22 - usedGb) * GB} disk_avail_before_kb=${(22 - usedGb) * GB} mem_total_kb=0 mem_avail_kb=0 ballast=present ballast_kb=524288\n`
          : 'P 8808038 /home/user/karmax/data/pramana.db.tmp\n' }
        : target.exec(cmd, args, opts);
      const value = (target as any)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as World;
    const store = await Store.create(':memory:');
    cleanup.push(() => store.close());
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', capabilities: { remote: true }, async create() { throw new Error('unused'); },
      async open() { return world; }, async destroy() {} } as any);
    const core = makeCoreActivities({ store, worlds, adapters: new Map() as any, profiles: new ProfileResolver(store, 'mock') });
    vi.spyOn(Context, 'current').mockImplementation(() => ({ cancellationSignal: new AbortController().signal, heartbeat() {},
      info: { attempt: 1, activityId: '1', workflowExecution: { workflowId: 'wait-task', runId: 'run' } } } as any));
    const job = await startJob(local, { command: 'sleep 30', name: 'rebuild' });
    const waited = core.awaitJobs(handle, [job.id], Date.now() + 60_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    usedGb = 20;
    const result = await waited;
    expect(result.finished).toBe(false);
    expect(result.disk).toBe(true);
    expect(result.summary).toMatch(/^\[tavya disk\] Disk 20 of 22 GB used \(91%\)\./);
    expect(result.summary).toContain('8.4 GB /home/user/karmax/data/pramana.db.tmp');
    expect(result.summary).toContain('rebuild');
    expect(JSON.parse((await store.kvGet('world-usage:wait-task'))!).disk.usedMb).toBe(20 * 1024);
  }, 30_000);
});
