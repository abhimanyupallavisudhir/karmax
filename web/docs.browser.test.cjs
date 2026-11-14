// The public documentation: a few pages (Getting started, How it works, the
// tavya CLI) and the existing public pages (Pricing, Policies) under one left
// sidebar, readable signed out, navigable in place, with linkable sections.
// Run: node web/docs.browser.test.cjs   (DOCS_SCREENSHOTS=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');
require('./site.js');
const site = globalThis.KarmaxSite;

(async () => {
  const browser = await launch();
  const shots = process.env.DOCS_SCREENSHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    const policies = [
      { slug: 'terms', title: 'Terms of Service', summary: 'The agreement.', version: '1' },
      { slug: 'privacy', title: 'Privacy Policy', summary: 'What we process.', version: '1' },
    ];
    // The server omits draftNotice once the operator opens paid checkout.
    const open = async (viewport = { width: 1280, height: 800 }, { approved = false } = {}) => {
      const draft = approved ? {} : { draftNotice: 'Draft.' };
      const launchInfo = { policyVersion: '1', ...draft, policies, pricingCatalog: [
        { id: 'free', name: 'Free', monthlyBasePriceCents: 0, currency: 'usd', maxMembers: 1, maxActiveAgentRuns: 1, storageBytes: 1e9 }] };
      const context = await browser.newContext({ serviceWorkers: 'block', viewport });
      const { requests } = await fakeConsole(context, { project: { id: 'p', organizationId: 'o', name: 'Website', config: {} }, async api(p) {
        if (p === '/api/launch') return launchInfo;
        if (p === '/api/legal/terms') return { ...policies[0], effectiveDate: 'Today', ...draft,
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
      ['Getting started', '/docs'], ['How it works', '/docs/how-it-works'], ['Cloud computers', '/docs/computers'], ['Chat bots', '/docs/chat-bots'], ['tavya CLI', '/docs/cli'],
      ['Claude Code in the cloud', '/docs/claude-code-in-the-cloud'], ['Parallel agents', '/docs/parallel-agents'], ['Schedules and events', '/docs/scheduled-tasks'],
      ['Agent review', '/docs/agent-review'], ['Agent payments', '/docs/agent-payments'], ['Files Git ignores', '/docs/ignored-files'], ['Self-hosting', '/docs/self-hosting'],
      ['Compare', '/compare'],
      ['Pricing', '/pricing'],
      ['Policies', '/legal'], ['Terms of Service', '/legal/terms'], ['Privacy Policy', '/legal/privacy'],
      ['About', '/about'], ['Changelog', '/changelog'],
    ], 'one sidebar: the docs and guides, the comparison, pricing, every policy, then About and the changelog');
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
    assert.equal(await page.locator('.legal-draft').count(), 1, 'an unapproved policy is marked as a draft');
    await page.locator('.docs-nav a', { hasText: 'Policies' }).click();
    await page.locator('.legal-grid').waitFor();
    assert.equal(await current(), 'Policies');
    assert.equal(await page.locator('.legal-draft').count(), 1, 'an unapproved policy set is marked as a draft');

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
    // The console's "Get a key" links land on each provider's section.
    await page.goto('http://console.test/docs/computers#aws');
    await page.locator('.docs-page h1', { hasText: 'Cloud computers' }).waitFor();
    const computers = await page.locator('.docs-page h2').evaluateAll((hs) => hs.map((h) => h.id));
    for (const id of ['aws', 'google-cloud']) assert.ok(computers.includes(id), `Cloud computers has #${id}`);
    assert.match(await page.locator('.docs-page').innerText(), /aws:RequestTag\/karmaxHome/, 'the AWS policy is on the page');
    if (shots) await page.screenshot({ path: path.join(shots, 'docs-computers.png'), fullPage: true });

    // Every page of Markdown (docs, guides, comparisons, About, the changelog) renders under its
    // own heading, and each link in it goes to a page, and to a section that page has.
    const byPath = new Map(site.pages.map((entry) => [entry.path, entry]));
    for (const entry of site.pages) {
      await page.goto(`http://console.test${entry.path}`);
      await page.locator('.docs-page h1', { hasText: entry.title }).waitFor();
      assert.match(await page.title(), new RegExp(`^${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · `));
      assert.doesNotMatch(await page.locator('.docs-page').innerText(), /\{\{\w+\}\}/, `${entry.path} has no unfilled placeholder`);
      const links = await page.locator('.docs-page a[href^="/"]').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), 'public' in a.dataset]));
      for (const [href, inPlace] of links) {
        const [route, hash] = href.split('#');
        const known = byPath.has(route) || ['/pricing', '/legal', '/signup', '/login'].includes(route) || /^\/legal\/[a-z-]+$/.test(route);
        assert.ok(known, `${entry.path}: link ${href} goes to a page`);
        if (!['/signup', '/login'].includes(route)) assert.ok(inPlace, `${entry.path}: link ${href} opens in place`);
        if (hash && byPath.has(route)) {
          const md = fs.readFileSync(path.join(__dirname, byPath.get(route).file), 'utf8');
          const ids = [...md.matchAll(/^##+ (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
          assert.ok(ids.includes(hash), `${entry.path}: link ${href} names a section`);
        }
      }
    }

    // The comparison draws the landing's table, with the rows only it has, and its sidebar lists each product's page.
    await page.goto('http://console.test/compare');
    await page.locator('.docs-page table').waitFor();
    assert.deepEqual(await page.locator('.docs-page table thead th').allInnerTexts(), ['', 'tavya', 'Claude Code', 'Codex', 'Devin', 'Cursor', 'Paperclip']);
    assert.ok((await page.locator('.docs-page table tbody tr').count()) > site.compare.rows.length, 'the full comparison has more rows than the landing');
    assert.deepEqual((await nav()).filter(([, href]) => href.startsWith('/compare/')).map(([, href]) => href),
      site.pages.filter((entry) => entry.path.startsWith('/compare/')).map((entry) => entry.path), 'inside the comparison, the sidebar lists each one');
    assert.equal(await current(), 'Compare');
    await page.evaluate(() => { window.stillHere = true; });
    await page.locator('.docs-page table thead a', { hasText: 'Devin' }).click();
    await page.locator('.docs-page h1', { hasText: 'tavya vs Devin' }).waitFor();
    assert.equal(await page.evaluate(() => [location.pathname, window.stillHere].join()), '/compare/devin,true', 'a comparison opens in place');
    // An unknown comparison falls back to the comparison.
    await page.goto('http://console.test/compare/nope');
    await page.locator('.docs-page h1', { hasText: 'tavya compared' }).waitFor();
    assert.equal(await page.evaluate(() => location.pathname), '/compare');

    // An unknown docs page falls back to the first one.
    await page.goto('http://console.test/docs/nope');
    await page.locator('.docs-page h1', { hasText: 'Getting started' }).waitFor();
    assert.equal(await page.evaluate(() => location.pathname), '/docs');
    assert.deepEqual(errors, []);
    await context.close();

    // Once the operator approves the current version, no page calls the policies a draft.
    const approved = await open(undefined, { approved: true });
    for (const route of ['/legal', '/legal/terms']) {
      await approved.page.goto(`http://console.test${route}`);
      await approved.page.locator('.legal-grid, .legal-document h1').first().waitFor();
      assert.equal(await approved.page.locator('.legal-draft').count(), 0, `${route} has no draft notice once approved`);
      assert.doesNotMatch(await approved.page.locator('main').innerText(), /Launch draft|undefined/);
    }
    assert.deepEqual(approved.errors, []);
    await approved.context.close();

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
