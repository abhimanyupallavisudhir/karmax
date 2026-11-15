import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import type { WorldHandle } from '../src/world/types.js';
import { launchChromium, openConsole } from './helpers/browser.js';
import { projectFilesFixture, sh } from './helpers/project-files-fixture.js';

// The Files page as a file manager (wiki features/project-files), in the
// shipped console against a real gateway: in the default view every change is
// a commit pushed to a bare "GitHub" remote; in a task's view it lands in the
// task's real worktree world, whose terminal opens in the folder shown.
// Screens land in design/files/ when SHOTS=1.

declare const document: any, window: any, DataTransfer: any, File: any, ClipboardEvent: any, DragEvent: any;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
let browser: Browser;
beforeAll(async () => { browser = await launchChromium(); });
afterAll(async () => { await browser?.close(); });
const shots = process.env.SHOTS === '1' ? path.join(import.meta.dirname, '..', 'design', 'files') : '';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function setup() {
  const f = await projectFilesFixture(cleanups);
  const bare = path.join(f.remotes, f.owner, 'site.git');
  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 1280, height: 860 } });
  cleanups.push(() => context.close());
  const shoot = async (name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
  const rows = () => page.locator('#files-body .files-row .files-name').allInnerTexts();
  const tree = (ref = 'main') => sh(bare, 'ls-tree', '-r', '--name-only', ref).trim().split('\n');
  const show = (file: string) => sh(bare, 'show', `main:${file}`);
  // `/projects/<slug>` redirects to the organization's address, dropping the rest: learn it once.
  let base = '';
  const open = async (where: string, query = '') => {
    if (!base) {
      await page.goto(`${f.server.url}/projects/site-builder/files`);
      await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
      base = new URL(page.url()).pathname;
    }
    await page.goto(`${f.server.url}${base}${where ? `/${where.split('/').map(encodeURIComponent).join('/')}` : ''}${query}`);
  };
  // Every error toast the page shows, as it shows it (they fade).
  const toastErrors: string[] = [];
  await page.exposeFunction('reportToastError', (text: string) => { toastErrors.push(text); });
  await page.addInitScript(() => {
    new (window as any).MutationObserver((records: any[]) => {
      for (const record of records) for (const added of record.addedNodes)
        if (added.classList?.contains('toast') && added.classList.contains('err')) (window as any).reportToastError(added.textContent);
    }).observe(document, { childList: true, subtree: true });
  });
  return { ...f, bare, page, errors, step, context, shoot, rows, tree, show, open, toastErrors };
}

/** Answer the console's name prompt. */
async function answer(page: Page, value: string) {
  const input = page.locator('dialog.text-prompt .text-prompt-value');
  await input.waitFor();
  await input.fill(value);
  await input.press('Enter');
  await input.waitFor({ state: 'detached' });
}

