import { describe, expect, it } from 'vitest';
import {
  activityDetail,
  claudeToolActivity,
  codexItemActivity,
  isSecretTool,
  toolActivityDetail,
} from '../src/agent/activity.js';

const SECRET_VALUE = 'hunter2-super-secret';
/** The exact shape `/api/vault/resolve` returns for an APPROVED reveal — the
 *  plaintext arrives under the blandest key in the payload, `value`. */
const REVEAL = JSON.stringify({
  status: 'granted',
  itemId: 'vi_github',
  field: 'password',
  username: 'octocat',
  value: SECRET_VALUE,
});

describe('provider activity normalization', () => {
  it('keeps a Codex command as one stable item across lifecycle updates', () => {
    const started = codexItemActivity({ type: 'commandExecution', id: 'cmd-1', command: 'npm test', status: 'inProgress' }, 'started');
    const finished = codexItemActivity({ type: 'commandExecution', id: 'cmd-1', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: '42 passed' }, 'completed');
    expect(started).toMatchObject({ id: 'cmd-1', kind: 'command', phase: 'started', title: 'npm test' });
    expect(finished).toMatchObject({ id: 'cmd-1', kind: 'command', phase: 'completed', detail: '42 passed' });
  });

  it('maps Claude Bash and file tools to concise activity kinds', () => {
    expect(claudeToolActivity({ id: 't1', name: 'Bash', input: { command: 'git status' } }, 'started')).toMatchObject({
      id: 't1', kind: 'command', title: 'git status',
    });
    expect(claudeToolActivity({ id: 't2', name: 'Read', input: { file_path: 'package.json' } }, 'completed')).toMatchObject({
      id: 't2', kind: 'file', title: 'Read package.json',
    });
  });

  it('bounds details and redacts obvious credential fields', () => {
    const detail = activityDetail({ command: 'deploy', apiKey: 'top-secret', nested: { password: 'also-secret' }, output: 'x'.repeat(3000) })!;
    expect(detail).toContain('[redacted]');
    expect(detail).not.toContain('top-secret');
    expect(detail).not.toContain('also-secret');
    expect(detail.length).toBeLessThanOrEqual(1601);
  });
});

/**
 * A correctly APPROVED one-time credential reveal must not be durably archived.
 * `detail` is persisted to SQLite and rendered in the conversation UI, so once it
 * is written the item's reveal policy has no further say. Two independent
 * defences: string payloads now go through redaction (they used to bypass it
 * entirely), and credential-bearing tool names publish no detail at all.
 */
describe('credential leakage into the durable timeline', () => {
  it('redacts a plaintext reveal even when the payload is a raw JSON string', () => {
    const detail = activityDetail(REVEAL)!;
    expect(detail).not.toContain(SECRET_VALUE);
    expect(detail).toContain('[redacted]');
  });

  it('redacts secret-bearing keys in a non-JSON string payload', () => {
    const detail = activityDetail(`ok\nvalue=${SECRET_VALUE}\ntotp: 123456`)!;
    expect(detail).not.toContain(SECRET_VALUE);
    expect(detail).not.toContain('123456');
  });

  it('classifies namespaced MCP tool names against the denylist', () => {
    expect(isSecretTool('get_credential')).toBe(true);
    expect(isSecretTool('mcp__karmax__get_credential')).toBe(true);
    expect(isSecretTool('karmax · check_agent_mail')).toBe(true);
    expect(isSecretTool('use_passkey')).toBe(true);
    expect(isSecretTool('fill_credential')).toBe(true);
    expect(isSecretTool('Bash')).toBe(false);
    expect(isSecretTool(undefined)).toBe(false);
  });

  it('suppresses the detail outright for a credential-bearing tool', () => {
    expect(toolActivityDetail('get_credential', REVEAL)).toBeUndefined();
    expect(toolActivityDetail('mcp__karmax__get_credential', { text: SECRET_VALUE })).toBeUndefined();
    expect(toolActivityDetail('Bash', 'ls -la')).toBe('ls -la');
  });

  it('never attaches a detail to a Claude get_credential tool call or its result', () => {
    const started = claudeToolActivity({ id: 'tu1', name: 'mcp__karmax__get_credential', input: { item_id: 'vi_github' } }, 'started');
    const done = claudeToolActivity({ id: 'tu1', name: 'mcp__karmax__get_credential' }, 'completed', REVEAL);
    expect(started.detail).toBeUndefined();
    expect(done.detail).toBeUndefined();
    expect(JSON.stringify(done)).not.toContain(SECRET_VALUE);
  });

  it('never attaches a detail to a Codex get_credential dynamic tool call', () => {
    const item = codexItemActivity(
      { type: 'dynamicToolCall', id: 'dt1', server: 'karmax', tool: 'get_credential', arguments: { item_id: 'vi_github' } },
      'completed',
    )!;
    expect(item.detail).toBeUndefined();
    expect(item.title).toContain('get_credential');
  });
});

it('redacts notes from generic JSON activity details', () => {
  expect(activityDetail({ status: 'granted', notes: 'private recovery text' })).not.toContain('private recovery text');
});

it('never archives generic platform-request results carrying mail or vault data (AU-19)', () => {
  for (const name of ['platform_request', 'mcp__karmax__platform_request']) {
    expect(toolActivityDetail(name, { messages: [{ text: 'code 123456', code: '123456', link: 'https://example.com/login/secret' }] })).toBeUndefined();
    expect(toolActivityDetail(name, { method: 'POST', path: '/api/vault/items', body: { note: 'private' } })).toBeUndefined();
  }
});
