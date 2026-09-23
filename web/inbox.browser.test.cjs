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
      window.S = { organizationId: 'org_fixture', projects: [{ id: 'karmax', name: 'Karmax' }, { id: 'site', name: 'Website' }], inboxFilter: 'all', inbox: [
        { id: 'critical', kind: 'escalated', urgency: 'critical', unread: true, actionable: true, createdAt: Date.now() - 60000, task: { projectId: 'karmax', num: 284, title: 'Restore the deployment after a failed health check', status: 'blocked' } },
        { id: 'review', kind: 'review-requested', urgency: 'high', unread: true, actionable: true, createdAt: Date.now() - 10 * 60000, task: { projectId: 'karmax', num: 283, title: 'Match notification rows to the task list', status: 'waiting' } },
        { id: 'resource', kind: 'approval-requested', urgency: 'normal', unread: true, actionable: true, createdAt: Date.now() - 3600000, resource: { name: 'Design assistant', projectId: 'karmax' }, subject: { kind: 'avatar-authorization' } },
        { id: 'read', kind: 'assigned', urgency: 'low', unread: false, actionable: true, createdAt: new Date(new Date().setDate(new Date().getDate() - 1)).getTime(), task: { projectId: 'site', num: 281, title: 'Polish the project settings page', status: 'active' } },
      ] };
      window.esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      window.renderFlag = (key, fallback) => localStorage.getItem(key) === null ? fallback : localStorage.getItem(key) === '1';
      window.inboxRoute = filter => '/inbox/' + filter;
      window.profileRoute = () => '/profile';
      window.requests = []; window.opened = [];
      window.api = async (url, options) => { requests.push({ url, ...options }); return {}; };
      window.openInboxItem = item => opened.push(item.id);
      window.renderRail = () => {};
      window.toast = message => { throw new Error(message); };
      window.workflowLabel = () => 'Software development';
      window.customBranch = () => false;
      window.stageLabel = () => 'Review';
      window.priorityFlag = () => '';
      window.pipeline = () => '';
      window.renderMain = () => { $('#main').innerHTML = inboxView(); wireInboxView(); };
    });
    await page.addScriptTag({ content: [
      constant('INBOX_TABS'), constant('URGENCY_LEVELS'),
      ...['updateBell', 'urgencyRank', 'inboxShowRead', 'inboxItemMatchesFilter', 'inboxUnreadCount', 'inboxItems', 'inboxTabs', 'inboxRowLabel', 'urgencyChip', 'inboxTimeLabel', 'inboxProjectLabel', 'inboxView', 'wireInboxView', 'rowKey', 'cursorRows', 'applyCursor', 'moveCursor', 'openListRow', 'taskRow'].map(fn),
      'renderMain();',
    ].join('\n') });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.inbox-row').count(), 3);
    // Compare actual task and notification renderers, not a second CSS fixture.
    const styles = await page.evaluate(() => {
      const reference = document.createElement('div');
      reference.innerHTML = taskRow({ id: 'reference', num: 283, title: 'Match notification rows to the task list', lastView: { status: 'waiting', stage: 'review' } }, { showTags: false });
      $('#main').append(reference);
      const pick = el => {
        const style = getComputedStyle(el);
        return Object.fromEntries(['padding', 'gap', 'borderRadius', 'borderWidth', 'borderColor', 'borderStyle', 'boxShadow', 'backgroundColor', 'fontSize', 'fontWeight'].map(k => [k, style[k]]));
      };
      const actual = [pick($('.inbox-row')), pick($('.inbox-row .task-title'))];
      const expected = [pick(reference.firstElementChild), pick(reference.querySelector('.task-title'))];
      reference.remove();
      return { actual, expected };
    });
    assert.deepEqual(styles.actual, styles.expected);
    await page.locator('[data-inbox-toggle="review"]').click();
    assert.equal(await page.locator('[data-inbox="review"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => opened), []);
    assert.equal(await page.evaluate(() => JSON.parse(requests[0].body).unread), false);
    await page.locator('#inbox-show-read').check();
    assert.equal(await page.locator('[data-inbox-toggle="review"]').getAttribute('aria-label'), 'Mark as unread');
    await page.locator('[data-inbox-toggle="review"]').click();
    assert.equal(await page.locator('[data-inbox-toggle="review"]').getAttribute('aria-label'), 'Mark as read');
    await page.locator('[data-inbox="resource"] .task-title').click();
    assert.deepEqual(await page.evaluate(() => opened), ['resource']);
    await page.evaluate(() => { S.cursorId = undefined; moveCursor(1); moveCursor(1); openListRow(document.activeElement); });
    assert.equal(await page.evaluate(() => opened.at(-1)), 'review');
    await page.evaluate(() => { document.activeElement.blur(); S.cursorId = undefined; applyCursor(); });
    assert.equal(await page.locator('[data-inbox="critical"] time').textContent(), '1 minute ago');
    assert.ok(await page.locator('[data-inbox="critical"] time').getAttribute('title'));
    assert.equal(await page.locator('[data-inbox="critical"] .inbox-project').textContent(), 'Karmax');
    assert.ok(await page.evaluate(() => {
      const right = document.querySelector('.inbox-row .task-right');
      return right.children[0].classList.contains('urgency-chip') && right.children[1].tagName === 'TIME' && right.children[2].tagName === 'BUTTON';
    }));
    // Compare hover and keyboard-focus outlines against a real project task row.
    await page.evaluate(() => {
      const reference = document.createElement('section');
      reference.id = 'task-reference';
      reference.innerHTML = '<h1 class="page-title">Project task row</h1>' + taskRow({ id: 'reference', num: 283, title: 'Match notification rows to the task list', lastView: { status: 'waiting', stage: 'review' } }, { showTags: false });
      $('#main').append(reference);
    });
    assert.equal(await page.locator('#task-reference .wf').count(), 0);
    const outline = async selector => page.locator(selector).evaluate(el => {
      const s = getComputedStyle(el);
      return [s.borderColor, s.borderWidth, s.borderRadius, s.boxShadow, s.outline];
    });
    const notification = '[data-inbox="critical"]';
    const reference = '#task-reference .task-row';
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
      await page.evaluate(() => {
        document.querySelector('[data-inbox="critical"]').classList.add('cursor');
        document.querySelector('#task-reference .task-row').classList.add('cursor');
      });
      await page.waitForTimeout(150);
      assert.deepEqual(await outline(notification), await outline(reference), theme + ': cursor outlines match');
      await page.evaluate(() => {
        document.querySelector('[data-inbox="critical"]').classList.remove('cursor');
        document.querySelector('#task-reference .task-row').classList.remove('cursor');
      });
      // Keyboard modality makes :focus-visible apply, unlike a mouse click.
      await page.keyboard.press('Tab');
      await page.locator(notification).focus();
      await page.waitForTimeout(150);
      const notificationFocus = await outline(notification);
      await page.locator(reference).focus();
      await page.locator(reference).evaluate(el => el.classList.add('cursor'));
      await page.waitForTimeout(150);
      assert.deepEqual(notificationFocus, await outline(reference), theme + ': keyboard focus outlines match');
      await page.evaluate(() => {
        document.activeElement.blur();
        S.cursorId = undefined;
        applyCursor();
      });
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.waitForTimeout(150);
    const dir = process.env.INBOX_SCREENSHOT_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'notifications-comparison.png'), fullPage: true });
      await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
      await page.waitForTimeout(150); // Let the shared border-color transition settle before capture.
      await page.screenshot({ path: path.join(dir, 'notifications-comparison-dark.png'), fullPage: true });
      await page.evaluate(() => document.documentElement.dataset.theme = 'light');
      await page.waitForTimeout(150);
    }
    await page.locator('#task-reference').evaluate(el => el.remove());
    if (dir) {
      await page.screenshot({ path: path.join(dir, 'notifications-desktop.png'), fullPage: true });
      await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
      await page.waitForTimeout(150); // Let the shared border-color transition settle before capture.
      await page.screenshot({ path: path.join(dir, 'notifications-dark.png'), fullPage: true });
      await page.evaluate(() => document.documentElement.dataset.theme = 'light');
      await page.waitForTimeout(150);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.inbox-row')].every(row => {
      const title = row.querySelector('.task-title').getBoundingClientRect();
      const button = row.querySelector('button').getBoundingClientRect();
      return (title.right <= button.left || title.bottom <= button.top) && button.right <= innerWidth;
    })), 'long titles leave room for Read on mobile');
    if (dir) await page.screenshot({ path: path.join(dir, 'notifications-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 700 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no overflow on small phones');
    // Exercise the real loader, badge and read handlers across organization routes.
    await page.addScriptTag({ content: ['loadInbox', 'inboxArrivals', 'markVisibleInboxRead'].map(fn).join('\n') });
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('afterbegin', '<a id="bell"><span id="bell-badge"></span></a>');
      S.organizations = [{ id: 'personal' }, { id: 'team' }];
      S.tab = 'inbox';
      S.inboxFilter = 'all';
      window.announceInbox = () => {};
      window.bgRenderMain = renderMain;
      window.requests = [];
      window.api = async (url, options) => {
        requests.push({ url, ...options });
        const organizationId = new URL(url, location.origin).searchParams.get('organizationId');
        if (options) return { unread: false };
        return [{ id: organizationId, organizationId, kind: 'escalated', actionable: true,
          urgency: 'high', unread: true, createdAt: Date.now(), task: { title: organizationId } }];
      };
    });
    for (const org of ['personal', 'team', null]) {
      await page.evaluate(async org => {
        S.organizationId = org;
        history.pushState({}, '', org ? `/${org}/inbox` : '/profile');
        await loadInbox();
      }, org);
      assert.equal(await page.locator('#bell-badge').textContent(), '2');
      assert.equal(await page.locator('.inbox-row').count(), 2);
    }
    await page.locator('[data-inbox-toggle="team"]').click();
    assert.equal(await page.locator('#bell-badge').textContent(), '1');
    assert.equal(await page.evaluate(() => requests.at(-1).url), '/api/inbox/team?organizationId=team');
    await page.locator('#inbox-read-all').click();
    assert.equal(await page.locator('#bell-badge').textContent(), '0');
    assert.equal(await page.locator('#bell-badge').isHidden(), true);
    assert.equal(await page.evaluate(() => requests.at(-1).url), '/api/inbox/personal?organizationId=personal');
    console.log('Inbox browser checks passed (desktop, dark, mobile, read/unread, navigation).');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
