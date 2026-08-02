import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');

describe('personal Git development settings', () => {
  it('sends a newly created account to its profile before the workspace dashboard', () => {
    expect(source).toContain('session.gitOnboarding');
    expect(source).toContain("globalRoute('profile')");
  });

  it('puts one GitHub control and the optional signing key inside the main profile card', () => {
    const profile = source.slice(source.indexOf('function profileView()'), source.indexOf('function notificationsCard()'));
    expect(profile).toContain('${profileGithubFields()}');
    expect(source).toContain('Connect GitHub');
    expect(source).toContain('GitHub signing key <span>(optional)</span>');
    expect(source).toContain('/api/user/git-profiles/signing-key');
    expect(source).not.toContain('user-git-token');
    expect(source).not.toContain('user-git-ssh');
    expect(source).not.toContain('Commit email');
    expect(source).toContain("JSON.stringify({ returnTo: 'profile' })");
  });

  it('reduces organization Git settings to one connect/manage control', () => {
    expect(source).toContain('id="connect-github"');
    expect(source).toContain("gitConnections.length ? 'Manage GitHub' : 'Connect GitHub'");
    expect(source).not.toContain('git-accounts-card');
    expect(source).not.toContain('setup-github-app');
    expect(source).not.toContain('save-github-app');
    expect(source).not.toContain('id="refresh-github"');
  });
});
