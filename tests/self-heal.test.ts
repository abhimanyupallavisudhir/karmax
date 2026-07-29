import { describe, it, expect } from 'vitest';
import { reloadSpecForWorkflowEdit, proposerMayInstall } from '../src/packages/manager.js';

/**
 * PLAN-dynamic-repos §21d / SPEC §4.4 — the pure decision the self-healing loop
 * runs on every task completion: reload the edited workflow only when a workflow
 * edit actually merged.
 */
const AUTHORIZED = { capabilities: ['workflow:edit', 'workflow:install'] };

describe('reloadSpecForWorkflowEdit (self-healing trigger)', () => {
  it('reloads from repo@target when a workflow-edit task completes', () => {
    const task = { params: { workflowEdit: true, repo: '/repos/note', target: 'main', _authorization: AUTHORIZED } };
    expect(reloadSpecForWorkflowEdit(task, 'done')).toEqual({ url: '/repos/note', ref: 'main' });
  });
  it('does nothing until the task is done', () => {
    const task = { params: { workflowEdit: true, repo: '/repos/note', target: 'main', _authorization: AUTHORIZED } };
    expect(reloadSpecForWorkflowEdit(task, 'active')).toBeUndefined();
    expect(reloadSpecForWorkflowEdit(task, 'failed')).toBeUndefined();
  });
  it('ignores ordinary (non-edit) task completions', () => {
    expect(reloadSpecForWorkflowEdit({ params: { prompt: 'x' } }, 'done')).toBeUndefined();
    expect(reloadSpecForWorkflowEdit({}, 'done')).toBeUndefined();
    expect(reloadSpecForWorkflowEdit({ params: { workflowEdit: true, _authorization: AUTHORIZED } }, 'done')).toBeUndefined(); // no repo
  });

  /**
   * Escalation guard. `proposeWorkflowEdit` requires only `workflow:edit` and
   * stores the caller's arbitrary `repo` URL on the task; the self-heal loop
   * then clones that URL and bundles it into the worker. Without this check,
   * `workflow:edit` (inside PROJECT_GRANT_CEILING) silently reaches
   * `workflow:install` (deliberately outside it), and the reviewed-PR gate does
   * not help — it reviews the branch diff, never the repo URL.
   */
  it('refuses to reload when the proposer could not have installed', () => {
    const editOnly = { params: { workflowEdit: true, repo: 'git@evil:x.git', target: 'main',
      _authorization: { capabilities: ['workflow:edit', 'task:*'] } } };
    expect(proposerMayInstall(editOnly)).toBe(false);
    expect(reloadSpecForWorkflowEdit(editOnly, 'done')).toBeUndefined();
  });

  it('refuses a task carrying no authorization snapshot rather than trusting it', () => {
    expect(proposerMayInstall({ params: { workflowEdit: true, repo: '/repos/note' } })).toBe(false);
    expect(reloadSpecForWorkflowEdit({ params: { workflowEdit: true, repo: '/repos/note' } }, 'done')).toBeUndefined();
  });

  it('honours a wildcard grant', () => {
    const admin = { params: { workflowEdit: true, repo: '/repos/note', _authorization: { capabilities: ['*'] } } };
    expect(proposerMayInstall(admin)).toBe(true);
    expect(reloadSpecForWorkflowEdit(admin, 'done')).toEqual({ url: '/repos/note', ref: undefined });
  });
});
