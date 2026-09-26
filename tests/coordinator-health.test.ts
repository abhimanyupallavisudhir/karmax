import { describe, it, expect } from 'vitest';
import { WorkflowNotFoundError } from '@temporalio/client';
import { healCoordinators } from '../src/platform/coordinator-health.js';
import { makeCoordinatorActivities } from '../src/activities/coordinator.js';
import { SIG_ENQUEUE, mergeQueueId } from '../src/coordinators/names.js';

/**
 * Coordinators are the one workflow family with no version pin — keyed by id,
 * started once, running for weeks — so editing `src/coordinators/*` makes every
 * in-flight singleton replay old history against new code. Temporal retries the
 * resulting nondeterministic workflow task forever, and the coordinator can then
 * neither grant nor answer a query. karmax#345 and #350 both stalled on exactly
 * that, invisibly, because the tasks waiting on it only saw a query that failed.
 */

const NONDET = '[TMPRL1100] Nondeterminism error: Activity machine does not handle this event';

interface FakeOpts {
  running: Record<string, { workflowId: string; runId?: string }[]>;
  /** Query outcome per workflowId: 'ok' answers, 'fail' throws a generic
   *  error, 'fail-nondet' throws the replay error a divergent query returns. */
  query: Record<string, 'ok' | 'fail' | 'fail-nondet'>;
  /** Last workflow-task event per workflowId. */
  history: Record<string, 'failed-nondet' | 'failed-other' | 'completed' | 'none'>;
}

function fakeClient(opts: FakeOpts) {
  const terminated: { workflowId: string; runId?: string }[] = [];
  const started: { type: string; workflowId: string; args: unknown[] }[] = [];

  const historyFor = (id: string) => {
    const kind = opts.history[id] ?? 'none';
    if (kind === 'completed') return { events: [{ workflowTaskCompletedEventAttributes: {} }] };
    if (kind === 'failed-nondet')
      return { events: [{ workflowTaskFailedEventAttributes: { failure: { message: NONDET } } }] };
    if (kind === 'failed-other')
      return { events: [{ workflowTaskFailedEventAttributes: { failure: { message: 'activity timeout' } } }] };
    return { events: [] };
  };

  const client = {
    workflow: {
      list({ query }: { query: string }) {
        const type = /WorkflowType = '([^']+)'/.exec(query)?.[1] ?? '';
        const items = opts.running[type] ?? [];
        return (async function* () { for (const i of items) yield i; })();
      },
      getHandle(workflowId: string, runId?: string) {
        return {
          async query() {
            const mode = opts.query[workflowId];
            if (mode === 'ok') return { queue: [], current: undefined };
            if (mode === 'fail-nondet') throw new Error(NONDET);
            throw new Error('Unable to query workflow due to Workflow Task in failed state');
          },
          async fetchHistory() { return historyFor(workflowId); },
          async terminate() { terminated.push({ workflowId, runId }); },
        };
      },
      async start(type: string, options: { workflowId: string; args: unknown[] }) {
        started.push({ type, workflowId: options.workflowId, args: options.args });
        return {};
      },
    },
  } as never;

  return { client, terminated, started };
}

const DOMAIN = '/repo:main';
const MQ_ID = mergeQueueId(DOMAIN);

