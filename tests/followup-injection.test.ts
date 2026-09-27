import { describe, it, expect, vi } from 'vitest';
import { createFollowUpInjector, toSdkUserMessage } from '../src/agent/sdk-stream.js';
import { MockAdapter } from '../src/agent/mock.js';
import type { PlatformToolContext, TurnInput } from '../src/agent/types.js';
import type { Message } from '../src/domain/types.js';

/**
 * In-flight follow-up injection (SPEC §5.6). A follow-up sent WHILE an agent turn
 * runs is polled from the workflow (pendingMessages) and injected into the LIVE
 * session — executed in the same turn, never dropped, and the turn reports exactly
 * how many messages it consumed so the workflow's boundary stays honest.
 */
describe('createFollowUpInjector (SDK streaming input)', () => {
  it('yields the initial batch, then pushed messages, and ends on close', async () => {
    const inj = createFollowUpInjector([toSdkUserMessage('one')]);
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const m of inj.stream) seen.push(m.message.content as string);
    })();
    // let the initial message flush, then inject two more mid-stream
    await new Promise((r) => setTimeout(r, 10));
    inj.push(toSdkUserMessage('two'));
    await new Promise((r) => setTimeout(r, 10));
    inj.push(toSdkUserMessage('three'));
    await new Promise((r) => setTimeout(r, 10));
    expect(inj.closed).toBe(false);
    (await inj.close());
    await consumer;
    expect(seen).toEqual(['one', 'two', 'three']);
    expect(inj.closed).toBe(true);
  });

  it('drops pushes after close (a late follow-up belongs to the next turn)', async () => {
    const inj = createFollowUpInjector([toSdkUserMessage('only')]);
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const m of inj.stream) seen.push(m.message.content as string);
    })();
    await new Promise((r) => setTimeout(r, 10));
    (await inj.close());
    inj.push(toSdkUserMessage('too-late'));
    await consumer;
    expect(seen).toEqual(['only']);
  });
});

describe('mock adapter in-flight injection + delivered accounting', () => {
  const runWith = async (opts: {
    messages: Message[];
    followUps?: Message[]; // returned by pullFollowUps, appended after `messages`
  }) => {
    const writes: string[] = [];
    const world = {
      handle: { id: `w-${Math.random().toString(36).slice(2)}` },
      async writeFile(p: string) { writes.push(p); },
      async exec() { return { code: 0, stdout: '', stderr: '' }; },
    } as any;
    // pullFollowUps(fromIndex) returns the tail of the virtual conversation
    // [...messages, ...followUps] at/after fromIndex — exactly what the workflow's
    // pendingMessages query does. Served ONCE (a real turn only injects each once).
    const convo = [...opts.messages, ...(opts.followUps ?? [])];
    const ctx: Partial<PlatformToolContext> = {
      emit() {},
      signalCompletion() {},
      async pullFollowUps(fromIndex: number) {
        return convo.slice(Math.max(0, fromIndex));
      },
    };
    const turn = await new MockAdapter().runTurn(
      { profile: {} as any, world, messages: opts.messages, systemPrompt: '', role: 'do' } as TurnInput,
      ctx as PlatformToolContext,
    );
    return { writes, turn };
  };

  it('reports delivered = messages.length when no follow-up arrives', async () => {
    const messages: Message[] = [{ id: 'm0', role: 'user', text: '@write a.txt :: a', ts: 0 }];
    const { writes, turn } = await runWith({ messages });
    expect(writes).toEqual(['a.txt']);
    expect(turn.delivered).toBe(1);
  });

  it('injects a follow-up that lands mid-turn and counts it in delivered', async () => {
    // Turn one sleeps briefly; the follow-up (index 1) is polled + processed in-flight.
    const messages: Message[] = [{ id: 'm0', role: 'user', text: '@sleep 400\n@write base.txt :: base', ts: 0 }];
    const followUps: Message[] = [{ id: 'f1', role: 'user', text: '@write injected.txt :: live', ts: 1 }];
    const { writes, turn } = await runWith({ messages, followUps });
    // BOTH files were written in the SAME turn — the follow-up was not deferred.
    expect(writes).toContain('base.txt');
    expect(writes).toContain('injected.txt');
    // delivered advanced past the injected message (1 initial + 1 follow-up).
    expect(turn.delivered).toBe(2);
  });

  it('skips a system-role follow-up but still advances the delivered index', async () => {
    const messages: Message[] = [{ id: 'm0', role: 'user', text: '@sleep 300', ts: 0 }];
    const followUps: Message[] = [
      { id: 's1', role: 'system', text: '@write nope.txt :: no', ts: 1 },
      { id: 'f2', role: 'user', text: '@write yes.txt :: yes', ts: 2 },
    ];
    const { writes, turn } = await runWith({ messages, followUps });
    expect(writes).not.toContain('nope.txt'); // system messages are never executed
    expect(writes).toContain('yes.txt');
    expect(turn.delivered).toBe(3); // 1 initial + system (counted, skipped) + user follow-up
  });
});

