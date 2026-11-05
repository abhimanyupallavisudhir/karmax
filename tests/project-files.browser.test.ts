import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { launchChromium, openConsole } from './helpers/browser.js';
import { projectFilesFixture } from './helpers/project-files-fixture.js';

// The project Files page (wiki features/project-files), driven in the shipped
// console against a real gateway: Git read from bare "GitHub" remotes through
// the host mirror, data from a real restic repository mounted at site/data/raw.
// Screens land in design/files/ when SHOTS=1.

declare const document: any, location: any;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
let browser: Browser;
beforeAll(async () => { browser = await launchChromium(); });
afterAll(async () => { await browser?.close(); });

const SERVER_TS = `import http from 'node:http';

/** Answers every request with the time, as JSON. */
export function serve(port: number): http.Server {
  const server = http.createServer((req, res) => {
    // Health checks stay cheap.
    if (req.url === '/health') return void res.end('ok');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ now: new Date().toISOString(), path: req.url }));
  });
  return server.listen(port);
}
`;
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="50" fill="#5454d4"/></svg>';
const shots = process.env.SHOTS === '1' ? path.join(import.meta.dirname, '..', 'design', 'files') : '';

it('browses repositories, the wiki and mounted data with an address bar, and shows text files', async () => {
  const f = await projectFilesFixture(cleanups, { files: { 'src/server.ts': SERVER_TS, 'assets/logo.svg': LOGO_SVG } });
  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 1280, height: 820 } });
  cleanups.push(() => context.close());
  const shoot = async (name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
  const rows = () => page.locator('.files-row .files-name').allInnerTexts();

  await step('the Files tab lists the repositories and the wiki', async () => {
    await page.goto(`${f.server.url}/projects/site-builder/files`);
    await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
    expect(await page.locator('.tab.active').innerText()).toBe('Files');
    expect(await rows()).toEqual(['site', 'site-wiki']);
    await shoot('root');
    expect(await page.locator('.files-row', { hasText: 'site-wiki' }).locator('.files-badge').innerText()).toBe('wiki');
  });

  await step('a repository shows its branch and the data mounted inside it', async () => {
    await page.locator('.files-link', { hasText: /^site$/ }).click();
    await page.waitForURL(/\/files\/site$/);
    await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
    expect(await rows()).toEqual(['assets', 'data', 'docs', 'src', 'link-to-app', 'logo.bin', 'README.md']);
    expect(await page.locator('#files-source').innerText()).toContain('main');
    await shoot('repository');
  });

  await step('Markdown renders, and its relative links stay in the tree', async () => {
    await page.locator('.files-link', { hasText: 'README.md' }).click();
    await page.locator('.files-rendered h1', { hasText: 'Site' }).waitFor();
    await shoot('markdown');
    await page.locator('.files-rendered a', { hasText: 'the guide' }).click();
    await page.waitForURL(/\/files\/site\/docs\/guide\.md$/);
    await page.locator('.files-rendered h2', { hasText: 'Guide' }).waitFor();
  });

  await step('Backspace goes up a folder and keeps your place', async () => {
    await page.locator('body').press('Backspace');
    await page.waitForURL(/\/files\/site\/docs$/);
    await page.waitForFunction(() => document.activeElement?.textContent?.includes('guide.md'));
  });

  await step('the address bar takes a typed path; code is coloured with numbered, linkable lines', async () => {
    await page.locator('#files-address').click({ position: { x: 600, y: 18 } });
    const input = page.locator('#files-path-input');
    await input.waitFor();
    expect(await input.inputValue()).toBe('site/docs');
    await input.fill('site/src/server.ts');
    await input.press('Enter');
    await page.waitForURL(/\/files\/site\/src\/server\.ts$/);
    await page.locator('.files-code .hljs-keyword').first().waitFor();
    expect(await page.locator('.files-line').count()).toBe(SERVER_TS.split('\n').length - 1);
    expect(await page.locator('.files-file-meta').innerText()).toMatch(/^12 lines · /);
    await page.locator('#L5 .files-ln').click();
    await page.locator('#L7 .files-ln').click({ modifiers: ['Shift'] });
    expect(await page.evaluate(() => location.hash)).toBe('#L5-L7');
    expect(await page.locator('.files-line.selected').count()).toBe(3);
    await shoot('code');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot('code-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('a name with spaces and # survives the URL and a reload', async () => {
    await page.locator('#files-address').click({ position: { x: 600, y: 18 } });
    await page.locator('#files-path-input').fill('site/src/weird name #1.txt');
    await page.locator('#files-path-input').press('Enter');
    await page.waitForURL(/weird%20name%20%231\.txt$/);
    await page.locator('.files-lc', { hasText: 'spaces and a hash' }).waitFor();
    await page.reload();
    await page.locator('.files-lc', { hasText: 'spaces and a hash' }).waitFor();
    expect(await page.locator('.files-crumb[aria-current="page"]').innerText()).toBe('weird name #1.txt');
  });

  await step('data read from its resource: a CSV as a table and as code', async () => {
    await page.locator('.files-crumb', { hasText: /^site$/ }).click();
    await page.locator('.files-link', { hasText: 'data' }).click();
    await page.locator('.files-row.mount-data', { hasText: 'raw' }).waitFor();
    await page.locator('.files-link', { hasText: 'raw' }).click();
    await page.locator('#files-source', { hasText: 'raw_data' }).waitFor();
    await page.locator('.files-link', { hasText: 'pages' }).click();
    await page.locator('.files-link', { hasText: 'b.csv' }).click();
    await page.locator('.files-table th', { hasText: 'x' }).waitFor();
    expect(await page.locator('.files-table td').allInnerTexts()).toEqual(['1', '2']);
    await shoot('data-csv');
    await page.locator('.files-modes [data-mode="code"]').click();
    expect(await page.locator('.files-lc').allInnerTexts()).toEqual(['x,y', '1,2']);
  });

  await step('an image shows; a binary file offers a download', async () => {
    await page.goto(`${f.server.url}${new URL(page.url()).pathname.replace(/\/files\/.*$/, '/files/site/assets/logo.svg')}`);
    await page.waitForFunction(() => document.querySelector('.files-image img')?.naturalWidth === 120);
    await page.goto(page.url().replace(/assets\/logo\.svg$/, 'logo.bin'));
    await page.locator('.files-status', { hasText: 'Binary file' }).waitFor();
  });

  await step('a missing path says so', async () => {
    await page.goto(page.url().replace(/logo\.bin$/, 'nope'));
    await page.locator('.files-status.error', { hasText: 'Nothing at site/nope' }).waitFor();
  });

  await step('g f opens Files from anywhere in the project', async () => {
    await page.locator('.tab', { hasText: 'Tasks' }).click();
    await page.waitForURL((url) => !url.pathname.includes('/files'));
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('g');
    await page.keyboard.press('f');
    await page.waitForURL(/\/files$/);
    await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
  });
  expect(errors).toEqual([]);
}, 120_000);

it('fits a phone', async () => {
  const f = await projectFilesFixture(cleanups, { files: { 'src/server.ts': SERVER_TS } });
  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 390, height: 800 } });
  cleanups.push(() => context.close());
  await step('a file on a phone scrolls inside its view, not the page', async () => {
    await page.goto(`${f.server.url}/projects/site-builder/files`);
    await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
    await page.goto(page.url().replace(/\/files$/, '/files/site/src/server.ts'));
    await page.locator('.files-code .hljs-keyword').first().waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (shots) await page.screenshot({ path: path.join(shots, 'phone.png') });
  });
  expect(errors).toEqual([]);
}, 60_000);
