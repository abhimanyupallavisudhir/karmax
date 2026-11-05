// Creates the demo administrator and stores the browser session.
// Usage: APP=http://127.0.0.1:48950 STATE=/home/user/demo/state.json node design/launch-video/first-cut/setup.cjs
const { chromium } = require('playwright');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/home/user/demo/state.json';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(APP);
  await page.locator('#setup-btn, #new-project, #main').first().waitFor();
  await page.waitForTimeout(1000);
  if (await page.locator('#setup-btn').count()) {
    await page.getByLabel('Name').fill('Abhimanyu Pallavi Sudhir');
    await page.getByLabel('Email').fill('abhimanyu@example.com');
    await page.getByLabel('Password (10+ characters)').fill('launch-video-demo-password');
    await page.locator('#setup-btn').click();
    await page.locator('#main').waitFor();
    await page.waitForTimeout(1500);
  }
  await context.storageState({ path: STATE });
  const session = await (await context.request.get(`${APP}/api/session`)).json();
  console.log(JSON.stringify(session).slice(0, 600));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
