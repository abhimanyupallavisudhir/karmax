import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { launchChromium, openConsole } from './helpers/browser.js';
import { artifactGalleryFixture } from './helpers/artifact-gallery-fixture.js';

// The artifact gallery under a project's Files and the organization's Files
// page (wiki features/project-files), in the shipped console against a real
// gateway. Screens land in design/files/ when SHOTS=1.

declare const document: any;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
let browser: Browser;
beforeAll(async () => { browser = await launchChromium(); });
afterAll(async () => { await browser?.close(); });
const shots = process.env.SHOTS === '1' ? path.join(import.meta.dirname, '..', 'design', 'files') : '';

it('shows what Reviews attached under the project’s files, and opens each in the viewer', async () => {
  const f = await artifactGalleryFixture(cleanups);
  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 1280, height: 900 } });
  cleanups.push(() => context.close());
  const shoot = async (name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
  const tiles = page.locator('#files-artifacts .gallery-tile');

  await step('the project tabs say Settings; its page says Project settings', async () => {
    await page.goto(`${f.server.url}/projects/site-builder/files`);
    await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
    expect(await page.locator('.tabs .tab').allInnerTexts()).toEqual(['Tasks', 'Queues', 'Files', 'Wiki', 'Settings']);
    await page.locator('.tab', { hasText: 'Settings' }).click();
    await page.locator('.settings-header', { hasText: 'Project settings' }).waitFor();
    await page.locator('.tab', { hasText: 'Files' }).click();
  });

  await step('the gallery lists the latest of each attached file, newest first', async () => {
    await tiles.first().waitFor();
    expect(await tiles.count()).toBe(5);
    const labels = await page.locator('#files-artifacts .gallery-tile .review-tile-label').allInnerTexts();
    expect(new Set(labels)).toEqual(new Set(['New screen', 'The answer', 'Home page, redesigned', 'Notes', 'Report']));
    expect(labels.slice(-3)).toEqual(['Home page, redesigned', 'Notes', 'Report']);
    // Underway tasks are marked; each tile names its task.
    const home = tiles.filter({ hasText: 'Home page, redesigned' });
    expect(await home.locator('.gallery-tile-live').count()).toBe(1);
    expect(await home.locator('.gallery-tile-meta').innerText()).toBe(`#${f.tasks.active.num}`);
    expect(await tiles.filter({ hasText: 'Report' }).locator('.gallery-tile-live').count()).toBe(0);
    // A saved image fills its tile.
    await home.locator('.review-tile-media img').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('#files-artifacts img')].every((img: any) => img.complete));
    // One whose world cannot be read shows its type instead.
    await tiles.filter({ hasText: 'New screen' }).locator('.review-tile-file', { hasText: 'PNG' }).waitFor();
    await shoot('artifacts');
  });

  await step('a done task’s file in Git opens as the repository has it now', async () => {
    await tiles.filter({ hasText: 'Report' }).click();
    const viewer = page.locator('dialog.artifact-reader');
    await viewer.locator('.artifact-reader-content', { hasText: 'Final.' }).waitFor();
    expect(await viewer.locator('.artifact-reader-count').innerText()).toBe('5 / 5');
    expect(await viewer.locator('a', { hasText: `#${f.tasks.first.num}` }).count()).toBe(1);
    await shoot('artifact-viewer');
    // ← steps to the saved notes of a done task.
    await page.keyboard.press('ArrowLeft');
    await viewer.locator('.artifact-reader-content', { hasText: 'Notes' }).waitFor();
    expect(await viewer.locator('#artifact-reader-title').innerText()).toBe('never.md');
    // A saved file never committed has no place in Files.
    expect(await viewer.locator('a', { hasText: 'Show in Files' }).count()).toBe(0);
    await page.keyboard.press('ArrowRight');
    await viewer.locator('.artifact-reader-content', { hasText: 'Final.' }).waitFor();
    await viewer.locator('a', { hasText: 'Show in Files' }).click();
    await page.waitForURL(/\/files\/site\/docs\/report\.md$/);
    await viewer.waitFor({ state: 'detached' });
    await page.locator('.files-rendered', { hasText: 'Final.' }).waitFor();
  });

  await step('an underway task’s image opens from its Review', async () => {
    await page.locator('.files-crumb-root').click();
    await tiles.first().waitFor();
    await tiles.filter({ hasText: 'Home page, redesigned' }).click();
    const viewer = page.locator('dialog.artifact-reader');
    await page.waitForFunction(() => document.querySelector('dialog.artifact-reader img')?.naturalWidth === 160);
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
  });

  await step('a folder below the root has no gallery', async () => {
    await page.locator('.files-link', { hasText: /^site$/ }).click();
    await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
    expect(await page.locator('#files-artifacts').count()).toBe(0);
  });
  expect(errors).toEqual([]);
}, 120_000);

