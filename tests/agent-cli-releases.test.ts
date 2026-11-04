import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WATCHED_CLIS, newReleases, pinnedVersions } from '../scripts/agent-cli-releases.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag, html_url: `https://github.com/x/releases/tag/${tag}`, published_at: '2026-11-04T00:00:00Z',
  prerelease: false, draft: false, ...extra,
});

// The agent CLI upgrade automation: a daily command reports each Claude
// Code or Codex release newer than the one tavya pins as an event, and the
// series it triggers makes tavya work with it.
describe('agent CLI release watcher', () => {
  it('reads the pinned versions from the browser image, where both CLIs are pinned by their own versions', () => {
    const pinned = pinnedVersions(fs.readFileSync(path.join(repoRoot, 'environments/browser/Dockerfile'), 'utf8'));
    expect(Object.keys(pinned).sort()).toEqual(WATCHED_CLIS.map((cli) => cli.id).sort());
    for (const version of Object.values(pinned)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pinned.codex).toBe(pkg.dependencies['@openai/codex']);
  });

  it('refuses a Dockerfile that no longer pins a watched CLI, rather than reporting every release as new', () => {
    expect(() => pinnedVersions('ARG CODEX_VERSION=0.1.0\n')).toThrow(/CLAUDE_CODE_VERSION/);
  });

  it('reports the newest stable release above the pin, once per version', () => {
    const codex = WATCHED_CLIS.find((cli) => cli.id === 'codex')!;
    const events = newReleases(codex, '0.162.1', [
      release('rust-v0.168.0-alpha.1', { prerelease: true }),
      release('libcap-v2.75'),
      release('rust-v0.166.0'),
      release('rust-v0.170.0', { draft: true }),
      release('rust-v0.165.0'),
      release('rust-v0.162.1'),
    ]);
    expect(events).toEqual([{
      type: 'agent-cli.released',
      key: 'codex@0.166.0',
      payload: {
        cli: 'codex', name: 'Codex', version: '0.166.0', pinned: '0.162.1', repository: 'openai/codex',
        url: 'https://github.com/x/releases/tag/rust-v0.166.0', publishedAt: '2026-11-04T00:00:00Z',
      },
    }]);
  });

  it('compares versions numerically and reports nothing when tavya is current', () => {
    const claude = WATCHED_CLIS.find((cli) => cli.id === 'claude-code')!;
    expect(newReleases(claude, '2.1.99', [release('v2.1.100')])[0]?.key).toBe('claude-code@2.1.100');
    expect(newReleases(claude, '2.1.318', [release('v2.1.318'), release('v2.1.317')])).toEqual([]);
  });
});
