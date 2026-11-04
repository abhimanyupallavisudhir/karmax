#!/usr/bin/env node
// Reports each Claude Code or Codex release newer than the version tavya pins
// as a project event; the series "Upgrade {{name}} to {{version}}" it triggers
// makes tavya work with it. The tavya App is not installed on anthropics/claude-code or openai/codex,
// so no GitHub delivery tells us; a daily command task of the series
// "Watch agent CLI releases" runs this instead (wiki ops/agent-cli-upgrades).
//
//   node karmax/scripts/agent-cli-releases.mjs            emit agent-cli.released per CLI behind (tavya emit)
//   node karmax/scripts/agent-cli-releases.mjs --dry-run  only print the events
//
// One event per CLI and version (key `<cli>@<version>`): re-emitting a key does
// nothing, so a poll that finds the same release again starts nothing.
// GITHUB_TOKEN or GH_TOKEN, when set, lifts GitHub's 60-requests-an-hour limit.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './cli-release-version.mjs';

export const EVENT_TYPE = 'agent-cli.released';

/** Both are pinned by their own version in the browser image (tests/deployment.test.ts keeps it in step). */
export const WATCHED_CLIS = [
  { id: 'claude-code', name: 'Claude Code', repository: 'anthropics/claude-code', tag: /^v(\d+\.\d+\.\d+)$/, arg: 'CLAUDE_CODE_VERSION' },
  { id: 'codex', name: 'Codex', repository: 'openai/codex', tag: /^rust-v(\d+\.\d+\.\d+)$/, arg: 'CODEX_VERSION' },
];

/** @param {string} dockerfile environments/browser/Dockerfile */
export function pinnedVersions(dockerfile) {
  return Object.fromEntries(WATCHED_CLIS.map((cli) => {
    const match = new RegExp(`^ARG ${cli.arg}=(\\d+\\.\\d+\\.\\d+)$`, 'm').exec(dockerfile);
    if (!match) throw new Error(`environments/browser/Dockerfile no longer pins ${cli.arg}`);
    return [cli.id, match[1]];
  }));
}

/**
 * The event for the newest stable release above `pinned`, if any.
 * @param {(typeof WATCHED_CLIS)[number]} cli
 * @param {string} pinned
 * @param {{ tag_name: string, html_url: string, published_at: string, prerelease: boolean, draft: boolean }[]} releases
 */
export function newReleases(cli, pinned, releases) {
  const stable = releases
    .filter((release) => !release.prerelease && !release.draft)
    .map((release) => ({ release, version: cli.tag.exec(release.tag_name)?.[1] }))
    .filter((entry) => entry.version && compareVersions(entry.version, pinned) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const newest = stable[0];
  if (!newest) return [];
  return [{
    type: EVENT_TYPE,
    key: `${cli.id}@${newest.version}`,
    payload: {
      cli: cli.id, name: cli.name, version: newest.version, pinned, repository: cli.repository,
      url: newest.release.html_url, publishedAt: newest.release.published_at,
    },
  }];
}

async function releasesOf(repository) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
    headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${repository}'s releases: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pinned = pinnedVersions(fs.readFileSync(path.join(root, 'environments/browser/Dockerfile'), 'utf8'));
  const dryRun = process.argv.includes('--dry-run');
  for (const cli of WATCHED_CLIS) {
    const events = newReleases(cli, pinned[cli.id], await releasesOf(cli.repository));
    if (!events.length) console.log(`${cli.name} ${pinned[cli.id]} is current`);
    for (const event of events) {
      if (dryRun) { console.log(JSON.stringify(event)); continue; }
      execFileSync('tavya', ['emit', event.type, '--key', event.key, '-d', JSON.stringify(event.payload)], { stdio: 'inherit' });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
