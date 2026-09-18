/** Native browser + hosted gateway + authenticated HTTPS Git verification.
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
import { totpCode } from '../../src/autonomy/vault-items.js';

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
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'tls.key'),
    '-out', path.join(root, 'tls.crt'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  process.env.GIT_SSL_CAINFO = path.join(root, 'tls.crt');
  run('gpg', ['--homedir', gpgHome, '--batch', '--passphrase', '', '--quick-generate-key', 'Browser Test <test@example.invalid>', 'rsa2048', 'encr', '0']);
  const fingerprint = run('gpg', ['--homedir', gpgHome, '--with-colons', '--list-secret-keys']).split('\n').find(x => x.startsWith('fpr:'))!.split(':')[9]!;
  const gpgPrivateKey = run('gpg', ['--homedir', gpgHome, '--armor', '--export-secret-keys', fingerprint]);
  const ageKey = path.join(root, 'age.key');
  run('age-keygen', ['-o', ageKey]);
  const ageIdentity = fs.readFileSync(ageKey, 'utf8');
  const ageRecipient = run('age-keygen', ['-y', ageKey]).trim();
  for (const [name, backend] of [['root', 'gpg'], ['work', 'age']]) {
    const repo = path.join(root, name! + '.git');
    const source = path.join(root, name! + '-source');
    run('git', ['init', '--bare', '--initial-branch=main', repo]);
    run('git', ['config', 'http.receivepack', 'true'], repo);
    run('git', ['init', '--initial-branch=main', source]);
    run('git', ['config', 'user.name', 'Test'], source);
    run('git', ['config', 'user.email', 'test@example.invalid'], source);
    fs.writeFileSync(path.join(source, backend === 'gpg' ? '.gpg-id' : '.age-recipients'), (backend === 'gpg' ? fingerprint : ageRecipient) + '\n');
    const file = path.join(source, `otp.${backend}`);
    if (backend === 'gpg') run('gpg', ['--homedir', gpgHome, '--batch', '--trust-model', 'always', '-r', fingerprint, '-o', file, '-e'], undefined, uri+'\nkeep GPG note\n');
    else run('age', ['-r', ageRecipient, '-o', file], undefined, uri+'\nkeep age note\n');
    run('git', ['add', '.'], source); run('git', ['commit', '-m', 'seed'], source);
    run('git', ['remote', 'add', 'origin', repo], source); run('git', ['push', '-u', 'origin', 'main'], source);
  }
  remoteServer = https.createServer({ key: fs.readFileSync(path.join(root, 'tls.key')), cert: fs.readFileSync(path.join(root, 'tls.crt')) }, (req, res) => {
    const url = new URL(req.url!, 'https://127.0.0.1');
    const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    const authorized = auth === `${gitToken}:${gitToken}`;
    requests.push({ path: url.pathname + url.search, authorized });
    if (!authorized) { res.writeHead(401, { 'www-authenticate': 'Basic realm="password-store-test"' }); res.end(); return; }
    const backend = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method!,
      CONTENT_TYPE: String(req.headers['content-type'] ?? ''), CONTENT_LENGTH: String(req.headers['content-length'] ?? ''),
      REMOTE_USER: 'test', REMOTE_ADDR: '127.0.0.1', SERVER_PROTOCOL: 'HTTP/1.1',
      HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? '') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let headers = Buffer.alloc(0); let sent = false;
    backend.stdout.on('data', (chunk: Buffer) => {
      if (sent) { res.write(chunk); return; }
      headers = Buffer.concat([headers, chunk]);
      const split = headers.indexOf('\r\n\r\n');
      if (split < 0) return;
      for (const line of headers.subarray(0, split).toString().split('\r\n')) {
        const index = line.indexOf(':'); const key = line.slice(0, index); const value = line.slice(index + 1).trim();
        if (key.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]); else res.setHeader(key, value);
      }
      sent = true; res.write(headers.subarray(split + 4));
    });
    backend.on('error', () => { res.statusCode = 500; res.end(); });
    backend.on('close', () => res.end());
    req.pipe(backend.stdin);
  });
  await new Promise<void>(resolve => remoteServer!.listen(0, '127.0.0.1', resolve));
  const gitBase = `https://127.0.0.1:${(remoteServer.address() as import('node:net').AddressInfo).port}`;
  harness = await bootHarness();
  const port = await findFreePortFrom(48900);
  const base = `http://127.0.0.1:${port}`;
  identity = await IdentityService.open(path.join(root, 'identity.db'), { baseURL: base });
  await harness.startGateway({ hosted: true, identity, port });
  const setup = await fetch(base+'/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Vault tester', email: 'vault@example.invalid', password: 'test-password-long-enough' }) });
  assert.equal(setup.status, 200);
  const admin = await setup.json() as { user: { id: string } };
  const org = harness.store.createOrganization({ name: 'Vault Staging', ownerUserId: admin.user.id });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('BROWSER ERROR', error.message); });
  await page.goto(base+'/login');
  await page.locator('#email').fill('vault@example.invalid');
  await page.locator('#pw').fill('test-password-long-enough');
  const signedIn = page.waitForResponse(r => r.url().endsWith('/api/login') && r.request().method() === 'POST');
  await page.locator('#login-btn').click();
  assert.equal((await signedIn).status(), 200);
  await page.waitForFunction("!document.querySelector('#login-btn')");
  // All requests below go through the real gateway, identity and authorization.
  const api = (url: string, body?: unknown) => page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }, { url, body });
  assert.equal((await api('/api/session')).body.authenticated, true);
  const profile = await api(`/api/organizations/${org.id}/git-profiles`, { name: 'staging', userName: 'Test', userEmail: 'test@example.invalid', githubToken: gitToken });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  const oq = `?organizationId=${org.id}`;
  await page.goto(`${base}/${org.slug}/settings#settings-payments`);
  const row = page.locator('[data-conn="pass-git"]');
  await row.locator('[data-git-pass-connect]').click();
  const form = page.locator('[data-git-pass-root]');
  await form.locator('.git-pass-repo').fill(gitBase+'/root.git');
  await form.locator('.git-pass-key').fill(gpgPrivateKey);
  await form.locator('.git-pass-profile').selectOption('staging');
  await page.locator('[data-git-pass-add]').click();
  const mount = page.locator('[data-git-pass-mount]');
  await mount.locator('.git-pass-mount-name').fill('work');
  await mount.locator('.git-pass-repo').fill(gitBase+'/work.git');
  await mount.locator('.git-pass-profile').selectOption('staging');
  await mount.locator('.git-pass-crypto').selectOption('age');
  await mount.locator('.git-pass-age-key').fill(ageIdentity);
  const connected = page.waitForResponse(r => r.url().includes('/connectors/pass-git/connect') && r.request().method() === 'POST');
  await page.locator('[data-git-pass-save]').click();
  const connection = await connected;
  assert.equal(connection.status(), 200, await connection.text());
  await page.locator('[data-git-pass-root]').waitFor({ state: 'detached' });
  await row.locator('[data-conn-import]').click();
  await page.waitForFunction("document.querySelectorAll('.imp-pick').length === 2");
  await page.locator('.imp-all').check();
  await page.locator('.imp-wb').check();
  await page.locator('.imp-reveal').selectOption('auto');
  assert.equal(await page.locator('.imp-pick:checked').count(), 2);
  const imported = page.waitForResponse(r => r.url().includes('/connectors/pass-git/sync'));
  void imported.catch(() => {});
  await page.locator('[data-imp-go]').click();
  assert.equal((await imported).status(), 200);
  await page.locator('[data-imp-go]').waitFor({ state: 'detached' });
  const listed = await api('/api/vault/items'+oq);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 2);
  assert(!JSON.stringify(listed.body).includes(seed));
  const nextSeed = 'JBSWY3DPEHPK3PXP';
  for (const item of listed.body) {
    assert(item.fields.includes('totp')); assert(!item.fields.includes('password'));
    const before = Date.now();
    const resolved = await api('/api/vault/resolve'+oq, { itemId: item.id, field: 'totp' });
    assert.equal(resolved.status, 200);
    assert([totpCode(seed, before), totpCode(seed, Date.now())].includes(resolved.body.value), JSON.stringify(resolved.body));
    const rotated = await api('/api/vault/items'+oq, { id: item.id, type: 'login', secrets: { totp: nextSeed } });
    assert.equal(rotated.status, 200); assert.equal(rotated.body.propagated?.connector, 'pass-git', JSON.stringify(rotated.body));
    const rotatedAt = Date.now();
    const updated = await api('/api/vault/resolve'+oq, { itemId: item.id, field: 'totp' });
    assert.equal(updated.status, 200);
    assert([totpCode(nextSeed, rotatedAt), totpCode(nextSeed, Date.now())].includes(updated.body.value));
  }
  for (const name of ['root', 'work']) run('git', ['pull', '--ff-only'], path.join(root, name+'-source'));
  const gpgBody = run('gpg', ['--homedir', gpgHome, '--batch', '-d', path.join(root, 'root-source', 'otp.gpg')]);
  const ageBody = run('age', ['-d', '-i', ageKey, path.join(root, 'work-source', 'otp.age')]);
  assert(gpgBody.includes(nextSeed) && gpgBody.includes('keep GPG note'));
  assert(ageBody.includes(nextSeed) && ageBody.includes('keep age note'));
  assert(requests.some(r => !r.authorized));
  for (const name of ['root', 'work']) {
    assert(requests.some(r => r.authorized && r.path === `/${name}.git/git-upload-pack`));
    assert(requests.some(r => r.authorized && r.path === `/${name}.git/git-receive-pack`));
  }
  // Bad transport credentials must fail visibly without replacing the working connector.
  await api(`/api/organizations/${org.id}/git-profiles`, { name: 'wrong', userName: 'Test', userEmail: 'test@example.invalid', githubToken: 'wrong-token' });
  await row.locator('[data-git-pass-connect]').click();
  await page.locator('[data-git-pass-root] .git-pass-repo').fill(gitBase+'/root.git');
  await page.locator('[data-git-pass-root] .git-pass-key').fill(gpgPrivateKey);
  await page.locator('[data-git-pass-root] .git-pass-profile').selectOption('wrong');
  const failed = page.waitForResponse(r => r.url().includes('/connectors/pass-git/connect'));
  await page.locator('[data-git-pass-save]').click();
  assert.equal((await failed).status(), 400);
  await page.locator('.toast.err').last().waitFor({ state: 'visible' });
  await page.locator('.toast.err .toast-dismiss').last().click();
  await page.waitForFunction("!document.querySelector('[data-git-pass-save]')?.disabled");
  await page.locator('[data-git-pass-cancel]').click();
  assert.equal((await api('/api/vault/connectors/pass-git/list'+oq, {})).body.length, 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browserLogin: true, hostedGateway: true, tlsVerified: true, gitChallengeResponse: true,
    gpgAndAgeMountImport: true, totpResolution: true, authenticatedGitPush: true, failedReplacementPreservesConnection: true, browserErrors: errors.length }));
} finally {
  await browser?.close();
  await harness?.stop();
  identity?.close();
  if (remoteServer) await new Promise<void>(resolve => remoteServer!.close(() => resolve()));
  run('gpgconf', ['--homedir', gpgHome, '--kill', 'gpg-agent']);
  fs.rmSync(root, { recursive: true, force: true });
}
