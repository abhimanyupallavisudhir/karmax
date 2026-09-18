// Render the real inbox and task row with fixture data; verify shared styling,
// read interactions, resource-only asks, and narrow layouts in Chromium.
// Run: node web/inbox.browser.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function fn(name) {
  const start = src.indexOf(`function ${name}(`);
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
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.evaluate(() => {
      window.$ = s => document.querySelector(s);
      window.S = { organizationId: 'org_fixture', inboxFilter: 'all', inbox: [
        { id: 'critical', kind: 'escalated', urgency: 'critical', unread: true, actionable: true, createdAt: 1789734600000, task: { num: 284, title: 'Restore the deployment after a failed health check', status: 'blocked' } },
        { id: 'review', kind: 'review-requested', urgency: 'high', unread: true, actionable: true, createdAt: 1789731000000, task: { num: 283, title: 'Match notification rows to the task list', status: 'waiting' } },
        { id: 'resource', kind: 'approval-requested', urgency: 'normal', unread: true, actionable: true, createdAt: 1789727400000, resource: { name: 'Design assistant' }, subject: { kind: 'avatar-authorization' } },
        { id: 'read', kind: 'assigned', urgency: 'low', unread: false, actionable: true, createdAt: 1789723800000, task: { num: 281, title: 'Polish the project settings page', status: 'active' } },
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
      ...['urgencyRank', 'inboxShowRead', 'inboxItemMatchesFilter', 'inboxUnreadCount', 'inboxItems', 'inboxTabs', 'inboxRowLabel', 'urgencyChip', 'inboxView', 'wireInboxView', 'rowKey', 'cursorRows', 'applyCursor', 'moveCursor', 'openListRow', 'taskRow'].map(fn),
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
        return Object.fromEntries(['padding', 'gap', 'borderRadius', 'borderWidth', 'backgroundColor', 'fontSize', 'fontWeight'].map(k => [k, style[k]]));
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
    assert.equal(await page.locator('[data-inbox-toggle="review"]').textContent(), 'Unread');
    await page.locator('[data-inbox-toggle="review"]').click();
    assert.equal(await page.locator('[data-inbox-toggle="review"]').textContent(), 'Read');
    await page.locator('[data-inbox="resource"] .task-title').click();
    assert.deepEqual(await page.evaluate(() => opened), ['resource']);
    await page.evaluate(() => { S.cursorId = undefined; moveCursor(1); moveCursor(1); openListRow(document.activeElement); });
    assert.equal(await page.evaluate(() => opened.at(-1)), 'review');
    await page.evaluate(() => { document.activeElement.blur(); S.cursorId = undefined; applyCursor(); });
    const dir = process.env.INBOX_SCREENSHOT_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'notifications-desktop.png'), fullPage: true });
      await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
      await page.screenshot({ path: path.join(dir, 'notifications-dark.png'), fullPage: true });
      await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.inbox-row')].every(row => {
      const title = row.querySelector('.task-title').getBoundingClientRect();
      const button = row.querySelector('button').getBoundingClientRect();
      return title.right <= button.left && button.right <= innerWidth;
    })), 'long titles leave room for Read on mobile');
    if (dir) await page.screenshot({ path: path.join(dir, 'notifications-mobile.png'), fullPage: true });
    console.log('Inbox browser checks passed (desktop, dark, mobile, read/unread, navigation).');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