it('gives the organization one Files page: a folder per project, and every project’s artifacts', async () => {
  const f = await artifactGalleryFixture(cleanups);
  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 1280, height: 900 } });
  cleanups.push(() => context.close());
  const shoot = async (name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
  const rows = () => page.locator('.files-row .files-name').allInnerTexts();

  let root = '';
  await step('the sidebar’s Files lists the projects, above every artifact', async () => {
    await page.goto(`${f.server.url}/projects/site-builder`);
    await page.locator('#rail-files').click();
    await page.waitForURL(/\/[^/]+\/files$/);
    root = new URL(page.url()).pathname;
    expect(await page.locator('#rail-files').getAttribute('aria-current')).toBe('page');
    await page.locator('.files-row', { hasText: 'site-builder' }).waitFor();
    expect(await rows()).toEqual(['site-builder']);
    expect(await page.locator('.tabs').count()).toBe(0);
    expect(await page.locator('h1').innerText()).toBe('Organization files');
    await page.locator('#files-artifacts .gallery-tile').first().waitFor();
    expect(await page.locator('#files-artifacts .gallery-tile').count()).toBe(5);
    // Across projects each tile names its project too.
    expect(await page.locator('#files-artifacts .gallery-tile', { hasText: 'Report' }).locator('.gallery-tile-meta').innerText())
      .toBe(`site-builder #${f.tasks.first.num}`);
    await page.waitForFunction(() => [...document.querySelectorAll('#files-artifacts img')].every((img: any) => img.complete));
    await shoot('organization');
  });

  await step('a project’s folder holds its repositories, wiki and data, under the organization', async () => {
    await page.locator('.files-link', { hasText: 'site-builder' }).click();
    await page.waitForURL(`${f.server.url}${root}/site-builder`);
    await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
    expect(await rows()).toEqual(['site', 'site-wiki']);
    expect(await page.locator('.files-crumb').allInnerTexts()).toEqual([root.split('/')[1], 'site-builder']);
    await page.locator('.files-link', { hasText: /^site$/ }).click();
    await page.waitForURL(`${f.server.url}${root}/site-builder/site`);
    await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
    await page.locator('.files-link', { hasText: 'README.md' }).click();
    await page.locator('.files-rendered h1', { hasText: 'Site' }).waitFor();
    await page.locator('.files-rendered a', { hasText: 'the guide' }).click();
    await page.waitForURL(`${f.server.url}${root}/site-builder/site/docs/guide.md`);
  });

  await step('Backspace climbs back to the projects, and the address bar takes a path from there', async () => {
    for (const where of ['/site-builder/site/docs', '/site-builder/site', '/site-builder', '']) {
      await page.locator('body').press('Backspace');
      await page.waitForURL(`${f.server.url}${root}${where}`);
    }
    await page.waitForFunction(() => document.activeElement?.textContent?.includes('site-builder'));
    await page.locator('#files-address').click({ position: { x: 600, y: 10 } });
    await page.locator('#files-path-input').fill('site-builder/site/src/app.ts');
    await page.locator('#files-path-input').press('Enter');
    await page.waitForURL(`${f.server.url}${root}/site-builder/site/src/app.ts`);
    await page.locator('.files-lc', { hasText: 'answer' }).waitFor();
  });

  await step('g F opens it from anywhere', async () => {
    await page.goto(`${f.server.url}/projects/site-builder`);
    await page.locator('#task-search').waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('g');
    await page.keyboard.press('Shift+F');
    await page.waitForURL(`${f.server.url}${root}`);
    await page.locator('.files-row', { hasText: 'site-builder' }).waitFor();
  });
  expect(errors).toEqual([]);
}, 120_000);
