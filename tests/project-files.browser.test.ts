import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Browser, Page } from 'playwright';
import { launchChromium, openConsole } from './helpers/browser.js';
import { projectFilesFixture } from './helpers/project-files-fixture.js';

// The project Files page (wiki features/project-files), driven in the shipped
// console against a real gateway: Git read from bare "GitHub" remotes through
// the host mirror, data from a real restic repository mounted at site/data/raw.
// Screens land in design/files/ when SHOTS=1.

declare const document: any, location: any, window: any;

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
    await clickAddressEnd(page);
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
    await clickAddressEnd(page);
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

it('shows image thumbnails, and shares a folder as a public snapshot anyone can browse', async () => {
  const f = await projectFilesFixture(cleanups, { files: { 'src/server.ts': SERVER_TS, 'assets/logo.svg': LOGO_SVG } });
  await f.store.kvSet(`conversation-sharing:organization:${f.project.organizationId}`, 'enabled');
  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 1280, height: 820 } });
  cleanups.push(() => context.close());
  const shoot = async (target: typeof page, name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await target.screenshot({ path: path.join(shots, `${name}.png`) }); } };

  await step('an image in a folder is its own icon', async () => {
    await page.goto(`${f.server.url}/projects/site-builder/files`);
    await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
    await page.goto(page.url().replace(/\/files$/, '/files/site/assets'));
    await page.locator('.files-row', { hasText: 'logo.svg' }).locator('.files-icon.has-thumb').waitFor();
    await shoot(page, 'thumbnails');
  });

  let link = '';
  await step('Share makes a public link to this folder', async () => {
    await page.goto(page.url().replace(/\/files\/site\/assets$/, '/files/site'));
    await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
    await page.locator('#files-share:not([hidden])').click();
    const dialog = page.locator('.files-share-dialog');
    await dialog.locator('[data-create]').click();
    link = await dialog.locator('[data-link]').inputValue();
    expect(link).toMatch(new RegExp(`^${f.server.url}/share/files/[A-Za-z0-9_-]{43}$`));
    await page.waitForFunction(() => !document.querySelector('.action-pending, .action-succeeded'));
    await shoot(page, 'share-dialog');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  });

  await step('someone signed out browses the snapshot', async () => {
    const outsider = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 820 } });
    cleanups.push(() => outsider.close());
    const shared = await outsider.newPage();
    const outsiderErrors: string[] = [];
    shared.on('pageerror', (error) => outsiderErrors.push(error.message));
    await shared.goto(link);
    await shared.locator('.files-row', { hasText: 'README.md' }).waitFor();
    expect(await shared.locator('.files-crumb').allInnerTexts()).toEqual(['site']);
    await shared.locator('.files-link', { hasText: /^src$/ }).click();
    await shared.locator('.files-link', { hasText: 'server.ts' }).click();
    await shared.locator('.files-code .hljs-keyword').first().waitFor();
    expect(shared.url()).toBe(`${link}/src/server.ts`);
    await shoot(shared, 'shared-page');
    await shared.goBack();
    await shared.locator('.files-link', { hasText: 'server.ts' }).waitFor();
    await shared.goto(`${link}/README.md`);
    await shared.locator('.files-rendered h1', { hasText: 'Site' }).waitFor();
    expect(outsiderErrors).toEqual([]);
  });

  await step('Stop sharing ends the link', async () => {
    await page.locator('#files-share').click();
    await page.locator('.files-share-dialog [data-revoke]').click();
    await page.locator('.files-share-dialog [data-create]').waitFor();
    expect((await fetch(link)).status).toBe(404);
  });
  expect(errors).toEqual([]);
}, 120_000);