describe('live follow-up channel cost (LT-13)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  interface Channel {
    pull(from: number): Promise<Message[]>;
    /** The workflow applies an accepted followUp signal. */
    apply(message: Message): void;
    /** The API journals the accepted follow-up (after Temporal accepted it). */
    journal(message: Message): Promise<void>;
    queries(): number;
  }

  /** Run one real runAgentTurn activity whose adapter polls like the SDK/Codex
   * adapters do; the fake workflow counts its pendingMessages queries. */
  async function runPollingTurn(script: (channel: Channel) => Promise<void>) {
    const { Context } = await import('@temporalio/activity');
    const { makeCoreActivities } = await import('../src/activities/core.js');
    const { ProfileResolver } = await import('../src/agent/profiles.js');
    const { Store } = await import('../src/store/db.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const store = await Store.create(':memory:');
    const project = await store.createProject('Follow-ups');
    const task = await store.createTask({ projectId: project.id, title: 'Poll', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'work' } as any });
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    const transcript: Message[] = [{ id: 'm0', role: 'user', text: 'work', ts: 0 }];
    let queries = 0;
    const heartbeat = vi.fn();
    const handle = {
      query: async (_name: string, _role: string, from: number) => { queries++; return transcript.slice(from); },
      signal: async () => {},
    };
    const spy = vi.spyOn(Context, 'current').mockImplementation(() => ({
      info: { attempt: 1, activityId: 'turn', workflowExecution: { runId: 'run' } },
      cancellationSignal: new AbortController().signal, heartbeat,
    }) as any);
    const runTurn = async (_input: TurnInput, ctx: PlatformToolContext) => {
      await script({
        pull: ctx.pullFollowUps!,
        apply: (message) => { transcript.push(message); },
        journal: async (message) => {
          await store.appendEvent({ taskId: task.id, type: 'conversation.message', ts: Date.now(), payload: { role: 'do', message } });
        },
        queries: () => queries,
      });
      return { termination: { kind: 'success' as const, status: 'end_turn' }, output: 'ok' };
    };
    const core = makeCoreActivities({ store, worlds, client: { workflow: { getHandle: () => handle } } as any,
      adapters: new Map([['claude', { provider: 'claude', runTurn }]]) as any,
      profiles: new ProfileResolver(store, 'claude') });
    try {
      await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`, agentSlotGranted: true,
        worldHandle: world.handle, messages: [...transcript],
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {},
          workflow: 'just-do', agents: { do: { provider: 'claude', model: 'test' } } } } as any);
      return { queries: () => queries, heartbeat };
    } finally { spy.mockRestore(); await world.destroy(); await store.close(); }
  }

  it('queries the workflow only when a follow-up was journaled, and still delivers it', async () => {
    let quiet = 0;
    let delivered: Message[] = [];
    const { queries } = await runPollingTurn(async (channel) => {
      // A quiet stretch of a long turn: 20 adapter polls.
      for (let i = 0; i < 20; i++) expect(await channel.pull(1)).toEqual([]);
      quiet = channel.queries();
      const followUp: Message = { id: 'u1', role: 'user', text: 'also update the docs', ts: 1 };
      channel.apply(followUp);
      await channel.journal(followUp);
      delivered = await channel.pull(1);
      for (let i = 0; i < 5; i++) expect(await channel.pull(2)).toEqual([]);
    });
    // The first poll always asks (a message may predate the turn's start);
    // quiet polls do not; the journaled follow-up costs exactly one query.
    expect(quiet).toBe(1);
    expect(delivered.map((m) => m.id)).toEqual(['u1']);
    expect(queries()).toBe(2);
  });

  it('keeps asking while the journal is ahead of the workflow, then stops', async () => {
    let delivered: Message[] = [];
    let settled = 0;
    await runPollingTurn(async (channel) => {
      await channel.pull(1);
      const followUp: Message = { id: 'u2', role: 'user', text: 'stop after tests', ts: 2 };
      // Journaled, but the query still races the workflow task applying the signal.
      await channel.journal(followUp);
      expect(await channel.pull(1)).toEqual([]);
      expect(await channel.pull(1)).toEqual([]);
      channel.apply(followUp);
      delivered = await channel.pull(1);
      settled = channel.queries();
      for (let i = 0; i < 5; i++) await channel.pull(2);
      expect(channel.queries()).toBe(settled);
    });
    expect(delivered.map((m) => m.id)).toEqual(['u2']);
    expect(settled).toBe(4);
  });

  it('beats once per second for the whole activity, not once per timer', async () => {
    const { heartbeat } = await runPollingTurn(async () => { await sleep(2_100); });
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(heartbeat.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('gateFollowUps (LT-13)', () => {
  it('asks once after a view publication, and at the backstop for writers that journal nothing', async () => {
    const { gateFollowUps, FOLLOW_UP_BACKSTOP_MS } = await import('../src/activities/follow-up-gate.js');
    let clock = 0, queries = 0;
    const journal: { seq: number; messageId?: string }[] = [];
    const pull = gateFollowUps({
      query: async () => { queries++; return []; },
      cursor: async () => 5,
      journaled: async (seq) => journal.filter((entry) => entry.seq > seq),
      now: () => clock,
    });
    await pull(1);
    journal.push({ seq: 6 }); // e.g. a mode switch appended a message and published
    await pull(1); await pull(1);
    expect(queries).toBe(2);
    for (clock = 1_000; clock < FOLLOW_UP_BACKSTOP_MS + 1_000; clock += 1_000) await pull(1);
    expect(queries).toBe(3);
  });

  it('stops asking once a journaled message for another agent has had time to arrive', async () => {
    const { gateFollowUps, FOLLOW_UP_SETTLE_MS } = await import('../src/activities/follow-up-gate.js');
    let clock = 0, queries = 0;
    const journal: { seq: number; messageId?: string }[] = [];
    const pull = gateFollowUps({
      query: async () => { queries++; return []; },
      cursor: async () => 5,
      journaled: async (seq) => journal.filter((entry) => entry.seq > seq),
      now: () => clock,
    });
    await pull(1);
    journal.push({ seq: 6, messageId: 'for-merge' }); // routed to the merge agent: never in this transcript
    for (; clock <= FOLLOW_UP_SETTLE_MS + 2_000; clock += 1_000) await pull(1);
    expect(queries).toBe(1 + FOLLOW_UP_SETTLE_MS / 1_000);
  });

  it('keeps asking after a pending parent answer until it arrives, then only until the window lapses', async () => {
    const { gateFollowUps, FOLLOW_UP_SETTLE_MS } = await import('../src/activities/follow-up-gate.js');
    let clock = 0, queries = 0;
    const journal: { seq: number; pending?: boolean }[] = [];
    const inbox: Message[] = [];
    const pull = gateFollowUps({
      query: async () => { queries++; return inbox.splice(0); },
      cursor: async () => 5,
      journaled: async (seq) => journal.filter((entry) => entry.seq > seq),
      now: () => clock,
    });
    await pull(1);
    // Journaled by the parent's turn before its workflow sends the signal.
    journal.push({ seq: 6, pending: true });
    clock = 1_000; expect(await pull(1)).toEqual([]);
    inbox.push({ id: 'p-3', role: 'user', text: 'use postgres', ts: 3 });
    clock = 2_000; expect((await pull(1)).map((m) => m.id)).toEqual(['p-3']);
    for (clock = 3_000; clock <= FOLLOW_UP_SETTLE_MS + 5_000; clock += 1_000) await pull(2);
    expect(queries).toBe(1 + FOLLOW_UP_SETTLE_MS / 1_000);
  });

  it('asks the workflow when the journal cannot be read', async () => {
    const { gateFollowUps } = await import('../src/activities/follow-up-gate.js');
    let queries = 0;
    const pull = gateFollowUps({
      query: async () => { queries++; return [{ id: 'u', role: 'user', text: 'hi', ts: 0 }]; },
      cursor: async () => 0,
      journaled: async () => { throw new Error('database unavailable'); },
    });
    await pull(1);
    expect((await pull(1)).map((m) => m.id)).toEqual(['u']);
    expect(queries).toBe(2);
  });
});
