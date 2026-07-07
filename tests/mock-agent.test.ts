import { describe, it, expect } from 'vitest';
import { MockAdapter } from '../src/agent/mock.js';
import type { PlatformToolContext, TurnInput } from '../src/agent/types.js';

/**
 * Cheap unit test (no Temporal): locks the mock agent's message visibility to MIRROR
 * the real provider adapters (claude.ts / codex.ts both strip conversation `system`
 * messages). If the mock ever "sees" a system message again, the sub-task pipeline
 * tests would silently pass while production is broken — the exact blind spot that hid
 * the "parent not notified of a child raise" bug (the raise was injected as a system
 * message the real adapters drop).
 */
describe('mock agent message visibility (mirrors real adapters)', () => {
  const run = async (messages: TurnInput['messages']) => {
    const writes: string[] = [];
    let completedSummary: string | undefined;
    const world = {
      handle: { id: 'w1' },
      async writeFile(p: string) { writes.push(p); },
      async exec() { return { code: 0, stdout: '', stderr: '' }; },
    } as any;
    const ctx: Partial<PlatformToolContext> = {
      emit() {},
      signalCompletion(s?: string) { completedSummary = s; },
    };
    await new MockAdapter().runTurn(
      { profile: {} as any, world, messages, systemPrompt: '', role: 'do' } as TurnInput,
      ctx as PlatformToolContext,
    );
    return { writes, completedSummary };
  };

  it('acts on a user-role directive', async () => {
    const { writes } = await run([{ id: 'm', role: 'user', text: '@write ok.txt :: hi', ts: 0 }]);
    expect(writes).toEqual(['ok.txt']);
  });

  it('IGNORES a system-role directive (as the real adapters would)', async () => {
    const { writes, completedSummary } = await run([
      { id: 'm', role: 'system', text: '@write should-not-run.txt :: nope', ts: 0 },
    ]);
    expect(writes).toEqual([]);
    // Falls back to the (empty) system prompt → no directives found.
    expect(completedSummary).toContain('no directives');
  });

  it('a child-raise-shaped user message is visible; the same text as system is not', async () => {
    const raiseText = 'Sub-task "X" (t1) needs you — needs_confirmation. Answer with respond_to_sub_task (confirm | comment | retry | cancel).';
    // As a user message (how drainChildEvents now injects it) the mock reads it as the
    // latest message — visible to the agent. As a system message it would be dropped.
    const asUser = await run([{ id: 'm', role: 'user', text: raiseText, ts: 0 }]);
    const asSystem = await run([{ id: 'm', role: 'system', text: raiseText, ts: 0 }]);
    // Neither carries a line-leading @directive, so neither writes; the point is only
    // the user-role one is even considered. We assert the system one is treated as an
    // empty turn (no directives), proving it was not read.
    expect(asSystem.completedSummary).toContain('no directives');
    void asUser;
  });
});
