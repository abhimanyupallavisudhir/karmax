#!/usr/bin/env node
// Reports a Claude Code or Codex release newer than the version tavya pins as a
// project event when upgrading to it is worth a run; the series
// "Upgrade {{name}} to {{version}}" it triggers makes tavya work with it. The
// tavya App is not installed on anthropics/claude-code or openai/codex, so no
// GitHub delivery tells us; a daily command task of the series "Watch agent CLI
// releases" runs this instead (wiki ops/agent-cli-upgrades).
//
// tavya pins exact versions, so a release cannot break it; most change nothing
// tavya uses. Worth a run (`reasons` in the event), counting every stable
// release since the pin:
//   - it adds a model tavya does not offer (src/agent/models.ts): users cannot
//     pick it, and OpenAI refuses a ChatGPT login a model its Codex lacks;
//   - it fixes a high or critical security advisory the pin is exposed to;
//   - the oldest release tavya lacks is MAX_LAG_DAYS old: a routine catch-up,
//     so no upgrade spans many weeks of changes.
// The event names the newest stable release, so a run takes everything at once.
//
//   node karmax/scripts/agent-cli-releases.mjs            emit agent-cli.released per CLI worth upgrading (tavya emit)
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
export const MAX_LAG_DAYS = 14;
const DAY_MS = 24 * 3600_000;
const URGENT_SEVERITIES = new Set(['high', 'critical']);

/** Claude Code names a model by its id: "Added Claude Opus 5.5 (`claude-opus-5-5`)". */
function claudeModels(notes) {
  return [...notes.matchAll(/`(claude-[a-z]+-\d+(?:-\d+)*)`/g)].map((match) => match[1]);
}

/** Codex names it in words where it joins a catalog or becomes the default:
 *  "Added GPT-6.1 Terra to the model catalogs" → gpt-6.1-terra. */
function codexModels(notes) {
  return notes.split('\n').filter((line) => /catalog|default/i.test(line))
    .flatMap((line) => [...line.matchAll(/\bGPT-(\d+(?:\.\d+)?)(?: ([A-Z][a-z]+)\b)?/g)])
    .map((match) => `gpt-${match[1]}${match[2] ? `-${match[2].toLowerCase()}` : ''}`);
}

/** Both are pinned by their own version in the browser image (tests/deployment.test.ts keeps it in step). */
export const WATCHED_CLIS = [
  { id: 'claude-code', name: 'Claude Code', repository: 'anthropics/claude-code', package: '@anthropic-ai/claude-code',
    tag: /^v(\d+\.\d+\.\d+)$/, arg: 'CLAUDE_CODE_VERSION', models: claudeModels },
  { id: 'codex', name: 'Codex', repository: 'openai/codex', package: '@openai/codex',
    tag: /^rust-v(\d+\.\d+\.\d+)$/, arg: 'CODEX_VERSION', models: codexModels },
];

/** The model ids tavya offers without asking a provider: every quoted id in src/agent/models.ts. */
export function knownModels(modelsTs) {
  return new Set([...modelsTs.matchAll(/'((?:claude|gpt)-[a-z0-9.-]+)'/g)].map((match) => match[1]));
}

/** @param {string} dockerfile environments/browser/Dockerfile */
export function pinnedVersions(dockerfile) {
  return Object.fromEntries(WATCHED_CLIS.map((cli) => {
    const match = new RegExp(`^ARG ${cli.arg}=(\\d+\\.\\d+\\.\\d+)$`, 'm').exec(dockerfile);
    if (!match) throw new Error(`environments/browser/Dockerfile no longer pins ${cli.arg}`);
    return [cli.id, match[1]];
  }));
}

