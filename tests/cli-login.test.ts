import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appGrantFixture, type AppGrantFixture } from './helpers/app-grants.js';

/** The real `tavya` binary signing in to a real hosted gateway (Better Auth,
 * authorization, the OAuth server) and acting as the person afterwards. */
let f: AppGrantFixture;
let config: string;
beforeAll(async () => { f = await appGrantFixture(); config = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-cli-config-')); });
afterAll(async () => { await f.g.close(); fs.rmSync(config, { recursive: true, force: true }); });

function tavya(args: string[], options: { token?: string; onStderr?: (text: string) => void } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('bin/tavya.js'), ...args], {
      env: { ...process.env, TAVYA_URL: f.g.url, TAVYA_TOKEN: options.token ?? '', KARMAX_TOKEN: '', KARMAX_GATEWAY_URL: '',
        TAVYA_CONFIG_DIR: config, TAVYA_NO_KEYCHAIN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; options.onStderr?.(stderr); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

it('signs in with the device flow, refreshes, makes a scoped token, and signs out', async () => {
  // Not signed in: a clear error (no terminal, so no automatic sign-in).
  const before = await tavya(['whoami']);
  expect(before.code).toBe(3);
  expect(before.stderr).toContain('tavya login');

  let approved = false;
  const login = await tavya(['login', '--name', 'test laptop', '--no-browser'], { onStderr: (text) => {
    const code = /confirm the code ([A-Z]{4}-[A-Z]{4})/.exec(text)?.[1];
    if (code && !approved) {
      approved = true;
      void f.call('POST', '/api/oauth/device/approve', { cookie: f.cookie }, { code });
    }
  } });
  expect(login.code, login.stderr).toBe(0);
  expect(login.stdout).toContain('Signed in');
  expect(login.stdout).toContain('Ada');
  const stored = JSON.parse(fs.readFileSync(path.join(config, 'hosts.json'), 'utf8'));
  expect(fs.statSync(path.join(config, 'hosts.json')).mode & 0o777).toBe(0o600);
  const credential = stored.hosts[f.g.url].credential;
  expect(credential.accessToken).toMatch(/^tva_/);

  expect(JSON.parse((await tavya(['whoami', '--json'])).stdout)).toMatchObject({ user: { name: 'Ada' } });
  // An access token about to expire is refreshed (and rotated) first.
  stored.hosts[f.g.url].credential.expiresAt = Date.now() - 1;
  fs.writeFileSync(path.join(config, 'hosts.json'), JSON.stringify(stored));
  const projects = await tavya(['api', 'GET', '/api/projects']);
  expect(projects.code, projects.stderr).toBe(0);
  expect(JSON.parse(projects.stdout).map((project: { name: string }) => project.name).sort()).toEqual(['Docs', 'Site']);
  const refreshed = JSON.parse(fs.readFileSync(path.join(config, 'hosts.json'), 'utf8')).hosts[f.g.url].credential;
  expect(refreshed.refreshToken).not.toBe(credential.refreshToken);
  expect(refreshed.expiresAt).toBeGreaterThan(Date.now());

  // A token limited to one project at Viewer, for CI.
  const created = JSON.parse((await tavya(['token', 'create', '--name', 'ci', '--level', 'viewer', '--project', f.site.id, '--expires', '7', '--json'])).stdout);
  expect(created.token).toMatch(/^tvp_/);
  const scoped = await tavya(['api', 'GET', '/api/projects'], { token: created.token });
  expect(JSON.parse(scoped.stdout).map((project: { name: string }) => project.name)).toEqual(['Site']);
  // org/project resolves even though a project-limited token cannot list organizations.
  const listed = await tavya(['task', 'list', '--project', 'acme/site', '--json'], { token: created.token });
  expect(listed.code, listed.stderr).toBe(0);
  const grants = await tavya(['token', 'list', '--json']);
  expect(JSON.parse(grants.stdout).map((grant: { name: string }) => grant.name)).toEqual(expect.arrayContaining(['ci', 'test laptop']));
  expect((await tavya(['token', 'revoke', created.id])).code).toBe(0);
  expect((await tavya(['api', 'GET', '/api/projects'], { token: created.token })).code).toBe(3);

  expect((await tavya(['logout'])).code).toBe(0);
  expect((await tavya(['whoami'])).code).toBe(3);
  // The revoked refresh token no longer works on the server either.
  const reuse = await f.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshed.refreshToken, client_id: 'tavya-cli' });
  expect(reuse.status).toBe(400);
});
