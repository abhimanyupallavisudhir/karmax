import { describe, it, expect } from 'vitest';
import { runTurn, OUTPUT_PUBLISH_INTERVAL_MS } from '../src/agent/runtime.js';
import type { AgentAdapter, PlatformToolContext, TurnInput } from '../src/agent/types.js';

/**
 * LT-5: agent text streams as it is produced. Adapters re-emit the growing text
 * of the block being generated; the runtime publishes the first chunk at once and
 * then at most one coalesced update per window, so a fast stream cannot flood the
 * event log or every open console. Cheap test: fake adapters, no provider.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const input = (): TurnInput => ({
  profile: { id: 'p', name: 'p', provider: 'claude', role: 'do', capabilities: [] },
  world: { handle: { id: 'task_stream', root: process.cwd(), kind: 'memory' } } as any,
  messages: [{ id: 'm1', role: 'user', ts: 0, text: 'go' }],
  role: 'do',
  systemPrompt: 'test',
});

function recorder() {
  const log: { at: number; kind: 'output' | 'activity'; text: string }[] = [];
  const started = Date.now();
  return {
    log,
    deps: {
      onEmit: (text: string) => { log.push({ at: Date.now() - started, kind: 'output', text }); },
      onActivity: (activity: { kind: string; phase: string; title?: string }) => {
        if (activity.kind !== 'turn') log.push({ at: Date.now() - started, kind: 'activity', text: `${activity.kind}:${activity.phase}:${activity.title}` });
      },
    },
  };
}

const adapter = (run: (ctx: PlatformToolContext) => Promise<string>): AgentAdapter => ({
  provider: 'claude',
  async runTurn(_input, ctx) {
    const output = await run(ctx);
    return { termination: { kind: 'success', status: 'end_turn' }, output };
  },
});

describe('runtime output publication (LT-5)', () => {
  it('publishes the first chunk at once and coalesces the rest of a burst', async () => {
    const { log, deps } = recorder();
    let publishedBeforeYield = 0;
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      let text = '';
      for (const word of ['Hel', 'lo', ', ', 'wor', 'ld']) { text += word; ctx.emit(text, 'assistant'); }
      publishedBeforeYield = log.length;
      await sleep(OUTPUT_PUBLISH_INTERVAL_MS * 2);
      return text;
    })]]), ...deps });
    expect(publishedBeforeYield).toBe(1);
    expect(log.map((e) => e.text)).toEqual(['Hel', 'Hello, world']);
  });

  it('keeps publishing at a bounded rate while text streams steadily', async () => {
    const { log, deps } = recorder();
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      let text = '';
      for (let i = 0; i < 40; i++) { text += `${i} `; ctx.emit(text, 'assistant'); await sleep(10); }
      return text;
    })]]), ...deps });
    const outputs = log.filter((e) => e.kind === 'output');
    // ~400 ms of streaming: the first chunk, a few window updates, the final text.
    expect(outputs.length).toBeGreaterThanOrEqual(3);
    expect(outputs.length).toBeLessThanOrEqual(6);
    // The turn's end flushes the final text at once; every update before it is paced.
    for (let i = 1; i < outputs.length - 1; i++)
      expect(outputs[i].at - outputs[i - 1].at).toBeGreaterThanOrEqual(OUTPUT_PUBLISH_INTERVAL_MS - 20);
    expect(outputs.at(-1)!.text).toBe(Array.from({ length: 40 }, (_, i) => `${i} `).join(''));
  });

  it('lands the latest text before the activity that completes it, exactly once', async () => {
    const { log, deps } = recorder();
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      ctx.emit('Plan', 'assistant');
      ctx.emit('Plan: edit', 'assistant');
      ctx.emit('Plan: edit the file', 'assistant');
      ctx.emitActivity({ id: 'msg-1', kind: 'message', phase: 'completed', title: 'Plan: edit the file' });
      await sleep(OUTPUT_PUBLISH_INTERVAL_MS * 2);
      return 'Plan: edit the file';
    })]]), ...deps });
    expect(log.map((e) => e.text)).toEqual(['Plan', 'Plan: edit the file', 'message:completed:Plan: edit the file']);
  });

  it('flushes the pending text when the turn completes', async () => {
    const { log, deps } = recorder();
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      ctx.emit('a', 'assistant');
      ctx.emit('ab', 'assistant');
      return 'ab';
    })]]), ...deps });
    expect(log.map((e) => e.text)).toEqual(['a', 'ab']);
  });

  it('publishes tool lines immediately, after any pending assistant text', async () => {
    const { log, deps } = recorder();
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      ctx.emit('Running', 'assistant');
      ctx.emit('Running the tests', 'assistant');
      ctx.emit('$ npm test');
      return 'Running the tests';
    })]]), ...deps });
    expect(log.map((e) => e.text)).toEqual(['Running', 'Running the tests', '$ npm test']);
  });

  it('never publishes a partial message after a failed or cancelled turn', async () => {
    const { log, deps } = recorder();
    const controller = new AbortController();
    await expect(runTurn(input(), { signal: controller.signal, adapters: new Map([['claude', {
      provider: 'claude',
      async runTurn(_input, ctx) {
        ctx.emit('Half', 'assistant');
        ctx.emit('Half a mess', 'assistant');
        controller.abort(new Error('cancelled'));
        throw new Error('cancelled');
      },
    } as AgentAdapter]]), ...deps })).rejects.toThrow('cancelled');
    await sleep(OUTPUT_PUBLISH_INTERVAL_MS * 2);
    expect(log.map((e) => e.text)).toEqual(['Half']);
  });
});
