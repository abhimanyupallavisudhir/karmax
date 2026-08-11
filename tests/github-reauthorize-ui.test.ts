import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');
const gatewaySource = fs.readFileSync(path.resolve('src/gateway/server.ts'), 'utf8');

function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const githubAuthorizeButton = Function(
  `${extractFunction('githubAuthorizeButton')}; return githubAuthorizeButton;`,
)() as (githubApp: unknown, id: string) => string;

describe('GitHub re-authorization affordance', () => {
  // `userAuthorized` only reports that a credential EXISTS, not that GitHub still
  // accepts it. Gating the button on `!userAuthorized` meant a token invalidated
  // server-side left the operator with no way to reconnect: the card claimed
  // "App ready" and offered nothing to click.
  it('offers re-authorization even while a stored credential still looks authorized', () => {
    const markup = githubAuthorizeButton({ oauthConfigured: true, userAuthorized: true }, 'authorize-github');
    expect(markup).toContain('id="authorize-github"');
    expect(markup).toMatch(/reconnect/i);
  });

  it('asks for first-time authorization when no credential is stored', () => {
    const markup = githubAuthorizeButton({ oauthConfigured: true, userAuthorized: false }, 'authorize-github');
    expect(markup).toContain('id="authorize-github"');
    expect(markup).toContain('Connect my GitHub identity');
  });

  it('stays hidden when the App has no OAuth credentials to authorize against', () => {
    expect(githubAuthorizeButton({ oauthConfigured: false, userAuthorized: false }, 'authorize-github')).toBe('');
    expect(githubAuthorizeButton(undefined, 'authorize-github')).toBe('');
  });

  it('keeps the project escape hatch while profile and organization use account cards', () => {
    expect(source).toContain("githubAuthorizeButton(githubApp, 'project-authorize-github')");
    expect(source).not.toContain("githubAuthorizeButton(githubApp, 'authorize-github')");
    expect(source).not.toContain("githubAuthorizeButton(github, 'user-authorize-github')");
    expect(source).toContain('github-account-row');
    expect(source).toContain('Add new GitHub account');
    expect(source).not.toContain('githubApp.oauthConfigured && !githubApp.userAuthorized');
  });

  it('returns profile-originated authorization to the user page', () => {
    expect(source).toContain("returnTo: 'profile', mode, accountId");
    expect(gatewaySource).toContain("pending.returnTo === 'profile'");
    expect(gatewaySource).toContain('userProfilePath(this.deps.store, pending.organizationId)');
  });
});

describe('GitHub merge authorization UX', () => {
  it('warns at task composition without blocking queueing', () => {
    expect(source).toContain('/github-merge-eligibility');
    expect(source).toContain('GitHub merge reviewer recommended');
    expect(source).toContain('You can still queue the task');
    expect(source).toContain('Add a <b>Human confirms</b> step');
  });

  it('separates PR review confirmation from later GitHub authorization', () => {
    expect(source).toContain("v.stage === 'review' ? 'Review' : 'Work summary'");
    expect(source).toContain('Confirm PR');
    expect(source).not.toContain('Confirm & authorize merge');
    expect(source).toContain('Authorize GitHub merge');
    expect(gatewaySource).toContain("github-merge-eligibility");
  });
});

describe('GitHub workflow-file permission UX', () => {
  it('separates App-owner configuration from installation-owner approval', () => {
    expect(source).toContain('Workflow-file access required');
    expect(source).toContain('Add permission on GitHub');
    expect(source).toContain('Add workflow access');
    expect(source).toContain('Approve permission');
    expect(source).toContain('workflow access required');
    expect(gatewaySource).toContain('workflowPermissionStatus(connection)');
    expect(gatewaySource).toContain('workflowPermissionStatus()');
  });
});