/** The stable releases of `cli` above `pinned`, oldest first. */
function releasesAbove(cli, pinned, releases) {
  return releases
    .filter((release) => !release.prerelease && !release.draft)
    .map((release) => ({ release, version: cli.tag.exec(release.tag_name)?.[1] }))
    .filter((entry) => entry.version && compareVersions(entry.version, pinned) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * The event for the newest stable release above `pinned`, if the releases
 * since the pin make upgrading worth a run (see the top of this file).
 * @param {(typeof WATCHED_CLIS)[number]} cli
 * @param {string} pinned
 * @param {{ tag_name: string, html_url: string, published_at: string, prerelease: boolean, draft: boolean, body?: string | null }[]} releases
 * @param {{ knownModels: Set<string>, advisories: { ghsa_id: string, severity: string, vulnerabilities?: { package?: { name?: string }, patched_versions?: string | null }[] }[], now: number }} context
 */
export function newReleases(cli, pinned, releases, { knownModels, advisories, now }) {
  const above = releasesAbove(cli, pinned, releases);
  const newest = above.at(-1);
  if (!newest) return [];
  const reasons = [];
  const named = new Set();
  for (const { release, version } of above)
    for (const model of cli.models(release.body ?? '')) {
      if (knownModels.has(model) || named.has(model)) continue;
      named.add(model);
      reasons.push(`new model ${model} (${version})`);
    }
  for (const advisory of advisories) {
    if (!URGENT_SEVERITIES.has(advisory.severity)) continue;
    for (const vulnerability of advisory.vulnerabilities ?? []) {
      const fixed = /\d+\.\d+\.\d+/.exec(vulnerability.patched_versions ?? '')?.[0];
      if (vulnerability.package?.name !== cli.package || !fixed || compareVersions(fixed, pinned) <= 0) continue;
      reasons.push(`security fix ${advisory.ghsa_id} (${advisory.severity}, fixed in ${fixed})`);
    }
  }
  const oldest = above[0];
  const behind = Math.floor((now - Date.parse(oldest.release.published_at)) / DAY_MS);
  if (behind >= MAX_LAG_DAYS) reasons.push(`${behind} days behind: ${oldest.version} came out ${oldest.release.published_at.slice(0, 10)}`);
  if (!reasons.length) return [];
  return [{
    type: EVENT_TYPE,
    key: `${cli.id}@${newest.version}`,
    payload: {
      cli: cli.id, name: cli.name, version: newest.version, pinned, repository: cli.repository,
      url: newest.release.html_url, publishedAt: newest.release.published_at, reasons,
    },
  }];
}

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/**
 * Every release since `pinned`, whose notes say what it adds. A Codex release
 * carries ~300 assets, so a page of 100 is ~50 MB and GitHub often answers it
 * with a 504 (2026-11-04). Ask in pages of 10 instead (each ~4 MB), newest
 * first, until one holds a stable release at or below the pin.
 * @param {(typeof WATCHED_CLIS)[number]} cli
 * @param {string} pinned
 * @param {typeof fetch} [fetchImpl]
 */
export async function releasesOf(cli, pinned, fetchImpl = fetch, { pageSize = 10, maxPages = 10, retryMs = 5_000 } = {}) {
  const releases = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${cli.repository}/releases?per_page=${pageSize}&page=${page}`;
    const batch = await getJson(url, githubHeaders(), fetchImpl, retryMs);
    releases.push(...batch);
    const reachedPin = batch.some((release) => {
      const version = cli.tag.exec(release.tag_name)?.[1];
      return version && !release.prerelease && !release.draft && compareVersions(version, pinned) <= 0;
    });
    if (batch.length < pageSize || reachedPin) break;
  }
  return releases;
}

/** The repository's published security advisories (GitHub's own, with patched versions). */
export async function advisoriesOf(cli, fetchImpl = fetch, { retryMs = 5_000 } = {}) {
  return getJson(`https://api.github.com/repos/${cli.repository}/security-advisories?state=published&per_page=100`,
    githubHeaders(), fetchImpl, retryMs);
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
  const models = knownModels(fs.readFileSync(path.join(root, 'src/agent/models.ts'), 'utf8'));
  const dryRun = process.argv.includes('--dry-run');
  for (const cli of WATCHED_CLIS) {
    const releases = await releasesOf(cli, pinned[cli.id]);
    const events = newReleases(cli, pinned[cli.id], releases, { knownModels: models, advisories: await advisoriesOf(cli), now: Date.now() });
    if (!events.length) {
      const waiting = releasesAbove(cli, pinned[cli.id], releases).map((entry) => entry.version);
      console.log(`${cli.name} ${pinned[cli.id]}: ${waiting.length ? `${waiting.join(', ')} not worth an upgrade yet` : 'current'}`);
    }
    for (const event of events) {
      if (dryRun) { console.log(JSON.stringify(event)); continue; }
      execFileSync('tavya', ['emit', event.type, '--key', event.key, '-d', JSON.stringify(event.payload)], { stdio: 'inherit' });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
