import { chromium } from 'playwright';
// A running tavya with a scratch KARMAX_HOME: KARMAX_HOME=/tmp/kh npx tsx src/main.ts
const base = process.env.TAVYA_URL ?? 'http://127.0.0.1:4505';
const out = new URL('.', import.meta.url).pathname;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const api = async (path, method = 'GET', body) => page.evaluate(async ([path, method, body]) => {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); try { return JSON.parse(text); } catch { return text; }
}, [path, method, body]);
await page.goto(base);
await api('/api/setup', 'POST', { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse battery staple' });
console.log(JSON.stringify(await api('/api/auth/sign-in/email', 'POST', { email: 'ada@example.com', password: 'correct horse battery staple' })).slice(0, 120));
await page.goto(base);
const project = await api('/api/projects', 'POST', { name: 'Pramana ' + Date.now().toString(36).slice(-3) });
console.log('project', project.id || project);
const b64 = (s) => Buffer.from(s).toString('base64');
const files = [];
for (const folder of ['gretil', 'ocr', 'mt']) for (let i = 0; i < 3; i++) files.push({ path: `${folder}/part-${i}.txt`, data: b64(`${folder} ${i} `.repeat(4000 * (i + 1))) });
files.push({ path: 'README.md', data: b64('per-source folders') });
console.log(JSON.stringify(await api(`/api/projects/${project.id}/resources`, 'POST', { name: 'raw_data', driver: 'volume@1', target: { kind: 'path', path: 'raw_data' }, access: 'write', isolation: 'fork', publish: 'review', onDemand: true, files })).slice(0, 200));
console.log(JSON.stringify(await api(`/api/projects/${project.id}/resources`, 'POST', { name: 'fixtures', driver: 'volume@1', target: { kind: 'path', path: 'tests/fixtures' }, access: 'read', isolation: 'fork', publish: 'discard', files: [{ path: 'a.json', data: b64('{}') }] })).slice(0, 200));
await page.goto(`${base}/`);
await page.waitForTimeout(1500);
await page.goto(base); await page.waitForTimeout(2500);
const orgs = await api('/api/organizations');
const org = (Array.isArray(orgs) ? orgs : orgs.organizations).find((o) => o.id === project.organizationId);
console.log('org', JSON.stringify(org).slice(0, 200), 'project slug', project.slug);
const url = `/${org.slug}/${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}/settings`;
console.log('route', url);
await page.goto(`${base}${url}`);
await page.waitForSelector('#project-data-box .project-resource-row', { timeout: 30000 });
const card = page.locator('#project-data-box').locator('xpath=..');
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await card.screenshot({ path: `${out}/data-settings.png` });
await page.locator('#data-add-panel summary').click();
await page.waitForTimeout(300);
await card.screenshot({ path: `${out}/data-add-form.png` });
// The explanation, as a phone shows it (tap on the ⓘ).
await page.setViewportSize({ width: 420, height: 860 });
await page.reload();
await page.waitForSelector('#project-data-box .project-resource-row', { timeout: 30000 });
await page.evaluate(() => document.querySelector('#project-data').scrollIntoView({ block: 'start' }));
await page.locator('#project-data-box .resource-on-demand .info-dot').first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/data-tooltip-phone.png` });
await browser.close();
