import { describe, expect, it } from 'vitest';
import { runTurn, type TurnJournal } from '../src/agent/runtime.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import type { AgentAdapter, TurnInput } from '../src/agent/types.js';

/** A turn's tool outcomes are journaled as they happen, before the tool answers,
 * and an interrupted attempt's journal is part of the retried attempt's result. */
describe('turn journal', () => {
  const input = (): TurnInput => ({
    profile: { id: 'do', name: 'do', provider: 'mock', role: 'do', capabilities: [] } as any,
    world: { handle: { id: 'w', root: '/tmp' } } as any,
    messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }],
    systemPrompt: '',
    role: 'do',
  });
  const adapterDoing = (act: (ctx: any) => Promise<void>): AgentAdapter => ({
    provider: 'mock',
    async runTurn(turnInput, ctx) {
      await act(ctx);
      return { termination: { kind: 'success', status: 'success' }, output: 'done', delivered: turnInput.messages.length };
    },
  });

  it('saves each outcome before the tool call returns', async () => {
    const saved: TurnJournal[] = [];
    const order: string[] = [];
    await runTurn(input(), {
      adapters: new Map([['mock', adapterDoing(async (ctx) => {
        const tools = platformToolHandlers({ handle: { id: 'w', root: '/tmp' } } as any, ctx, () => ({})) as Record<string, (args: any) => Promise<string>>;
        order.push(await tools.create_sub_task!({ title: 'child', prompt: 'do it' }));
        ctx.followUpsDelivered(3);
        order.push(await tools.open_pr!({}));
      })]]) as any,
      journal: { async save(journal) { order.push('saved'); saved.push(journal); } },
    });
    expect(order[0]).toBe('saved'); // before the agent is told the sub-task exists
    expect(order.indexOf('saved', 2)).toBeLessThan(order.findIndex((entry) => entry.startsWith('pull request requested')));
    expect(saved.at(-1)).toEqual({
      completed: true, openPrRequested: true, subTasks: [{ title: 'child', prompt: 'do it' }], delivered: 3,
    });
  });

  it('restores an interrupted attempt into the retried result', async () => {
    const result = await runTurn(input(), {
      adapters: new Map([['mock', adapterDoing(async (ctx) => {
        await ctx.saveSkill({ name: 'later', content: 'from the retry' });
      })]]) as any,
      journal: {
        restored: { openPrRequested: true, completed: true, subTasks: [{ title: 'child', prompt: 'do it' }],
          skills: [{ name: 'earlier', content: 'from the first attempt' }] },
        async save() {},
      },
    });
    expect(result).toMatchObject({
      openPrRequested: true, completed: true, subTasks: [{ title: 'child', prompt: 'do it' }],
      skills: [{ name: 'earlier', content: 'from the first attempt' }, { name: 'later', content: 'from the retry' }],
    });
  });

  it('keeps a requested wait and the jobs a turn started across an interruption', async () => {
    const saved: TurnJournal[] = [];
    await runTurn(input(), {
      adapters: new Map([['mock', adapterDoing(async (ctx) => {
        await ctx.jobStarted('job-0000000a');
        await ctx.requestWait({ minutes: 45, jobs: ['job-0000000a'] });
      })]]) as any,
      journal: { async save(journal) { saved.push(journal); } },
    });
    expect(saved.at(-1)).toEqual({ wait: { minutes: 45, jobs: ['job-0000000a'] }, jobsStarted: ['job-0000000a'] });

    const retried = await runTurn(input(), {
      adapters: new Map([['mock', adapterDoing(async () => {})]]) as any,
      journal: { restored: saved.at(-1), async save() {} },
    });
    expect(retried.wait).toEqual({ minutes: 45, jobs: ['job-0000000a'] });
  });
});
