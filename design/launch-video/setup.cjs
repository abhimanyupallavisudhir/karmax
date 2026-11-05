const { chromium } = require('playwright');
const APP = 'http://127.0.0.1:48950';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(APP);
  await page.locator('#setup-btn').waitFor();
  await page.getByLabel('Name').fill('Abhimanyu Pallavi Sudhir');
  await page.getByLabel('Email').fill('abhimanyu@tavya.io');
  await page.getByLabel('Password (10+ characters)').fill('demo-launch-password');
  await page.locator('#setup-btn').click();
  await page.waitForTimeout(3000);
  await context.storageState({ path: '/tmp/demo/state.json' });
  await page.screenshot({ path: '/tmp/demo/after-setup.png' });
  console.log(page.url());
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
