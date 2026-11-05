// Stills of the real console for the feature grid, taken off camera in their own
// page (2× for crisp tiles). Each is a crop around the part that tells the story.
const path = require('node:path');

module.exports = async function shoot(browser, { app, storageState, out, route }) {
  const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2, colorScheme: 'light' });
  if (route) await route(context);
  const page = await context.newPage();
  const sleep = (ms) => page.waitForTimeout(ms);
  const shots = {};
  const crop = async (name, locators, pad = 14) => {
    const boxes = [];
    for (const l of locators) boxes.push(await l.boundingBox());
    const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad), y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
    const r = Math.min(1440, Math.max(...boxes.map((b) => b.x + b.width)) + pad), bt = Math.min(810, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
    const file = path.join(out, `${name}.png`);
    await page.screenshot({ path: file, clip: { x, y, width: r - x, height: bt - y } });
    shots[name] = file;
  };
  const form = async () => {
    await page.goto(`${app}/personal/tavya`); await sleep(1500);
    await page.keyboard.press('n'); await sleep(400); await page.keyboard.press('Enter'); await sleep(300); await page.keyboard.press('Enter');
    await page.locator('#tf-page textarea').first().waitFor(); await sleep(800);
  };

  // Agents: the model picker, open.
  await form();
  const agent = page.locator('#tf-page .form-row[data-row="agent:do"]');
  await agent.scrollIntoViewIfNeeded();
  await agent.locator('.combo-caret').first().click(); await sleep(700);
  const menu = page.locator('[role="listbox"], .combo-menu, .combo-list').filter({ visible: true }).first();
  await crop('agents', [agent.locator('.af-ref').first(), menu]);
  await page.keyboard.press('Escape'); await sleep(200);

  // Triggers: after a task, on a schedule, on an event.
  const triggers = page.locator('#tf-page .form-row[data-row="__triggers"]');
  await triggers.evaluate((e) => e.scrollIntoView({ block: 'center' })); await sleep(400);
  await crop('triggers', [triggers]);

  // The vault and connected apps.
  await page.goto(`${app}/personal/settings#settings-payments`); await sleep(1800);
  const apps = page.locator('section, .card, .settings-card').filter({ hasText: 'Connected apps' }).last();
  await crop('apps', [apps]);
  await page.getByText('Vault credentials', { exact: false }).first().click(); await sleep(1500);
  await crop('vault', [page.locator('main, #main').first()], 0);

  // Insights.
  await page.goto(`${app}/personal/insights`); await sleep(2200);
  const chart = page.locator('section, .card, .ins-card').filter({ hasText: 'Agent time' }).filter({ has: page.locator('svg') }).last();
  await crop('insights', [chart]);

  await context.close();
  return shots;
};