it('switches to a branch or a task with the picker, opens an agent’s cited file at its line, and shows Markdown images', async () => {
  const f = await projectFilesFixture(cleanups, { files: { 'src/server.ts': SERVER_TS, 'assets/logo.svg': LOGO_SVG,
    'docs/guide.md': '## Guide\n\n![The logo](../assets/logo.svg)\n' } });
  const { sh } = await import('./helpers/project-files-fixture.js');
  sh(f.site.work, 'checkout', '-qb', 'redesign');
  fs.writeFileSync(path.join(f.site.work, 'README.md'), '# Site, redesigned\n');
  sh(f.site.work, 'commit', '-qam', 'redesign');
  sh(f.site.work, 'push', '-q', f.site.bare, 'redesign');
  sh(f.site.work, 'checkout', '-qb', 'tavya/task_one', 'main');
  fs.writeFileSync(path.join(f.site.work, 'src/server.ts'), SERVER_TS.replace('cheap', 'cheap and fast'));
  sh(f.site.work, 'commit', '-qam', 'task work');
  sh(f.site.work, 'push', '-q', f.site.bare, 'tavya/task_one');
  const task = await f.store.createTask({ projectId: f.project.id, title: 'Speed up health checks', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
  const handle = { id: task.id, kind: 'e2b', root: '/home/user/w', workdir: '/home/user/w/site', branch: 'tavya/task_one', base: 'main',
    repos: [{ name: 'site', root: '/home/user/w/site', repo: `git@github.com:${f.owner}/site.git`, branch: 'tavya/task_one', base: 'main' }] } as any;
  await f.store.registerWorld(handle, f.project.id);
  await f.store.setWorldState(handle, 'parked');
  // An organization wiki page with its own image.
  const { wikiRoot } = await import('../src/wiki/wiki.js');
  const { paths } = await import('../src/config/paths.js');
  const wikiPage = path.join(wikiRoot(paths().content, 'organization', f.project.organizationId!), 'guides', 'brand');
  fs.mkdirSync(wikiPage, { recursive: true });
  fs.writeFileSync(path.join(wikiPage, 'SKILL.md'), '---\nname: Brand\ndescription: Our mark\n---\nOur mark:\n\n![Mark](mark.svg)\n');
  fs.writeFileSync(path.join(wikiPage, 'mark.svg'), LOGO_SVG);

  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 1280, height: 820 } });
  cleanups.push(() => context.close());
  const shoot = async (name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };

  await step('a Markdown file shows the image beside it', async () => {
    await page.goto(`${f.server.url}/projects/site-builder/files`);
    await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
    await page.goto(page.url().replace(/\/files$/, '/files/site/docs/guide.md'));
    await page.waitForFunction(() => document.querySelector('.files-rendered img')?.naturalWidth === 120);
  });

  await step('the picker shows a branch', async () => {
    await page.goto(page.url().replace(/\/files\/.*$/, '/files/site'));
    await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
    await page.locator('#files-view').click();
    const menu = page.locator('#files-view-menu');
    await menu.locator('[role="option"]', { hasText: 'redesign' }).waitFor();
    expect(await menu.locator('.files-view-group').allInnerTexts()).toEqual(['DEFAULT', 'TASKS', 'BRANCHES']);
    await shoot('view-picker');
    await page.keyboard.type('redes');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/files\/site\?branch=redesign$/);
    await page.locator('.files-link', { hasText: 'README.md' }).click();
    await page.locator('.files-rendered h1', { hasText: 'Site, redesigned' }).waitFor();
    expect(await page.locator('#files-view').innerText()).toContain('redesign');
  });

  await step('the picker shows a task’s files', async () => {
    await page.locator('#files-view').click();
    await page.locator('#files-view-menu [role="option"]', { hasText: 'Speed up health checks' }).click();
    await page.waitForURL(new RegExp(`/files/site/README\\.md\\?task=${task.num}$`));
    await page.locator('.files-crumb', { hasText: /^src$/ }).count();
    await page.goto(page.url().replace(/README\.md\?/, 'src/server.ts?'));
    await page.locator('.files-lc', { hasText: 'cheap and fast' }).waitFor();
    expect(await page.locator('#files-view').innerText()).toMatch(new RegExp(`#${task.num} Speed up health checks`));
    await shoot('task-view');
  });

  await step('an agent’s cited file opens in Files, in its task, at the line', async () => {
    await page.goto(`${f.server.url}/projects/site-builder/tasks/${task.num}/file?path=${encodeURIComponent('/home/user/w/site/src/server.ts')}&line=6`);
    await page.waitForURL(new RegExp(`/files/site/src/server\\.ts\\?task=${task.num}#L6$`));
    await page.locator('#L6.selected').waitFor();
    expect(await page.locator('#L6 .files-lc').innerText()).toContain('cheap and fast');
  });

  await step('a wiki page shows its own image', async () => {
    await page.goto(`${f.server.url}/personal/wiki#guides/brand`);
    await page.waitForFunction(() => document.querySelector('.wiki-md img')?.naturalWidth === 120);
    await shoot('wiki-image');
  });
  expect(errors).toEqual([]);
}, 120_000);

// Click the address bar's empty right end (past the breadcrumbs), wherever the bar ends —
// once it has stopped moving: the source chip beside it arrives on its own and narrows it.
async function clickAddressEnd(page: Page) {
  const address = page.locator('#files-address');
  // boundingBox() does not wait: while the view re-renders the bar can be briefly
  // detached (null), so a missing box counts as not settled yet (CI #2830).
  await address.waitFor();
  let box = await address.boundingBox();
  for (let settled = 0; settled < 3;) {
    await page.waitForTimeout(50);
    const next = await address.boundingBox();
    settled = next && box && next.width === box.width && next.x === box.x ? settled + 1 : 0;
    box = next;
  }
  await address.click({ position: { x: box!.width - 12, y: box!.height / 2 } });
}

// The same axe-core gate the console's main pages pass (tests/accessibility-check.cjs).
it('meets WCAG 2.2 AA on a folder, a code file and a rendered Markdown file, light and dark', async () => {
  const f = await projectFilesFixture(cleanups, { files: { 'src/server.ts': SERVER_TS } });
  const { page, errors, context } = await openConsole(browser, { viewport: { width: 1280, height: 820 } });
  cleanups.push(() => context.close());
  const axe = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  const violations: string[] = [];
  await page.goto(`${f.server.url}/projects/site-builder/files`);
  await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
  const base = page.url();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, at, ready] of [
      ['folder', '/site', '.files-row'],
      ['code', '/site/src/server.ts', '.files-code .hljs-keyword'],
      ['markdown', '/site/README.md', '.files-page .md'],
    ] as const) {
      await page.goto(`${base}${at}`);
      await page.locator(ready).first().waitFor();
      await page.evaluate(axe); // as an expression: CDP evaluation is not subject to the page's CSP
      const result = await page.evaluate(async () => window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        exclude: [['.mark']],
      }));
      for (const v of result.violations) violations.push(`${scheme} · ${name}: ${v.id} — ${v.help}: ${v.nodes.slice(0, 3).map((n: any) => `${n.target.join(' ')} (${(n.failureSummary || '').split('\n').slice(1, 2).join('').trim()})`).join(', ')}`);
    }
  }
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
}, 90_000);
