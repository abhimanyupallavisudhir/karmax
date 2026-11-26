import './helpers/isolated-home.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { WorldRegistry } from '../src/world/registry.js';
import { registerHostedGit, type HostedGit } from '../src/world/hosted-git.js';
import { wikiRoot } from '../src/wiki/wiki.js';
import { ensureEveryOrganizationWiki } from '../src/wiki/organization-wiki.js';
import type { Repository } from '../src/domain/types.js';

/**
 * The organization wiki in Git (wiki features/organization-wiki): its folder
 * becomes a repository in place, every edit a commit by whoever made it,
 * published to a repository tavya keeps for the organization — hidden from the
 * ones people attach — while who may read and write it stays as it was.
 */
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const page = (name: string, body: string) => `---\nname: ${name}\ndescription: When to read ${name}.\n---\n${body}\n`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** tavya's Git server, as bare repositories on disk that `tavya:` URLs lead to. */
function hostedOnDisk(dir: string) {
  const hostedRoot = path.join(dir, 'hosted');
  const created: string[] = [];
  const hosted = {
    async create(repository: Repository) {
      const bare = path.join(hostedRoot, repository.sshUrl.slice('tavya:'.length));
      fs.mkdirSync(bare, { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
      created.push(repository.id);
    },
    async brokerCredentials(repository: Repository) {
      return { httpsToken: 'unused', mirrorScope: repository.id,
        env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${hostedRoot}/.insteadOf`, GIT_CONFIG_VALUE_0: 'tavya:' } };
    },
  } as unknown as HostedGit;
  return { hosted, hostedRoot, created };
}

async function fixture(options: { hosted?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-org-wiki-git-'));
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const client = { workflow: { getHandle: () => ({ query: async () => [], signal: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization, worlds: new WorldRegistry(), contentDir: dir });
  const organization = await store.createOrganization({ name: 'Firm', ownerUserId: 'ana' });
  await authorization.bootstrapOrganizationOwner('system:test', 'ana', organization.id);
  await store.setOrganizationMembership(organization.id, 'bo', 'member');
  await authorization.replacePrincipalAuthorization('user:ana', 'user:bo', organization.id, { level: 'developer', scope: 'organization' });
  const tokenFor = async (user: string) => (await tokens.mintPrincipal(`user:${user}`,
    await authorization.capabilitiesAsync(`user:${user}`, undefined, organization.id), undefined, 60 * 60_000, organization.id)).token;
  const onDisk = options.hosted ? hostedOnDisk(dir) : undefined;
  if (onDisk) registerHostedGit(onDisk.hosted);
  cleanups.push(async () => { registerHostedGit(undefined); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = wikiRoot(dir, 'organization', organization.id);
  return { dir, store, api, organization, root, ana: await tokenFor('ana'), bo: await tokenFor('bo'), onDisk };
}

describe('the organization wiki in Git', () => {
  it('migrates in place: what was there is its first commit, and each edit is a commit by whoever made it', async () => {
    const f = await fixture();
    // An organization wiki from before: plain files, no repository.
    fs.mkdirSync(path.join(f.root, 'policy'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'policy', 'SKILL.md'), page('Policy', 'Be frugal.'));

    await f.api.saveWikiPageResolved(f.ana, 'organization', f.organization.id, { path: 'guides/hiring', content: page('Hiring', 'Hire slowly.'), kind: 'skill' });
    const log = git(f.root, ['log', '--format=%an|%s', 'main']).split('\n');
    expect(log).toEqual(['user:ana|wiki: update guides/hiring', 'tavya|tavya: initialize organization wiki']);
    // The page from before is in the baseline, untouched.
    expect(git(f.root, ['show', 'HEAD~1:policy/SKILL.md'])).toBe(page('Policy', 'Be frugal.').trim());
    expect(git(f.root, ['status', '--porcelain'])).toBe('');

    await f.api.saveWikiPageResolved(f.ana, 'organization', f.organization.id,
      { path: 'guides/recruiting', prevPath: 'guides/hiring', content: page('Hiring', 'Hire slowly, fire fast.'), kind: 'skill' });
    await f.api.deleteWikiPageResolved(f.ana, 'organization', f.organization.id, 'policy');
    expect(git(f.root, ['log', '--format=%s', '-2', 'main']).split('\n'))
      .toEqual(['wiki: delete policy', 'wiki: move guides/hiring to guides/recruiting']);
    expect(git(f.root, ['ls-files'])).toBe('guides/recruiting/SKILL.md');
    // Readers see the pages, never Git's own files.
    const read = await f.api.readWikiResolved(f.ana, 'organization', f.organization.id, '');
    expect(JSON.stringify(read.toc)).not.toContain('.git');
    // The database journal still records every edit (backups, data exports).
    const journal = await f.store.organizationWikiHistory(f.organization.id);
    expect(journal.map((version) => version.operation)).toEqual(expect.arrayContaining(['write', 'move', 'delete', 'baseline']));
  });

  it('who may write it is unchanged: a developer is refused before anything is set up', async () => {
    const f = await fixture({ hosted: true });
    await expect(f.api.saveWikiPageResolved(f.bo, 'organization', f.organization.id, { path: 'x', content: page('X', 'x'), kind: 'skill' }))
      .rejects.toThrow(/organization:wiki:write/);
    expect(fs.existsSync(path.join(f.root, '.git'))).toBe(false);
    expect(f.onDisk!.created).toEqual([]);
    expect(await f.store.organizationWikiRepository(f.organization.id)).toBeUndefined();
  });

  it('where tavya hosts repositories, each edit is published to the organization’s own, which no repository list shows', async () => {
    const f = await fixture({ hosted: true });
    await f.api.saveWikiPageResolved(f.ana, 'organization', f.organization.id, { path: 'mission', content: page('Mission', 'Ship.'), kind: 'skill' });
    const repository = (await f.store.organizationWikiRepository(f.organization.id))!;
    expect(repository).toMatchObject({ provider: 'tavya', organizationId: f.organization.id, private: true });
    expect(f.onDisk!.created).toEqual([repository.id]);
    const bare = path.join(f.onDisk!.hostedRoot, repository.sshUrl.slice('tavya:'.length));
    expect(git(bare, ['log', '--format=%an|%s', 'main']).split('\n')[0]).toBe('user:ana|wiki: update mission');
    // The platform's: not among the repositories people attach.
    expect(await f.store.repositoryIsWiki(repository.id)).toBe(true);

    await f.api.saveWikiPageResolved(f.ana, 'organization', f.organization.id, { path: 'mission', content: page('Mission', 'Ship daily.'), kind: 'skill' });
    expect(git(bare, ['show', 'main:mission/SKILL.md'])).toContain('Ship daily.');
    // One repository, however often it is edited.
    expect(f.onDisk!.created).toHaveLength(1);
  });

  it('boot puts every organization’s wiki in Git and publishes it', async () => {
    const f = await fixture({ hosted: true });
    fs.mkdirSync(path.join(f.root, 'policy'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'policy', 'SKILL.md'), page('Policy', 'Be frugal.'));
    await ensureEveryOrganizationWiki(f.store, f.dir);
    await ensureEveryOrganizationWiki(f.store, f.dir);
    const repository = (await f.store.organizationWikiRepository(f.organization.id))!;
    const bare = path.join(f.onDisk!.hostedRoot, repository.sshUrl.slice('tavya:'.length));
    expect(git(bare, ['show', 'main:policy/SKILL.md'])).toContain('Be frugal.');
    // The installation's personal organization too, and nothing made twice.
    expect(f.onDisk!.created.length).toBe((await f.store.listOrganizations()).length);
  });
});
