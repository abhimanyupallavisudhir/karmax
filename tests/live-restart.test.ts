import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replacementInvocation, worldLandedInCheckout } from '../src/util/live-restart.js';

describe('live source restart', () => {
  it('detects a completed merge into the checkout running this process', () => {
    const cwd = path.resolve('/srv/karmax');
    expect(worldLandedInCheckout({
      kind: 'e2b', id: 'task', root: '/workspace', branch: 'karmax/task', base: 'master',
      repos: [
        { name: 'app', repo: 'git@github.com:org/app.git', localPath: cwd, root: '/workspace/app', branch: 'karmax/task', base: 'master' },
        { name: 'wiki', repo: 'git@github.com:org/wiki.git', root: '/workspace/wiki', branch: 'karmax/task', base: 'master' },
      ],
    }, cwd)).toBe(true);
    expect(worldLandedInCheckout({
      kind: 'e2b', id: 'task', root: '/workspace', branch: 'karmax/task', base: 'master',
      repos: [{ name: 'wiki', repo: 'git@github.com:org/wiki.git', root: '/workspace', branch: 'karmax/task', base: 'master' }],
    }, cwd)).toBe(false);
  });

  it('replays the current Node invocation for a graceful handoff', () => {
    expect(replacementInvocation('/usr/bin/node', ['--import', 'tsx'], ['/srv/karmax/src/main.ts']))
      .toEqual({ command: '/usr/bin/node', args: ['--import', 'tsx', '/srv/karmax/src/main.ts'] });
  });
});
