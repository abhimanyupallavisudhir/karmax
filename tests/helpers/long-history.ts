import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import { applyConversationPatch, conversationPage, type ViewConversation } from '../../src/domain/view-publication.js';
import type { StubActivities } from './stub-task-worker.js';

const { temporal } = createRequire(import.meta.url)('@temporalio/proto');

/** Prose of `bytes` characters, distinct per `seed`. */
export function prose(seed: string, bytes: number): string {
  const words = ['the', 'worker', 'conversation', 'workflow', 'review', 'branch', 'test', 'replay', 'agent', 'task'];
  let out = `${seed}. `;
  for (let i = 0; out.length < bytes; i++) out += words[(i * 7 + seed.length) % words.length] + (i % 13 ? ' ' : '.\n');
  return out.slice(0, bytes);
}

/** Stub activities and driver for a long software-dev task shaped like
 * pramana#111: a world of several repositories, an agent replying at length,
 * a person following up after every turn, view snapshots held by reference. */
export function longTaskStubs({ replyBytes = 2_000, worldRepos = 3 } = {}) {
  const repos = Array.from({ length: worldRepos }, (_, i) => ({ name: `repo-${i}`, repo: `https://github.com/acme/repo-${i}`,
    root: `/home/user/world/repo-${i}`, branch: 'tavya/task_fixture', base: 'master', target: 'master', baseSha: 'f'.repeat(40) }));
  const world = { version: 2, kind: 'memory', provider: 'memory', id: 'long-history-fixture', root: '/home/user/world',
    workdir: '/home/user/world', branch: 'tavya/task_fixture', base: 'master', target: 'master', repos,
    sealedProviderRef: 'sealed:' + 'x'.repeat(400), meta: { template: 'fixture', cpu: 4, memoryMb: 8192 } };
  const snapshots = new Map<string, ViewConversation>();
  let turns = 0;
  const activities: StubActivities = {
    publishView: async (_taskId: string, view: any, reference?: string) => {
      if (reference) {
        const { conversationPatch: patch, messages, transcripts } = view;
        if (patch) snapshots.set(reference, applyConversationPatch(snapshots.get(patch.base)!, patch));
        else if (messages) snapshots.set(reference, { messages, transcripts });
      }
      return 'fence';
    },
    readConversationPage: async (_taskId: string, reference: string, offset: number) =>
      conversationPage(snapshots.get(reference)!, offset, 64 * 1024),
    releaseTaskRun: async () => 'unpinned', adoptTaskRun: async () => true,
    parkWaitingWorld: async () => {}, recordEvent: async () => {},
    restoreChildTasks: async () => [], createWorld: async () => world,
    prepareAgentTurn: async () => ({ accountPool: 0 }), accountPoolSize: async () => 0,
    agentUsesHostCapacity: async () => false,
    runAgentTurn: async () => ({ output: prose(`Reply ${turns++}`, replyBytes), providerCompleted: true }),
    pendingServiceConnections: async () => 0, buildReview: async () => ({ summary: 'fixture', changedFiles: [] }),
    suspendWorldForRecovery: async () => {}, closePrs: async () => [], destroyWorld: async () => {},
    pendingResourceCandidates: async () => 0, unsavedResourceCandidates: async () => [],
  };
  return {
    activities,
    get turns() { return turns; },
    input: (taskId: string, extra: Record<string, unknown> = {}) => ({ taskId, projectId: 'fixture', title: 'Long task',
      prompt: prose('Start', 2_000), project: { repos: repos.map((repo) => repo.repo), remote: 'pr' }, ...extra }),
    followUp: (i: number, bytes: number) => ({ id: `u${i}`, role: 'user', text: prose(`Follow-up ${i}`, bytes), ts: i,
      author: 'user:fixture', authorLabel: 'Fixture' }),
    /** Until the agent has answered `delivered` times and the task waits for a person. */
    async parked(handle: WorkflowHandle, delivered: number) {
      for (const started = Date.now(); ;) {
        const view: any = await handle.query('view');
        if (turns >= delivered && view.status === 'waiting' && view.waitingFor?.kind === 'human') return;
        if (Date.now() - started > 60_000) throw new Error(`turn ${delivered} did not park`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

export function bundleTaskWorkflows() {
  return bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url)) });
}

/** Encoded bytes of a history and of each kind of event in it (activity
 * schedules by activity type), as Temporal measures the history size. */
export function historyBreakdown(history: any) {
  const byKind = new Map<string, { count: number; bytes: number }>();
  let bytes = 0;
  for (const event of history.events) {
    const size = temporal.api.history.v1.HistoryEvent.encode(event).finish().length;
    bytes += size;
    const type = event.activityTaskScheduledEventAttributes?.activityType?.name;
    const kind = type ? `scheduled:${type}` : String(temporal.api.enums.v1.EventType[event.eventType] ?? event.eventType);
    const entry = byKind.get(kind) ?? { count: 0, bytes: 0 };
    entry.count++; entry.bytes += size;
    byKind.set(kind, entry);
  }
  const sorted = Object.fromEntries([...byKind].sort((a, b) => b[1].bytes - a[1].bytes));
  return { summary: { events: history.events.length, bytes }, byKind: sorted };
}
