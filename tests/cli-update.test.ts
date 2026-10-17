import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cliVersionOf, olderVersion } from '../src/domain/cli-version.js';
import { updateCheck, updateCheckWanted, updateCommand } from '../src/cli/update.js';

let cache: string;
const previous = process.env.TAVYA_CACHE_DIR;
beforeEach(() => { cache = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-update-')); process.env.TAVYA_CACHE_DIR = cache; });
afterEach(() => {
  fs.rmSync(cache, { recursive: true, force: true });
  if (previous === undefined) delete process.env.TAVYA_CACHE_DIR; else process.env.TAVYA_CACHE_DIR = previous;
});

/** A registry that answers `version` and counts the questions. */
const registry = (version: unknown, status = 200) => {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ name: '@tavya/cli', version }), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};
const DAY = 24 * 60 * 60 * 1000;

it('compares x.y.z versions and reads the CLI from a User-Agent', () => {
  expect(olderVersion('1.0.1', '1.4.2')).toBe(true);
  expect(olderVersion('1.4.2', '1.4.10')).toBe(true);
  expect(olderVersion('1.4.10', '1.4.2')).toBe(false);
  expect(olderVersion('2.0.0', '1.9.9')).toBe(false);
  expect(olderVersion('1.4.2', '1.4.2')).toBe(false);
  expect(olderVersion('1.4.2-rc.1', '9.0.0')).toBe(false);
  expect(cliVersionOf('tavya-cli/1.4.3')).toBe('1.4.3');
  expect(cliVersionOf('tavya-cli/1.4.3 (darwin)')).toBe('1.4.3');
  expect(cliVersionOf('node')).toBeUndefined();
  expect(cliVersionOf('tavya-cli/next')).toBeUndefined();
  expect(cliVersionOf(undefined)).toBeUndefined();
});

it('names the update command for how tavya was installed', () => {
  expect(updateCommand('npm', '/usr/local/lib/node_modules/@tavya/cli/dist/tavya.mjs')).toBe('npm install -g @tavya/cli@latest');
  expect(updateCommand('npm', '/Users/a/.npm/_npx/0f3a/node_modules/@tavya/cli/dist/tavya.mjs')).toBe('npx @tavya/cli@latest');
  expect(updateCommand('npm', 'C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\0f3a\\node_modules\\@tavya\\cli\\dist\\tavya.mjs'))
    .toBe('npx @tavya/cli@latest');
  expect(updateCommand('binary', '/home/a/.local/bin/tavya', 'darwin')).toBe('curl -fsSL https://tavya.io/cli/install.sh | sh');
  expect(updateCommand('binary', 'C:\\tavya.exe', 'win32')).toMatch(/tavya-windows-x64\.exe from https:\/\/github\.com\/.+\/releases\/latest/);
});

it('looks for updates only from a released copy, on a terminal, for people', () => {
  expect(updateCheckWanted(['clone', 'acme/site'], true, 'npm', {})).toBe(true);
  expect(updateCheckWanted(['clone', 'acme/site'], true, undefined, {})).toBe(false); // a checkout
  expect(updateCheckWanted(['clone', 'acme/site'], false, 'npm', {})).toBe(false);
  expect(updateCheckWanted(['status', '--json'], true, 'npm', {})).toBe(false);
  expect(updateCheckWanted(['run', '--', 'jq', '--json'], true, 'npm', {})).toBe(true); // the command's own flag
  expect(updateCheckWanted(['git-credential', 'get'], true, 'npm', {})).toBe(false);
  expect(updateCheckWanted(['clone', 'acme/site'], true, 'binary', { TAVYA_NO_UPDATE_CHECK: '1' })).toBe(false);
});

it('says when npm has a newer version, asking at most once a day', async () => {
  const npm = registry('1.4.2');
  const now = Date.UTC(2026, 9, 17);
  expect(await updateCheck('1.0.1', { now, fetch: npm.fetch }).notice())
    .toMatch(/^tavya 1\.4\.2 is available \(this is 1\.0\.1\)\. Update: /);
  expect(npm.calls).toEqual(['https://registry.npmjs.org/@tavya/cli/latest']);
  // Remembered: later commands that day ask nobody, and a current copy says nothing.
  expect(await updateCheck('1.0.1', { now: now + DAY - 1, fetch: npm.fetch }).notice()).toMatch(/1\.4\.2 is available/);
  expect(await updateCheck('1.4.2', { now: now + 60_000, fetch: npm.fetch }).notice()).toBeUndefined();
  expect(npm.calls).toHaveLength(1);
  // A day later it asks again.
  const newer = registry('1.5.0');
  expect(await updateCheck('1.4.2', { now: now + DAY, fetch: newer.fetch }).notice()).toMatch(/^tavya 1\.5\.0 is available/);
  expect(newer.calls).toHaveLength(1);
});

it('stays silent when npm is unreachable or answers nonsense, and does not ask again that day', async () => {
  const now = Date.UTC(2026, 9, 17);
  const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  expect(await updateCheck('1.0.1', { now, fetch: offline }).notice()).toBeUndefined();
  const npm = registry('1.4.2');
  expect(await updateCheck('1.0.1', { now: now + 1000, fetch: npm.fetch }).notice()).toBeUndefined();
  expect(npm.calls).toHaveLength(0);

  fs.rmSync(path.join(cache, 'update-check.json'));
  expect(await updateCheck('1.0.1', { now, fetch: registry('1.4.2', 503).fetch }).notice()).toBeUndefined();
  fs.rmSync(path.join(cache, 'update-check.json'));
  expect(await updateCheck('1.0.1', { now, fetch: registry({ evil: true }).fetch }).notice()).toBeUndefined();
  // A failed check keeps what an earlier one found.
  fs.writeFileSync(path.join(cache, 'update-check.json'), JSON.stringify({ checkedAt: now - 2 * DAY, latest: '1.4.2' }));
  expect(await updateCheck('1.0.1', { now, fetch: offline }).notice()).toMatch(/1\.4\.2 is available/);
});

it('tells the user how to update when a server refuses this CLI as too old', async () => {
  const agents: string[] = [];
  const server = http.createServer((req, res) => {
    agents.push(String(req.headers['user-agent']));
    res.writeHead(426, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'tavya 1.4.0 is too old for this server, which needs 2.0.0 or newer' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const run = await new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.resolve('bin/tavya.js'), 'whoami'], { stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TAVYA_URL: url, TAVYA_TOKEN: 'tvp_test', KARMAX_TOKEN: '', KARMAX_GATEWAY_URL: '',
          TAVYA_CONFIG_DIR: path.join(cache, 'config'), TAVYA_NO_KEYCHAIN: '1' } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('tavya: tavya 1.4.0 is too old for this server, which needs 2.0.0 or newer\n'
      + 'Update: npm install -g @tavya/cli@latest\n');
    expect(agents[0]).toMatch(/^tavya-cli\/\d+\.\d+\.\d+$/);
  } finally { server.close(); }
});
