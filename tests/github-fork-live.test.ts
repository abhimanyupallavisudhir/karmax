import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService } from '../src/integrations/github-app.js';
import { GithubPrApi, upstreamPullRequestUrl } from '../src/integrations/github-pr.js';
import type { Repository } from '../src/domain/types.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * Working on someone else's repository (wiki features/fork-contributions)
 * against **real GitHub**. `github-fork-contribution.test.ts` runs the whole
 * workflow against a stub; this checks the GitHub behaviour that design rests
 * on, which a stub cannot prove:
 *
 * - a fork names its upstream, and `merge-upstream` syncs it;
 * - a classic token opens a pull request on the upstream from the fork
 *   (`owner:branch`), finds it again, and edits it;
 * - GitHub's prefilled compare page for that branch exists;
 * - readiness and merge state read back after the upstream's maintainer merges.
 *
 * Fixtures (reused, never deleted): the public upstream `tavya-e2e-upstream/fork-fixture`,
 * an organization without the tavya App, and its fork in the token owner's
 * account. Requires `KARMAX_RUN_LIVE=1` and `LIVE_GITHUB_FORK_TOKEN`, a classic
 * `public_repo` token of the fork's owner, who also owns the upstream
 * organization and so can play its maintainer. Each run leaves no PR open and
 * deletes its branch.
 */

const skipLive = !liveEnabled();
const token = process.env.LIVE_GITHUB_FORK_TOKEN;
const UPSTREAM = process.env.LIVE_GITHUB_FORK_UPSTREAM ?? 'tavya-e2e-upstream/fork-fixture';
const API = 'https://api.github.com';

