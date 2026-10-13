// Seeds a scratch tavya (mock agent) with a realistic task for task-page screenshots.
// Usage: APP=http://127.0.0.1:48950 REPO=/tmp/shots/repo node design/task-page/seed.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext(fs.existsSync(STATE) ? { storageState: STATE } : {});
  const page = await context.newPage();
  await page.goto(APP);
  await page.locator('#setup-btn, #new-project, .task-list, #main').first().waitFor();
  await page.waitForTimeout(1500);
  if (await page.locator('#setup-btn').count()) {
    await page.getByLabel('Name').fill('Ann Author');
    await page.getByLabel('Email').fill('ann@example.test');
    await page.getByLabel('Password (10+ characters)').fill('long-screenshot-password');
    await page.locator('#setup-btn').click();
    await page.locator('#new-project').waitFor();
    await context.storageState({ path: STATE });
  }
  const req = async (method, path, body) => {
    const session = await (await context.request.get(`${APP}/api/session`)).json();
    const r = await context.request.fetch(`${APP}${path}`, { method, data: body,
      headers: { origin: APP, ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) } });
    if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${await r.text()}`);
    return r.json();
  };
  const project = await req('POST', '/api/projects', { name: 'Video Studio',
    config: { repos: [process.env.REPO || '/tmp/shots/repo'], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } });
  const prompt = [
    'Add a dark-mode toggle to the settings page, and make it remember the choice.',
    '@write src/theme.js :: export const themes = ["light", "dark"];\\nexport function apply(t) { document.documentElement.dataset.theme = t; }\\n',
    '@run git add -A && git commit -qm "Add theme toggle"',
    '@subtask Write tests for the theme toggle :: Cover persistence across reloads.\\n@write tests.txt :: ok\\n@run git add -A && git commit -qm tests',
    '@review Toggle lives in Settings → Appearance; check it survives a reload.',
    '@runaction Run tests :: echo "12 passed"',
    '@openaction Screenshot :: README.md',
  ].join('\n');
  const task = await req('POST', `/api/projects/${project.id}/tasks`, { workflow: 'software-dev', title: 'Dark-mode toggle in Settings', params: { prompt } });
  for (let i = 0; i < 120; i++) {
    const v = await req('GET', `/api/tasks/${task.id}`);
    if (v.stage === 'review') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await req('POST', `/api/projects/${project.id}/tasks`, { workflow: 'software-dev', title: 'Draft: export to MP4', params: { prompt: 'Export to MP4', draft: true } }).catch((e) => console.error(e.message));
  fs.writeFileSync('/tmp/shots/seed.json', JSON.stringify({ projectId: project.id, taskId: task.id, num: task.num, slug: project.slug }));
  console.log(JSON.stringify({ project: project.slug, task: task.num }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
