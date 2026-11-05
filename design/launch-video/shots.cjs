// Stills of the real console for the feature grid, taken off camera in their own
// page (2× for crisp tiles). Each is a crop around the part that tells the story.
const path = require('node:path');

module.exports = async function shoot(browser, { app, storageState, out, route, subtasks }) {
  const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2, colorScheme: 'light' });
  if (route) await route(context);
  const page = await context.newPage();
  const sleep = (ms) => page.waitForTimeout(ms);
  const shots = {};
  const crop = async (name, locators, pad = 14, { bottom } = {}) => {
    const boxes = [];
    for (const l of locators) boxes.push(await l.boundingBox());
    const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad), y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
    const r = Math.min(1440, Math.max(...boxes.map((b) => b.x + b.width)) + pad), bt = Math.min(810, bottom ?? Math.max(...boxes.map((b) => b.y + b.height)) + pad);
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
  await agent.evaluate((e) => e.scrollIntoView({ block: 'start' })); await sleep(300);
  await page.mouse.wheel(0, -70); await sleep(300);
  await agent.locator('.combo-caret').first().click(); await sleep(700);
  const ref = agent.locator('.af-ref').first(), rb = await ref.boundingBox();
  await crop('agents', [ref], 14, { bottom: rb.y + 318 });
  await page.keyboard.press('Escape'); await sleep(200);

  // Sub-tasks: a task that split itself up, its children in every state.
  if (subtasks) {
    await page.goto(`${app}${subtasks}`); await sleep(2500);
    await crop('subtasks', [page.locator('.rail-sec.subtasks')], 6);
  }

  // The vault and connected apps.
  await page.goto(`${app}/personal/settings#settings-payments`); await sleep(1800);
  const apps = page.locator('#settings-connections');
  await crop('apps', [apps]);
  await page.getByText('Vault credentials').filter({ visible: true }).first().click(); await sleep(1500);
  await crop('vault', [page.locator('dialog[open], [role="dialog"]').filter({ visible: true }).first()], 0);

  // Insights.
  await page.goto(`${app}/personal/insights`); await sleep(2200);
  const chart = page.locator('.ins-chart').first();
  await crop('insights', [chart]);

  await context.close();
  return shots;
};
