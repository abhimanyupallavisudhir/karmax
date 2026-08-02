import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');

describe('personal Git development settings', () => {
  it('sends a newly created account to its profile before the workspace dashboard', () => {
    expect(source).toContain('session.gitOnboarding');
    expect(source).toContain("globalRoute('profile')");
  });

  it('puts connected GitHub accounts and custom identity controls inside the main profile card', () => {
    const profile = source.slice(source.indexOf('function profileView()'), source.indexOf('function notificationsCard()'));
    expect(profile).toContain('${profileGithubFields()}');
    expect(source).toContain('Connect GitHub');
    expect(source).toContain('Add new GitHub account');
    expect(source).toContain('Custom identity');
    expect(source).toContain('/api/user/github-accounts');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('git config user.name');
    expect(source).toContain('git config user.email');
    expect(source).not.toContain('user-git-token');
    expect(source).not.toContain('user-git-ssh');
    expect(source).not.toContain('Commit email');
    expect(source).toContain("returnTo: 'profile', mode, accountId");
  });

  it('shows organization installation cards and one automation identity control', () => {
    expect(source).toContain('id="connect-github"');
    expect(source).toContain('Custom automation identity');
    expect(source).toContain('githubManageUrl');
    expect(source).toContain('/git-connections/${encodeURIComponent(row.dataset.connection)}');
    expect(source).not.toContain('git-accounts-card');
    expect(source).not.toContain('setup-github-app');
    expect(source).not.toContain('save-github-app');
    expect(source).not.toContain('id="refresh-github"');
  });
});
