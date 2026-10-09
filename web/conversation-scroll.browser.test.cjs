// Real layout regression: npx playwright install chromium
// Run: node web/conversation-scroll.browser.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function fn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(') {', start)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="main"></div><div id="overlay-root"></div><div id="modal-root"></div>');
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.addStyleTag({ content: '#main { height: 600px; } .entry { min-height:100px; } pre { height:300px; }' });
    await page.evaluate(() => {
      window.$ = (s) => document.querySelector(s);
      window.S = { view: { taskId: 'a', title: 'Conversation', actions: [] }, taskTab: 'checkin' };
      window.TASK_TABS = [];
      for (const name of ['taskRecord', 'parentTaskContext', 'taskBreadcrumb', 'stageIndicator', 'workflowLabel', 'customBranch', 'mergeQueueBadge', 'pullRequestLinks', 'taskAttempts', 'taskActions', 'captureFocus', 'captureFollowupFocus', 'captureThreadSelection', 'restoreThreadSelection', 'restoreFocus', 'restoreFollowupFocus', 'closeTask', 'wireAttempts', 'wireStageTransitions', 'wireWorkflowMode', 'wireTiming', 'wireNotes', 'wireResourceInventory', 'wireActions', 'wireTaskOrg', 'wireResourceReview', 'wireReviewActions', 'wireTaskApprovalRequests', 'wireCheckinSidebar', 'wireFollowups', 'wireTerminal', 'wireExplainMessages', 'wireCopyButtons', 'wireMessageCopies', 'typesetMath', 'shouldFocusTaskBody']) window[name] = () => '';
      window.esc = (s) => String(s ?? '');
      window.taskUrl = () => '/task/a';
      window.role = 'do'; window.count = 30; window.extra = 0;
      window.taskTabBody = () => `<div class="ck-layout"><div class="ck-side">Agents</div><div class="ck-pane"><div class="ck-thread" id="ck-thread" data-task-id="${S.view.taskId}" data-role="${role}"><div class="thread">${Array.from({ length: count }, (_, i) => `<div class="entry" data-conversation-key="${i}">${i === 0 ? 'Extra<br>'.repeat(extra) : ''}Message ${i}<details><summary>Details</summary><pre>Output</pre></details></div>`).join('')}</div></div></div></div>`;
    });
    await page.addScriptTag({ content: ['visibleTaskTabs', 'captureConversationScroll', 'restoreConversationScroll', 'retainedTaskNodes', 'patchChildren', 'patchConversationRows', 'patchTaskPage', 'renderTaskPage'].map(fn).join('\n') });
    const result = await page.evaluate(() => {
      renderTaskPage();
      const thread = document.getElementById('ck-thread');
      thread.querySelectorAll('details')[2].open = true;
      thread.scrollTop = 1200;
      const anchor = [...thread.querySelectorAll('.entry')].find((e) => e.getBoundingClientRect().bottom > thread.getBoundingClientRect().top);
      const offset = anchor.getBoundingClientRect().top;
      renderTaskPage();
      const current = document.getElementById('ck-thread');
      return { sameThread: current === thread, open: current.querySelectorAll('details')[2].open, sameAnchor: anchor.isConnected, delta: current.querySelector(`[data-conversation-key="${anchor.dataset.conversationKey}"]`).getBoundingClientRect().top - offset };
    });
    assert.equal(result.sameThread, true, 'refresh must retain the scrolling element (including wheel/touch momentum)');
    assert.equal(result.open, true, 'refresh must retain expanded output');
    assert.equal(result.sameAnchor, true, 'unchanged messages retain their DOM');
    assert.ok(Math.abs(result.delta) < 1, 'visible message must not move');
    assert.ok(await page.evaluate(() => {
      const thread = $('#ck-thread');
      const anchor = [...thread.querySelectorAll('.entry')].find((e) => e.getBoundingClientRect().bottom > thread.getBoundingClientRect().top);
      const top = anchor.getBoundingClientRect().top;
      extra = 20; count += 1; renderTaskPage();
      return Math.abs(anchor.getBoundingClientRect().top - top) < 1;
    }), 'growth above the reader keeps the visible message anchored');
    assert.ok(await page.evaluate(() => {
      const thread = $('#ck-thread'); thread.scrollTop = thread.scrollHeight;
      count += 1; renderTaskPage();
      return thread.scrollHeight - thread.clientHeight - thread.scrollTop < 1;
    }), 'readers at the bottom follow appended messages');
    assert.ok(await page.evaluate(() => {
      const thread = $('#ck-thread'); thread.scrollTop = 200;
      role = 'merge'; renderTaskPage();
      const next = $('#ck-thread');
      return next !== thread && next.scrollHeight - next.clientHeight - next.scrollTop < 1;
    }), 'changing agents starts at the latest message');
    assert.ok(await page.evaluate(() => {
      const thread = $('#ck-thread');
      thread.scrollTop = thread.scrollHeight - thread.clientHeight - 20;
      const top = thread.scrollTop;
      renderTaskPage();
      return Math.abs(thread.scrollTop - top) < 1;
    }), 'a small upward scroll must not snap back to the bottom');
    assert.ok(await page.evaluate(() => {
      const thread = $('#ck-thread');
      thread.querySelector('details').open = true;
      extra += 1; renderTaskPage();
      return thread.querySelector('details').open;
    }), 'updated tool output retains its expanded state');
    assert.ok(await page.evaluate(() => {
      const thread = $('#ck-thread');
      thread.scrollTop = 200;
      S.view.taskId = 'attempt-3'; renderTaskPage();
      const next = $('#ck-thread');
      return next !== thread && next.scrollHeight - next.clientHeight - next.scrollTop < 1;
    }), 'changing attempts resets the conversation independently of the agent role');
    // Exercise native wheel input during repeated background refreshes at both
    // desktop and narrow/mobile widths with the actual console stylesheet.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => {
        const thread = $('#ck-thread'); thread.scrollTop = 1500;
        window.scrollingThread = thread;
        window.repaint = setInterval(renderTaskPage, 16);
      });
      await page.locator('#ck-thread').hover();
      await page.mouse.wheel(0, -350);
      await page.waitForFunction(() => $('#ck-thread').scrollTop < 1400);
      const position = await page.locator('#ck-thread').evaluate((el) => el.scrollTop);
      await page.waitForTimeout(100);
      assert.ok(await page.evaluate((position) => {
        clearInterval(repaint);
        return $('#ck-thread') === scrollingThread && Math.abs($('#ck-thread').scrollTop - position) < 1;
      }, position), `wheel scrolling stays stable during refreshes at ${width}px`);
    }
    // Timing navigation follows installation opt-in and disappears on a live disable.
    await page.addScriptTag({ content: 'const timingReports = new Map();\n' + fn('applyTimingSetting') });
    await page.evaluate(() => {
      TASK_TABS = [{key:'overview',label:'Overview'},{key:'timing',label:'Timing'}];
      S.selected = S.view.taskId; S.meta = {}; renderTaskPage();
    });
    assert.equal(await page.locator('[data-tasktab="timing"]').count(), 0);
    await page.evaluate(() => applyTimingSetting(true));
    assert.equal(await page.locator('[data-tasktab="timing"]').count(), 1);
    await page.evaluate(() => { S.taskTab = 'timing'; applyTimingSetting(false); });
    assert.equal(await page.locator('[data-tasktab="timing"]').count(), 0);
    assert.equal(await page.evaluate(() => S.taskTab), 'overview');
    console.log('Conversation scroll and timing visibility browser regressions passed');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
