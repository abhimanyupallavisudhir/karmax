import { it, expect } from 'vitest';
import fs from 'node:fs';
import { Context } from '@temporalio/activity';
import { Worker } from '@temporalio/worker';
import { startStubTaskWorker, historyChain } from './helpers/stub-task-worker.js';
import { applyConversationPatch, conversationPage, transcriptOf, type ViewConversation } from '../src/domain/view-publication.js';

const world = { id: 'history-fixture', kind: 'memory', root: '/fixture', branch: 'task', base: 'main' };
const TURNS = Number(process.env.KARMAX_HISTORY_TURNS ?? 50);
// KARMAX_CONTINUE_AFTER_EVENTS=0 measures the production threshold.
const CONTINUE_AFTER = Number(process.env.KARMAX_CONTINUE_AFTER_EVENTS ?? 600) || undefined;

// A pinned task (as after a lifecycle replacement) runs 50 turns with 4 KB
// replies and 1 KB follow-ups. It continues as new at the top of Do, and every
// turn still receives its whole transcript, rebuilt from the view snapshots
// the platform holds by reference (WF-3, WF-4).
it(`bounds the history of a ${TURNS}-turn task`, async () => {
  let turnInputBytes = 0, turns = 0, pin = '';
  const snapshots = new Map<string, ViewConversation>();
  const updates: number[] = [];
  const runId = () => Context.current().info.workflowExecution!.runId;
  const reply = (i: number) => `Reply ${i}. ${'r'.repeat(4_000)}`;
  const env = await startStubTaskWorker({
    publishView: async (_taskId: string, view: any, reference: string) => {
      const { conversationPatch: patch, messages, transcripts } = view;
      snapshots.set(reference, patch ? applyConversationPatch(snapshots.get(patch.base)!, patch)
        : messages ? { messages, transcripts } : snapshots.get(reference)!);
      updates.push(view.updatedAt);
      return 'fence';
    },
    readConversationPage: async (_taskId: string, reference: string, offset: number) =>
      conversationPage(snapshots.get(reference)!, offset, 64 * 1024),
    releaseTaskRun: async () => {
      if (!pin) return 'unpinned';
      if (pin !== runId()) return 'foreign';
      pin = '';
      return 'released';
    },
    adoptTaskRun: async () => {
      if (pin) return false;
      pin = runId();
      return true;
    },
    parkWaitingWorld: async () => {}, recordEvent: async () => {},
    restoreChildTasks: async () => [], createWorld: async () => world,
    prepareAgentTurn: async () => ({ accountPool: 0 }), agentUsesHostCapacity: async () => false,
    runAgentTurn: async (args: any) => {
      turnInputBytes += JSON.stringify(args).length;
      const base = args.messagesBase;
      const full = [...(base ? transcriptOf(snapshots.get(base.reference)!, 'do').slice(0, base.count) : []), ...args.messages];
      const asked = full.filter((m: any) => m.role === 'user').map((m: any) => m.id);
      expect(asked).toEqual(['m0', ...Array.from({ length: turns }, (_, i) => `u${i + 1}`)]);
      expect(full.filter((m: any) => m.role === 'agent').map((m: any) => m.text.slice(0, 10)))
        .toEqual(Array.from({ length: turns }, (_, i) => reply(i).slice(0, 10)));
      return { output: reply(turns++), providerCompleted: true };
    },
    pendingServiceConnections: async () => 0, buildReview: async () => ({ summary: 'fixture', changedFiles: [] }),
    suspendWorldForRecovery: async () => {}, closePrs: async () => [], destroyWorld: async () => {},
  });
  const workflowId = 'history-bounds-long';
  const handle = await env.client.workflow.start('softwareDev@1.26.0', { taskQueue: env.taskQueue, workflowId, args: [{
    taskId: workflowId, projectId: 'fixture', title: 'Long task', prompt: `Start. ${'p'.repeat(2_000)}`,
    project: { repos: ['/fixture'], remote: 'pr' }, ...(CONTINUE_AFTER ? { continueAfterEvents: CONTINUE_AFTER } : {}),
  }] });
  pin = handle.firstExecutionRunId;
  const current = () => env.client.workflow.getHandle(workflowId);
  try {
    const parked = async (delivered: number) => expect.poll(async () => {
      const view: any = await current().query('view');
      return turns >= delivered && view.status === 'waiting' && view.waitingFor?.kind === 'human';
    }, { timeout: 30_000, interval: 20 }).toBe(true);
    for (let i = 1; i < TURNS; i++) {
      await parked(i);
      await current().signal('followUp', { id: `u${i}`, role: 'user', text: `Follow-up ${i}. ${'u'.repeat(1_000)}`, ts: i });
    }
    await parked(TURNS);
    const runs = await historyChain(env.client, workflowId);
    const total = runs.reduce((sum, run) => ({ events: sum.events + run.events, bytes: sum.bytes + run.bytes }), { events: 0, bytes: 0 });
    const report = { turns, runs: runs.length, totalEvents: total.events, totalBytes: total.bytes,
      maxRunEvents: Math.max(...runs.map(run => run.events)), maxRunBytes: Math.max(...runs.map(run => run.bytes)),
      turnInputBytes };
    process.stderr.write(`history-bounds ${JSON.stringify(report)}\n`);
    if (process.env.KARMAX_RECORD_HISTORY) fs.writeFileSync(process.env.KARMAX_RECORD_HISTORY, JSON.stringify(runs[0]!.history.toJSON()));
    expect(turns).toBe(TURNS);
    const view: any = await current().query('view');
    expect(view.messages).toHaveLength(2 * TURNS);
    expect(view.transcripts[0].messages).toHaveLength(2 * TURNS);
    for (let i = 1; i < updates.length; i++) expect(updates[i]).toBeGreaterThan(updates[i - 1]!);
    if (CONTINUE_AFTER) {
      expect(runs.length).toBeGreaterThanOrEqual(4);
      // A run stops at the first Do turn past the threshold.
      expect(report.maxRunEvents).toBeLessThan(CONTINUE_AFTER + 200);
      expect(pin).toBe(runs.at(-1)!.runId);
      // Every continued run replays deterministically, conversation load included.
      for (const run of runs) await Worker.runReplayHistory({ workflowBundle: env.workflowBundle }, run.history, run.runId);
    }
  } finally {
    await current().signal('cancel').catch(() => undefined);
    await env.stop();
  }
}, 600_000);
