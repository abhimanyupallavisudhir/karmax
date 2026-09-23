import fs from 'node:fs';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';

const evaluate = (page: Page, source: string) => page.evaluate(source => (globalThis as any).eval(source), source);

for (const fullscreen of [false, true]) {
  it(`grows follow-up drafts and preserves manual sizing in ${fullscreen ? 'full screen' : 'the usual view'}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('http://followup.test/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${pathname}`) });
        if (pathname.endsWith('/signal')) return route.fulfill({ json: {} });
        return route.fulfill({ contentType: 'text/html', body: '<main id="main" style="height:min(700px, 100dvh)"></main>' });
      });
      await page.goto('http://followup.test/');
      await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '') });
      await evaluate(page, `
        Object.assign(S, { projects: [{ id: 'project', organizationId: 'org' }], projectId: 'project',
          taskEvents: [], sessions: {}, meta: {}, selected: 'task', taskTab: 'checkin', conversationFullscreen: ${fullscreen} });
        S.view = { taskId: 'task', stage: 'do', status: 'active',
          actions: [{ name: 'followUp', enabled: true }],
          transcripts: [{ role: 'do', messages: [{ role: 'assistant', text: 'Working.' }] }] };
        toast = () => {}; refreshTask = async () => {}; refreshTasks = async () => {};
        renderTaskPage = () => {
          const focus = captureFollowupFocus(document.getElementById('main'));
          patchTaskPage(document.getElementById('main'), checkinTab(S.view));
          wireFollowups(S.view); wireCheckinSidebar(S.view);
          restoreFollowupFocus(document.getElementById('main'), focus);
        };
        renderTaskPage();
      `);
      const input = page.locator('.followup-input');
      const height = () => input.evaluate(el => el.getBoundingClientRect().height);
      const initial = await height();
      const draft = Array.from({ length: 8 }, (_, i) => `Draft line ${i}`).join('\n');
      await input.fill(draft);
      expect(await height()).toBeGreaterThan(initial + 60);
      expect(await input.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      await evaluate(page, 'renderTaskPage()');
      expect(await input.inputValue()).toBe(draft);
      expect(await input.evaluate(el => document.activeElement === el)).toBe(true);
      expect(await input.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

      // Soft-wrapped text grows too, and recalculates when the available width changes.
      await input.fill('Words that wrap naturally across the message box. '.repeat(12));
      const wideHeight = await height();
      expect(wideHeight).toBeGreaterThan(initial);
      await page.setViewportSize({ width: 800, height: 900 });
      await expect.poll(height).toBeGreaterThan(wideHeight);
      await page.setViewportSize({ width: 1200, height: 900 });
      await expect.poll(height).toBeCloseTo(wideHeight, 0);
      await input.fill('A short draft');
      expect(await height()).toBeLessThanOrEqual(initial + 1);
      // Drag the real native textarea resize handle, then trigger a background render.
      const box = (await input.boundingBox())!;
      await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 4, box.y + box.height + 150, { steps: 10 });
      await page.mouse.up();
      const manual = await height();
      expect(manual).toBeGreaterThan(initial + 100);
      await input.press('End');
      await input.pressSequentially(' plus more');
      expect(await height()).toBeCloseTo(manual, 0);
      await page.locator('#conversation-fullscreen').focus();
      await evaluate(page, 'renderTaskPage()');
      expect(await height()).toBeCloseTo(manual, 0);
      await page.locator('#conversation-fullscreen').click();
      await evaluate(page, 'renderTaskPage()');
      expect(await height()).toBeCloseTo(manual, 0);

      // Other tasks and agents have their own draft size.
      await evaluate(page, "S.view.taskId = 'other'; renderTaskPage()");
      expect(await height()).toBeLessThanOrEqual(initial + 1);
      await evaluate(page, "S.view.taskId = 'task'; renderTaskPage()");
      expect(await height()).toBeCloseTo(manual, 0);
      await evaluate(page, "S.view.transcripts[0].role = 'confirm'; renderTaskPage()");
      expect(await height()).toBeLessThanOrEqual(initial + 1);
      await evaluate(page, "S.view.transcripts[0].role = 'do'; renderTaskPage()");
      expect(await height()).toBeCloseTo(manual, 0);

      await input.fill('Long draft\n'.repeat(100));
      expect(await height()).toBeGreaterThan(240);
      expect(await height()).toBeLessThanOrEqual(360);
      expect(await input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      expect(await page.locator('#ck-thread').evaluate(el => el.clientHeight)).toBeGreaterThan(100);
      await page.setViewportSize({ width: 650, height: 500 });
      await expect.poll(height).toBeLessThanOrEqual(200);
      expect((await page.locator('.followup-send').boundingBox())!.y).toBeLessThan(500);
      await page.locator('.followup-send').click();
      await expect.poll(() => input.inputValue()).toBe('');
      await expect.poll(height).toBeLessThanOrEqual(initial + 1);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
}
