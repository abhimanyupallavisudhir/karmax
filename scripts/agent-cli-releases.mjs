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

/**
 * A Codex release carries ~300 assets, so a page of 100 is ~50 MB and GitHub
 * often answers it with a 504 (2026-11-04). Ask in pages of 10 instead (each ~4 MB),
 * newest first, until one holds a stable release of the CLI: anything newer
 * was on an earlier page.
 * @param {(typeof WATCHED_CLIS)[number]} cli
 * @param {typeof fetch} [fetchImpl]
 */
export async function releasesOf(cli, fetchImpl = fetch, { pageSize = 10, maxPages = 10, retryMs = 5_000 } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const releases = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${cli.repository}/releases?per_page=${pageSize}&page=${page}`;
    const batch = await getJson(url, headers, fetchImpl, retryMs);
    releases.push(...batch);
    if (batch.length < pageSize || batch.some((release) => !release.prerelease && !release.draft && cli.tag.test(release.tag_name))) break;
  }
  return releases;
}

/** GitHub's 5xx and dropped connections are transient: three tries, then the command fails. */
async function getJson(url, headers, fetchImpl, retryMs) {
  for (let attempt = 1; ; attempt++) {
    let failure;
    try {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (response.ok) return await response.json();
      failure = new Error(`GitHub answered ${response.status} for ${url}: ${(await response.text()).slice(0, 300)}`);
      if (response.status < 500) attempt = 3;
    } catch (error) {
      failure = error;
    }
    if (attempt >= 3) throw failure;
    await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pinned = pinnedVersions(fs.readFileSync(path.join(root, 'environments/browser/Dockerfile'), 'utf8'));
  const dryRun = process.argv.includes('--dry-run');
  for (const cli of WATCHED_CLIS) {
    const events = newReleases(cli, pinned[cli.id], await releasesOf(cli));
    if (!events.length) console.log(`${cli.name} ${pinned[cli.id]} is current`);
    for (const event of events) {
      if (dryRun) { console.log(JSON.stringify(event)); continue; }
      execFileSync('tavya', ['emit', event.type, '--key', event.key, '-d', JSON.stringify(event.payload)], { stdio: 'inherit' });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
