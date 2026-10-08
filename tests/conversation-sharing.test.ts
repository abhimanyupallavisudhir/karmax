import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { publicShare, currentShare } from '../src/gateway/conversation-sharing.js';

describe('public conversation sharing over HTTP', async () => {
  const store = (await Store.create(':memory:'));
  const project = (await store.createProject('Sharing'));
  const other = (await store.createProject('Other'));
  const task = (await store.createTask({ projectId: project.id, title: '<script>title</script>', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'Share test' } }));
  const tokens = new TokenAuthority();
  const owner = (await tokens.mintPrincipal('system:test', ['*'])).token;
  const developer = (await tokens.mintPrincipal('system:developer', ['task:*', 'project:settings:read'], project.id)).token;
  const viewer = (await tokens.mintPrincipal('system:viewer', ['task:read', 'task:conversation:read'], project.id)).token;
  const foreign = (await tokens.mintPrincipal('system:foreign', ['task:*'], other.id)).token;
  const messages = [
    { id: 's', role: 'system', text: 'hidden system', ts: 1 },
    { id: 'u', role: 'user', text: '<img src=x onerror=alert(1)> hello', ts: 2, files: [{ path: 'private-file' }] },
    { id: 'a', role: 'agent', text: 'Answer', ts: 3, sourceActivity: { id: 'private-tool' } },
  ];
  let base: string;
  let close: () => Promise<void>;
  let gateway: Gateway;
  const endpoint = `/api/tasks/${task.id}/conversation-share?role=merge`;
  const request = (url: string, method = 'GET', token = owner, body?: unknown) => fetch(`${base}${url}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const orgPolicy = (enabled: boolean) => request(`/api/organizations/${project.organizationId}/conversation-sharing`, 'PUT', owner, { enabled });
  beforeAll(async () => {
    gateway = (await Gateway.create({ store, tokens, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), client: {} as any, taskQueue: 'test', staticDir: 'web',
      api: { taskConversation: async () => ({ messages }), getTaskView: async () => ({ messages: [{ role: 'agent', text: 'wrong agent' }], transcripts: [{ role: 'merge', messages }] }) } as any,
      worlds: new WorldRegistry(), agentInfo: { provider: 'mock', reason: 'test' }, password: 'test-password',
    } as any));
    const running = await gateway.listen(await findFreePortFrom(48_700));
    base = running.url; close = running.close;
  });
  afterAll(async () => { await close?.(); (await store.close()); });

  it('defaults to disabled and reserves policy management for administrators', async () => {
    expect(await (await request(endpoint)).json()).toMatchObject({
      enabled: false, settings: { scope: 'organization', id: project.organizationId, canManage: true },
    });
    expect(await (await request(endpoint, 'GET', developer)).json()).toMatchObject({
      enabled: false, settings: { scope: 'organization', id: project.organizationId, canManage: false },
    });
    expect((await request(endpoint, 'POST', developer)).status).toBe(403);
    expect((await request(`/api/organizations/${project.organizationId}/conversation-sharing`, 'PUT', developer, { enabled: true })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/conversation-sharing`, 'PUT', developer, { value: 'inherit' })).status).toBe(403);
    expect((await orgPolicy(true)).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/conversation-sharing`, 'PUT', owner, { value: 'enabled' })).status).toBe(400);
  });
  it('rejects anonymous, read-only, cross-project and invalid-role requests', async () => {
    expect((await fetch(`${base}${endpoint}`, { method: 'POST' })).status).toBe(401);
    for (const token of [viewer, foreign]) {
      for (const method of ['GET', 'POST', 'DELETE']) expect((await request(endpoint, method, token)).status).toBe(403);
    }
    for (const method of ['GET', 'POST', 'DELETE']) expect((await request(`${endpoint}&projectId=${other.id}`, method, foreign)).status).toBe(403);
    expect((await request(endpoint.replace('merge', 'missing'), 'POST', developer)).status).toBe(404);
  });
  let sharedUrl: string;
  it('publishes only the selected agent as an escaped immutable anonymous snapshot', async () => {
    const response = await request(endpoint, 'POST', developer);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.settings).toBeNull();
    sharedUrl = result.url;
    const publicResponse = await fetch(`${base}${sharedUrl}`);
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get('cache-control')).toBe('no-store');
    expect(publicResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await publicResponse.text();
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>title</script>');
    expect(html).toContain('/shared-conversation.js');
    expect(html).toContain('/styles.css');
    expect(html).toContain('Join tavya');
    for (const hidden of ['wrong agent', 'private-file', 'private-tool', 'hidden system']) expect(html).not.toContain(hidden);
    messages.push({ id: 'later', role: 'agent', text: 'later message', ts: 4 });
    expect(await (await fetch(`${base}${sharedUrl}`)).text()).not.toContain('later message');
    expect((await (await request(endpoint, 'POST', developer)).json() as any).url).toBe(sharedUrl);
  });
  it('enforces both policies on existing links and allows revocation while disabled', async () => {
    const projectUrl = `/api/projects/${project.id}/conversation-sharing`;
    await request(projectUrl, 'PUT', owner, { value: 'disabled' });
    expect(await (await request(endpoint)).json()).toMatchObject({
      enabled: false, settings: { scope: 'project', id: project.id, canManage: true },
    });
    expect(await (await request(endpoint, 'GET', developer)).json()).toMatchObject({
      enabled: false, settings: { scope: 'project', id: project.id, canManage: false },
    });
    expect((await fetch(`${base}${sharedUrl}`)).status).toBe(404);
    expect((await request(endpoint, 'POST', developer)).status).toBe(403);
    await request(projectUrl, 'PUT', owner, { value: 'inherit' });
    expect((await fetch(`${base}${sharedUrl}`)).status).toBe(200);
    await orgPolicy(false);
    expect((await fetch(`${base}${sharedUrl}`)).status).toBe(404);
    expect((await request(endpoint, 'DELETE', developer)).status).toBe(200);
    await orgPolicy(true);
    expect((await fetch(`${base}${sharedUrl}`)).status).toBe(404);
    const next = (await (await request(endpoint, 'POST', developer)).json() as any).url;
    expect(next).not.toBe(sharedUrl);
    expect(await (await fetch(`${base}${next}`)).text()).toContain('later message');
  });
  it('guides the browser from a blocked policy through creating and revoking a snapshot', async () => {
    await request(endpoint, 'DELETE');
    await orgPolicy(false);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(process.env.KARMAX_TEST_REAL_MATHJAX ? 20000 : 5000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(`${base}/sharing-test`, route => route.fulfill({ contentType: 'text/html', body: '<div id="main"></div>' }));
      await page.goto(`${base}/sharing-test`);
      await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '') });
      await page.evaluate(({ owner, project, task }) => {
        (globalThis as any).eval(`
          Object.assign(S, ${JSON.stringify({ token: owner, projects: [project], organizations: [{ id: project.organizationId, name: 'Personal', slug: 'personal' }] })});
          globalThis.shareTask = ${JSON.stringify(task)};
          globalThis.openShare = () => openConversationShare({ taskId: shareTask.id }, 'merge');
          toast = () => {};
          // Keep navigation in this fixture; settings and sharing use the real gateway.
          go = async href => {
            history.pushState({}, '', href);
            const scope = href.includes('/sharing/settings') ? 'project' : 'organization';
            document.querySelector('#main').innerHTML = '<div id="' + scope + '-conversation-sharing"></div>';
            await hydrateConversationSharing(scope, scope === 'project' ? shareTask.projectId : S.organizations[0].id);
          };
        `);
      }, { owner, project, task });
      const open = () => page.evaluate(() => (globalThis as any).openShare());
      await open();
      expect(await page.getByRole('button', { name: 'Create public link' }).isDisabled()).toBe(true);
      expect(await page.locator('dialog [role=status]').innerText()).toBe('Your organization has disabled public conversation sharing. Enable it in Organization settings.');
      const settingsLink = page.getByRole('link', { name: 'Organization settings', exact: true });
      expect(await settingsLink.getAttribute('href')).toBe('/personal/settings#organization-conversation-sharing');
      await settingsLink.click();
      expect(await page.locator('dialog').count()).toBe(0);
      // The policy saves as soon as it changes; there is no Save button.
      await page.getByRole('combobox', { name: 'Public conversation links' }).selectOption('enabled');
      await expect.poll(async () => (await (await request(endpoint)).json() as any).enabled).toBe(true);

      // A project override is identified separately; developers cannot manage it.
      await request(`/api/projects/${project.id}/conversation-sharing`, 'PUT', owner, { value: 'disabled' });
      await open();
      expect(await page.locator('dialog [role=status]').innerText()).toBe('Your project has disabled public conversation sharing. Enable it in Project settings.');
      expect(await page.getByRole('link', { name: 'Project settings', exact: true }).getAttribute('href')).toBe('/personal/sharing/settings#project-conversation-sharing');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.evaluate(token => (globalThis as any).eval(`S.token = ${JSON.stringify(token)}`), developer);
      await open();
      expect(await page.locator('dialog').innerText()).toContain('Ask a project administrator to enable it.');
      expect(await page.locator('dialog [data-sharing-settings]').count()).toBe(0);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.evaluate(token => (globalThis as any).eval(`S.token = ${JSON.stringify(token)}`), owner);
      await request(`/api/projects/${project.id}/conversation-sharing`, 'PUT', owner, { value: 'inherit' });
      await open();
      await page.getByText('Preview message text', { exact: true }).click();
      expect(await page.locator('dialog details').innerText()).toContain('Answer');
      expect(await page.locator('dialog details').innerText()).not.toContain('hidden system');
      await page.getByRole('button', { name: 'Create public link' }).click();
      await page.locator('[data-link]').waitFor();
      const url = await page.locator('[data-link]').inputValue();
      const anonymous = await browser.newPage();
      await anonymous.goto(url);
      expect(await anonymous.locator('main').innerText()).toContain('Answer');
      await page.getByRole('button', { name: 'Revoke link' }).click();
      await page.getByRole('button', { name: 'Create public link' }).waitFor();
      expect((await fetch(url)).status).toBe(404);
      expect(errors).toEqual([]);
      // Leave a snapshot for the deletion regression below.
      await request(endpoint, 'POST');
    } finally { await browser.close(); }
  });
  it('renders public Markdown safely, with navigation, responsive layout, and a conversation TeX toggle', async () => {
    const body = '# A shared answer\n\n**Bold** and _italic_.\n\n| Method | Result |\n| --- | --- |\n| Test | Passed |\n\n1. First\n2. Second\n\n```js\nconst x = 1;\n```\n\n[Reference](https://example.com)\n\n$x^2$ and $$y = 2x$$ and $\\href{javascript:alert(1)}{unsafe}$\n\n<script>window.injected = true</script>\n[Unsafe](javascript:alert(1))';
    await orgPolicy(true);
    messages.push({ id: 'formatted', role: 'agent', text: body, ts: 5 });
    await request(endpoint, 'DELETE');
    const url = (await (await request(endpoint, 'POST')).json() as any).url;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(process.env.KARMAX_TEST_REAL_MATHJAX ? 20000 : 5000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      // Keep browser integrity enforcement enabled for the deterministic loader fixture.
      if (!process.env.KARMAX_TEST_REAL_MATHJAX) {
        const mathjax = `
        Object.assign(window.MathJax, { typesetClear() {}, typesetPromise: async nodes => {
          for (const node of nodes) node.innerHTML = '<mjx-container><svg aria-label="math"></svg></mjx-container>';
        } });
        window.MathJax.startup.defaultReady = () => {};
        window.MathJax.startup.ready();
        `;
        const integrity = `sha384-${createHash('sha384').update(mathjax).digest('base64')}`;
        await page.route('**/markdown.js', async route => {
          const response = await route.fetch();
          const source = await response.text();
          expect(source).toMatch(/'tex-svg': 'sha384-[A-Za-z0-9+/=]+'/);
          await route.fulfill({ response, body: source.replace(/'tex-svg': 'sha384-[A-Za-z0-9+/=]+'/, `'tex-svg': '${integrity}'`) });
        });
        await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({
          contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: mathjax,
        }));
      }
      await page.goto(`${base}${url}`);
      await page.locator('.md-table').waitFor();
      expect(await page.getByRole('link', { name: 'tavya home' }).getAttribute('href')).toBe('/');
      expect(await page.getByRole('link', { name: 'Join tavya' }).getAttribute('href')).toBe('/signup');
      expect(await page.getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href')).toBe('/login');
      expect(await page.locator('.msg-text strong').last().innerText()).toBe('Bold');
      expect(await page.locator('.md-table tbody td').last().innerText()).toBe('Passed');
      expect(await page.locator('.md-list li').count()).toBe(2);
      expect(await page.locator('.md-code').innerText()).toBe('const x = 1;');
      expect(await page.locator('.msg-text script, .msg-text img').count()).toBe(0);
      expect(await page.evaluate(() => (globalThis as any).injected)).toBeUndefined();
      expect(await page.locator('.msg-text a[href^="javascript:"]').count()).toBe(0);
      await page.locator('mjx-container').first().waitFor();
      expect(await page.locator('mjx-container a[href]').count()).toBe(0);
      const toggle = page.getByRole('button', { name: 'Typeset math' });
      expect(await toggle.getAttribute('aria-pressed')).toBe('true');
      await toggle.click();
      expect(await toggle.getAttribute('aria-pressed')).toBe('false');
      expect(await page.locator('mjx-container').count()).toBe(0);
      expect(await page.locator('[data-share-message]').last().innerText()).toContain('$x^2$');
      expect(await page.evaluate(() => (globalThis as any).localStorage.getItem('karmax-mathjax'))).toBe('0');
      await page.reload();
      await page.locator('.conversation-math[aria-pressed="false"]:not([hidden])').waitFor();
      expect(await page.locator('mjx-container').count()).toBe(0);
      await toggle.click();
      await page.locator('mjx-container').first().waitFor();
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth)).toBe(true);
      }
      expect(errors).toEqual([]);
      const plain = await browser.newPage({ javaScriptEnabled: false });
      await plain.goto(`${base}${url}`);
      expect(await plain.locator('[data-share-message]').last().innerText()).toContain('**Bold**');
      expect(await plain.getByRole('link', { name: 'tavya home' }).count()).toBe(1);
      await plain.close();
      const offline = await browser.newPage();
      await offline.route('https://cdn.jsdelivr.net/**', route => route.abort());
      await offline.goto(`${base}${url}`);
      expect(await offline.locator('.md-table').count()).toBe(1);
      expect(await offline.locator('.md-math').first().innerText()).toBe('$x^2$');
      await offline.getByRole('button', { name: 'Typeset math' }).click();
      expect(await offline.getByRole('button', { name: 'Typeset math' }).getAttribute('aria-pressed')).toBe('false');
      await offline.close();
      const deps = (gateway as any).deps;
      const identity = deps.identity;
      try {
        deps.identity = { session: async (headers: Headers) => headers.get('cookie')?.includes('share-test=member') ? { user: { id: 'member' } } : null };
        await page.context().addCookies([{ name: 'share-test', value: 'member', url: base }]);
        await page.reload();
        expect(await page.getByRole('link', { name: 'Open workspace' }).getAttribute('href')).toBe('/');
        expect(await page.getByRole('link', { name: 'Sign in', exact: true }).count()).toBe(0);
        expect(await page.getByRole('link', { name: 'Join tavya' }).count()).toBe(0);
      } finally { deps.identity = identity; }
      await request(endpoint, 'DELETE');
      expect((await page.reload())?.status()).toBe(404);
      expect(await page.getByRole('heading', { name: 'Conversation unavailable' }).count()).toBe(1);
      expect(await page.getByRole('link', { name: 'tavya home' }).count()).toBe(1);
      expect(await page.locator('[data-share-message]').count()).toBe(0);
      await request(endpoint, 'POST');
    } finally { await browser.close(); }
  });
  it('removes snapshot data when its project is deleted', async () => {
    const share = (await currentShare(store, task.id, 'merge'))!;
    (await store.deleteProject(project.id));
    expect((await publicShare(store, share.id))).toBeUndefined();
    expect((await store.kvGet(`conversation-share:${share.id}`))).toBeUndefined();
  });
  it('binds sharing to its own capability', () => {
    expect(routeCapability('POST', endpoint.split('?')[0]!, new URL(`http://localhost${endpoint}`))).toBe('task:conversation:share');
  });
});
