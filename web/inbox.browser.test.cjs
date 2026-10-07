// Render the real inbox and task row with fixture data; verify shared styling,
// read interactions, resource-only asks, and narrow layouts in Chromium.
// Run: node web/inbox.browser.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function fn(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  let parens = 0, open = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') parens--;
    else if (src[i] === '{' && parens === 0) { open = i; break; }
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Missing function: ${name}`);
}
function constant(name) {
  const start = src.indexOf(`const ${name} = `);
  return src.slice(start, src.indexOf('\n];', start) + 3);
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, locale: 'en-US', timezoneId: 'UTC' });
    await page.route('http://inbox.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(path.join(__dirname, pathname)), contentType: 'font/woff2' });
      return route.fulfill({ body: '<!doctype html><html data-theme="light"><body><main class="main"><div id="main" class="main-inner"></div></main></body></html>', contentType: 'text/html' });
    });
    await page.goto('http://inbox.test/');
    await page.clock.setFixedTime(new Date('2026-09-18T14:00:00Z'));
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.evaluate(() => {
      window.$ = s => document.querySelector(s);
      window.S = { tab: 'inbox', search: 'for:me', organizationId: 'org_fixture',
        organizations: [{ id: 'org_fixture', name: 'Fixture', slug: 'fixture' }],
        projects: [{ id: 'karmax', organizationId: 'org_fixture', name: 'Karmax' }, { id: 'site', organizationId: 'org_fixture', name: 'Website' }], inbox: [
        { id: 'critical', organizationId: 'org_fixture', kind: 'escalated', urgency: 'critical', unread: true, actionable: true, createdAt: Date.now() - 60000, taskId: 'reference', task: { projectId: 'karmax', num: 284, title: 'Restore the deployment after a failed health check', status: 'blocked' } },
        { id: 'resource', organizationId: 'org_fixture', kind: 'approval-requested', urgency: 'normal', unread: true, actionable: true, createdAt: Date.now() - 3600000, resource: { name: 'Design assistant with a long name that should truncate politely on a phone', projectId: 'karmax' }, subject: { kind: 'avatar-authorization', projectId: 'karmax' } },
        { id: 'login', organizationId: 'org_fixture', kind: 'approval-requested', urgency: 'high', unread: false, actionable: true, createdAt: Date.now() - 7200000, subject: { kind: 'credential', provider: 'claude', account: 'ops', reason: 'signed-out' } },
      ] };
      window.FOR_ME_VIEW = '__for_me__';
      window.viewIdForQuery = q => (q === 'for:me' ? FOR_ME_VIEW : null);
      window.esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      window.organizationById = id => S.organizations.find(o => o.id === id);
      window.projectById = id => S.projects.find(p => p.id === id);
      window.formatBytes = n => `${n} B`;
      window.opened = [];
      window.openInboxItem = item => opened.push(item.id);
      window.workflowLabel = () => 'Software development';
      window.customBranch = () => false;
      window.stageLabel = () => 'Review';
      window.priorityFlag = () => '';
      window.pipeline = () => '';
      window.attentionChip = () => '<span class="chip attention escalated">Input</span>';
      window.renderMain = () => {
        $('#main').innerHTML = `<div class="task-list">${inboxNoticesHtml()}${taskRow({ id: 'reference', projectId: 'karmax', num: 284, title: 'Restore the deployment after a failed health check', lastView: { status: 'waiting', stage: 'review' } }, { showTags: false, project: true })}</div>`;
        wireInboxNotices();
      };
    });
    await page.addScriptTag({ content: [
      constant('URGENCY_LEVELS'), 'const systemNotifications = new Map();',
      ...['updateBell', 'syncNotificationAlerts', 'urgencyRank', 'inboxUnreadCount', 'taskHasUnreadAsk', 'inboxRowLabel', 'inboxTitle', 'urgencyChip',
        'inboxNotices', 'inboxNoticesHtml', 'wireInboxNotices', 'slugify', 'projectSlug', 'projectPath', 'orgSlug', 'projectLabel',
        'rowKey', 'cursorRows', 'applyCursor', 'moveCursor', 'openListRow', 'taskRow'].map(fn),
      'renderMain();',
    ].join('\n') });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.inbox-row').count(), 2, 'asks that are not tasks are rows');
    // Notices are task rows: compare the actual renderers, not a second CSS fixture.
    const pick = selector => page.locator(selector).evaluate(el => {
      const style = getComputedStyle(el);
      return Object.fromEntries(['padding', 'gap', 'borderRadius', 'borderWidth', 'borderColor', 'borderStyle', 'backgroundColor', 'fontSize'].map(k => [k, style[k]]));
    });
    const notification = '[data-inbox="login"]';
    const reference = '.task-row[data-id="reference"]';
    assert.deepEqual(await pick(notification), await pick(reference));
    assert.deepEqual(await pick(`${notification} .task-title`).then(({ fontSize }) => fontSize), await pick(`${reference} .task-title`).then(({ fontSize }) => fontSize));
    // A new ask has an accent edge; a project is a plain monospace slug, never a chip.
    const shadow = selector => page.locator(selector).evaluate(el => getComputedStyle(el).boxShadow);
    assert.notEqual(await shadow(reference), 'none', 'the unread task row has an accent edge');
    assert.equal(await shadow(notification), 'none', 'a read notice does not');
    const label = await page.locator(`${reference} .task-project`).evaluate(el => {
      const s = getComputedStyle(el);
      return { text: el.textContent, font: s.fontFamily, border: s.borderTopWidth, background: s.backgroundColor, radius: s.borderRadius };
    });
    assert.equal(label.text, 'fixture/karmax');
    assert.match(label.font, /mono/i);
    assert.deepEqual([label.border, label.background, label.radius], ['0px', 'rgba(0, 0, 0, 0)', '0px']);
    await page.locator('[data-inbox="resource"] .task-title').click();
    assert.deepEqual(await page.evaluate(() => opened), ['resource']);
    await page.locator('[data-inbox="login"]').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => opened), ['resource', 'login'], 'Enter opens a focused notice');
    await page.evaluate(() => document.activeElement.blur());
    // Hover and keyboard-focus outlines match a real task row in every theme.
    const outline = async selector => page.locator(selector).evaluate(el => {
      const s = getComputedStyle(el);
      return [s.borderColor, s.borderWidth, s.borderRadius, s.outline];
    });
    for (const theme of ['light', 'dark', 'system-dark']) {
      await page.emulateMedia({ colorScheme: theme === 'light' ? 'light' : 'dark' });
      await page.evaluate(theme => {
        if (theme === 'system-dark') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = theme;
      }, theme);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
      assert.deepEqual(await outline(notification), await outline(reference), theme + ': resting outlines match');
      await page.locator(notification).hover();
      await page.waitForTimeout(150);
      const notificationHover = await outline(notification);
      await page.locator(reference).hover();
      await page.waitForTimeout(150);
      assert.deepEqual(notificationHover, await outline(reference), theme + ': hover outlines match');
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      // The list's focus handler (wireTasksView) moves the cursor to any focused row.
      await page.locator(notification).focus();
      await page.locator(notification).evaluate(el => el.classList.add('cursor'));
      await page.waitForTimeout(150);
      const notificationFocus = await outline(notification);
      await page.locator(notification).evaluate(el => el.classList.remove('cursor'));
      await page.locator(reference).focus();
      await page.locator(reference).evaluate(el => el.classList.add('cursor'));
      await page.waitForTimeout(150);
      assert.deepEqual(notificationFocus, await outline(reference), theme + ': keyboard focus outlines match');
      await page.evaluate(() => { document.activeElement.blur(); S.cursorId = undefined; applyCursor(); });
    }
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.waitForTimeout(150);
    const dir = process.env.INBOX_SCREENSHOT_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'notices-desktop.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
    if (dir) await page.screenshot({ path: path.join(dir, 'notices-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 700 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no overflow on small phones');
    // The real loader: one badge over every organization, whichever page is open.
    await page.addScriptTag({ content: ['loadInbox', 'inboxArrivals', 'scheduleHomeRefresh'].map(fn).join('\n') + '\nlet homeRefreshTimer = null; const HOME_REFRESH_MS = 10;' });
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('afterbegin', '<a id="bell"><span id="bell-badge"></span></a>');
      S.organizations = [{ id: 'personal' }, { id: 'team' }];
      window.announceInbox = () => {};
      window.isCrossProjectList = () => true;
      window.runSearch = async () => {};
      window.bgRenderMain = () => {};
      window.api = async url => {
        const organizationId = new URL(url, location.origin).searchParams.get('organizationId');
        return [{ id: organizationId, organizationId, kind: 'escalated', actionable: true, urgency: 'high', unread: true, createdAt: Date.now(), taskId: organizationId }];
      };
    });
    for (const org of ['personal', 'team', null]) {
      await page.evaluate(async org => { S.organizationId = org; await loadInbox(); }, org);
      assert.equal(await page.locator('#bell-badge').textContent(), '2');
    }
    console.log('Inbox browser checks passed (notices as task rows, slugs, unread edge, themes, mobile, badge).');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
