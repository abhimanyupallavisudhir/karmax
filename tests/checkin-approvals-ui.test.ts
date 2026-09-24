import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync('web/app.js', 'utf8');
function fn(name: string) {
  const start = app.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return app.slice(start, app.indexOf('\n}', start) + 2);
}
function setup() {
  const S = { approvalRequests: [], permissionRequests: [], authorizationRequests: [], connections: [], approvalItems: [], user: { id: 'user' }, projects: [] };
  const context = vm.createContext({ S, esc: String, credentialRequestTaskLink: () => '',
    authorizationSummary: () => 'Developer', policyTip: () => '', sortVaultItems: (v: any) => v });
  for (const name of ['credentialRequestRows', 'permissionRequestRows', 'authorizationRequestRows', 'connectionRows', 'conversationApprovalRequests', 'resourceReviewNeedsAction']) {
    vm.runInContext(fn(name), context);
  }
  return context;
}
describe('check-in pending decisions', () => {
  it('shows all approval kinds and removes the section after resolution', () => {
    const c = setup();
    c.S.approvalRequests = [{ id: 'vault', itemId: 'item', status: 'pending' }];
    c.S.permissionRequests = [{ id: 'permission', status: 'pending', capabilities: [], audience: [] }];
    c.S.authorizationRequests = [{ id: 'authorization', status: 'pending', recipients: ['user'], target: { kind: 'task' }, audience: [] }];
    c.S.connections = [{ id: 'connection', status: 'requested' }];
    const html = c.conversationApprovalRequests();
    for (const attr of ['data-vreq', 'data-preq', 'data-areq', 'data-connection']) expect(html).toContain(attr);
    expect(html).not.toContain('Recent decisions');
    c.S.approvalRequests[0].status = 'approved';
    c.S.permissionRequests[0].status = 'denied';
    c.S.authorizationRequests[0].status = 'approved';
    c.S.connections[0].status = 'active';
    expect(c.conversationApprovalRequests()).toBe('');
  });
  it('keeps dismissed requests actionable and reconnects visible', () => {
    const c = setup();
    c.S.permissionRequests = [{ id: 'permission', status: 'pending', dismissed: { by: 'user' }, capabilities: [], audience: [] }];
    expect(c.conversationApprovalRequests()).toContain('data-preq-act="approve"');
    c.S.permissionRequests = [];
    for (const status of ['requested', 'connecting', 'expired']) {
      c.S.connections = [{ id: 'connection', status }];
      expect(c.conversationApprovalRequests()).toContain('data-connection');
    }
    for (const status of ['active', 'denied', 'disconnected']) {
      c.S.connections = [{ id: 'connection', status }];
      expect(c.conversationApprovalRequests()).toBe('');
    }
  });
  it('offers an existing account before a new sign-in', () => {
    const c = setup();
    const request = { id: 'connection', label: 'gmail', status: 'requested', projectIds: [], taskId: 'task' };
    expect(c.connectionRows([request], true)).toContain('Connect for this task');
    const one = c.connectionRows([{ ...request, reusable: [{ id: 'mine', label: 'gmail' }] }], true);
    expect(one).toContain('data-connection-action="allow" data-use-connection="mine"');
    expect(one).toContain('>Allow<');
    expect(one).toContain('>Other account<');
    const two = c.connectionRows([{ ...request, reusable: [{ id: 'a', label: 'Work' }, { id: 'b', label: 'Home' }] }], true);
    expect(two).toContain('>Use Work<'); expect(two).toContain('>Use Home<');
    expect(c.connectionRows([{ ...request, status: 'active', ownerId: 'user', grantedConnectionId: 'mine' }], true)).toContain('>Revoke<');
  });
  it('removes settled resource cards but keeps pending decisions and failures', () => {
    const c = setup();
    for (const state of ['pending', 'discarding']) expect(c.resourceReviewNeedsAction({ candidate: { state } })).toBe(true);
    for (const state of ['adopted', 'discarded']) expect(c.resourceReviewNeedsAction({ candidate: { state } })).toBe(false);
    expect(c.resourceReviewNeedsAction({ discarded: true })).toBe(false);
    expect(c.resourceReviewNeedsAction({ error: 'retry needed' })).toBe(true);
    const item = { resource: { publish: 'review' }, summary: { added: 1, modified: 0, deleted: 0 } };
    expect(c.resourceReviewNeedsAction(item)).toBe(true);
    expect(c.resourceReviewNeedsAction({ ...item, summary: { ...item.summary, promoted: true } })).toBe(false);
    expect(c.resourceReviewNeedsAction({ ...item, summary: { added: 0, modified: 0, deleted: 0 } })).toBe(false);
    expect(c.resourceReviewNeedsAction({ ...item, resource: { publish: 'discard' } })).toBe(false);
  });
});