async function github<T = any>(pathname: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${API}${pathname}`, { ...init, headers: {
    accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28',
    'content-type': 'application/json', ...(init.headers ?? {}),
  } });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** Commit one file on a branch through the Contents API. */
async function commitFile(slug: string, branch: string, file: string, content: string, message: string) {
  const existing = await github(`/repos/${slug}/contents/${file}?ref=${encodeURIComponent(branch)}`);
  const put = await github(`/repos/${slug}/contents/${file}`, { method: 'PUT', body: JSON.stringify({
    message, branch, content: Buffer.from(content).toString('base64'),
    ...(existing.status === 200 ? { sha: existing.body.sha } : {}),
  }) });
  expect(put.status, JSON.stringify(put.body)).toBeLessThan(300);
  return put.body.commit.sha as string;
}

const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 60_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
};

describe.skipIf(skipLive || !token)('a fork of someone else\'s repository, against real GitHub', () => {
  let dir: string;
  let store: Store;
  let service: GitHubAppService;
  let fork: Repository;
  let forkSlug: string;
  const branch = `tavya/task_live${Date.now().toString(36)}`;
  let prNumber: number | undefined;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-live-'));
    store = await Store.create(':memory:');
    service = await GitHubAppService.create(store, new CredentialBroker(new Vault(dir)), { appId: '1', appSlug: 'tavya' });
    // The App is not what is under test here: its installation token is
    // replaced by the person's token, which may do the same on their fork.
    (service as any).installationToken = async () => token;
    const login = (await github('/user')).body.login as string;
    forkSlug = `${login}/${UPSTREAM.split('/')[1]}`;
    const listed = await github(`/repos/${forkSlug}`);
    expect(listed.status, `fixture fork ${forkSlug} is missing`).toBe(200);
    const upstream = await (service as any).forkUpstream(listed.body, token);
    const organization = await store.createOrganization({ name: 'Live', ownerUserId: 'live' });
    const connection = await store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '1', accountLogin: login, accountType: 'User' });
    fork = await store.upsertRepository({ organizationId: organization.id, provider: 'github', providerId: String(listed.body.id),
      owner: login, name: listed.body.name, sshUrl: listed.body.ssh_url, defaultBranch: listed.body.default_branch,
      private: listed.body.private, gitConnectionId: connection.id, ...(upstream ? { upstream } : {}) });
  }, 60_000);

  afterAll(async () => {
    if (token && prNumber) {
      const pr = await github(`/repos/${UPSTREAM}/pulls/${prNumber}`);
      if (pr.body?.state === 'open') await github(`/repos/${UPSTREAM}/pulls/${prNumber}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    }
    if (token && forkSlug) await github(`/repos/${forkSlug}/git/refs/heads/${branch}`, { method: 'DELETE' });
    await store?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the fork\'s upstream and syncs the fork with it', async () => {
    const [owner, name] = UPSTREAM.split('/');
    expect(fork.upstream).toMatchObject({ owner, name, private: false });
    // The upstream moves on; the fork is behind until it is synced.
    const moved = await commitFile(UPSTREAM, fork.upstream!.defaultBranch, 'runs.txt', `${new Date().toISOString()}\n`, 'Live run');
    const synced = await service.syncFork(fork, fork.defaultBranch);
    expect(synced, synced.detail).toMatchObject({ synced: true });
    const head = await until(() => github(`/repos/${forkSlug}/branches/${fork.defaultBranch}`), (r) => r.body?.commit?.sha === moved);
    expect(head.body.commit.sha).toBe(moved);
  }, 120_000);

  it('opens the pull request on the upstream from the fork, finds it, and links GitHub\'s prefilled page', async () => {
    const base = (await github(`/repos/${forkSlug}/git/ref/heads/${fork.defaultBranch}`)).body.object.sha;
    const created = await github(`/repos/${forkSlug}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base }) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const head = await commitFile(forkSlug, branch, `proposals/${branch.split('/')[1]}.txt`, 'proposed\n', 'Propose a change');

    const page = upstreamPullRequestUrl(UPSTREAM, { base: fork.upstream!.defaultBranch, headRepository: forkSlug,
      head: branch, title: 'Live fork proposal', body: 'From the live suite' });
    const compare = await fetch(page, { redirect: 'manual' });
    expect(compare.status, page).toBe(200);
    expect(await compare.text()).toContain('Open a pull request');

    const api = new GithubPrApi(token!);
    const headOwner = forkSlug.split('/')[0]!;
    const opened = await api.openOrUpdate(UPSTREAM, { head: branch, base: fork.upstream!.defaultBranch, headOwner,
      title: 'Live fork proposal', body: 'From the live suite' });
    expect(opened.created).toBe(true);
    prNumber = opened.pr.number;
    expect(opened.pr).toMatchObject({ state: 'open', headSha: head });
    await expect(api.findByHead(UPSTREAM, branch, headOwner)).resolves.toMatchObject({ number: prNumber });
    // The same branch name in the upstream itself is a different head.
    await expect(api.findByHead(UPSTREAM, branch)).resolves.toBeUndefined();
    const again = await api.openOrUpdate(UPSTREAM, { head: branch, base: fork.upstream!.defaultBranch, headOwner,
      title: 'Live fork proposal (updated)', body: 'From the live suite' });
    expect(again).toMatchObject({ created: false, pr: { number: prNumber, title: 'Live fork proposal (updated)' } });

    const readiness = await until(() => api.readiness(UPSTREAM, prNumber!), (r) => r.mergeable !== 'UNKNOWN');
    expect(readiness).toMatchObject({ headSha: head });
  }, 180_000);

  it('reads the merge once the upstream\'s maintainer lands it', async () => {
    expect(prNumber).toBeDefined();
    const api = new GithubPrApi(token!);
    const live = await api.get(UPSTREAM, prNumber!);
    const merged = await github(`/repos/${UPSTREAM}/pulls/${prNumber}/merge`, { method: 'PUT',
      body: JSON.stringify({ sha: live.headSha, merge_method: 'squash' }) });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    await expect(api.get(UPSTREAM, prNumber!)).resolves.toMatchObject({ merged: true, state: 'closed' });
    // A merged proposal is not adopted again for new work on the same branch.
    await expect(api.findByHead(UPSTREAM, branch, forkSlug.split('/')[0])).resolves.toMatchObject({ merged: true });
    const synced = await service.syncFork(fork, fork.defaultBranch);
    expect(synced, synced.detail).toMatchObject({ synced: true });
  }, 120_000);
});
