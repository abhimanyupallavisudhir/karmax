import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { accountCoordinatorId, mergeQueueId } from '../src/coordinators/names.js';
import { mergeQueueDomains } from '../src/domain/types.js';

const view = (h: any) => h.query('view') as Promise<any>;
const baseInput = (taskId: string, repo: string, over: any = {}) => ({
  taskId,
  projectId: 'p1',
  title: over.title ?? 'Task',
  prompt: over.prompt ?? '',
  base: 'main',
  target: 'main',
  project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
  ...over,
});

describe('the v1 workflow family (real Temporal + git, mock agent)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness('mock');
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('just-do: a single agent call, work committed to the branch (no merge)', async () => {
    const repo = await h.makeRepo('jd');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('justDo', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'note', prompt: '@write note.txt :: a quick note' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    const res = await handle.result();
    expect(res.stage).toBe('done');
    // committed to the task branch, NOT merged to main
    const onBranch = await git(repo, ['show', `karmax/${taskId}:note.txt`]);
    expect(onBranch.stdout).toContain('a quick note');
    const onMain = await git(repo, ['cat-file', '-e', 'main:note.txt']);
    expect(onMain.code).not.toBe(0);
  });

  it('just-do: injects a follow-up sent mid-turn into the live turn (SPEC §5.6)', async () => {
    const repo = await h.makeRepo('jd-mid');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('justDo', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      // A ~3s turn — a window to send a follow-up while the single Do turn runs.
      args: [baseInput(taskId, repo, { title: 'mid', prompt: '@sleep 3000\n@write base.txt :: base' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('do');
    await new Promise((r) => setTimeout(r, 700));
    await handle.signal('followUp', { id: 'm1', role: 'user', text: '@write injected.txt :: from a live follow-up', ts: 0 });
    // The follow-up is executed in the SAME turn (in-flight), so the turn reaches Review
    // with BOTH files written and no second Do turn.
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    const res = await handle.result();
    expect(res.stage).toBe('done');
    const injected = await git(repo, ['show', `karmax/${taskId}:injected.txt`]);
    expect(injected.stdout).toContain('from a live follow-up');
    const base = await git(repo, ['show', `karmax/${taskId}:base.txt`]);
    expect(base.stdout).toContain('base');
  });

  it('just-do: keeps working in parallel, then parks at the turn boundary until collaboration settles', async () => {
    const repo = await h.makeRepo('jd-collaboration');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('justDo', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, {
        title: 'parallel join',
        prompt: '@sleep 3000\n@write own.txt :: requester work',
      })],
    });
    // Temporal buffers a signal sent before its handler is installed. Sending
    // the request immediately makes this a durable ordering test instead of a
    // race to observe a short-lived `do` view on a busy CI runner.
    await handle.signal('collaborationRequested', 'collab-test');

    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 15_000 })
      .toBe('collaboration');
    expect((await view(handle)).stage).toBe('do');

    await handle.signal('collaborationSettled', 'collab-test', {
      id: 'collab-collab-test',
      role: 'user',
      text: '@write joined.txt :: publication arrived',
      ts: Date.now(),
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', `karmax/${taskId}:own.txt`])).stdout).toContain('requester work');
    expect((await git(repo, ['show', `karmax/${taskId}:joined.txt`])).stdout).toContain('publication arrived');
  });

  it('script-exec: runs a command and captures its output', async () => {
    const repo = await h.makeRepo('se');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('scriptExec', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'echo', command: 'echo karmax-rocks' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    const v = await view(handle);
    expect(JSON.stringify(v.messages)).toContain('karmax-rocks');
    await handle.signal('confirm');
    const res = await handle.result();
    expect(res.stage).toBe('done');
    expect(res.code).toBe(0);
  });

  it('goal: completes and merges without a human review gate', async () => {
    const repo = await h.makeRepo('goal');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('goal', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'reach goal', prompt: '@write goal.txt :: achieved\n@review goal done' })],
    });
    // no confirm sent — goal auto-confirms and merges
    const res = await handle.result();
    expect(res.stage).toBe('done');
    const onMain = await git(repo, ['show', 'main:goal.txt']);
    expect(onMain.stdout).toContain('achieved');
  });

  it('software-dev v1.5: parks a replacement at its originating stage and resumes on request', async () => {
    const repo = await h.makeRepo('stage-human-hold');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.5.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, {
        title: 'Paused task',
        recovery: {
          messages: [{ id: 'm0', role: 'user', text: '@write resumed.txt :: resumed', ts: 0 }],
          seen: 0,
          target: 'main',
          resumeStage: 'do',
          pausedForHuman: true,
        },
      })],
    });

    await expect.poll(async () => `${(await view(handle)).stage}/${(await view(handle)).waitingFor?.kind}`, { timeout: 15_000 })
      .toBe('do/human');
    expect((await view(handle)).state.humanPauseOrigin).toBe('do');

    await handle.signal('retry');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    expect((await view(handle)).state.humanPauseOrigin).toBeUndefined();
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
  });

  it('software-dev v1.7: a follow-up releases a Review-origin hold and returns to Do', async () => {
    const repo = await h.makeRepo('stage-human-followup');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.7.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, {
        title: 'Paused review',
        recovery: {
          messages: [{ id: 'm0', role: 'user', text: 'Previous work was reviewed.', ts: 0 }],
          seen: 1,
          target: 'main',
          resumeStage: 'review',
          pausedForHuman: true,
        },
      })],
    });

    await expect.poll(async () => `${(await view(handle)).stage}/${(await view(handle)).waitingFor?.kind}`, { timeout: 15_000 })
      .toBe('review/human');
    await handle.signal('followUp', {
      id: 'revision',
      role: 'user',
      text: '@write revised.txt :: resumed from review feedback',
      ts: 1,
    }, 'do');

    await expect.poll(async () => {
      const current = await view(handle);
      return current.stage === 'review'
        && current.messages.some((message: any) => message.role === 'agent' && /wrote revised/.test(message.text));
    }, { timeout: 20_000 }).toBe(true);
    expect((await view(handle)).state.humanPauseOrigin).toBeUndefined();
    expect(fs.readFileSync(path.join((await view(handle)).worldPath, 'revised.txt'), 'utf8'))
      .toContain('resumed from review feedback');
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
  });

  it('software-dev v1.7: Confirm releases a Review-origin hold and approves it once', async () => {
    const repo = await h.makeRepo('stage-human-confirm');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.7.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, {
        title: 'Paused approval',
        recovery: {
          messages: [{ id: 'm0', role: 'user', text: 'The preserved work is approved.', ts: 0 }],
          seen: 1,
          target: 'main',
          resumeStage: 'review',
          pausedForHuman: true,
        },
      })],
    });

    await expect.poll(async () => `${(await view(handle)).stage}/${(await view(handle)).waitingFor?.kind}`, { timeout: 15_000 })
      .toBe('review/human');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
  });

  it('goal: a clean partial return triggers another turn until explicit completion', async () => {
    const repo = await h.makeRepo('goal-persist');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('goal@1.3.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'persist', prompt: '@write persisted.txt :: first pass\n@incomplete' })],
    });
    expect((await handle.result()).stage).toBe('done');
    const finalView = await view(handle);
    expect(finalView.messages.map((m: any) => m.text).join('\n')).toMatch(/call signal_completion/i);
    const onMain = await git(repo, ['show', 'main:persisted.txt']);
    expect(onMain.stdout).toContain('first pass');
  });

  it('switches Software Dev at Review to Goal without approving the partial Review', async () => {
    const repo = await h.makeRepo('switch-to-goal');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.3.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'finish autonomously', prompt: '@write switched.txt :: achieved\n@review first pass' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    const changed = await handle.executeUpdate('changeWorkflow', { args: ['goal'] }) as any;
    expect(changed.workflow).toBe('goal');
    // The switch injects a continuation and goes back through Do; it does not
    // treat the already-waiting Software Dev review as implicitly confirmed.
    const res = await handle.result();
    expect(res.stage).toBe('done');
    const finalView = await view(handle);
    expect(finalView.workflow).toBe('goal');
    expect(finalView.messages.map((m: any) => m.text).join('\n')).toMatch(/entire task is complete/i);
    const onMain = await git(repo, ['show', 'main:switched.txt']);
    expect(onMain.stdout).toContain('achieved');
  });

  it('switches Goal back to Software Dev during Do and restores the Review gate', async () => {
    const repo = await h.makeRepo('switch-to-dev');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('goal@1.3.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'restore review', prompt: '@sleep 1500\n@write reviewed.txt :: ready' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('do');
    const changed = await handle.executeUpdate('changeWorkflow', { args: ['software-dev'] }) as any;
    expect(changed.workflow).toBe('software-dev');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    const atReview = await view(handle);
    expect(atReview.workflow).toBe('software-dev');
    expect(atReview.status).toBe('waiting');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
  });

  it('accepts an in-flight authorization edit while running, freezes it once terminal', async () => {
    const repo = await h.makeRepo('auth-inflight');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, {
        title: 'retune authorization',
        prompt: '@write auth.txt :: ok\n@review authorization edit',
        grant: ['task:signal'],
        grantPrincipal: 'user:creator',
        authorizationProfile: 'reader',
      })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    // Re-point the live grant: later turns mint their scoped token from this.
    const applied = await handle.executeUpdate('updateAuthorization', {
      args: [{ grant: ['task:signal', 'use-credential:item:cred-1'], grantPrincipal: 'user:editor', authorizationProfile: 'developer' }],
    }) as any;
    expect(applied).toEqual({ applied: true });
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    // Frozen once the execution has finished — no live grant to re-point.
    await expect(handle.executeUpdate('updateAuthorization', {
      args: [{ grant: ['task:signal'], grantPrincipal: 'user:editor', authorizationProfile: 'developer' }],
    })).rejects.toThrow();
  });

  it('merge-only: reviews and merges an existing branch (the dogfooded gate)', async () => {
    const repo = await h.makeRepo('mo');
    // build an existing feature branch with work
    await git(repo, ['checkout', '-q', '-b', 'feature']);
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature work\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'feat']);
    await git(repo, ['checkout', '-q', 'main']);

    const taskId = newId('task');
    const handle = await h.client.workflow.start('mergeOnly', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'merge feature', branch: 'feature', target: 'main' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await handle.signal('confirm');
    const res = await handle.result();
    expect(res.stage).toBe('done');
    const onMain = await git(repo, ['show', 'main:feat.txt']);
    expect(onMain.stdout).toContain('feature work');
  });

  /** A repo with `main` plus a `feature` branch carrying one extra commit. */
  const repoWithFeature = async (name: string) => {
    const repo = await h.makeRepo(name);
    await git(repo, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature work\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'feat']);
    await git(repo, ['checkout', '-q', 'main']);
    return repo;
  };

  /** Park a merge-queue domain by seeding its singleton coordinator with a slot
   *  already leased to a task that never releases it. */
  const holdMergeDomain = async (domain: string) =>
    h.client.workflow.start('mergeQueue', {
      taskQueue: TASK_QUEUE,
      workflowId: mergeQueueId(domain),
      args: [{ domain, state: { domain, queue: [], current: 'held', processed: 0 } }],
    });

  // Both behaviors below are pinned to mergeOnly@1.6.0 — the version the manifest
  // stamps on every new merge-only task. They are deliberately NOT retrofitted onto
  // older pins: each changes the commands a workflow task emits at a point older
  // executions already recorded, which would be a NonDeterminismError on replay.
  // The `keeps the pre-1.5 shape` test below is the other half of that contract.
  // (1.6.0, not 1.5.0: master published its own 1.5.0 concurrently — see SPEC §4.5.)
  it('merge-only 1.6: cancelling while queued for a merge slot releases the world instead of leaking it', async () => {
    const repo = await repoWithFeature('mo-cancel');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('mergeOnly@1.6.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'merge feature', branch: 'feature', target: 'main' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    const parked = await view(handle);
    const worldRoot = parked.worldPath ?? parked.world.root;
    expect(fs.existsSync(worldRoot)).toBe(true);

    // Hold the domain this task will queue on so it cannot merge straight through.
    const domain = `${parked.world.repos?.[0]?.localPath ?? parked.world.repo}:main`;
    const holder = await holdMergeDomain(domain);
    await handle.signal('confirm');
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 20_000 }).toBe('mergeSlot');
    expect((await view(handle)).stage).toBe('merge');

    // Cancel from the queue. This exit used to return `cancelled` without ever
    // calling destroyWorld — for a cloud world, a leaked billable sandbox.
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
    expect(fs.existsSync(worldRoot)).toBe(false);
    // …and the slot it was waiting on was handed back, not left queued.
    expect(((await holder.query('queue')) as any).queue).toEqual([]);
    // nothing landed on main
    expect((await git(repo, ['cat-file', '-e', 'main:feat.txt'])).code).not.toBe(0);
    await holder.terminate('test done');
  });

  it('merge-only 1.6: a confirm that arrives before the Review gate does not pre-approve it', async () => {
    const repo = await repoWithFeature('mo-latch');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('mergeOnly@1.6.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'early confirm', branch: 'feature', target: 'main' })],
    });
    // Fire the confirm immediately — before the world even exists, so it predates
    // the gate. `confirmSignal` sets the latch at ANY stage; without the clear on
    // entry to Review the branch merged completely unreviewed.
    await handle.signal('confirm');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    // Still parked on a human at the gate, and nothing merged.
    await new Promise((r) => setTimeout(r, 1_500));
    const v = await view(handle);
    expect(v.stage).toBe('review');
    expect(v.waitingFor?.kind).toBe('human');
    expect((await git(repo, ['cat-file', '-e', 'main:feat.txt'])).code).not.toBe(0);
    // The Review gate advertises exactly Approve + Cancel — no dead "Request
    // changes" action (there is no Do stage to send work back to).
    expect(v.actions.map((a: any) => a.name).sort()).toEqual(['cancel', 'confirm']);

    // A confirm sent while the gate IS open still works.
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:feat.txt'])).stdout).toContain('feature work');
  });

  it('merge-only pre-1.5: keeps the pre-1.5 confirm-latch shape, so in-flight executions still replay', async () => {
    const repo = await repoWithFeature('mo-latch-legacy');
    const taskId = newId('task');
    // The bare `mergeOnly` type is the 1.1.0 entry point. An execution pinned here
    // recorded its Review gate returning INSTANTLY for a confirm that predated the
    // gate; if the 1.5.0 clear leaked onto this version the gate would park instead,
    // emitting no command where history has one — a NonDeterminismError that wedges
    // the execution for good. So the old (buggier) behavior is the CORRECT behavior
    // here, and this test exists to keep anyone from "fixing" it retroactively.
    const handle = await h.client.workflow.start('mergeOnly', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'early confirm', branch: 'feature', target: 'main' })],
    });
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:feat.txt'])).stdout).toContain('feature work');
  });

  // Asserted, not skip-guarded. This once carried
  // `it.skipIf(!BUNDLED_QUALIFIED.has(...))` from when the export did not yet
  // exist; now that it does, that guard could only ever hide a regression which
  // dropped the export, turning a failure into a silent skip.
  it(
    'merge-only 1.6: serializes on EVERY repo domain, not just repo[0]',
    async () => {
      const repo = await repoWithFeature('mo-domains');
      // A real project makes the world multi-repo: karmax attaches the project
      // wiki companion checkout alongside the development repo, and the wiki pins
      // its own target branch — precisely the case the old single ad-hoc domain
      // key merged unserialized.
      const project = h.store.createProject('MergeOnly domains',
        { repos: [repo], defaultBase: 'main', defaultTarget: 'main' });
      const task = h.store.createTask({ projectId: project.id, title: 'merge feature',
        workflow: 'merge-only', workflowVersion: '1.5.0', params: { prompt: '' } as any });
      const taskId = task.id;
      const handle = await h.client.workflow.start('mergeOnly@1.6.0', {
        taskQueue: TASK_QUEUE,
        workflowId: taskId,
        args: [{
          ...baseInput(taskId, repo, { title: 'merge feature', branch: 'feature', target: 'main' }),
          projectId: project.id,
        }],
      });
      await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
      const v = await view(handle);
      const domains = mergeQueueDomains(v.world, 'main', project.id);
      expect(domains.length).toBeGreaterThan(1);
      expect(v.state.mergeDomains).toEqual(domains); // same keys software-dev computes
      // The one domain the old ad-hoc `repo[0]` key would never have locked.
      const adHoc = `${v.world.repos?.[0]?.localPath ?? v.world.repo}:main`;
      const unlocked = domains.filter((d: string) => d !== adHoc);
      expect(unlocked.length).toBeGreaterThan(0);

      const holder = await holdMergeDomain(unlocked[0]!);
      await handle.signal('confirm');
      // Old behavior: blows straight past this domain and merges within a second.
      await new Promise((r) => setTimeout(r, 4_000));
      const queued = await view(handle);
      expect(queued.stage).toBe('merge');
      expect(queued.waitingFor?.kind).toBe('mergeSlot');
      expect((await git(repo, ['cat-file', '-e', 'main:feat.txt'])).code).not.toBe(0);

      // Release the held slot → it acquires the rest and merges.
      await holder.signal('release', { taskId: 'held' });
      expect((await handle.result()).stage).toBe('done');
      expect((await git(repo, ['show', 'main:feat.txt'])).stdout).toContain('feature work');
      await holder.terminate('test done');
    },
  );

  it('account coordinator: leases account capacity and frees it on return', async () => {
    // a grantee workflow that simply exists to receive the grant signal
    const grantee = newId('task');
    const ping = await h.client.workflow.start('pingWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: grantee,
      args: ['x'],
    });
    const coord = await h.client.workflow.start('accountCoordinator', {
      taskQueue: TASK_QUEUE,
      workflowId: accountCoordinatorId(),
      args: [{ state: { accounts: [{ id: 'acct1', configHome: '/tmp/ch', provider: 'claude', maxConcurrent: 1, inUse: 0, status: 'available' }], queue: [], processed: 0 } }],
    });
    await coord.signal('leaseAccount', { taskId: grantee, turnId: 't1', provider: 'claude' });
    await expect.poll(async () => ((await coord.query('accounts')) as any).accounts[0].inUse, { timeout: 10_000 }).toBe(1);
    const used = ((await coord.query('accounts')) as any).accounts[0];
    expect(used.status).toBe('available');
    expect(used.provider).toBe('claude');
    await coord.signal('returnAccount', { accountId: 'acct1' });
    await expect.poll(async () => ((await coord.query('accounts')) as any).accounts[0].inUse, { timeout: 10_000 }).toBe(0);

    await ping.signal('finish');
    await ping.result();
    await coord.terminate('test done');
  });

  it('leases an account per turn when a pool is registered, then returns it', async () => {
    const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
    const coordClient = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    // Register a pool (creates the singleton coordinator via the new signal path).
    await coordClient.registerAccounts([{ id: 'mock:work', configHome: '/tmp/karmax-ch-work', provider: 'mock', maxConcurrent: 2 }]);
    const coord = h.client.workflow.getHandle(accountCoordinatorId());
    await expect.poll(async () => ((await coord.query('accounts')) as any).accounts.length, { timeout: 10_000 }).toBe(1);

    const repo = await h.makeRepo('leased');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [baseInput(taskId, repo, { title: 'Leased', prompt: 'Do it.\n@write a.txt :: hi\n@review done' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 20_000 }).toBe('review');
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');

    // The do-turn leased the account and returned it (inUse back to 0, still available).
    const acct = ((await coord.query('accounts')) as any).accounts[0];
    expect(acct.provider).toBe('mock');
    expect(acct.status).toBe('available');
    await expect.poll(async () => ((await coord.query('accounts')) as any).accounts[0].inUse, { timeout: 10_000 }).toBe(0);
    await coord.terminate('test done');
  });

  it('merge queue reorders: prioritize (top), move-to-bottom, and drag (insert-before)', async () => {
    const { mergeQueueId } = await import('../src/coordinators/names.js');
    const domain = 'repo:main';
    // Seed with a held slot so the coordinator parks instead of draining the queue.
    const wf = await h.client.workflow.start('mergeQueue', {
      taskQueue: TASK_QUEUE,
      workflowId: mergeQueueId(domain),
      args: [{ domain, state: { domain, queue: ['t1', 't2', 't3'], current: 'held', processed: 0 } }],
    });
    const q = async () => ((await wf.query('queue')) as any).queue as string[];
    expect(await q()).toEqual(['t1', 't2', 't3']);

    // Move to top (the old "Prioritize").
    await wf.signal('prioritize', { taskId: 't3' });
    await expect.poll(q, { timeout: 10_000 }).toEqual(['t3', 't1', 't2']);

    // Move to bottom (reorder with no anchor).
    await wf.signal('reorderQueue', { taskId: 't3' });
    await expect.poll(q, { timeout: 10_000 }).toEqual(['t1', 't2', 't3']);

    // Drag: place t1 immediately before t3.
    await wf.signal('reorderQueue', { taskId: 't1', beforeTaskId: 't3' });
    await expect.poll(q, { timeout: 10_000 }).toEqual(['t2', 't1', 't3']);

    // Unknown anchor → falls to the bottom.
    await wf.signal('reorderQueue', { taskId: 't2', beforeTaskId: 'gone' });
    await expect.poll(q, { timeout: 10_000 }).toEqual(['t1', 't3', 't2']);

    await wf.terminate('test done');
  });

  it('agent queue owns capacity and supports durable waiting-order changes', async () => {
    const { agentQueueId } = await import('../src/coordinators/names.js');
    const held = [
      { taskId: 'running-1', turnId: 'running-1#0', role: 'do' },
      { taskId: 'running-2', turnId: 'running-2#0', role: 'confirm' },
    ];
    const waiting = [
      { taskId: 't1', turnId: 't1#0', role: 'do' },
      { taskId: 't2', turnId: 't2#0', role: 'merge' },
      { taskId: 't3', turnId: 't3#0', role: 'resolve' },
    ];
    const wf = await h.client.workflow.start('agentQueue', {
      taskQueue: TASK_QUEUE,
      workflowId: `${agentQueueId()}:reorder-test`,
      args: [{ capacity: 2, state: { capacity: 2, current: held, queue: waiting, processed: 0 } }],
    });
    const q = async () => await wf.query('agentQueue') as any;
    expect((await q()).queue.map((x: any) => x.turnId)).toEqual(['t1#0', 't2#0', 't3#0']);

    await wf.signal('reorderQueue', { turnId: 't3#0', beforeTurnId: 't1#0' });
    await expect.poll(async () => (await q()).queue.map((x: any) => x.turnId), { timeout: 10_000 }).toEqual(['t3#0', 't1#0', 't2#0']);

    await wf.signal('setAgentCapacity', { capacity: 1 });
    await expect.poll(async () => (await q()).capacity, { timeout: 10_000 }).toBe(1);
    expect((await q()).current).toHaveLength(2); // shrinking never kills running turns
    await wf.terminate('test done');
  });

  it('acknowledges queued turns without a blocking Update and rotates with an active lease', async () => {
    const { agentQueueId } = await import('../src/coordinators/names.js');
    const receiver = await h.client.workflow.start('mergeQueue', {
      taskQueue: TASK_QUEUE,
      workflowId: 'agent-v2-receiver',
      args: [{ domain: 'agent-v2-receiver' }],
    });
    const held = { taskId: 'already-running', turnId: 'already-running#0', role: 'do' };
    const waiting = { taskId: 'agent-v2-receiver', turnId: 'agent-v2-receiver#0', role: 'merge' };
    const wf = await h.client.workflow.start('agentQueue', {
      taskQueue: TASK_QUEUE,
      workflowId: `${agentQueueId()}:v2-test`,
      args: [{
        capacity: 1,
        state: { capacity: 1, current: [held], queue: [], processed: 49, modern: true },
      }],
    });
    const initialRunId = (await wf.describe()).runId;

    await wf.signal('requestAgentSlotV2', waiting);
    await expect(wf.executeUpdate('requestAgentSlotV2', { args: [waiting] })).resolves.toEqual({
      granted: false,
      position: 1,
      capacity: 1,
    });
    expect((await wf.query('agentQueue') as any).queue.map((x: any) => x.turnId)).toEqual([waiting.turnId]);

    await wf.signal('releaseAgentSlot', { taskId: held.taskId, turnId: held.turnId });
    await expect.poll(async () => (await wf.query('agentQueue') as any).current.map((x: any) => x.turnId))
      .toEqual([waiting.turnId]);
    await expect.poll(async () => (await wf.describe()).runId).not.toBe(initialRunId);
    expect((await wf.query('agentQueue') as any).current.map((x: any) => x.turnId)).toEqual([waiting.turnId]);

    await wf.terminate('test done');
    await receiver.terminate('test done');
  });

  it('admits a burst through one blocking update per waiter', async () => {
    const { agentQueueId } = await import('../src/coordinators/names.js');
    const wf = await h.client.workflow.start('agentQueue', {
      taskQueue: TASK_QUEUE,
      workflowId: `${agentQueueId()}:burst-test`,
      args: [{ capacity: 2 }],
    });
    const items = Array.from({ length: 5 }, (_, i) => ({
      taskId: `burst-${i}`,
      turnId: `burst-${i}#0`,
      role: 'do',
    }));
    for (const item of items) await wf.signal('leaseAgentSlot', item);
    const waits = items.map((item) =>
      wf.executeUpdate('waitAgentSlot', { args: [{ taskId: item.taskId, turnId: item.turnId }] }) as Promise<boolean>);

    await expect.poll(async () => {
      const view = await wf.query('agentQueue') as any;
      return [view.current.map((x: any) => x.turnId), view.queue.map((x: any) => x.turnId)];
    }, { timeout: 10_000 }).toEqual([
      ['burst-0#0', 'burst-1#0'],
      ['burst-2#0', 'burst-3#0', 'burst-4#0'],
    ]);
    await expect(Promise.all(waits.slice(0, 2))).resolves.toEqual([true, true]);

    await wf.signal('releaseAgentSlot', { taskId: 'burst-0', turnId: 'burst-0#0' });
    await wf.signal('releaseAgentSlot', { taskId: 'burst-1', turnId: 'burst-1#0' });
    await expect(Promise.all(waits.slice(2, 4))).resolves.toEqual([true, true]);
    await wf.signal('releaseAgentSlot', { taskId: 'burst-2', turnId: 'burst-2#0' });
    await wf.signal('releaseAgentSlot', { taskId: 'burst-3', turnId: 'burst-3#0' });
    await expect(waits[4]).resolves.toBe(true);

    await wf.signal('setAgentCapacity', { capacity: 1 });
    const cancelled = { taskId: 'burst-cancelled', turnId: 'burst-cancelled#0', role: 'do' };
    await wf.signal('leaseAgentSlot', cancelled);
    const cancelledWait = wf.executeUpdate('waitAgentSlot', {
      args: [{ taskId: cancelled.taskId, turnId: cancelled.turnId }],
    }) as Promise<boolean>;
    await expect.poll(async () => (await wf.query('agentQueue') as any).queue.map((x: any) => x.turnId))
      .toContain(cancelled.turnId);
    await wf.signal('cancelAgentSlot', { taskId: cancelled.taskId, turnId: cancelled.turnId });
    await expect(cancelledWait).resolves.toBe(false);

    await wf.terminate('test done');
  });
});
