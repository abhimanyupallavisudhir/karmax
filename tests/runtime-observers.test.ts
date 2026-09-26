import { describe, expect, it } from 'vitest';
import { runTurn } from '../src/agent/runtime.js';
import type { TurnInput, PlatformToolContext } from '../src/agent/types.js';

const input = { profile: { provider: 'mock' }, world: { handle: { kind: 'memory' } }, systemPrompt: '', messages: [], role: 'do' } as unknown as TurnInput;
const result = { session: 'session', output: '', termination: { kind: 'success' as const, status: 'completed' } };
const adapters = (run: (ctx: PlatformToolContext) => Promise<void>) => new Map([['mock' as const, {
  provider: 'mock' as const, runTurn: async (_input: TurnInput, ctx: PlatformToolContext) => { await run(ctx); return result; },
}]]);

describe('runtime observer delivery', () => {
  it('waits for asynchronous output/session observers even when adapters do not await them', async () => {
    const delivered: string[] = [];
    const later = async (name: string) => { await new Promise(resolve => setTimeout(resolve, 10)); delivered.push(name); };
    await runTurn(input, { adapters: adapters(async ctx => { ctx.emit('hello'); ctx.onSession?.('session'); }),
      onEmit: () => later('output'), onSession: () => later('session'),
      onActivity: activity => later(activity.phase!),
    });
    expect(delivered).toEqual(expect.arrayContaining(['output', 'session', 'started', 'completed']));
  });

  it('catches ignored rejected notifications and reports their error through the turn', async () => {
    const failure = new Error('session persistence unavailable');
    await expect(runTurn(input, { adapters: adapters(async ctx => { ctx.onSession?.('session'); }),
      onSession: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it('awaits the spend observer before acknowledging a payment request', async () => {
    let recorded = false;
    await runTurn(input, { adapters: adapters(async ctx => {
      await ctx.requestSpend({ amount: 1 });
      expect(recorded).toBe(true);
    }), budget: { request: async () => ({ status: 'granted' }) }, spendCtx: { projectId: 'p', taskId: 't' },
    onSpend: async () => { await new Promise(resolve => setTimeout(resolve, 10)); recorded = true; },
    });
  });
});