it('manages a branch’s files: new, edit, upload, copy, cut, paste, rename, delete — each a commit', async () => {
  const s = await setup();
  const { page, step } = s;

  await step('a repository folder offers the tools; the project root does not', async () => {
    await s.open('');
    await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
    expect(await page.locator('#files-new-file').count()).toBe(0);
    await s.open('site');
    await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
    await page.locator('#files-new-file').waitFor();
    await page.locator('#files-new-folder').waitFor();
    await page.locator('#files-upload').waitFor();
  });

  await step('T makes a text file and opens it to edit; ⌘S commits it', async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Shift+T');
    await answer(page, 'notes.md');
    await page.waitForURL(/\/files\/site\/notes\.md$/);
    const area = page.locator('#files-edit-area');
    await area.waitFor();
    await area.type('# Notes\n\nWritten in Files.\n');
    expect(await page.locator('#files-edit-state').innerText()).toBe('Edited');
    await s.shoot('manager-editor');
    await area.press(`${mod}+s`);
    await page.locator('.files-rendered h1', { hasText: 'Notes' }).waitFor();
    expect(s.show('notes.md')).toBe('# Notes\n\nWritten in Files.\n');
    expect(sh(s.bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('Update notes.md');
  });

  await step('e edits an existing file; Esc leaves without saving', async () => {
    await s.open('site/src/app.ts');
    await page.locator('.files-lc', { hasText: 'answer' }).waitFor();
    await page.keyboard.press('e');
    const area = page.locator('#files-edit-area');
    await area.waitFor();
    expect(await area.inputValue()).toBe('export const answer = 42;\n');
    await area.fill('export const answer = 43;\n');
    await page.locator('#files-edit-save').click();
    await page.locator('.files-lc', { hasText: '43' }).waitFor();
    expect(s.show('src/app.ts')).toBe('export const answer = 43;\n');
    await page.keyboard.press('e');
    await area.waitFor();
    await area.press('Escape');
    await area.waitFor({ state: 'detached' });
  });

  await step('F makes a folder; files and a folder upload into it', async () => {
    await s.open('site');
    await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
    await page.keyboard.press('Shift+F');
    await answer(page, 'incoming');
    await page.locator('.files-row', { hasText: 'incoming' }).waitFor();
    expect(s.tree()).toContain('incoming/.gitkeep');
    await page.locator('.files-link', { hasText: 'incoming' }).click();
    await page.waitForURL(/\/files\/site\/incoming$/);
    await page.locator('.files-row', { hasText: '.gitkeep' }).waitFor();
    const files = page.waitForEvent('filechooser');
    await page.keyboard.press('Shift+U');
    await (await files).setFiles([{ name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('one\n') },
      { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('two\n') }]);
    await page.locator('.files-row', { hasText: 'two.txt' }).waitFor();
    expect(s.show('incoming/one.txt')).toBe('one\n');
    // A folder, through the Upload menu.
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-'));
    cleanups.push(() => fs.rmSync(local, { recursive: true, force: true }));
    fs.mkdirSync(path.join(local, 'photos', 'raw'), { recursive: true });
    fs.writeFileSync(path.join(local, 'photos', 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(local, 'photos', 'raw', 'b.txt'), 'b\n');
    await page.locator('#files-upload').click();
    const folder = page.waitForEvent('filechooser');
    await page.locator('.files-menu button', { hasText: 'A folder' }).click();
    await (await folder).setFiles(path.join(local, 'photos'));
    await page.locator('.files-row', { hasText: 'photos' }).waitFor();
    expect(s.show('incoming/photos/raw/b.txt')).toBe('b\n');
  });

  await step('a drop uploads, and so does pasting files', async () => {
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['dropped\n'], 'dropped.txt', { type: 'text/plain' }));
      document.querySelector('#files-body').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await page.locator('.files-row', { hasText: 'dropped.txt' }).waitFor();
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['pasted\n'], 'pasted.txt', { type: 'text/plain' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await page.locator('.files-row', { hasText: 'pasted.txt' }).waitFor();
    expect(s.show('incoming/dropped.txt')).toBe('dropped\n');
    expect(s.show('incoming/pasted.txt')).toBe('pasted\n');
  });

  await step('select with ⌘-click and Shift-click, copy with ⌘C, paste elsewhere with ⌘V', async () => {
    await page.locator('.files-link', { hasText: 'one.txt' }).click({ modifiers: [mod] });
    await page.locator('.files-link', { hasText: 'two.txt' }).click({ modifiers: ['Shift'] });
    expect(await page.locator('.files-row.selected .files-name').allInnerTexts()).toEqual(['one.txt', 'pasted.txt', 'two.txt']);
    await s.shoot('manager-selection');
    await page.keyboard.press(`${mod}+c`);
    await s.open('site/docs');
    await page.locator('.files-row', { hasText: 'guide.md' }).waitFor();
    await page.keyboard.press(`${mod}+v`);
    await page.locator('.files-row', { hasText: 'two.txt' }).waitFor();
    expect(s.tree()).toEqual(expect.arrayContaining(['docs/one.txt', 'docs/pasted.txt', 'docs/two.txt', 'incoming/one.txt']));
    // Pasting again here makes copies, never overwrites.
    await page.keyboard.press(`${mod}+v`);
    await page.locator('.files-row', { hasText: 'one copy.txt' }).waitFor();
  });

  await step('⌘X then ⌘V moves; F2 renames; Delete deletes', async () => {
    await page.locator('.files-link', { hasText: 'guide.md' }).focus();
    await page.keyboard.press(`${mod}+x`);
    await page.locator('.files-row.cut', { hasText: 'guide.md' }).waitFor();
    await s.open('site/incoming');
    await page.locator('.files-row', { hasText: 'photos' }).waitFor();
    await page.keyboard.press(`${mod}+v`);
    await page.locator('.files-row', { hasText: 'guide.md' }).waitFor();
    expect(s.tree()).toContain('incoming/guide.md');
    expect(s.tree()).not.toContain('docs/guide.md');
    await page.locator('.files-link', { hasText: 'guide.md' }).focus();
    await page.keyboard.press('F2');
    await answer(page, 'handbook.md');
    await page.locator('.files-row', { hasText: 'handbook.md' }).waitFor();
    expect(sh(s.bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('Rename guide.md to handbook.md');
    await page.locator('.files-link', { hasText: 'handbook.md' }).focus();
    await page.keyboard.press('Delete');
    await page.locator('.files-row', { hasText: 'handbook.md' }).waitFor({ state: 'detached' });
    expect(s.tree()).not.toContain('incoming/handbook.md');
  });

  await step('a row’s menu (right-click) and the folder’s menu', async () => {
    await page.locator('.files-link', { hasText: 'one.txt' }).click({ button: 'right' });
    expect(await page.locator('.files-menu button').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining('Rename')]));
    await s.shoot('manager-menu');
    await page.keyboard.press('Escape');
    await page.locator('.files-menu').waitFor({ state: 'detached' });
  });
  expect(s.errors).toEqual([]);
  expect(s.toastErrors).toEqual([]);
}, 180_000);

it('changes a task’s world and opens its terminal in the folder shown', async () => {
  const s = await setup();
  const { page, step } = s;
  const task = await s.store.createTask({ projectId: s.project.id, title: 'Rework the docs', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(s.dir, 'task-worlds')));
  const world = await worlds.create('worktree', { taskId: task.id, repos: [s.site.work], base: 'main' });
  world.handle.meta = { projectId: s.project.id };
  const handle = await s.store.registerWorld(world.handle, s.project.id) as WorldHandle;
  await s.store.setWorldState(handle, 'ready');
  await s.store.saveView(task.id, { taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [], world: handle } as any);
  const root = handle.root;

  await step('a new folder in the task’s view is made in its world', async () => {
    await s.open('', `?task=${task.num}`);
    await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
    await page.locator('#files-new-folder').click();
    await answer(page, 'drafts');
    await page.locator('.files-row', { hasText: 'drafts' }).waitFor();
    expect(fs.statSync(path.join(root, 'drafts')).isDirectory()).toBe(true);
    expect(s.tree()).not.toContain('drafts/.gitkeep');
  });

  await step('pasting from the default view copies into the world', async () => {
    await s.open('site/src');
    await page.locator('.files-row', { hasText: 'app.ts' }).waitFor();
    await page.locator('.files-link', { hasText: 'app.ts' }).focus();
    await page.keyboard.press(`${mod}+c`);
    await s.open('drafts', `?task=${task.num}`);
    await page.locator('.files-status', { hasText: 'Empty folder' }).waitFor();
    await page.locator('#files-new-file').waitFor();
    await page.keyboard.press(`${mod}+v`);
    await page.locator('.files-row', { hasText: 'app.ts' }).waitFor();
    expect(fs.readFileSync(path.join(root, 'drafts/app.ts'), 'utf8')).toBe('export const answer = 42;\n');
  });

  await step('Ctrl+` opens a shell in that folder', async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+`');
    const screen = page.locator('#files-term #term-out');
    await screen.waitFor();
    await page.locator('.files-term-where', { hasText: '/drafts' }).waitFor();
    await screen.click();
    await page.keyboard.type('pwd && ls\n');
    await page.waitForFunction((dir) => document.querySelector('#term-out')?.textContent?.includes(dir), path.join(root, 'drafts'));
    await page.waitForFunction(() => /app\.ts/.test(document.querySelector('#term-out')?.textContent || ''));
    await s.shoot('manager-terminal');
    // It stays open while you move about the folders.
    await page.keyboard.press('Escape');
    await page.locator('.files-crumb', { hasText: 'site-builder' }).click();
    await page.locator('.files-row', { hasText: 'drafts' }).waitFor();
    await page.locator('#files-term #term-out').waitFor();
    expect(await page.locator('#term-out').innerText()).toContain('app.ts');
    await page.locator('#files-term-close').click();
    await page.locator('#files-term').waitFor({ state: 'detached' });
  });

  await step('in the default view the terminal starts a scratch task and opens in its view', async () => {
    let asked: any = null;
    await page.route('**/api/tasks', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      asked = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: task.id, num: task.num }) });
    });
    await s.open('site');
    await page.locator('#files-terminal').waitFor();
    await page.locator('#files-terminal').click();
    await page.waitForURL(new RegExp(`\\?task=${task.num}$`));
    await page.locator('#files-term #term-out').waitFor();
    expect(asked).toMatchObject({ projectId: s.project.id, workflow: 'script-exec', command: 'true', title: 'Terminal on the default branch' });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.locator('#files-term-close').click();
  });
  expect(s.errors).toEqual([]);
  expect(s.toastErrors).toEqual([]);
}, 120_000);
