import { describe, it, expect } from 'vitest';
import { newSubagentTracker, trackTaskMessage, pendingSubagentCount } from '../src/agent/subagents.js';

/** Synthetic Claude-Agent-SDK `system` task-lifecycle messages (sdk.d.ts shapes). */
const started = (task_id: string, subagent_type?: string) => ({
  type: 'system',
  subtype: 'task_started',
  task_id,
  ...(subagent_type ? { subagent_type } : {}),
});
const updated = (task_id: string, patch: Record<string, unknown>) => ({ type: 'system', subtype: 'task_updated', task_id, patch });
const notify = (task_id: string, status: string) => ({ type: 'system', subtype: 'task_notification', task_id, status });

describe('subagent tracker', () => {
  it('counts a started sub-agent as still in flight', () => {
    const t = newSubagentTracker();
    trackTaskMessage(t, started('a1', 'general-purpose'));
    expect(pendingSubagentCount(t)).toBe(1);
  });

  it('clears a sub-agent that settles via task_notification', () => {
    const t = newSubagentTracker();
    trackTaskMessage(t, started('a1', 'code-reviewer'));
    trackTaskMessage(t, notify('a1', 'completed'));
    expect(pendingSubagentCount(t)).toBe(0);
  });

  it('clears a sub-agent that settles via task_updated status', () => {
    const t = newSubagentTracker();
    trackTaskMessage(t, started('a1', 'general-purpose'));
    for (const s of ['completed', 'failed', 'killed']) {
      const tt = newSubagentTracker();
      trackTaskMessage(tt, started('x', 'general-purpose'));
      trackTaskMessage(tt, updated('x', { status: s }));
      expect(pendingSubagentCount(tt), `status=${s} should settle`).toBe(0);
    }
  });

  it('keeps a backgrounded sub-agent outstanding until it settles', () => {
    const t = newSubagentTracker();
    trackTaskMessage(t, started('a1', 'general-purpose'));
    trackTaskMessage(t, updated('a1', { is_backgrounded: true }));
    expect(pendingSubagentCount(t)).toBe(1); // backgrounded ≠ done
    trackTaskMessage(t, notify('a1', 'completed'));
    expect(pendingSubagentCount(t)).toBe(0);
  });

  it('does NOT track non-sub-agent tasks (shells, monitors) — those must not block the turn', () => {
    const t = newSubagentTracker();
    trackTaskMessage(t, started('shell-1')); // no subagent_type → a backgrounded shell/dev-server
    trackTaskMessage(t, { type: 'system', subtype: 'task_started', task_id: 'wf-1', task_type: 'workflow', name: 'spec' });
    expect(pendingSubagentCount(t)).toBe(0);
  });

  it('recognizes task_type:"subagent" without subagent_type', () => {
    const t = newSubagentTracker();
    trackTaskMessage(t, { type: 'system', subtype: 'task_started', task_id: 's', task_type: 'subagent' });
    expect(pendingSubagentCount(t)).toBe(1);
  });

  it('ignores unrelated messages and settlements for untracked ids', () => {
    const t = newSubagentTracker();
    trackTaskMessage(t, { type: 'assistant', message: { content: [] } });
    trackTaskMessage(t, { type: 'result', subtype: 'success' });
    trackTaskMessage(t, notify('never-started', 'completed'));
    trackTaskMessage(t, undefined);
    expect(pendingSubagentCount(t)).toBe(0);
  });

  it('tracks several sub-agents independently', () => {
    const t = newSubagentTracker();
    trackTaskMessage(t, started('a', 'general-purpose'));
    trackTaskMessage(t, started('b', 'general-purpose'));
    trackTaskMessage(t, started('c', 'code-reviewer'));
    expect(pendingSubagentCount(t)).toBe(3);
    trackTaskMessage(t, notify('b', 'failed'));
    expect(pendingSubagentCount(t)).toBe(2);
  });
});
