import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
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

/** /proc/<pid>/stat after the command name: [state, ppid, pgrp, session, …]. */
const procStat = (pid: string) => { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(') ') + 2).split(' '); };
/** Live processes whose argv[0] is `name` (set with `exec -a`); zombies hold nothing. */
const named = (name: string) => fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e)).filter((e) => {
  try { return procStat(e)[0] !== 'Z' && fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').split('\0')[0] === name; } catch { return false; }
});
const marker = () => `karmax-test-${Math.random().toString(36).slice(2, 10)}`;

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

  it('reports a job that finishes while its status is read as exited, never lost', async () => {
    const job = await startJob(world, { command: 'sleep 30' });
    // The job ends between the status script's look for its exit record and
    // its look at the process: `cat <dir>/pid` (inside `alive`) records the exit
    // first and names a process that is gone, as a job finishing then would.
    const shim = path.join(home, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'cat'), `#!/bin/bash
case "$1" in */pid) d=$(dirname -- "$1"); echo 0 > "$d/exit"; echo 4194303; exit 0;; esac
exec /bin/cat "$@"
`, { mode: 0o755 });
    const exec = world.exec.bind(world);
    world.exec = (cmd, args, opts = {}) => exec(cmd, args, { ...opts, env: { ...opts.env, PATH: `${shim}:${process.env.PATH}` } });
    const [status] = await jobStatuses(world, [job.id], { root: '.karmax-injection/jobs' });
    expect(status).toMatchObject({ state: 'exited', exitCode: 0 });
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

  // #466: a vitest fork worker outlived stop_job twice. The job's session
  // leader died on SIGTERM at once, so the stop never followed up with SIGKILL.
  it('kills a child that ignores SIGTERM', async () => {
    const m = marker();
    const job = await startJob(world, { command: `bash -c 'trap "" TERM; exec -a ${m} sleep 120' & wait` });
    await until(async () => named(m).length === 1);
    await stopJobs(world, [job.id]);
    expect(named(m)).toEqual([]);
  });

  it('kills children that left its process group or its session', async () => {
    const m = marker();
    const job = await startJob(world, { command: [
      `(set -m; bash -c 'exec -a ${m}-group sleep 120' & wait) &`,
      `setsid bash -c 'exec -a ${m}-session sleep 120' &`,
      `setsid bash -c 'setsid bash -c "trap \\"\\" TERM; exec -a ${m}-deep sleep 120" & wait' &`,
      'wait',
    ].join('\n') });
    const kinds = ['group', 'session', 'deep'];
    await until(async () => kinds.every((kind) => named(`${m}-${kind}`).length === 1));
    const pid = fs.readFileSync(path.join(world.handle.root, '.karmax-injection/jobs', job.id, 'pid'), 'utf8').trim();
    const [group, session, deep] = kinds.map((kind) => procStat(named(`${m}-${kind}`)[0]!));
    // They really escaped: a group of its own, then sessions of their own.
    expect(group![2]).not.toBe(pid);
    expect(group![3]).toBe(pid);
    expect(session![3]).not.toBe(pid);
    expect(deep![3]).not.toBe(pid);
    await stopJobs(world, [job.id]);
    expect(kinds.flatMap((kind) => named(`${m}-${kind}`))).toEqual([]);
  });

  it('stops what an exited job left running, and nothing that is not its own', async () => {
    const m = marker();
    const job = await startJob(world, { command: `setsid bash -c 'exec -a ${m}-left sleep 120' & echo started` });
    const other = await startJob(world, { command: `exec -a ${m}-other sleep 120` });
    const stranger = spawn('bash', ['-c', `exec -a ${m}-stranger sleep 120`], { stdio: 'ignore' });
    try {
      await until(async () => (await jobStatuses(world, [job.id]))[0]!.state === 'exited'
        && ['left', 'other', 'stranger'].every((kind) => named(`${m}-${kind}`).length === 1));
      await stopJobs(world, [job.id]);
      expect(named(`${m}-left`)).toEqual([]);
      expect(named(`${m}-other`)).toHaveLength(1);
      expect(named(`${m}-stranger`)).toHaveLength(1);
      expect((await jobStatuses(world, [other.id]))[0]!.state).toBe('running');
      // A world's teardown stops every job it ever ran.
      await stopJobs(world);
      expect(named(`${m}-other`)).toEqual([]);
      expect(named(`${m}-stranger`)).toHaveLength(1);
    } finally { stranger.kill('SIGKILL'); }
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

      // indike.org#2: "End your turn now" alone made agents drop a question they were just asked.
      expect(await t.pause!({ minutes: 10 })).toBe('Pausing for 10 min. End your turn now, answering in your final response anything you were just asked; you will be resumed then, or sooner if a message arrives.');
      const running = await startJob(world, { command: 'sleep 30' });
      const waiting = await t.pause!({ minutes: 90, jobs: [running.id, done.id] });
      expect(waiting).toContain(`Waiting for ${running.id} (at most 90 min)`);
      expect(waiting).toContain('End your turn now, answering in your final response anything you were just asked;');
      // A plain pause lets a cloud world be suspended, which would freeze the job.
      expect(await t.pause!({ minutes: 10 })).toBe(`error: ${running.id} is still running. Pass it in jobs: a pause without it lets the world be suspended, which freezes it. You are still resumed after minutes at the latest.`);
      expect(ctx.waits).toEqual([{ minutes: 10 }, { minutes: 90, jobs: [running.id] }]);
    });

    // pramana#2: a job whose log ended mid-line (progress output) hid the next
    // job's status line inside its tail, so pause called that job "no such job".
    it('pause and the resume summary read every job, whatever its log ends with', async () => {
      const ctx = { started: [] as string[], waits: [] as AgentWait[] };
      const progress = await startJob(world, { command: "printf 'fetched 50 pages'; sleep 30" });
      const quiet = await startJob(world, { command: 'sleep 30' });
      const done = await startJob(world, { command: "printf 'no newline at the end'" });
      await until(async () => (await jobStatuses(world, [done.id]))[0]!.state === 'exited'
        && fs.readFileSync(progress.log, 'utf8') === 'fetched 50 pages');
      const statuses = await jobStatuses(world, [progress.id, done.id, quiet.id], { tailLines: 20 });
      expect(statuses.map(({ id, state, tail }) => ({ id, state, tail }))).toEqual([
        { id: progress.id, state: 'running', tail: 'fetched 50 pages' },
        { id: done.id, state: 'exited', tail: 'no newline at the end' },
        { id: quiet.id, state: 'running', tail: undefined },
      ]);
      expect(await tools(ctx).pause!({ minutes: 60, jobs: [progress.id, quiet.id] })).toContain(`Waiting for ${progress.id}, ${quiet.id}`);
      expect(ctx.waits).toEqual([{ minutes: 60, jobs: [progress.id, quiet.id] }]);
    });

    // An agent that paused while waiting on someone's answer read "Paused", and
    // nobody was told. needs_input makes the same pause an ask.
    it('a job may be named, and the name follows it to every wait on it', async () => {
      const ctx = { started: [] as string[], waits: [] as AgentWait[] };
      const t = tools(ctx);
      expect(await t.start_job!({ command: 'sleep 30', name: 'x'.repeat(61) })).toBe('error: name must be at most 60 characters');
      const reply = await t.start_job!({ command: 'sleep 30', name: '  render\nfinal  ' });
      const render = reply.match(/job-[a-f0-9]{8}/)![0];
      expect(reply).toContain(`Started job ${render} (render final)`);
      const unnamed = (await t.start_job!({ command: 'sleep 30' })).match(/job-[a-f0-9]{8}/)![0];
      expect((await jobStatuses(world, [render, unnamed])).map((job) => job.name)).toEqual(['render final', undefined]);
      expect(describeJobs(await jobStatuses(world, [render]))).toContain(`Job ${render} (render final) is still running`);

      expect(await t.pause!({ minutes: 30, jobs: [render, unnamed] })).toContain('Waiting for');
      expect(await t.pause!({ minutes: 30, jobs: [render] })).toBe('error: ' + unnamed + ' is still running. Pass it in jobs: a pause without it lets the world be suspended, which freezes it. You are still resumed after minutes at the latest.');
      await stopJobs(world, [unnamed]);
      expect(await t.pause!({ minutes: 30, jobs: [render] })).toContain('Waiting for render final');
      expect(ctx.waits).toEqual([
        { minutes: 30, jobs: [render, unnamed], jobNames: ['render final'] },
        { minutes: 30, jobs: [render], jobNames: ['render final'] },
      ]);
      await stopJobs(world, [render]);
    });

    it('pause with needs_input asks for an answer, routed and as loud as the agent said', async () => {
      const ctx = { started: [] as string[], waits: [] as AgentWait[] };
      const targets = { users: [{ selector: 'user:ana' }], teams: [{ selector: '@team:ops' }], special: [{ selector: '@creator' }] };
      const requests: string[] = [];
      const t = platformToolHandlers(world, {
        requestWait: (wait: AgentWait) => { ctx.waits.push(wait); },
        platformRequest: async (method: string, requestPath: string) => { requests.push(`${method} ${requestPath}`); return targets; },
        emit: () => {},
      } as any);
      // pause waits on jobs and events; it is not how an agent asks for input it needs.
      const pause = TOOL_SCHEMAS.find((tool) => tool.name === 'pause')!;
      expect(pause.description).toContain('It is not for asking: if you need an answer to continue, end your turn with the question (or call escalate_to_human for what only a person can give).');
      const schema = pause.parameters as any;
      expect(Object.keys(schema.properties)).toEqual(['minutes', 'jobs', 'needs_input', 'message', 'audience', 'urgency']);
      expect(schema.properties.urgency.enum).toEqual(['low', 'normal', 'high', 'critical']);

      // The ask's fields only mean something on an ask.
      expect(await t.pause!({ minutes: 5, urgency: 'high' })).toBe('error: message, audience and urgency apply only with needs_input: true');
      // A route nobody receives would park the task on an ask nobody sees.
      expect(await t.pause!({ minutes: 5, needs_input: true, audience: ['user:nobody'] }))
        .toBe('error: no such route: user:nobody. Valid routes: user:ana, @team:ops, @creator');
      expect(await t.pause!({ minutes: 5, needs_input: true, audience: ['avatar:a1'] }))
        .toBe('error: avatar:a1: ask an Avatar with escalate_to_human');
      expect(await t.pause!({ minutes: 5, needs_input: true, message: '  ' })).toBe('error: message must not be empty');
      expect(ctx.waits).toEqual([]);

      const asked = await t.pause!({ minutes: 120, needs_input: true, audience: ['user:ana', '@team:ops'],
        message: 'Which region should the bucket live in?', urgency: 'high' });
      expect(asked).toContain('Asking user:ana, @team:ops');
      expect(asked).toContain('after 120 min to carry on without it');
      // With no question, the final response is the question.
      expect(await t.pause!({ minutes: 30, needs_input: true })).toContain('with the question as your final response');
      expect(ctx.waits).toEqual([
        { minutes: 120, needsInput: { message: 'Which region should the bucket live in?', audience: ['user:ana', '@team:ops'], urgency: 'high' } },
        { minutes: 30, needsInput: {} },
      ]);
      expect(requests).toEqual(['GET /api/agent/escalation-targets', 'GET /api/agent/escalation-targets']);
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

      const m = marker();
      const leaver = await startJob(world, { command: `bash -c 'exec -a ${m} sleep 120' &` });
      await until(async () => (await jobStatuses(world, [leaver.id]))[0]!.state === 'exited' && named(m).length === 1);
      expect(await t.stop_job!({ jobs: [leaver.id] })).toBe(`${leaver.id} had already exited; ended the 1 process it left running.`);
      expect(named(m)).toEqual([]);
    });
  });

  it('stop_job names processes that survive SIGKILL', async () => {
    const id = 'job-0000000b';
    const fake = { handle: world.handle, exec: async (_cmd: string, args: string[]) => {
      if (args[2] === 'karmax-job-stop') return { code: 0, stdout: `stopped ${id} 3\nsurvivor ${id} 41\nsurvivor ${id} 42\n`, stderr: '' };
      const boundary = args[3];
      return { code: 0, stdout: `${boundary} ${id} lost 1 \n\n\n${boundary} end\n`, stderr: '' };
    } } as unknown as World;
    expect(await stopJobs(fake, [id])).toEqual([{ id, processes: 3, survivors: [41, 42] }]);
    const t = platformToolHandlers(fake, { emit: () => {} } as any);
    expect(await t.stop_job!({ jobs: [id] })).toBe(`${id}: processes 41, 42 survived SIGKILL.`);
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
