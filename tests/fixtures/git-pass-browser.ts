/** Native browser + deployment policy + authenticated HTTPS Git verification.
 * Uses generated credentials only; no request interception or production accounts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { bootHarness, type Harness } from '../helpers/harness.js';
import { IdentityService } from '../../src/auth/identity.js';
import { findFreePortFrom } from '../../src/util/ports.js';
import { encryptIdentity } from '../helpers/age-encrypted-identity.js';
import { totpCode } from '../../src/autonomy/vault-items.js';

// Bodies passed to page.evaluate run in the page; this file has no DOM lib.
declare const document: any;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pass-browser-'));
process.env.KARMAX_HOME = path.join(root, 'karmax');
process.env.KARMAX_SKIP_LIVE = '1';
process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
const run = (cmd: string, args: string[], cwd?: string, input?: string) => execFileSync(cmd, args,
  { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const uri = `otpauth://totp/staging?secret=${seed}`;
const gitToken = 'throwaway-git-transport-token';
const gpgHome = path.join(root, 'gpg');
fs.mkdirSync(gpgHome, { mode: 0o700 });
let harness: Harness | undefined;
let identity: IdentityService | undefined;
let browser: Browser | undefined;
let remoteServer: https.Server | undefined;
const requests: { path: string; authorized: boolean }[] = [];
try {
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path.join(root, 'tls.key'),
    '-out',
    path.join(root, 'tls.crt'),
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  process.env.GIT_SSL_CAINFO = path.join(root, 'tls.crt');
  run('gpg', [
    '--homedir',
    gpgHome,
    '--batch',
    '--passphrase',
    '',
    '--quick-generate-key',
    'Browser Test <test@example.invalid>',
    'rsa2048',
    'encr',
    '0',
  ]);
  const fingerprint = run('gpg', ['--homedir', gpgHome, '--with-colons', '--list-secret-keys'])
    .split('\n')
    .find((x) => x.startsWith('fpr:'))!
    .split(':')[9]!;
  const gpgPrivateKey = run('gpg', ['--homedir', gpgHome, '--armor', '--export-secret-keys', fingerprint]);
  const ageKey = path.join(root, 'age.key');
  run('age-keygen', ['-o', ageKey]);
  const encryptedAgeKey = path.join(root, 'identity.age');
  await encryptIdentity(ageKey, encryptedAgeKey, 'browser-test-passphrase');
  const ageRecipient = run('age-keygen', ['-y', ageKey]).trim();
  for (const [name, backend] of [
    ['root', 'gpg'],
    ['work', 'age'],
  ]) {
    const repo = path.join(root, name! + '.git');
    const source = path.join(root, name! + '-source');
    run('git', ['init', '--bare', '--initial-branch=main', repo]);
    run('git', ['config', 'http.receivepack', 'true'], repo);
    run('git', ['init', '--initial-branch=main', source]);
    run('git', ['config', 'user.name', 'Test'], source);
    run('git', ['config', 'user.email', 'test@example.invalid'], source);
    fs.writeFileSync(
      path.join(source, backend === 'gpg' ? '.gpg-id' : '.age-recipients'),
      (backend === 'gpg' ? fingerprint : ageRecipient) + '\n',
    );
    const file = path.join(source, `otp.${backend}`);
    if (backend === 'gpg')
      run(
        'gpg',
        ['--homedir', gpgHome, '--batch', '--trust-model', 'always', '-r', fingerprint, '-o', file, '-e'],
        undefined,
        uri + '\nkeep GPG note\n',
      );
    else run('age', ['-r', ageRecipient, '-o', file], undefined, uri + '\nkeep age note\n');
    run('git', ['add', '.'], source);
    run('git', ['commit', '-m', 'seed'], source);
    run('git', ['remote', 'add', 'origin', repo], source);
    run('git', ['push', '-u', 'origin', 'main'], source);
  }
  remoteServer = https.createServer(
    { key: fs.readFileSync(path.join(root, 'tls.key')), cert: fs.readFileSync(path.join(root, 'tls.crt')) },
    (req, res) => {
      const url = new URL(req.url!, 'https://127.0.0.1');
      const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
      const authorized = auth === `${gitToken}:${gitToken}`;
      requests.push({ path: url.pathname + url.search, authorized });
      if (!authorized) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="password-store-test"' });
        res.end();
        return;
      }
      const backend = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method!,
          CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
          CONTENT_LENGTH: String(req.headers['content-length'] ?? ''),
          REMOTE_USER: 'test',
          REMOTE_ADDR: '127.0.0.1',
          SERVER_PROTOCOL: 'HTTP/1.1',
          HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let headers = Buffer.alloc(0);
      let sent = false;
      backend.stdout.on('data', (chunk: Buffer) => {
        if (sent) {
          res.write(chunk);
          return;
        }
        headers = Buffer.concat([headers, chunk]);
        const split = headers.indexOf('\r\n\r\n');
        if (split < 0) return;
        for (const line of headers.subarray(0, split).toString().split('\r\n')) {
          const index = line.indexOf(':');
          const key = line.slice(0, index);
          const value = line.slice(index + 1).trim();
          if (key.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
          else res.setHeader(key, value);
        }
        sent = true;
        res.write(headers.subarray(split + 4));
      });
      backend.on('error', () => {
        res.statusCode = 500;
        res.end();
      });
      backend.on('close', () => res.end());
      req.pipe(backend.stdin);
    },
  );
  await new Promise<void>((resolve) => remoteServer!.listen(0, '127.0.0.1', resolve));
  const gitBase = `https://127.0.0.1:${(remoteServer.address() as import('node:net').AddressInfo).port}`;
  harness = await bootHarness();
  const port = await findFreePortFrom(48900);
  const base = `http://127.0.0.1:${port}`;
  identity = await IdentityService.open(path.join(root, 'identity.db'), { baseURL: base });
  const hostedGateway = await harness.startGateway({ hosted: true, identity, port });
  const setup = await fetch(base + '/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Vault tester',
      email: 'vault@example.invalid',
      password: 'test-password-long-enough',
    }),
  });
  assert.equal(setup.status, 200);
  const admin = (await setup.json()) as { user: { id: string } };
  const org = (await harness.store.createOrganization({ name: 'Vault Staging', ownerUserId: admin.user.id }));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('BROWSER ERROR', error.message);
  });
  await page.goto(base + '/login');
  await page.locator('#email').fill('vault@example.invalid');
  await page.locator('#pw').fill('test-password-long-enough');
  const signedIn = page.waitForResponse((r) => r.url().endsWith('/api/login') && r.request().method() === 'POST');
  await page.locator('#login-btn').click();
  assert.equal((await signedIn).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#login-btn'));
  // All requests below go through the real gateway, identity and authorization.
  const api = (url: string, body?: unknown) =>
    page.evaluate(
      async ({ url, body }) => {
        const response = await fetch(
          url,
          body === undefined
            ? {}
            : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        );
        return { status: response.status, body: (await response.json()) as any };
      },
      { url, body },
    );
  assert.equal((await api('/api/session')).body.authenticated, true);
  const profile = await api(`/api/organizations/${org.id}/git-profiles`, {
    name: 'staging',
    userName: 'Test',
    userEmail: 'test@example.invalid',
    githubToken: gitToken,
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  const oq = `?organizationId=${org.id}`;
  await page.goto(`${base}/${org.slug}/settings#settings-payments`);
  await page.locator('#onboarding-minimize').click();
  const row = page.locator('[data-conn="pass-git"]');
  const connectFromBrowser = async () => {
    await row.locator('[data-git-pass-connect]').click();
    const form = page.locator('[data-git-pass-root]');
    await form.locator('.git-pass-repo').fill(gitBase + '/root.git');
    await form.locator('.git-pass-key').fill(gpgPrivateKey);
    await form.locator('.git-pass-profile').selectOption('staging');
    await page.locator('[data-git-pass-add]').click();
    const mount = page.locator('[data-git-pass-mount]');
    await mount.locator('.git-pass-mount-name').fill('work');
    await mount.locator('.git-pass-repo').fill(gitBase + '/work.git');
    await mount.locator('.git-pass-profile').selectOption('staging');
    await mount.locator('.git-pass-crypto').selectOption('age');
    await mount.locator('.git-pass-age-file').setInputFiles(encryptedAgeKey);
    await mount.locator('.git-pass-age-passphrase').fill('browser-test-passphrase');
    await mount.locator('.git-pass-verify-entry').fill('otp');
    const connected = page.waitForResponse(r => r.url().includes('/connectors/pass-git/connect') && r.request().method() === 'POST');
    await page.locator('[data-git-pass-save]').click();
    return await connected;
  };
  const refused = await connectFromBrowser();
  assert.equal(refused.status(), 400);
  assert.match(await refused.text(), /hosted Git password stores require public/);
  assert.equal(requests.length, 0, 'hosted rejection must happen before contacting the private Git server');
  // A private HTTPS remote is supported only on the self-hosted deployment.
  await hostedGateway.close();
  await harness.startGateway({ hosted: false, identity, port });
  await page.reload();
  const connection = await connectFromBrowser();
  assert.equal(connection.status(), 200, await connection.text());
  const checks = (await connection.json()).connector.checks;
  assert.equal(checks.length, 2);
  assert(checks.every((check: any) => check.read === 'verified' && check.encryption && check.push));
  await page.locator('[data-git-pass-root]').waitFor({ state: 'detached' });
  // A newly connected store opens its import picker by itself.
  await page.waitForFunction(() => document.querySelectorAll('.imp-pick').length === 2);
  await page.locator('.imp-all').check();
  await page.locator('.imp-wb').check();
  await page.locator('.imp-reveal').selectOption('auto');
  assert.equal(await page.locator('.imp-pick:checked').count(), 2);
  const imported = page.waitForResponse((r) => r.url().includes('/connectors/pass-git/sync'));
  void imported.catch(() => {});
  await page.locator('[data-imp-go]').click();
  assert.equal((await imported).status(), 200);
  await page.locator('[data-imp-go]').waitFor({ state: 'detached' });
  const checked = page.waitForResponse(response => response.url().includes('/connectors/pass-git/check'));
  await row.locator('[data-git-pass-check]').click();
  const checkedResponse = await checked;
  assert.equal(checkedResponse.status(), 200);
  assert.deepEqual((await checkedResponse.json()).checks, checks);
  const listed = await api('/api/vault/items' + oq);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 2);
  assert(!JSON.stringify(listed.body).includes(seed));
  const nextSeed = 'JBSWY3DPEHPK3PXP';
  for (const item of listed.body) {
    assert(item.fields.includes('totp'));
    assert(!item.fields.includes('password'));
    const before = Date.now();
    const resolved = await api('/api/vault/resolve' + oq, { itemId: item.id, field: 'totp' });
    assert.equal(resolved.status, 200);
    assert(
      [totpCode(seed, before), totpCode(seed, Date.now())].includes(resolved.body.value),
      JSON.stringify(resolved.body),
    );
    const rotated = await api('/api/vault/items' + oq, { id: item.id, type: 'login', secrets: { totp: nextSeed } });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.propagated?.connector, 'pass-git', JSON.stringify(rotated.body));
    const rotatedAt = Date.now();
    const updated = await api('/api/vault/resolve' + oq, { itemId: item.id, field: 'totp' });
    assert.equal(updated.status, 200);
    assert([totpCode(nextSeed, rotatedAt), totpCode(nextSeed, Date.now())].includes(updated.body.value));
  }
  for (const name of ['root', 'work']) run('git', ['pull', '--ff-only'], path.join(root, name + '-source'));
  const gpgBody = run('gpg', ['--homedir', gpgHome, '--batch', '-d', path.join(root, 'root-source', 'otp.gpg')]);
  const ageBody = run('age', ['-d', '-i', ageKey, path.join(root, 'work-source', 'otp.age')]);
  assert(gpgBody.includes(nextSeed) && gpgBody.includes('keep GPG note'));
  assert(ageBody.includes(nextSeed) && ageBody.includes('keep age note'));
  assert(requests.some((r) => !r.authorized));
  for (const name of ['root', 'work']) {
    assert(requests.some((r) => r.authorized && r.path === `/${name}.git/git-upload-pack`));
    assert(requests.some((r) => r.authorized && r.path === `/${name}.git/git-receive-pack`));
  }
  // Agent-style saves export real typed ciphertext. Rejected pushes keep the
  // vault intact and expose a durable retry action through the shipped UI.
  const apiKey = await api('/api/vault/store' + oq, {
    type: 'api-key',
    label: 'API export',
    secrets: { secret: 'synthetic-api-secret' },
  });
  assert.equal(apiKey.status, 200);
  assert.equal(apiKey.body.writeBack[0].connector, 'pass-git');
  assert(!apiKey.body.writeBack[0].error, JSON.stringify(apiKey.body));
  const rejectHook = path.join(root, 'root.git', 'hooks', 'pre-receive');
  fs.writeFileSync(rejectHook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const note = await api('/api/vault/store' + oq, {
    type: 'note',
    label: 'Note export',
    secrets: { note: 'first line\nsecond line\n' },
  });
  assert.equal(note.status, 200);
  assert(note.body.writeBack[0].error);
  const reveal = await api(`/api/vault/items/${note.body.id}/reveal` + oq, { field: 'note' });
  assert.equal(reveal.status, 200);
  assert(JSON.stringify(reveal.body).includes('first line'));
  fs.rmSync(rejectHook);
  await page.reload();
  await row.locator('[data-conn-retry]').waitFor({ state: 'visible' });
  const retried = page.waitForResponse((r) => r.url().includes('/connectors/pass-git/retry-writes'));
  await row.locator('[data-conn-retry]').click();
  const retryResult = await retried;
  assert.equal(retryResult.status(), 200);
  assert(!(await retryResult.json()).some((entry: any) => entry.error));
  await row.locator('[data-conn-retry]').waitFor({ state: 'detached' });
  const exported = (await api('/api/vault/items' + oq)).body.filter(
    (entry: any) => entry.id === note.body.id || entry.id === apiKey.body.id,
  );
  assert.equal(exported.length, 2);
  for (const entry of exported) {
    const externalId = entry.provenance.externalIds['pass-git'];
    const sync = await api('/api/vault/connectors/pass-git/sync' + oq, { externalIds: [externalId] });
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.deepEqual(sync.body.itemIds, [entry.id]);
  }
  assert.equal((await api('/api/vault/items' + oq)).body.length, 4);
  const rotatedNote = await api('/api/vault/items' + oq, {
    id: note.body.id,
    type: 'note',
    secrets: { note: 'rotated\nmultiline note' },
  });
  assert.equal(rotatedNote.body.propagated.connector, 'pass-git');
  run('git', ['pull', '--ff-only'], path.join(root, 'root-source'));
  for (const entry of exported) {
    const plaintext = run('gpg', [
      '--homedir',
      gpgHome,
      '--batch',
      '-d',
      path.join(root, 'root-source', entry.provenance.externalIds['pass-git'] + '.gpg'),
    ]);
    assert(plaintext.includes(entry.type === 'note' ? 'multiline note' : 'synthetic-api-secret'));
  }
  fs.writeFileSync(rejectHook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await page.reload();
  await page.locator('#vault-manage-open').click();
  await page.locator(`[data-vi-rotate="${note.body.id}"]`).click();
  await page.locator('.secret-prompt-value').fill('rotation pending');
  const failedRotation = page.waitForResponse(
    (r) => r.url().includes('/api/vault/items?') && r.request().method() === 'POST',
  );
  await page.locator('.secret-prompt-scrim button[type="submit"]').click();
  assert((await (await failedRotation).json()).propagated.error);
  await page.locator('.toast.err').filter({ hasText: 'external writes failed' }).waitFor({ state: 'visible' });
  fs.rmSync(rejectHook);
  await page.reload();
  await row.locator('[data-conn-retry]').click();
  await row.locator('[data-conn-retry]').waitFor({ state: 'detached' });
  {
  // A rejected remote write is durable and can be retried from the real UI.
  const rootItem = listed.body.find((item: any) => item.provenance.externalId === 'otp');
  const hook = path.join(root, 'root.git', 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const rejected = await api('/api/vault/items'+oq, { id: rootItem.id, type: 'login', secrets: { totp: seed } });
  assert(rejected.body.propagated?.error);
  await page.reload();
  await page.locator(`[data-write-retry="${rootItem.id}"]`).waitFor();
  fs.rmSync(hook);
  const retried = page.waitForResponse(response => response.url().includes('/retry-write-back'));
  await page.locator(`[data-write-retry="${rootItem.id}"]`).click();
  assert.equal((await retried).status(), 200);
  await page.locator(`[data-write-retry="${rootItem.id}"]`).waitFor({ state: 'detached' });
  run('git', ['pull', '--ff-only'], path.join(root, 'root-source'));
  assert(run('gpg', ['--homedir', gpgHome, '--batch', '-d', path.join(root, 'root-source', 'otp.gpg')]).includes(seed));
  }
  // Bad transport credentials must fail visibly without replacing the working connector.
  await api(`/api/organizations/${org.id}/git-profiles`, {
    name: 'wrong',
    userName: 'Test',
    userEmail: 'test@example.invalid',
    githubToken: 'wrong-token',
  });
  await row.locator('[data-git-pass-connect]').click();
  await page.locator('[data-git-pass-root] .git-pass-repo').fill(gitBase + '/root.git');
  await page.locator('[data-git-pass-root] .git-pass-key').fill(gpgPrivateKey);
  await page.locator('[data-git-pass-root] .git-pass-profile').selectOption('wrong');
  const failed = page.waitForResponse((r) => r.url().includes('/connectors/pass-git/connect'));
  await page.locator('[data-git-pass-save]').click();
  assert.equal((await failed).status(), 400);
  await page.locator('.toast.err').last().waitFor({ state: 'visible' });
  await page.locator('.toast.err .toast-dismiss').last().click();
  await page.waitForFunction(() => !document.querySelector('[data-git-pass-save]')?.disabled);
  await page.locator('[data-git-pass-cancel]').click();
  assert.equal((await api('/api/vault/connectors/pass-git/list' + oq, {})).body.length, 4);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browserLogin: true,
      hostedPrivateRemoteRejected: true,
      selfHostedGateway: true,
      tlsVerified: true,
      gitChallengeResponse: true,
      gpgAndAgeMountImport: true,
      totpResolution: true,
      authenticatedGitPush: true,
      typedExportsAndRetry: true,
      failedReplacementPreservesConnection: true,
      browserErrors: errors.length,
    }),
  );
} finally {
  await browser?.close();
  await harness?.stop();
  identity?.close();
  if (remoteServer) await new Promise<void>(resolve => remoteServer!.close(() => resolve()));
  run('gpgconf', ['--homedir', gpgHome, '--kill', 'gpg-agent']);
  fs.rmSync(root, { recursive: true, force: true });
}
