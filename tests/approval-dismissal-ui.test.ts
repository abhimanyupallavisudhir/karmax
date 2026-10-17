import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync('web/app.js', 'utf8');
const context = vm.createContext({
  S: { user: { id: 'approver' }, projects: [] }, esc: String,
  credentialRequestTaskLink: () => 'Task', authorizationSummary: () => 'Developer',
  credentialRequestBindings: new Map(), globalRoute: () => '/settings', siteNameMarkup: () => 'tavya', policyTip: () => '',
  connectionAccountNames: () => [],
});
const slice = (from: string, to: string) => {
  const start = app.indexOf(from);
  vm.runInContext(app.slice(start, app.indexOf(to, start)), context);
};
slice('function credentialRequestRows(', 'function wireAuthorizationRequestActions(');
slice('function connectionRows(', '/** Distinct names for a person');
slice('function approvalHistoryLink(', '// The shell, last in the rail');
slice('function inboxEventChanges(', 'let inboxRefreshTimer');

const IGNORE = 'aria-label="Ignore request"';

describe('ignored approval rows', () => {
  it('refreshes notifications when another browser ignores a request', () => {
    for (const type of ['permission.approval-dismissed', 'authorization.approval-dismissed',
      'credential.approval-dismissed', 'connection.dismissed'])
      expect(context.inboxEventChanges({ type })).toBe(true);
  });

  it.each(['permission', 'authorization'])('keeps %s decisions available without an approval badge', (kind) => {
    const request = { id: 'request', role: 'do', status: 'pending', capabilities: ['task:read'],
      recipients: ['approver'], audience: ['@owners'], target: { kind: 'task' }, reason: 'Read task' };
    const render = context[`${kind}RequestRows`];
    expect(render([request])).toContain(IGNORE);
    expect(render([request])).toContain('approval-needed');
    const ignored = render([{ ...request, dismissed: { by: 'approver', at: 1 } }]);
    expect(ignored).toContain('approval-request-dismissed');
    expect(ignored).toContain('>ignored</span>');
    expect(ignored).not.toContain('approval-needed');
    expect(ignored).not.toContain(IGNORE);
    expect(ignored).toContain('act="approve"');
    expect(ignored).toContain('act="deny"');
  });

  it('lets a credential request be ignored and still decided', () => {
    const request = { id: 'vreq', taskId: 't', itemId: 'item', mode: 'use', status: 'pending' };
    const items = [{ id: 'item', label: 'GitHub', type: 'login' }];
    expect(context.credentialRequestRows([request], items)).toContain(IGNORE);
    const ignored = context.credentialRequestRows([{ ...request, dismissed: { by: 'approver', at: 1 } }], items);
    expect(ignored).toContain('approval-request-dismissed');
    expect(ignored).toContain('>ignored</span>');
    expect(ignored).not.toContain(IGNORE);
    expect(ignored).toContain('data-vreq-act="task"');
    expect(ignored).toContain('data-vreq-act="deny"');
  });

  it('lets an app connection request be ignored and still connected', () => {
    const connection = { id: 'conn', organizationId: 'org', label: 'Gmail', status: 'requested', taskId: 't', projectIds: [] };
    expect(context.connectionRows([connection], true)).toContain(IGNORE);
    const ignored = context.connectionRows([{ ...connection, dismissed: { by: 'user:approver', at: 1 } }], true);
    expect(ignored).toContain('approval-request-dismissed');
    expect(ignored).toContain('>ignored</span>');
    expect(ignored).not.toContain(IGNORE);
    expect(ignored).toContain('data-connection-action="connect"');
    // Only an open request can be ignored; an account is managed, not ignored.
    expect(context.connectionRows([{ ...connection, status: 'active', ownerId: 'approver' }], true)).not.toContain(IGNORE);
  });

  it('counts every pending request, ignored ones too, on the rail link', () => {
    expect(context.approvalHistoryLink({ pendingDecisions: 3, approvalRequests: 1 })).toMatch(/Approval requests\s*<span class="rail-link-count"[^>]*>3<\/span>/);
    expect(context.approvalHistoryLink({})).not.toContain('rail-link-count');
  });
});
