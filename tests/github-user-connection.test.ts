import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitProfiles, userGitScope } from '../src/autonomy/git-profiles.js';
import { Vault } from '../src/autonomy/vault.js';
import { inheritPersonalGithubProfile, saveGithubUserIdentity } from '../src/integrations/github-user.js';
import { Store } from '../src/store/db.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-github-user-'));
  dirs.push(dir);
  return { store: new Store(':memory:'), broker: new CredentialBroker(new Vault(path.join(dir, 'vault'))) };
}

describe('Personal organization GitHub inheritance', () => {
  it('links an empty Personal organization to a newly connected user GitHub identity', () => {
    const { store, broker } = harness();
    const personal = store.createOrganization({ name: "Jane's workspace", kind: 'personal', ownerUserId: 'jane' });

    const saved = saveGithubUserIdentity(store, broker, 'jane', { id: '42', login: 'jane-dev', name: 'Jane' });

    expect(saved.github).toMatchObject({ id: '42', login: 'jane-dev' });
    expect(new GitProfiles(store, broker, undefined, personal.id).resolve(undefined)).toMatchObject({
      github: { id: '42', login: 'jane-dev' },
      source: { kind: 'user', userId: 'jane', profile: saved.name },
    });
  });

  it('does not override an explicit organization GitHub connection', () => {
    const { store, broker } = harness();
    const personal = store.createOrganization({ name: "Jane's workspace", kind: 'personal', ownerUserId: 'jane' });
    store.upsertGitConnection({ organizationId: personal.id, provider: 'github', installationId: '99',
      accountLogin: 'jane-dev', accountType: 'User' });

    saveGithubUserIdentity(store, broker, 'jane', { id: '42', login: 'jane-dev' });

    expect(new GitProfiles(store, broker, undefined, personal.id).list()).toEqual([]);
    expect(new GitProfiles(store, broker, undefined, userGitScope('jane')).resolve(undefined)?.github?.id).toBe('42');
  });

  it('can inherit after social sign-in provisions the Personal organization', () => {
    const { store, broker } = harness();
    saveGithubUserIdentity(store, broker, 'jane', { id: '42', login: 'jane-dev' });
    const personal = store.createOrganization({ name: "Jane's workspace", kind: 'personal', ownerUserId: 'jane' });

    expect(inheritPersonalGithubProfile(store, broker, 'jane')).toBe(true);
    expect(new GitProfiles(store, broker, undefined, personal.id).resolve(undefined)?.source?.userId).toBe('jane');
  });
});
