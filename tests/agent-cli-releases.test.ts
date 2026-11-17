import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_LAG_DAYS, WATCHED_CLIS, knownModels, newReleases, pinnedVersions, releasesOf, type GitHubAdvisory } from '../scripts/agent-cli-releases.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const DAY = 24 * 3600_000;
const NOW = Date.parse('2026-11-07T03:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag, html_url: `https://github.com/x/releases/tag/${tag}`, published_at: daysAgo(1),
  prerelease: false, draft: false, body: '- Fixed a typo in `/help`', ...extra,
});
const claude = WATCHED_CLIS.find((cli) => cli.id === 'claude-code')!;
const codex = WATCHED_CLIS.find((cli) => cli.id === 'codex')!;
const known = knownModels(fs.readFileSync(path.join(repoRoot, 'src/agent/models.ts'), 'utf8'));
const context = { knownModels: known, advisories: [], now: NOW };

// The agent CLI upgrade automation: a daily command reports a Claude Code or
// Codex release newer than the one tavya pins as an event when upgrading to it
// is worth a run (wiki ops/agent-cli-upgrades), and the series it triggers
// makes tavya work with it. tavya pins exact versions, so a release cannot
// break it; most releases change nothing tavya uses (Codex 0.167.0, Claude
// Code 2.1.319: no new model, no adapter change).
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

  it('knows the models tavya offers from its offline catalog', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6.1-terra']) expect(known.has(id)).toBe(true);
  });

  it('reports nothing for releases that only fix and add things tavya does not use', () => {
    expect(newReleases(claude, '2.1.318', [release('v2.1.320'), release('v2.1.319')], context)).toEqual([]);
    expect(newReleases(claude, '2.1.318', [release('v2.1.318')], context)).toEqual([]);
  });

  it('upgrades to the newest stable release when any release since the pin adds a model tavya does not offer', () => {
    const events = newReleases(claude, '2.1.318', [
      release('v2.1.322', { prerelease: true, body: '- Added Claude Opus 6 (`claude-opus-6`)' }),
      release('v2.1.321'),
      release('v2.1.320', { body: '- Added Claude Opus 6 (`claude-opus-6`), now the default Opus model\n- Added `/claude-api` tips\n- Fixed `claude-sonnet-5-5` effort' }),
      release('v2.1.319'),
    ], context);
    expect(events).toEqual([{
      type: 'agent-cli.released',
      key: 'claude-code@2.1.321',
      payload: {
        cli: 'claude-code', name: 'Claude Code', version: '2.1.321', pinned: '2.1.318', repository: 'anthropics/claude-code',
        url: 'https://github.com/x/releases/tag/v2.1.321', publishedAt: daysAgo(1),
        reasons: ['new model claude-opus-6 (2.1.320)'],
      },
    }]);
  });

  it('reads a Codex model from the lines that add it to a catalog or make it the default', () => {
    const events = newReleases(codex, '0.162.1', [
      release('rust-v0.168.0-alpha.1', { prerelease: true }),
      release('libcap-v2.75'),
      release('rust-v0.166.0', { body: '- Added GPT-6.2 Luna to the bundled model catalogs. (#1)\n- #2 Update Bedrock GPT-6 Sol catalog tests' }),
      release('rust-v0.170.0', { draft: true }),
      release('rust-v0.165.0', { body: '- GPT-7 is now the default model. (#3)\n- Mentions GPT-8 Vela in passing' }),
      release('rust-v0.162.1'),
    ], context);
    expect(events.map((event) => [event.key, event.payload.reasons]))
      .toEqual([['codex@0.166.0', ['new model gpt-7 (0.165.0)', 'new model gpt-6.2-luna (0.166.0)']]]);
  });

  it('upgrades for a high or critical security advisory the pinned version is exposed to', () => {
    const advisory = (severity: string, patched: string, name = '@anthropic-ai/claude-code') => ({
      ghsa_id: `GHSA-${severity}`, severity, html_url: 'https://github.com/advisories/x',
      vulnerabilities: [{ package: { ecosystem: 'npm', name }, patched_versions: patched }],
    });
    const releases = [release('v2.1.320'), release('v2.1.319')];
    const reasons = (advisories: GitHubAdvisory[]) => newReleases(claude, '2.1.318', releases, { ...context, advisories })[0]?.payload.reasons;
    expect(reasons([advisory('high', '2.1.320')])).toEqual(['security fix GHSA-high (high, fixed in 2.1.320)']);
    expect(reasons([advisory('critical', '>= 2.1.319')])).toEqual(['security fix GHSA-critical (critical, fixed in 2.1.319)']);
    expect(reasons([advisory('high', '2.1.250')])).toBeUndefined(); // the pin already has the fix
    expect(reasons([advisory('medium', '2.1.320')])).toBeUndefined(); // waits for the routine catch-up
    expect(reasons([advisory('high', '2.1.320', 'Claude Desktop')])).toBeUndefined();
  });

  it(`catches up once the oldest release tavya lacks is ${MAX_LAG_DAYS} days old, so no upgrade spans many weeks`, () => {
    const behind = (days: number) => newReleases(claude, '2.1.318',
      [release('v2.1.320', { published_at: daysAgo(2) }), release('v2.1.319', { published_at: daysAgo(days) })], context);
    expect(behind(MAX_LAG_DAYS - 1)).toEqual([]);
    expect(behind(MAX_LAG_DAYS)[0]).toMatchObject({ key: 'claude-code@2.1.320', payload: { reasons: [`${MAX_LAG_DAYS} days behind: 2.1.319 came out ${daysAgo(MAX_LAG_DAYS).slice(0, 10)}`] } });
  });

  it('compares versions numerically', () => {
    const events = newReleases(claude, '2.1.99', [release('v2.1.100', { body: '- Added Claude Opus 6 (`claude-opus-6`)' })], context);
    expect(events[0]?.key).toBe('claude-code@2.1.100');
  });

  // A Codex release carries ~300 assets: a page of 100 is ~50 MB, and GitHub
  // answered it with a 504 about half the time (2026-11-04), failing the watch.
  it('reads releases in small pages until it reaches the pinned version, and retries GitHub\'s 5xx', async () => {
    const pages: Record<number, ReturnType<typeof release>[]> = {
      1: [release('rust-v0.168.0-alpha.2', { prerelease: true }), release('rust-v0.167.0')],
      2: [release('rust-v0.167.0-alpha.5', { prerelease: true }), release('rust-v0.166.0')],
      3: [release('rust-v0.165.0'), release('rust-v0.164.0')],
      4: [release('rust-v0.163.0')],
    };
    const asked: string[] = [];
    let failures = 1;
    const fetchStub = (async (url: string) => {
      asked.push(url);
      if (failures-- > 0) return new Response('Unicorn!', { status: 504 });
      return Response.json(pages[Number(new URL(url).searchParams.get('page'))] ?? []);
    }) as typeof fetch;
    const releases = await releasesOf(codex, '0.165.0', fetchStub, { pageSize: 2, retryMs: 0 });
    expect(asked.map((url) => new URL(url).search))
      .toEqual(['?per_page=2&page=1', '?per_page=2&page=1', '?per_page=2&page=2', '?per_page=2&page=3']);
    expect(releases.map((entry) => entry.tag_name)).toContain('rust-v0.166.0');
  });

  it('gives up on a 4xx at once and on a 5xx after three tries, so the command fails and its repair agent is called', async () => {
    let calls = 0;
    const answering = (status: number) => (async () => { calls++; return new Response('no', { status }); }) as typeof fetch;
    await expect(releasesOf(codex, '0.162.1', answering(403), { retryMs: 0 })).rejects.toThrow(/GitHub answered 403/);
    expect(calls).toBe(1);
    calls = 0;
    await expect(releasesOf(codex, '0.162.1', answering(502), { retryMs: 0 })).rejects.toThrow(/GitHub answered 502/);
    expect(calls).toBe(3);
  });
});