describe('healCoordinators', () => {
  it('rebuilds a merge queue whose history cannot be replayed', async () => {
    const f = fakeClient({
      running: { mergeQueue: [{ workflowId: MQ_ID, runId: 'run-1' }] },
      query: { [MQ_ID]: 'fail' },
      history: { [MQ_ID]: 'failed-nondet' },
    });

    const health = await healCoordinators(f.client, 'karmax');

    expect(health.wedged).toEqual([MQ_ID]);
    expect(health.rebuilt).toEqual([MQ_ID]);
    // Terminating alone is not enough: Temporal replays *closed* workflows to
    // answer queries, so without a replacement the domain still serves nothing.
    expect(f.terminated).toEqual([{ workflowId: MQ_ID, runId: 'run-1' }]);
    expect(f.started).toEqual([{ type: 'mergeQueue', workflowId: MQ_ID, args: [{ domain: DOMAIN }] }]);
  });

  it('pins the terminate to the exact runId it probed', async () => {
    const f = fakeClient({
      running: { mergeQueue: [{ workflowId: MQ_ID, runId: 'run-abc' }] },
      query: { [MQ_ID]: 'fail' },
      history: { [MQ_ID]: 'failed-nondet' },
    });

    await healCoordinators(f.client, 'karmax');

    // A replacement started concurrently must never be the run we kill.
    expect(f.terminated[0]?.runId).toBe('run-abc');
  });

  it('catches a latent wedge whose last workflow task still completed', async () => {
    // Found by running the classifier against the live incident: the GitHub
    // merge domain answered queries with TMPRL1100 while its most recent
    // workflow task had *completed*, because a coordinator parked in
    // `condition()` executes no task until something signals it. A
    // history-only verdict calls that healthy right up to the moment it wedges
    // hard — so the query error, when it names the divergence, is conclusive.
    const f = fakeClient({
      running: { mergeQueue: [{ workflowId: MQ_ID, runId: 'run-latent' }] },
      query: { [MQ_ID]: 'fail-nondet' },
      history: { [MQ_ID]: 'completed' },
    });

    const health = await healCoordinators(f.client, 'karmax');

    expect(health.wedged).toEqual([MQ_ID]);
    expect(health.rebuilt).toEqual([MQ_ID]);
    expect(f.terminated).toEqual([{ workflowId: MQ_ID, runId: 'run-latent' }]);
  });

  it('leaves a healthy coordinator alone', async () => {
    const f = fakeClient({
      running: { mergeQueue: [{ workflowId: MQ_ID }] },
      query: { [MQ_ID]: 'ok' },
      history: {},
    });

    const health = await healCoordinators(f.client, 'karmax');

    expect(health.checked).toBe(1);
    expect(health.wedged).toEqual([]);
    expect(f.terminated).toEqual([]);
    expect(f.started).toEqual([]);
  });

  it('does not rebuild when a failed query is not a replay failure', async () => {
    // An unregistered query name or a transient transport error also throws.
    // Rebuilding on those would destroy a live queue for no reason, so the
    // verdict comes from history, not from the query error.
    const f = fakeClient({
      running: { mergeQueue: [{ workflowId: MQ_ID }] },
      query: { [MQ_ID]: 'fail' },
      history: { [MQ_ID]: 'failed-other' },
    });

    const health = await healCoordinators(f.client, 'karmax');

    expect(health.wedged).toEqual([]);
    expect(f.terminated).toEqual([]);
  });

  it('does not rebuild a coordinator still making progress', async () => {
    const f = fakeClient({
      running: { mergeQueue: [{ workflowId: MQ_ID }] },
      query: { [MQ_ID]: 'fail' },
      history: { [MQ_ID]: 'completed' },
    });

    expect((await healCoordinators(f.client, 'karmax')).wedged).toEqual([]);
  });

  it('reports a wedged budget coordinator instead of resetting its spend counters', async () => {
    const f = fakeClient({
      running: { budgetCoordinator: [{ workflowId: 'budget-coordinator' }] },
      query: { 'budget-coordinator': 'fail' },
      history: { 'budget-coordinator': 'failed-nondet' },
    });

    const health = await healCoordinators(f.client, 'karmax');

    expect(health.wedged).toEqual(['budget-coordinator']);
    expect(health.rebuilt).toEqual([]);
    expect(f.terminated).toEqual([]);
    expect(health.reported[0]?.reason).toMatch(/already spent/i);
  });

  it('reports a wedged agent queue rather than orphaning parked turns', async () => {
    // A granted agent slot is a one-shot signal, not a poll: a fresh empty queue
    // would never re-grant a turn that is already parked waiting for one.
    const f = fakeClient({
      running: { agentQueue: [{ workflowId: 'agent-queue' }] },
      query: { 'agent-queue': 'fail' },
      history: { 'agent-queue': 'failed-nondet' },
    });

    const health = await healCoordinators(f.client, 'karmax');

    expect(health.rebuilt).toEqual([]);
    expect(health.reported[0]?.reason).toMatch(/one-shot signal/i);
  });
});

