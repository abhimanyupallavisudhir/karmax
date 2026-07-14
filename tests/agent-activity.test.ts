import { describe, expect, it } from 'vitest';
import { activityDetail, claudeToolActivity, codexItemActivity } from '../src/agent/activity.js';

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
