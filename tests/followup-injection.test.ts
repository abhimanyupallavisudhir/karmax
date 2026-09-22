import { describe, it, expect } from 'vitest';
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
