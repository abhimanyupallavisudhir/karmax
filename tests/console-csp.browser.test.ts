// UI-13 / CI-16: the console runs under a real Content-Security-Policy. The
// shell is served with the headers the gateway sends (staticAssetHeaders) on a
// fake /api + WS, and every page a person commonly opens is walked while each
// CSP violation is recorded. Agent-authored HTML keeps its scripts because it is
// served as its own document under its own sandbox policy, never inherited.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { consoleContentSecurityPolicy, staticAssetHeaders, CONSOLE_CONTENT_SECURITY_POLICY } from '../src/gateway/static-assets.js';
import { untrustedContentHeaders } from '../src/gateway/server.js';

// Bodies passed to page.evaluate run in the page; this file has no DOM lib.
declare const window: any, document: any, history: any, dispatchEvent: any, PopStateEvent: any;

const web = path.join(import.meta.dirname, '..', 'web');
const AGENT_HTML = '<!doctype html><p id="state">static</p><script>document.getElementById("state").textContent = "ran"</script>';
let browser: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] }); });
afterAll(async () => { await browser?.close(); });

const directives = (policy: string) => Object.fromEntries(policy.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));

it('declares a policy with no inline or eval script and no third-party script host but pinned MathJax', () => {
  const policy = directives(CONSOLE_CONTENT_SECURITY_POLICY);
  expect(policy['default-src']).toEqual(["'self'"]);
  expect(policy['script-src']).toEqual(["'self'", 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/']);
  expect(fs.readFileSync(path.join(web, 'markdown.js'), 'utf8')).toContain("const MATHJAX_ROOT = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/';");
  expect(policy['object-src']).not.toContain("'self'");
  expect(policy['base-uri']).toEqual(["'none'"]);
  expect(policy['frame-ancestors']).toEqual(["'self'"]);
  expect(staticAssetHeaders('/x/index.html')['content-security-policy']).toBe(CONSOLE_CONTENT_SECURITY_POLICY);
  expect(staticAssetHeaders('/x/paddle-checkout.html')['content-security-policy']).toContain('https://cdn.paddle.com');
});

it('names the socket and blob worker sources that older Safari does not derive', () => {
  // Older Safari matches neither ws(s): against 'self' nor worker-src.
  const policy = directives(consoleContentSecurityPolicy('console.test:8080'));
  expect(policy['connect-src']).toEqual(["'self'", 'wss://console.test:8080', 'ws://console.test:8080']);
  expect(policy['child-src']).toEqual(["'self'", 'blob:']);
  expect(staticAssetHeaders('/x/index.html', 'console.test')['content-security-policy']).toBe(consoleContentSecurityPolicy('console.test'));
  // A Host header is the requester's to choose: it may not add directives or sources.
  for (const host of ["evil; script-src 'unsafe-inline'", 'a b', 'console.test/x']) {
    const forged = directives(consoleContentSecurityPolicy(host));
    expect(forged['connect-src']).toEqual(["'self'"]);
    expect(forged['script-src']).toEqual(policy['script-src']);
  }
  // Agent HTML may script itself but submits nowhere.
  expect(untrustedContentHeaders('text/html', 'report.html')['content-security-policy']).toMatch(/; form-action 'none'$/);
});

it('walks the console under its policy without a violation, and agent HTML still runs', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    (window as any).__violations = [];
    document.addEventListener('securitypolicyviolation', (event: any) =>
      (window as any).__violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
  });
  const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
  const task = { id: 't', projectId: 'p', num: 1, title: 'Report', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'review', status: 'waiting' } };
  const view = { taskId: 't', projectId: 'p', title: 'Report', workflow: 'software-dev', stage: 'review', status: 'waiting', messages: [], actions: [], state: {},
    reviewInfo: { caption: 'Check the report', html: AGENT_HTML, actions: [{ kind: 'open', label: 'Report', target: 'report.html' }] } };
  await context.routeWebSocket('**/ws*', () => {});
  // MATHJAX_PACKAGE (an unpacked mathjax@3.2.2 npm package) serves the real
  // release, so the browser itself verifies every pinned hash; otherwise the CDN
  // answers 404 and only the policy's allowance for the request is checked.
  const cdn: string[] = [];
  const mathjax = process.env.MATHJAX_PACKAGE;
  await context.route('https://cdn.jsdelivr.net/**', (route) => {
    const url = new URL(route.request().url());
    cdn.push(url.pathname);
    const file = mathjax && path.join(mathjax, 'es5', url.pathname.replace('/npm/mathjax@3.2.2/es5/', ''));
    return file && fs.existsSync(file)
      ? route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(file) })
      : route.fulfill({ status: 404, body: '' });
  });
  await context.route('http://console.test/**', async (route) => {
    const req = route.request(), p = new URL(req.url()).pathname;
    if (!p.startsWith('/api/')) {
      const rel = /^\/[\w-]+\.(js|css)$|^\/vendor\/|^\/fonts\/|^\/brand\//.test(p) && fs.existsSync(path.join(web, p)) ? p : '/index.html';
      const file = path.join(web, rel.startsWith('/brand/') ? rel.replace(/^\/brand\//, '/brand/diamond/') : rel);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ headers: staticAssetHeaders(file, 'console.test'), body: fs.readFileSync(file) });
    }
    if (p === '/api/tasks/t/review-info.html' || p === '/api/tasks/t/review-artifact')
      return route.fulfill({ headers: untrustedContentHeaders('text/html; charset=utf-8', 'report.html'), body: AGENT_HTML });
    let data: unknown = [];
    if (p === '/api/meta') data = { siteName: 'Fixture', hostLocal: true, consoleRevision: 'one', agent: { provider: 'mock' }, worldProviders: [] };
    else if (p === '/api/session') data = { authenticated: true, user: { id: 'u', name: 'Tester' } };
    else if (p === '/api/organizations') data = [{ id: 'o', name: 'Organization', slug: 'org' }];
    else if (p === '/api/user/default-organization') data = { organizationId: 'o' };
    else if (p === '/api/projects') data = [project];
    else if (p === '/api/projects/p') data = project;
    else if (p === '/api/schema') data = [{ name: 'software-dev', params: [], stages: [{ key: 'review', label: 'Review' }] }];
    else if (p === '/api/contributions') data = { slots: [], commands: [], events: [] };
    else if (p === '/api/projects/p/tasks') data = [task];
    else if (p === '/api/projects/p/search') data = { tasks: [task], total: 1 };
    else if (p === '/api/tasks/t') data = view;
    else if (p === '/api/tasks/t/attempts') data = { principalAttemptId: 't', attempts: [task] };
    else if (p === '/api/tasks/t/review-action') data = { kind: 'open', url: '/api/tasks/t/review-artifact' };
    else if (p === '/api/organizations/o/roles') data = { canCreate: true, profiles: [], capabilityGroups: [], creatableCapabilities: [] };
    else if (p.endsWith('/execution-policy')) data = { worldProvider: 'worktree', resources: { cpu: 2, memoryMb: 2048 }, network: { unrestricted: true } };
    else if (p.endsWith('/github/app')) data = { configured: false };
    else if (p.endsWith('/github/identity')) data = { profile: null };
    else if (/\/(entitlements|usage|usage-policy|identity-policy)$/.test(p)) data = null;
    else if (p.endsWith('/payments/providers')) data = { providers: [], active: null };
    else if (p.endsWith('/defaults') || p.startsWith('/api/defaults/') || /^\/api\/(launch|models|settings\/installation)$/.test(p) || p.endsWith('/sessions')) data = {};
    return route.fulfill({ json: data });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const violations = (target: Page = page) => target.evaluate(() => (window as any).__violations as string[]);
  const go = (to: string) => page.evaluate((pathname) => { history.pushState({ kx: 1 }, '', pathname); dispatchEvent(new PopStateEvent('popstate')); }, to);

  await page.goto('http://console.test/org/workspace');
  await page.locator('[data-id="t"]').waitFor();
  const typeset = await page.evaluate(async () => {
    if (!await (globalThis as any).KarmaxMarkdown.ensureMathJax()) return 'unavailable';
    const node = document.createElement('div');
    node.textContent = '$\\color{red}{x} + \\cancel{y}$';
    document.body.append(node);
    await (window as any).MathJax.typesetPromise([node]);
    const svg = !!node.querySelector('svg') && !node.textContent.includes('\\color');
    node.remove();
    return svg ? 'typeset' : 'not typeset';
  });
  if (mathjax) {
    expect(typeset).toBe('typeset');
    expect(cdn).toEqual(expect.arrayContaining(['/npm/mathjax@3.2.2/es5/ui/safe.js', '/npm/mathjax@3.2.2/es5/input/tex/extensions/color.js']));
  } else {
    expect(typeset).toBe('unavailable');
    expect(cdn).toEqual(['/npm/mathjax@3.2.2/es5/tex-svg.js']);
  }
  // The TOTP QR reader decodes in a worker it builds from a blob.
  const scanned = await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/qr-scanner.legacy.min.js'; script.onload = resolve; script.onerror = reject;
      document.head.append(script);
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    return (window as any).QrScanner.scanImage(canvas, { returnDetailedScanResult: true }).then(() => 'decoded', (error: unknown) => String(error));
  });
  expect(scanned).toMatch(/No QR code found/);
  await go('/org/workspace/tasks/1');
  // The agent's review HTML is its own sandboxed document, so its script runs.
  await expect.poll(() => page.frameLocator('.review iframe').locator('#state').textContent()).toBe('ran');
  // An HTML artifact opens as its own document under the gateway's sandbox policy.
  const opened = context.waitForEvent('page');
  await page.locator('.review-action[data-kind="open"]').click();
  const artifact = await opened;
  await artifact.waitForLoadState();
  expect(new URL(artifact.url()).pathname).toBe('/api/tasks/t/review-artifact');
  await expect.poll(() => artifact.locator('#state').textContent()).toBe('ran');
  await artifact.close();
  await go('/org/settings');
  await page.locator('#org-members').waitFor({ state: 'attached' });
  await go('/org/workspace/queue');
  await page.waitForTimeout(300);
  expect(await violations()).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});
