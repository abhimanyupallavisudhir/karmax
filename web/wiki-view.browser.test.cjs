// Real-browser coverage for browsing wiki branches (task 367's complaints):
// picking a task branch did nothing until Enter was pressed again, the view had
// no URL, and every entry click waited on the whole wiki to be re-read before
// anything appeared. Run: node web/wiki-view.browser.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function fn(name) {
  const match = new RegExp(`\\n(async )?function ${name}\\(`).exec(src);
  if (!match) throw new Error(`Missing function ${name}`);
  let depth = 0;
  for (let i = src.indexOf(') {', match.index) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(match.index + 1, i + 1);
  }
  throw new Error(`Unterminated ${name}`);
}
function decl(name) {
  const line = new RegExp(`\\n((?:const|let) ${name}\\b[^\\n]*)`).exec(src);
  if (!line) throw new Error(`Missing declaration ${name}`);
  return line[1];
}

const FUNCTIONS = ['wikiScopeInfo', 'wikiView', 'wikiViewOptionsHtml', 'loadWikiRefs', 'wikiUrl', 'wikiRead',
  'forgetWikiReads', 'paintWikiRead', 'openWikiEntry', 'wikiEnclosingEntry', 'wikiTreeHtml', 'wireWikiView',
  'wikiBody', 'renderWikiHome', 'renderWikiPage', 'wireWikiLocalLinks', 'wikiRoute', 'wikiViewFromQuery', 'isNewTabClick', 'decodeRoutePart'];
const DECLS = ['wikiReadCache', 'wikiReadsInFlight', 'wikiIsDefault', 'wikiGlyph', 'wikiTaskIds', 'wikiGeneration'];

