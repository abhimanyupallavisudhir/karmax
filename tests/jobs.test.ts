import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import type { World } from '../src/world/types.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { startJob, jobStatuses, stopJobs, startJobWaiter, listJobs, describeJobs, isJobId } from '../src/world/jobs.js';
import { platformToolHandlers, TOOL_SCHEMAS, SDK_CONTROL_TOOL_NAMES } from '../src/agent/tools.js';
import type { AgentWait } from '../src/domain/types.js';

const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('condition not met');
};

describe('durable jobs (real worktree world)', () => {
  let home: string;
  let repo: string;
  let world: World;
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-jobs-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-jobs-repo-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    world = await new WorktreeProvider(home).create({ taskId: 'jobs', repo, base: 'main', target: 'main' });
  });
  afterEach(async () => {
    await stopJobs(world).catch(() => {});
    await world.destroy().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('runs a command in its own session, records output and exit code, and stays out of git', async () => {
    const job = await startJob(world, { command: 'echo hello from $GREETING; pwd; exit 3', env: { GREETING: 'job' } });
    expect(isJobId(job.id)).toBe(true);
    expect(job.log).toBe(path.posix.join(world.handle.root, '.karmax-injection/jobs', job.id, 'log'));
    await until(async () => (await jobStatuses(world, [job.id]))[0]!.state === 'exited');
    const [status] = await jobStatuses(world, [job.id], { tailLines: 10 });
    expect(status).toMatchObject({ id: job.id, state: 'exited', exitCode: 3, command: 'echo hello from $GREETING; pwd; exit 3' });
    expect(status!.tail).toContain('hello from job');
    expect(status!.tail).toContain(fs.realpathSync(world.handle.root));
    expect(status!.startedAt).toBeGreaterThan(0);
    expect(status!.endedAt).toBeGreaterThanOrEqual(status!.startedAt!);
    // Job state never shows up as a change to commit.
    expect((await world.exec('git', ['status', '--porcelain'])).stdout).toBe('');
    expect(await listJobs(world)).toEqual([job.id]);
  });

  it('honours a cwd relative to the working directory', async () => {
    fs.mkdirSync(path.join(world.handle.root, 'sub'));
    const job = await startJob(world, { command: 'pwd', cwd: 'sub' });
    await until(async () => (await jobStatuses(world, [job.id]))[0]!.state === 'exited');
    const [status] = await jobStatuses(world, [job.id], { tailLines: 5 });
    expect(status!.tail).toBe(fs.realpathSync(path.join(world.handle.root, 'sub')));
  });

  it('survives the process that started it, and reports running until it exits', async () => {
    const job = await startJob(world, { command: 'sleep 1; echo done' });
    const [running] = await jobStatuses(world, [job.id]);
    expect(running!.state).toBe('running');
    // The job leads its own session, so it is not in the starter's process group.
    const pid = Number(fs.readFileSync(path.join(world.handle.root, '.karmax-injection/jobs', job.id, 'pid'), 'utf8'));
    const sid = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[3];
    expect(Number(sid)).toBe(pid);
    await until(async () => (await jobStatuses(world, [job.id]))[0]!.state === 'exited');
  });

  it('reports a job killed without an exit record as lost, and an unknown id as missing', async () => {
    const job = await startJob(world, { command: 'sleep 30' });
    const pid = Number(fs.readFileSync(path.join(world.handle.root, '.karmax-injection/jobs', job.id, 'pid'), 'utf8'));
    process.kill(-pid, 'SIGKILL');
    await until(async () => (await jobStatuses(world, [job.id]))[0]!.state === 'lost');
    const statuses = await jobStatuses(world, ['job-00000000', 'not a job; rm -rf /']);
    expect(statuses.map((s) => s.state)).toEqual(['missing', 'missing']);
  });

  it('stops a job and its children', async () => {
    const job = await startJob(world, { command: 'sleep 60 & sleep 60; wait' });
    await stopJobs(world, [job.id]);
    const [status] = await jobStatuses(world, [job.id]);
    expect(status!.state).not.toBe('running');
    const pid = Number(fs.readFileSync(path.join(world.handle.root, '.karmax-injection/jobs', job.id, 'pid'), 'utf8'));
    const survivors = fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e)).filter((e) => {
      try { return fs.readFileSync(`/proc/${e}/stat`, 'utf8').split(') ')[1]!.split(' ')[2] === String(pid); } catch { return false; }
    });
    expect(survivors).toEqual([]);
  });

  it('a waiter process exits when the jobs finish, or at its deadline', async () => {
    const job = await startJob(world, { command: 'sleep 1' });
    const waiter = await startJobWaiter(world, [job.id], 60);
    const code = await new Promise<number | null>((resolve) => waiter.onExit(resolve));
    expect(code).toBe(0);
    expect((await jobStatuses(world, [job.id]))[0]!.state).toBe('exited');

    const long = await startJob(world, { command: 'sleep 60' });
    const started = Date.now();
    const bounded = await startJobWaiter(world, [long.id], 1);
    await new Promise((resolve) => bounded.onExit(resolve));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await jobStatuses(world, [long.id]))[0]!.state).toBe('running');
  });

  describe('start_job, pause and stop_job tools', () => {
    const tools = (ctx: { started: string[]; waits: AgentWait[] }) => platformToolHandlers(world, {
      jobStarted: (id: string) => { ctx.started.push(id); },
      requestWait: (wait: AgentWait) => { ctx.waits.push(wait); },
      emit: () => {},
    } as any, () => ({ SECRET_FOR_WORK: 'value' }));

    it('are turn-local controls every rail exposes', () => {
      for (const name of ['start_job', 'pause', 'stop_job']) {
        expect(TOOL_SCHEMAS.some((tool) => tool.name === name)).toBe(true);
        expect(SDK_CONTROL_TOOL_NAMES.has(name)).toBe(true);
      }
      expect(TOOL_SCHEMAS.find((tool) => tool.name === 'pause')!.parameters.required).toEqual(['minutes']);
    });

    it('start_job runs with the work environment and records the job for the turn', async () => {
      const ctx = { started: [] as string[], waits: [] as AgentWait[] };
      const reply = await tools(ctx).start_job!({ command: 'echo $SECRET_FOR_WORK' });
      const id = reply.match(/job-[a-f0-9]{8}/)![0];
      expect(ctx.started).toEqual([id]);
      expect(reply).toContain(`${world.handle.root}/.karmax-injection/jobs/${id}/log`);
      await until(async () => (await jobStatuses(world, [id]))[0]!.state === 'exited');
      expect((await jobStatuses(world, [id], { tailLines: 1 }))[0]!.tail).toBe('value');
    });

    it('pause always has a time limit, and only waits for jobs that exist and still run', async () => {
      const ctx = { started: [] as string[], waits: [] as AgentWait[] };
      const t = tools(ctx);
      expect(await t.pause!({})).toMatch(/^error: minutes must be between 1 and 10080/);
      expect(await t.pause!({ minutes: 0.5 })).toMatch(/^error/);
      expect(await t.pause!({ minutes: 20_000 })).toMatch(/^error/);
      expect(await t.pause!({ minutes: 5, jobs: ['job-deadbeef'] })).toBe('error: no such job: job-deadbeef');
      expect(ctx.waits).toEqual([]);

      const done = await startJob(world, { command: 'echo finished-already' });
      await until(async () => (await jobStatuses(world, [done.id]))[0]!.state === 'exited');
      const immediate = await t.pause!({ minutes: 5, jobs: [done.id] });
      expect(immediate).toContain('nothing to wait for');
      expect(immediate).toContain('finished-already');
      expect(ctx.waits).toEqual([]);

      expect(await t.pause!({ minutes: 10 })).toContain('Pausing for 10 min');
      const running = await startJob(world, { command: 'sleep 30' });
      expect(await t.pause!({ minutes: 90, jobs: [running.id, done.id] })).toContain(`Waiting for ${running.id} (at most 90 min)`);
      // A plain pause lets a cloud world be suspended, which would freeze the job.
      expect(await t.pause!({ minutes: 10 })).toBe(`error: ${running.id} is still running. Pass it in jobs: a pause without it lets the world be suspended, which freezes it. You are still resumed after minutes at the latest.`);
      expect(ctx.waits).toEqual([{ minutes: 10 }, { minutes: 90, jobs: [running.id] }]);
    });

    it('stop_job stops running jobs and reports each one', async () => {
      const t = tools({ started: [], waits: [] });
      expect(await t.stop_job!({ jobs: [] })).toBe('error: jobs is required');
      expect(await t.stop_job!({ jobs: ['job-deadbeef'] })).toBe('error: no such job: job-deadbeef');
      const runaway = await startJob(world, { command: 'yes > /dev/null' });
      const reply = await t.stop_job!({ jobs: [runaway.id] });
      expect(reply).toContain(`Stopped ${runaway.id}.`);
      expect((await jobStatuses(world, [runaway.id]))[0]!.state).not.toBe('running');
      expect(await t.stop_job!({ jobs: [runaway.id] })).toBe(`${runaway.id} had already stopped.`);
    });
  });

  it('describes jobs for the resumed agent', () => {
    const text = describeJobs([
      { id: 'job-aaaaaaaa', state: 'exited', exitCode: 0, command: 'make', log: '/w/log', startedAt: 0, endedAt: 90_000, tail: 'ok' },
      { id: 'job-bbbbbbbb', state: 'running', log: '/w/log2', startedAt: 0 },
      { id: 'job-cccccccc', state: 'lost', log: '/w/log3' },
    ], 30 * 60_000);
    expect(text).toContain('Job job-aaaaaaaa exited with code 0 after 2 min.');
    expect(text).toContain('Last output:\nok');
    expect(text).toContain('Job job-bbbbbbbb is still running (30 min so far).');
    expect(text).toContain('Job job-cccccccc stopped without recording an exit code');
  });
});
