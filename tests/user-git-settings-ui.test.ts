import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');

describe('personal Git development settings', () => {
  it('sends a newly created account to its profile before the workspace dashboard', () => {
    expect(source).toContain('session.gitOnboarding');
    expect(source).toContain("globalRoute('profile')");
  });

  it('puts development Git identity on the user profile, with a commit byline preview', () => {
    const profile = source.slice(source.indexOf('function profileView()'), source.indexOf('function notificationsCard()'));
    expect(profile).toContain('/api/user/git-profiles');
    expect(profile).not.toContain('/api/organizations/${encodeURIComponent');
    expect(source).toContain('Development Git identity');
    expect(source).toContain('git-byline-preview');
  });

  it('offers an authorized organization owner a one-click link only while organization Git is empty', () => {
    const hydrate = source.slice(source.indexOf('async function hydrateGitProfiles('), source.indexOf('async function hydrateWorkflows('));
    expect(hydrate).toContain('canManage');
    expect(hydrate).toContain('Use my Git credentials');
    expect(hydrate).toContain('/reuse-user');
  });
});