const index = (label) => ({
  toc: { children: [
    { kind: 'section', name: 'notes', path: 'notes', children: [{ kind: 'skill', name: `${label} notes`, path: 'notes/a' }] },
    { kind: 'section', name: 'reviews', path: 'reviews', children: [{ kind: 'skill', name: 'Code review', path: 'reviews/2026-09-26' }] },
  ] },
  unconditional: [], tocText: `${label} table of contents`, view: { writable: true },
});
const page = (p, body) => ({ page: { path: p, name: p, kind: 'skill', content: body, labels: [] }, view: { writable: true } });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const tab = await browser.newPage();
    tab.on('pageerror', (error) => console.error('page error:', error.message));
    await tab.route('http://wiki.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="main"></div>' }));
    await tab.goto('http://wiki.test/acme/app/wiki');
    await tab.exposeFunction('respond', () => {});
    await tab.evaluate(({ indexes, pages }) => {
      window.$ = (s) => document.querySelector(s);
      window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      window.renderMessageBody = (t) => esc(t);
      window.typesetMath = () => {};
      window.toast = () => {};
      window.renderWikiEditor = () => {};
      window.projectRoute = (pid, t) => `/acme/app/${t}`;
      window.currentOrg = () => null;
      window.resolveProjectTaskKey = async (pid, key) => (key === '367' ? 't367' : null);
      window.S = { projectId: 'p1', tab: 'wiki', wikiView: '', tasks: [] };
      window.PROJ = { id: 'p1', name: 'App' };
      // A controllable server: every request is logged; `hold(prefix)` delays
      // matching answers until released, like a cold cloud sandbox.
      window.calls = [];
      window.held = [];
      window.holdPrefix = null;
      window.api = (url) => new Promise((resolve) => {
        calls.push(url);
        const u = new URL(url, location.origin);
        const answer = () => {
          if (u.pathname.endsWith('/refs')) return resolve({ defaultBranch: 'main', branches: ['main'],
            tasks: [{ id: 't367', num: 367, title: 'Review the codebase', branch: 'karmax/t367' }] });
          const scope = u.searchParams.get('taskId') ? 'task' : 'main';
          const p = u.searchParams.get('path');
          resolve(p ? (pages[`${scope}:${p}`] || {}) : indexes[scope]);
        };
        if (holdPrefix && url.includes(holdPrefix)) held.push(answer); else setTimeout(answer, 5);
      });
      window.release = () => { const all = held.splice(0); all.forEach((f) => f()); };
      window.renderWiki = () => { $('#main').innerHTML = wikiView(PROJ); wireWikiView(PROJ); };
      window.go = (to) => {
        history.pushState({}, '', to);
        S.wikiView = wikiViewFromQuery(new URLSearchParams(location.search));
        renderWiki();
      };
      window.addEventListener('popstate', () => {
        S.wikiView = wikiViewFromQuery(new URLSearchParams(location.search));
        renderWiki();
      });
    }, {
      indexes: { main: index('Main'), task: index('Task') },
      pages: {
        'task:reviews/2026-09-26': page('reviews/2026-09-26', 'Open items tracker'),
        'task:notes/a': page('notes/a', 'Task notes body'),
      },
    });
    await tab.addScriptTag({ content: [...DECLS.map(decl), ...FUNCTIONS.map(fn)].join('\n') });
    await tab.evaluate(() => renderWiki());
    await tab.waitForSelector('#wiki-pane >> text=Main table of contents');
    await tab.waitForSelector('#wiki-view-select option[value="task:367"]', { state: 'attached' });

    // Choosing a task branch acts on the choice itself and gets its own URL.
    await tab.selectOption('#wiki-view-select', 'task:367');
    assert.equal(await tab.evaluate(() => location.pathname + location.search), '/acme/app/wiki?task=367');
    await tab.waitForSelector('#wiki-pane >> text=Task table of contents');
    assert.equal(await tab.inputValue('#wiki-view-select'), 'task:367');

    // An entry responds at once (highlight + loading state) while its read is slow…
    await tab.evaluate(() => { calls.length = 0; holdPrefix = 'path=reviews'; });
    await tab.click('[data-wiki-path="reviews/2026-09-26"]');
    assert.equal(await tab.evaluate(() => location.hash), '#reviews%2F2026-09-26');
    assert.equal(await tab.getAttribute('[data-wiki-path="reviews/2026-09-26"]', 'class'), 'active');
    assert.match(await tab.textContent('#wiki-pane'), /Loading/);
    // …and only the entry is requested: the index and branch list are in hand.
    assert.deepEqual(await tab.evaluate(() => calls), ['/api/projects/p1/wiki?taskId=t367&path=reviews%2F2026-09-26']);

    // Moving on before it answers: the late answer must not replace the newer entry.
    await tab.evaluate(() => { holdPrefix = null; });
    await tab.click('[data-wiki-path="notes/a"]');
    await tab.waitForSelector('#wiki-pane >> text=Task notes body');
    await tab.evaluate(() => release());
    await tab.waitForTimeout(50);
    assert.match(await tab.textContent('#wiki-pane'), /Task notes body/);

    // Back returns to the previous entry, painted from memory with no wait.
    await tab.evaluate(() => { calls.length = 0; });
    await tab.goBack();
    await tab.waitForSelector('#wiki-pane >> text=Open items tracker', { timeout: 1000 });
    assert.equal(await tab.evaluate(() => location.search + location.hash), '?task=367#reviews%2F2026-09-26');

    // A reload of that URL opens the same branch and entry.
    await tab.evaluate(() => {
      forgetWikiReads(); wikiTaskIds.clear(); S.wikiRefs = {};
      S.wikiView = wikiViewFromQuery(new URLSearchParams(location.search));
      renderWiki();
    });
    await tab.waitForSelector('#wiki-pane >> text=Open items tracker');
    assert.equal(await tab.inputValue('#wiki-view-select'), 'task:367');

    // A cited attachment inside an entry opens the entry that holds it.
    await tab.evaluate(() => { history.replaceState({}, '', '/acme/app/wiki?task=367#reviews%2F2026-09-26%2Fdiagram'); renderWiki(); });
    await tab.waitForFunction(() => location.hash === '#reviews%2F2026-09-26');
    await tab.waitForSelector('#wiki-pane >> text=Open items tracker');

    // Back on the default branch, the plain wiki URL again; an entry that
    // branch lacks falls back to the Index, and the URL says so.
    await tab.selectOption('#wiki-view-select', '');
    assert.equal(await tab.evaluate(() => location.pathname + location.search), '/acme/app/wiki');
    await tab.waitForSelector('#wiki-pane >> text=Main table of contents');
    assert.equal(await tab.evaluate(() => location.hash), '');

    // The organization wiki shows edit controls only where the server says the
    // reader may edit: none for a developer; for an organization-wide maintainer,
    // ordinary pages but not the prompt-wide (`default`) ones.
    const orgIndex = (writable) => ({ ...index('Org'), view: { writable },
      unconditional: [{ path: 'rules/everywhere', name: 'Everywhere', body: 'Everywhere body', labels: ['default'], writable: false }] });
    const showOrg = async (writable, entry = '') => {
      await tab.evaluate(({ data, entry, writable }) => {
        forgetWikiReads();
        window.currentOrg = () => ({ id: 'o1', name: 'Acme' });
        window.api = async (url) => (new URL(url, location.origin).searchParams.get('path')
          ? { page: { path: 'notes/a', name: 'Org notes', kind: 'skill', content: 'Org notes body', labels: [] }, view: { writable } }
          : data);
        history.replaceState({}, '', `/acme/wiki${entry ? `#${encodeURIComponent(entry)}` : ''}`);
        $('#main').innerHTML = wikiView(null); wireWikiView(null);
      }, { data: orgIndex(writable), entry, writable });
      await tab.waitForSelector(entry ? '#wiki-pane >> text=Org notes body' : '#wiki-pane >> text=Everywhere body');
    };
    await showOrg(false);
    assert.equal(await tab.locator('#wiki-new, .wiki-uncond-edit').count(), 0);
    await showOrg(false, 'notes/a');
    assert.equal(await tab.locator('#wiki-page-edit, #wiki-page-delete').count(), 0);
    assert.doesNotMatch(await tab.textContent('#wiki-pane'), /Read-only branch view/);
    await showOrg(true);
    assert.equal(await tab.locator('#wiki-new').count(), 1);
    assert.equal(await tab.locator('.wiki-uncond-edit').count(), 0);
    await showOrg(true, 'notes/a');
    assert.equal(await tab.locator('#wiki-page-edit').count(), 1);
    console.log('Wiki view browser checks passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
