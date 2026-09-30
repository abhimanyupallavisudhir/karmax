import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { trackProcess, trackedProcesses, sampleProcesses, killTracked, processStartTick } from '../src/util/processes.js';

// The sampler/killer read Linux procfs; on other platforms they degrade to
// `supported: false`, which the first test pins down and the rest then skip.
const HAS_PROC = process.platform === 'linux' && fs.existsSync('/proc');
const itProc = HAS_PROC ? it : it.skip;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(50);
  }
  return false;
}

describe('process registry + /proc sampler (dashboard task manager)', () => {
  const children: ChildProcess[] = [];
  const untracks: Array<() => void> = [];
  const sleeper = () => {
    const c = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(c);
    return c;
  };

  afterEach(() => {
    for (const u of untracks.splice(0)) u();
    for (const c of children.splice(0)) {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
  });

  it('reports unsupported (not a crash) without procfs, and samples with it', () => {
    const s = sampleProcesses();
    expect(s.supported).toBe(HAS_PROC);
    if (!HAS_PROC) expect(s.groups).toEqual([]);
  });

  itProc('sees an UNREGISTERED child under "other karmax children" — coverage does not depend on registration', async () => {
    const c = sleeper();
    await delay(100); // let /proc entries materialize
    const s = sampleProcesses();
    const untracked = s.groups.find((g) => g.key === 'untracked');
    expect(untracked, 'untracked group present').toBeTruthy();
    expect(untracked!.procs.some((r) => r.pid === c.pid)).toBe(true);
    // ...and the sampler always accounts for karmax itself.
    const self = s.groups.find((g) => g.key === 'self');
    expect(self?.procs.map((r) => r.pid)).toEqual([process.pid]);
    expect(self?.protected).toBe(true);
    expect(s.totals.rssMb).toBeGreaterThan(0);
  });

  itProc('attributes a registered root AND its descendants to the labeled group', async () => {
    // bash parent that spawns its own sleep child — the child must be attributed
    // to the registered root, not to the catch-all.
    const c = spawn('bash', ['-c', 'sleep 60 & wait'], { stdio: 'ignore' });
    children.push(c);
    untracks.push(trackProcess({ pid: c.pid!, kind: 'terminal', label: 'test terminal', taskId: 'task_test1', startedAt: Date.now() }));
    await delay(300); // let bash fork its child
    const s = sampleProcesses();
    const g = s.groups.find((x) => x.key === String(c.pid));
    expect(g, 'registered group present').toBeTruthy();
    expect(g!.taskId).toBe('task_test1');
    expect(g!.kind).toBe('terminal');
    expect(g!.procs.some((r) => r.pid === c.pid)).toBe(true);
    expect(g!.procs.length, 'descendant sleep attributed to the root').toBeGreaterThanOrEqual(2);
    // Not double-counted in the catch-all.
    const untracked = s.groups.find((x) => x.key === 'untracked');
    expect(untracked?.procs.some((r) => r.pid === c.pid) ?? false).toBe(false);
  });

  itProc('computes CPU%% as a delta between samples (first sighting is 0)', async () => {
    const c = spawn('bash', ['-c', 'while :; do :; done'], { stdio: 'ignore' }); // busy loop
    children.push(c);
    await delay(100);
    sampleProcesses(); // baseline
    await delay(400);
    const s = sampleProcesses();
    const row = s.groups.flatMap((g) => g.procs).find((r) => r.pid === c.pid);
    expect(row).toBeTruthy();
    expect(row!.cpuPct).toBeGreaterThan(20); // a busy loop burns most of a core
  });

  itProc('prunes registry entries whose process died', async () => {
    const c = sleeper();
    trackProcess({ pid: c.pid!, kind: 'probe', label: 'doomed', startedAt: Date.now() });
    c.kill('SIGKILL');
    await waitGone(c.pid!);
    sampleProcesses();
    expect(trackedProcesses().some((t) => t.pid === c.pid)).toBe(false);
  });

  itProc('kills an in-scope pid, prefers a registered killer, and refuses everything else', async () => {
    // In-scope plain child → signalled directly.
    const a = sleeper();
    await delay(100);
    expect((await killTracked(a.pid!, 'SIGKILL')).ok).toBe(true);
    expect(await waitGone(a.pid!)).toBe(true);

    // Registered custom killer is preferred over a raw signal.
    const b = sleeper();
    let customKilled = false;
    untracks.push(
      trackProcess({
        pid: b.pid!,
        kind: 'terminal',
        label: 'custom',
        startedAt: Date.now(),
        kill: () => {
          customKilled = true;
          b.kill('SIGKILL');
        },
      }),
    );
    await delay(100);
    expect((await killTracked(b.pid!)).ok).toBe(true);
    expect(customKilled).toBe(true);

    // Refusals: karmax itself, out-of-scope pids, protected roots, nonsense.
    expect((await killTracked(process.pid)).ok).toBe(false);
    expect((await killTracked(1)).ok).toBe(false);
    expect((await killTracked(2)).ok).toBe(false); // kthreadd — alive but outside karmax's trees
    expect((await killTracked(0.5)).ok).toBe(false);
    const c = sleeper();
    untracks.push(trackProcess({ pid: c.pid!, kind: 'temporal', label: 'fake temporal', startedAt: Date.now(), protected: true }));
    const refused = await killTracked(c.pid!);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('protected');
    try {
      process.kill(c.pid!, 0); // still alive — the refusal really refused
    } catch {
      expect.unreachable('protected process was killed');
    }
  });

  itProc('stops an agent through its task without sending a retryable kill (AD-22)', async () => {
    const child = sleeper();
    const kill = vi.fn();
    const stopTask = vi.fn(async () => {});
    untracks.push(trackProcess({ pid: child.pid!, kind: 'agent', label: 'agent',
      taskId: 'task_stop', startedAt: Date.now(), kill }));
    expect(await killTracked(child.pid!, 'SIGKILL', stopTask)).toEqual({ ok: true });
    expect(stopTask).toHaveBeenCalledExactlyOnceWith('task_stop');
    expect(kill).not.toHaveBeenCalled();
    expect(await waitGone(child.pid!, 100)).toBe(false);
  });

  itProc('does not kill an agent if task cancellation fails (AD-22)', async () => {
    const child = sleeper();
    const kill = vi.fn();
    untracks.push(trackProcess({ pid: child.pid!, kind: 'agent', label: 'agent',
      taskId: 'task_stop', startedAt: Date.now(), kill }));
    const result = await killTracked(child.pid!, 'SIGTERM', async () => { throw new Error('not authorized'); });
    expect(result).toEqual({ ok: false, error: 'not authorized' });
    expect(kill).not.toHaveBeenCalled();
  });

  itProc('records a start tick so a recycled pid cannot be killed as ours', async () => {
    const child = sleeper();
    const pid = child.pid!;
    untracks.push(trackProcess({ pid, kind: 'agent', label: 'agent', startedAt: Date.now() }));
    expect(trackedProcesses().find((p) => p.pid === pid)?.startTick).toBe(processStartTick(pid));

    // Simulate pid reuse: the registered process is gone and an unrelated one now
    // holds that number. Killing it would SIGKILL a stranger — and for a group
    // leader, the stranger's entire process group.
    const entry = trackedProcesses().find((p) => p.pid === pid)!;
    (entry as any).startTick = String(Number(entry.startTick) + 12345);
    const result = await killTracked(pid, 'SIGTERM');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('recycled') });
    // The stale entry is dropped rather than left mislabelling a live stranger.
    expect(trackedProcesses().some((p) => p.pid === pid)).toBe(false);
    expect(await waitGone(pid, 300)).toBe(false); // still alive: we did not kill it
  });
});
