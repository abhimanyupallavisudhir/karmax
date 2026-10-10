// The public documentation: a few pages (Getting started, How it works, the
// tavya CLI) and the existing public pages (Pricing, Policies) under one left
// sidebar, readable signed out, navigable in place, with linkable sections.
// Run: node web/docs.browser.test.cjs   (DOCS_SCREENSHOTS=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  const shots = process.env.DOCS_SCREENSHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    const policies = [
      { slug: 'terms', title: 'Terms of Service', summary: 'The agreement.', version: '1' },
      { slug: 'privacy', title: 'Privacy Policy', summary: 'What we process.', version: '1' },
    ];
    const launchInfo = { policyVersion: '1', draftNotice: 'Draft.', policies, pricingCatalog: [
      { id: 'free', name: 'Free', monthlyBasePriceCents: 0, currency: 'usd', maxMembers: 1, maxActiveAgentRuns: 1, storageBytes: 1e9 }] };
    const open = async (viewport = { width: 1280, height: 800 }) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport });
      const { requests } = await fakeConsole(context, { project: { id: 'p', organizationId: 'o', name: 'Website', config: {} }, async api(p) {
        if (p === '/api/launch') return launchInfo;
        if (p === '/api/legal/terms') return { ...policies[0], effectiveDate: 'Today', draftNotice: 'Draft.',
          sections: [{ heading: 'Agreement', paragraphs: ['You agree.'] }] };
      } });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
      return { context, page, errors, requests };
    };
    const { context, page, errors, requests } = await open();
    const nav = () => page.locator('.docs-nav a').evaluateAll((links) => links.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
    const current = () => page.locator('.docs-nav a[aria-current="page"]').textContent();

    // Signed out, /docs is the first page, and it never reads a session.
    await page.goto('http://console.test/docs');
    await page.locator('.docs-page h1').waitFor();
    assert.equal(await page.locator('.docs-page h1').textContent(), 'Getting started');
    assert.ok(!requests.includes('GET /api/session'), 'a public page does not read (and so provision) a session');
    assert.deepEqual(await nav(), [
      ['Getting started', '/docs'], ['How it works', '/docs/how-it-works'], ['tavya CLI', '/docs/cli'],
      ['Pricing', '/pricing'],
      ['Policies', '/legal'], ['Terms of Service', '/legal/terms'], ['Privacy Policy', '/legal/privacy'],
    ], 'one sidebar: the docs, then pricing, then every policy');
    assert.equal(await current(), 'Getting started');
    assert.match(await page.title(), /Getting started · Fixture/);
    if (shots) await page.screenshot({ path: path.join(shots, 'docs-getting-started.png'), fullPage: true });

    // In-place navigation: the sidebar moves between pages without a reload.
    await page.evaluate(() => { window.stillHere = true; });
    await page.locator('.docs-nav a', { hasText: 'tavya CLI' }).click();
    await page.waitForFunction(() => location.pathname === '/docs/cli');
    await page.locator('.docs-page h1', { hasText: 'tavya CLI' }).waitFor();
    assert.equal(await page.evaluate(() => window.stillHere), true, 'no full page load');
    assert.equal(await current(), 'tavya CLI');
    const cli = await page.locator('.docs-page').innerText();
    assert.match(cli, /curl -fsSL http:\/\/console\.test\/cli\/install\.sh \| sh/, 'the install command names this server');
    assert.match(cli, /npm install -g @tavya\/cli/);
    for (const command of ['tavya login', 'tavya clone', 'tavya pull', 'tavya push', 'tavya run', 'tavya task new', 'tavya exec', 'tavya token create'])
      assert.ok(cli.includes(command), `the CLI page covers ${command}`);
    if (shots) await page.screenshot({ path: path.join(shots, 'docs-cli.png'), fullPage: true });

    // Pricing and policies live in the same shell.
    await page.locator('.docs-nav a', { hasText: 'Pricing' }).click();
    await page.waitForFunction(() => location.pathname === '/pricing');
    await page.locator('.pricing-grid .price-card').first().waitFor();
    assert.equal(await current(), 'Pricing');
    await page.locator('.docs-nav a', { hasText: 'Terms of Service' }).click();
    await page.locator('.legal-document h1', { hasText: 'Terms of Service' }).waitFor();
    assert.equal(await current(), 'Terms of Service');
    await page.locator('.docs-nav a', { hasText: 'Policies' }).click();
    await page.locator('.legal-grid').waitFor();
    assert.equal(await current(), 'Policies');

    // Back returns to the previous page.
    await page.goBack();
    await page.locator('.legal-document h1', { hasText: 'Terms of Service' }).waitFor();
    assert.equal(await current(), 'Terms of Service');

    // Every section has a stable anchor, so the console can link straight to it.
    await page.goto('http://console.test/docs/how-it-works#worlds');
    await page.locator('.docs-page h1', { hasText: 'How it works' }).waitFor();
    const anchors = await page.locator('.docs-page h2').evaluateAll((hs) => hs.map((h) => h.id));
    for (const id of ['tasks', 'agents', 'worlds', 'resources', 'wiki', 'access', 'authorization'])
      assert.ok(anchors.includes(id), `How it works has #${id} (has ${anchors.join(', ')})`);
    await page.waitForFunction(() => document.getElementById('worlds')?.getBoundingClientRect().top < 200, null, { timeout: 3000 });
    if (shots) await page.screenshot({ path: path.join(shots, 'docs-how-it-works.png'), fullPage: true });

    // Every in-docs link goes somewhere real.
    for (const slug of ['', 'how-it-works', 'cli']) {
      await page.goto(`http://console.test/docs${slug ? `/${slug}` : ''}`);
      await page.locator('.docs-page h1').waitFor();
      const links = await page.locator('.docs-page a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      for (const href of links) {
        const [route, hash] = href.split('#');
        const known = ['/docs', '/docs/how-it-works', '/docs/cli', '/pricing', '/legal', '/signup', '/login'].includes(route) || /^\/legal\/[a-z-]+$/.test(route);
        assert.ok(known, `docs link ${href} goes to a page`);
        if (hash && route.startsWith('/docs')) {
          const md = fs.readFileSync(path.join(__dirname, 'docs', `${route.replace(/^\/docs\/?/, '') || 'getting-started'}.md`), 'utf8');
          const ids = [...md.matchAll(/^##+ (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
          assert.ok(ids.includes(hash), `docs link ${href} names a section`);
        }
      }
    }

    // An unknown docs page falls back to the first one.
    await page.goto('http://console.test/docs/nope');
    await page.locator('.docs-page h1', { hasText: 'Getting started' }).waitFor();
    assert.equal(await page.evaluate(() => location.pathname), '/docs');
    assert.deepEqual(errors, []);
    await context.close();

    // A phone: no sideways scrolling; the sidebar becomes a strip above the page.
    const phone = await open({ width: 390, height: 780 });
    await phone.page.goto('http://console.test/docs/cli');
    await phone.page.locator('.docs-page h1').waitFor();
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal page overflow on a phone (${overflow}px)`);
    if (shots) await phone.page.screenshot({ path: path.join(shots, 'docs-phone.png'), fullPage: false });
    assert.deepEqual(phone.errors, []);
    await phone.context.close();
    console.log('Docs: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
