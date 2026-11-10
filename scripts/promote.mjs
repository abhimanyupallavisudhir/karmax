#!/usr/bin/env node
// Which master commit, if any, should production get now? Run by Promote
// (.github/workflows/promote.yml). Deploy (deploy.yml) records each commit's
// result per environment as a commit status: `deploy/staging` once the commit
// deployed to staging and passed the smoke suite there, `deploy/production`
// once it did on production. A status's description is the release image the
// commit ran, so production gets exactly the image staging tested.
//
// Rules (wiki ops/release-and-deploy, "Promotion"):
// - the candidate is the newest commit newer than production's that passed
//   staging, at least `soakMinutes` ago;
// - a promotion waits `intervalMinutes` after the previous one;
// - nothing is promoted while the repository variable DEPLOYS_PAUSED is true;
// - a person or agent may name a commit (or take the newest that passed
//   staging) with `now`: soak, interval and pause are waived, staging is not.
//
// Output (GITHUB_OUTPUT when set): sha, image and a one-line reason.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGING = 'deploy/staging';
export const PRODUCTION = 'deploy/production';
const IMAGE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

/**
 * @param commits master's history, newest first, each with `sha` and
 *   `statuses` (the latest status per context: { state, createdAt, description })
 */
export function choosePromotion({ commits, now, soakMinutes = 60, intervalMinutes = 240, paused = false,
  requested = '', immediate = false }) {
  const productionAt = commits.findIndex((commit) => commit.statuses[PRODUCTION]?.state === 'success');
  const production = productionAt >= 0 ? commits[productionAt] : undefined;
  // Newer than production; with no production record yet, the recent history.
  const newer = productionAt >= 0 ? commits.slice(0, productionAt) : commits.slice(0, 30);
  const passed = (commit) => commit.statuses[STAGING]?.state === 'success'
    && IMAGE.test(commit.statuses[STAGING]?.description ?? '');
  const choose = (commit, reason) => ({ sha: commit.sha, image: commit.statuses[STAGING].description, reason });
  const none = (reason) => ({ sha: '', image: '', reason });

  if (requested) {
    const commit = commits.find((candidate) => candidate.sha === requested);
    if (!commit) return none(`${requested} is not among master's recent commits`);
    if (!passed(commit)) return none(`${requested} has not passed staging`);
    if (production && !newer.includes(commit)) return none(`${requested} is not newer than production (${production.sha})`);
    return choose(commit, `${requested} was asked for`);
  }
  if (paused && !immediate) return none('deploys are paused (repository variable DEPLOYS_PAUSED)');
  const productionTime = production ? Date.parse(production.statuses[PRODUCTION].createdAt) : 0;
  if (!immediate && production && now - productionTime < intervalMinutes * 60_000) {
    const next = new Date(productionTime + intervalMinutes * 60_000).toISOString();
    return none(`production was deployed less than ${intervalMinutes} minutes ago; next promotion after ${next}`);
  }
  const candidate = newer.find((commit) => passed(commit)
    && (immediate || now - Date.parse(commit.statuses[STAGING].createdAt) >= soakMinutes * 60_000));
  if (!candidate) {
    const waiting = newer.find(passed);
    return none(waiting ? `${waiting.sha} passed staging less than ${soakMinutes} minutes ago`
      : production ? `nothing newer than production (${production.sha}) has passed staging` : 'nothing has passed staging');
  }
  return choose(candidate, `${candidate.sha} passed staging${immediate ? '' : ` at least ${soakMinutes} minutes ago`}`);
}

async function github(route) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${route}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.GH_TOKEN}`,
      'x-github-api-version': '2022-11-28', 'user-agent': 'tavya-promote' },
  });
  if (!response.ok) throw new Error(`GitHub ${route} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

/** Master's recent history with the latest deploy status per environment. */
async function history(repository, branch, depth) {
  const commits = await github(`/repos/${repository}/commits?sha=${encodeURIComponent(branch)}&per_page=${depth}`);
  const out = [];
  for (const commit of commits) {
    const combined = await github(`/repos/${repository}/commits/${commit.sha}/status?per_page=100`);
    const statuses = {};
    for (const status of combined.statuses ?? []) {
      if (status.context === STAGING || status.context === PRODUCTION)
        statuses[status.context] = { state: status.state, createdAt: status.created_at ?? status.updated_at,
          description: status.description ?? '' };
    }
    out.push({ sha: commit.sha, statuses });
    // History older than production's commit cannot be promoted.
    if (statuses[PRODUCTION]?.state === 'success') break;
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const env = process.env;
  const number = (value, fallback) => (Number.isFinite(Number(value)) && String(value).trim() !== '' ? Number(value) : fallback);
  const requested = (env.PROMOTE_SHA ?? '').trim().toLowerCase();
  if (requested && !/^[0-9a-f]{40}$/.test(requested)) {
    console.error(`a commit to promote is 40 hexadecimal characters, not ${requested}`);
    process.exit(2);
  }
  const decision = choosePromotion({
    commits: await history(env.GITHUB_REPOSITORY, env.PROMOTE_BRANCH || 'master', 100),
    now: Date.now(),
    soakMinutes: number(env.PROMOTE_SOAK_MINUTES, 60),
    intervalMinutes: number(env.PROMOTE_INTERVAL_MINUTES, 240),
    paused: env.DEPLOYS_PAUSED === 'true',
    requested,
    immediate: env.PROMOTE_NOW === 'true',
  });
  console.log(decision.sha ? `Promote ${decision.sha} (${decision.image}): ${decision.reason}` : `Nothing to promote: ${decision.reason}`);
  if (env.GITHUB_OUTPUT)
    fs.appendFileSync(env.GITHUB_OUTPUT, `sha=${decision.sha}\nimage=${decision.image}\nreason=${decision.reason}\n`);
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${decision.sha ? `**Promoting** \`${decision.sha}\`` : '**Nothing to promote**'}: ${decision.reason}\n`);
  // A named commit that cannot be promoted is a failed request, not a quiet run.
  process.exit(requested && !decision.sha ? 1 : 0);
}
