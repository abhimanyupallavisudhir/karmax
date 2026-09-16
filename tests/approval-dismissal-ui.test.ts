import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync('web/app.js', 'utf8');
const context = vm.createContext({
  S: { user: { id: 'approver' }, projects: [] }, esc: String,
  credentialRequestTaskLink: () => 'Task', authorizationSummary: () => 'Developer',
});
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
});
