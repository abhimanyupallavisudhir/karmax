// In-app alerts and system notifications mirror the inbox: each one leaves the
// moment its ask is read or resolved, however that happens, in Chromium.
// Run: node web/notification-alerts.browser.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function fn(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`Missing function: ${name}`);
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
function statement(prefix) {
  const start = src.indexOf(prefix);
  if (start < 0) throw new Error(`Missing: ${prefix}`);
  return src.slice(start, src.indexOf(';\n', start) + 1);
}
const code = [
  statement('const URGENCY_LEVELS = '), statement('const NOTIFY_DEFAULTS = '), statement('const systemNotifications = '), statement('const liveInboxItem = '),
  ...['urgencyRank', 'inboxUnreadCount', 'inboxRowLabel', 'notifyPrefs', 'inboxArrivals',
    'announceInbox', 'inboxTitle', 'showVisualNotification', 'showSystemNotification', 'syncNotificationAlerts', 'updateBell',
    'markInboxItemReadLocally', 'loadInbox'].map(fn),
].join('\n');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('http://alerts.test/**', (route) => route.fulfill({
      body: '<!doctype html><html><body><span id="bell"><span id="bell-badge"></span></span></body></html>', contentType: 'text/html' }));
    await page.goto('http://alerts.test/');
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.evaluate((code) => {
      window.$ = (s) => document.querySelector(s);
      window.esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      window.S = { organizations: [{ id: 'org' }], inbox: [], tab: 'tasks' };
      window.bgRenderMain = () => {};
      window.playNotificationSound = () => {};
      // A system notification stand-in that records whether the page closed it.
      window.popups = [];
      window.Notification = class { constructor(title, options) { Object.assign(this, { title, ...options, closed: false }); popups.push(this); }
        close() { this.closed = true; this.onclose?.(); } };
      Notification.permission = 'granted';
      window.server = [];
      window.api = async (url) => url.startsWith('/api/inbox?') ? structuredClone(server) : {};
      // The real opener marks the item read locally before navigating.
      window.opened = [];
      window.openInboxItem = (item) => { opened.push(item); markInboxItemReadLocally(item); };
      (0, eval)(code);
    }, code);

    const ask = (id, urgency = 'critical') => ({ id, kind: 'escalated', urgency, unread: true, organizationId: 'org', task: { title: `Task ${id}` } });
    const alerts = () => page.evaluate(() => [...document.querySelectorAll('#notification-alerts .notification-alert')].map((node) => node.dataset.id));
    const openPopups = () => page.evaluate(() => popups.filter((popup) => !popup.closed).map((popup) => popup.tag));
    const serve = (items) => page.evaluate((items) => { server = items; }, items);

    await page.evaluate(() => loadInbox()); // first load stays quiet
    await serve([ask('phone'), ask('deploy'), ask('review'), ask('other')]);
    await page.evaluate(() => loadInbox());
    assert.deepEqual((await alerts()).sort(), ['deploy', 'other', 'phone', 'review']);
    assert.deepEqual((await openPopups()).sort(), ['deploy', 'other', 'phone', 'review']);

    // Resolved elsewhere: the ask leaves the inbox on the next refresh, and its alerts go with it.
    await serve([ask('deploy'), ask('review'), ask('other')]);
    await page.evaluate(() => loadInbox());
    assert.deepEqual((await alerts()).sort(), ['deploy', 'other', 'review'], 'a resolved ask drops its in-app alert');
    assert.deepEqual((await openPopups()).sort(), ['deploy', 'other', 'review'], 'a resolved ask closes its system notification');

    // Read from the inbox itself (row click, check button, mark all read) in this tab.
    await page.evaluate(() => markInboxItemReadLocally(S.inbox.find((item) => item.id === 'deploy')));
    assert.deepEqual((await alerts()).sort(), ['other', 'review'], 'reading in the inbox drops the in-app alert');
    assert.deepEqual((await openPopups()).sort(), ['other', 'review'], 'reading in the inbox closes the system notification');

    // Read on another device: the refreshed inbox reports it read.
    await serve([{ ...ask('deploy'), unread: false }, { ...ask('review'), unread: false }, ask('other')]);
    await page.evaluate(() => loadInbox());
    assert.deepEqual(await alerts(), ['other']);
    assert.deepEqual(await openPopups(), ['other']);
    assert.equal(await page.evaluate(() => $('#bell-badge').textContent), '1');

    // Opening the alert acts on the current inbox row, so the badge drops at once.
    await page.click('.notification-alert .notification-open');
    assert.deepEqual(await alerts(), []);
    assert.deepEqual(await openPopups(), [], 'opening an in-app alert also closes its system notification');
    assert.equal(await page.evaluate(() => $('#bell-badge').textContent), '0', 'the opened ask is the live inbox row');
    assert.equal(await page.evaluate(() => opened[0] === S.inbox.find((item) => item.id === 'other')), true);

    // Dismissing only hides the alert; the ask stays unread in the inbox.
    await serve([ask('fresh')]);
    await page.evaluate(() => loadInbox());
    await page.click('.notification-alert [aria-label="Dismiss notification"]');
    assert.deepEqual(await alerts(), []);
    assert.equal(await page.evaluate(() => S.inbox.find((item) => item.id === 'fresh').unread), true);

    // A user-closed system notification is forgotten, and a restated ask's popup replaces its own.
    await serve([ask('fresh', 'high'), ask('restated', 'high')]);
    await page.evaluate(() => loadInbox());
    await serve([ask('fresh', 'high'), ask('restated')]);
    await page.evaluate(() => loadInbox());
    await page.evaluate(() => popups.filter((popup) => popup.tag === 'restated')[0].close());
    assert.deepEqual((await openPopups()).sort(), ['fresh', 'restated'], 'closing a replaced popup leaves its replacement tracked');
    await serve([]);
    await page.evaluate(() => loadInbox());
    assert.deepEqual(await openPopups(), []);
    assert.deepEqual(await alerts(), []);
    console.log('Notification alert checks passed (resolve, read here, read elsewhere, open, dismiss, restate).');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