describe('the merge wait repopulates a rebuilt queue', () => {
  it('re-enqueues a task that the queue has never heard of', async () => {
    // This is what makes rebuilding a merge queue safe: its waiters put
    // themselves back within one poll interval.
    const signals: { workflowId: string; signal: string; args: unknown[] }[] = [];
    const client = {
      workflow: {
        getHandle: () => ({ query: async () => ({ queue: ['other'], current: undefined }) }),
        async signalWithStart(_type: string, o: { workflowId: string; signal: string; signalArgs: unknown[] }) {
          signals.push({ workflowId: o.workflowId, signal: o.signal, args: o.signalArgs });
        },
      },
    } as never;

    const act = makeCoordinatorActivities({ client, taskQueue: 'karmax' });
    const pos = await act.mergeQueuePosition(DOMAIN, 'task_me');

    expect(signals).toEqual([
      { workflowId: MQ_ID, signal: SIG_ENQUEUE, args: [{ taskId: 'task_me' }] },
    ]);
    // …and it reports the slot it just took rather than the -1 that would keep
    // the UI claiming the task isn't queued at all.
    expect(pos.position).toBe(2);
    expect(pos.unreachable).toBeUndefined();
  });

  it('does not re-enqueue a task already holding or waiting for the slot', async () => {
    const signals: unknown[] = [];
    const make = (view: { queue: string[]; current?: string }) => {
      const client = {
        workflow: {
          getHandle: () => ({ query: async () => view }),
          async signalWithStart() { signals.push(1); },
        },
      } as never;
      return makeCoordinatorActivities({ client, taskQueue: 'karmax' });
    };

    expect(await make({ queue: [], current: 'task_me' }).mergeQueuePosition(DOMAIN, 'task_me'))
      .toMatchObject({ position: 0 });
    expect(await make({ queue: ['task_me'], current: 'x' }).mergeQueuePosition(DOMAIN, 'task_me'))
      .toMatchObject({ position: 1, total: 2 });
    expect(signals).toEqual([]);
  });
});

describe('account-pool discovery', () => {
  const activity = (query: () => Promise<unknown>) => makeCoordinatorActivities({
    client: { workflow: { getHandle: () => ({ query }) } } as never,
    taskQueue: 'karmax',
  });

  it('returns zero only when the optional coordinator does not exist', async () => {
    await expect(activity(async () => {
      throw new WorkflowNotFoundError('missing', 'account-coordinator', undefined);
    }).accountPoolSize()).resolves.toBe(0);
  });

  it('rethrows transient query failures so Temporal retries instead of bypassing credentials', async () => {
    await expect(activity(async () => {
      throw new Error('query task expired during worker replay');
    }).accountPoolSize()).rejects.toThrow('query task expired');
  });
});

describe('WF-13: lease-holder liveness', () => {
  const activities = (describe: () => Promise<unknown>) => makeCoordinatorActivities({ client: { workflow: {
    getHandle: () => ({ describe }),
  } } as never, taskQueue: 'queue' });
  it('propagates transient describe failures without reclaiming a live lease', async () => {
    const error = new Error('UNAVAILABLE');
    await expect(activities(async () => { throw error; }).isTaskAlive('task')).rejects.toBe(error);
  });
  it('reclaims only missing or closed executions', async () => {
    expect(await activities(async () => { throw new WorkflowNotFoundError('missing', 'task'); }).isTaskAlive('task')).toBe(false);
    expect(await activities(async () => ({ status: { name: 'COMPLETED' } })).isTaskAlive('task')).toBe(false);
    expect(await activities(async () => ({ status: { name: 'RUNNING' } })).isTaskAlive('task')).toBe(true);
  });
});
