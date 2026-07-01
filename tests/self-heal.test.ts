import { describe, it, expect } from 'vitest';
import { reloadSpecForWorkflowEdit } from '../src/packages/manager.js';

/**
 * PLAN-dynamic-repos §21d / SPEC §4.4 — the pure decision the self-healing loop
 * runs on every task completion: reload the edited workflow only when a workflow
 * edit actually merged.
 */
describe('reloadSpecForWorkflowEdit (self-healing trigger)', () => {
  it('reloads from repo@target when a workflow-edit task completes', () => {
    const task = { params: { workflowEdit: true, repo: '/repos/note', target: 'main' } };
    expect(reloadSpecForWorkflowEdit(task, 'done')).toEqual({ url: '/repos/note', ref: 'main' });
  });
  it('does nothing until the task is done', () => {
    const task = { params: { workflowEdit: true, repo: '/repos/note', target: 'main' } };
    expect(reloadSpecForWorkflowEdit(task, 'active')).toBeUndefined();
    expect(reloadSpecForWorkflowEdit(task, 'failed')).toBeUndefined();
  });
  it('ignores ordinary (non-edit) task completions', () => {
    expect(reloadSpecForWorkflowEdit({ params: { prompt: 'x' } }, 'done')).toBeUndefined();
    expect(reloadSpecForWorkflowEdit({}, 'done')).toBeUndefined();
    expect(reloadSpecForWorkflowEdit({ params: { workflowEdit: true } }, 'done')).toBeUndefined(); // no repo
  });
});
