import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync('web/app.js', 'utf8');
const context = vm.createContext({
  S: { user: { id: 'approver' }, projects: [] }, esc: String,
  credentialRequestTaskLink: () => 'Task', authorizationSummary: () => 'Developer',
  credentialRequestBindings: new Map(), policyTip: () => '', siteNameMarkup: () => 'Tavya', globalRoute: () => '/settings',
});
for (const name of ['credentialRequestRows', 'connectionRows']) {
  const at = app.indexOf(`function ${name}(`);
  vm.runInContext(app.slice(at, app.indexOf('\n}', at) + 2), context);
}
const start = app.indexOf('function permissionRequestRows(');
const end = app.indexOf('function wireAuthorizationRequestActions(', start);
vm.runInContext(app.slice(start, end), context);

const inboxStart = app.indexOf('function inboxEventChanges(');
vm.runInContext(app.slice(inboxStart, app.indexOf('let inboxRefreshTimer', inboxStart)), context);

describe('dismissed approval rows', () => {
  it('refreshes notifications when another browser dismisses a request', () => {
    expect(context.inboxEventChanges({ type: 'permission.approval-dismissed' })).toBe(true);
    expect(context.inboxEventChanges({ type: 'authorization.approval-dismissed' })).toBe(true);
  });
  it.each(['permission', 'authorization'])('keeps %s decisions available without an approval badge', (kind) => {
    const request = { id: 'request', role: 'do', status: 'pending', capabilities: ['task:read'],
      recipients: ['approver'], audience: ['@owners'], target: { kind: 'task' }, reason: 'Read task' };
    const render = context[`${kind}RequestRows`];
    expect(render([request])).toContain('aria-label="Dismiss request"');
    expect(render([request])).toContain('approval-needed');
    const dismissed = render([{ ...request, dismissed: { by: 'approver', at: 1 } }]);
    expect(dismissed).toContain('approval-request-dismissed');
    expect(dismissed).toContain('>dismissed</span>');
    expect(dismissed).not.toContain('approval-needed');
    expect(dismissed).not.toContain('aria-label="Dismiss request"');
    expect(dismissed).toContain('act="approve"');
    expect(dismissed).toContain('act="deny"');
  });
  it('offers dismissal on credential requests and dims dismissed ones', () => {
    const request = { id: 'credential', itemId: 'item', status: 'pending', mode: 'use', taskId: 'task' };
    const items = [{ id: 'item', label: 'Login' }];
    expect(context.credentialRequestRows([request], items)).toContain('data-vreq-act="dismiss"');
    const dismissed = context.credentialRequestRows([{ ...request, dismissed: { by: 'approver', at: 1 } }], items);
    expect(dismissed).toContain('approval-request-dismissed');
    expect(dismissed).toContain('>dismissed</span>');
    expect(dismissed).not.toContain('data-vreq-act="dismiss"');
    for (const action of ['once', 'task', 'always', 'deny']) expect(dismissed).toContain(`data-vreq-act="${action}"`);
  });
  it('offers dismissal only on open task connection requests', () => {
    const request = { id: 'connection', label: 'gmail', status: 'requested', projectIds: [], taskId: 'task' };
    for (const status of ['requested', 'connecting', 'expired'])
      expect(context.connectionRows([{ ...request, status }], true)).toContain('data-connection-action="dismiss"');
    for (const status of ['active', 'denied', 'disconnected'])
      expect(context.connectionRows([{ ...request, status }], true)).not.toContain('data-connection-action="dismiss"');
    expect(context.connectionRows([{ ...request, taskId: undefined, ownerId: 'approver' }])).not.toContain('data-connection-action="dismiss"');
    expect(context.connectionRows([{ ...request, ownerId: 'someone-else' }], true)).not.toContain('data-connection-action="dismiss"');
    const dismissed = context.connectionRows([{ ...request, dismissed: { by: 'approver', at: 1 } }], true);
    expect(dismissed).toContain('approval-request-dismissed');
    expect(dismissed).toContain('>dismissed</span>');
    expect(dismissed).not.toContain('data-connection-action="dismiss"');
    expect(dismissed).toContain('data-connection-action="connect"');
  });
});
