import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { launchChromium, openConsole } from './helpers/browser.js';
import { capsOf, projectFilesFixture, sh } from './helpers/project-files-fixture.js';
import { fakeOfflineApp } from './helpers/offline-app.js';

// Offline edits in the apps (wiki features/offline-files § Offline edits),
// in the shipped console against a real gateway and real Git remotes, the
// app's native side played by tests/helpers/offline-app.ts. tavya out of
// reach is files/changes failing at the network (page.route abort); back
// online is the route lifted and an `online` event. An edit waits on the
// device (both outbox homes) through reloads, then is merged with what
// changed meanwhile, kept beside the file when it conflicts, or — refused —
// stays with Save a copy / Download / Discard.
// Screens: SHOTS=1 writes design/offline-files/edit-*.png (not tracked).

declare const window: any, localStorage: any;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
let browser: Browser;
beforeAll(async () => { browser = await launchChromium(); });
afterAll(async () => { await browser?.close(); });
const shots = process.env.SHOTS === '1' ? path.join(import.meta.dirname, '..', 'design', 'offline-files') : '';
const shoot = async (page: Page, name: string) => {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

const NOTES = 'one\ntwo\nthree\nfour\nfive\n';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function setup() {
  const f = await projectFilesFixture(cleanups, { files: { 'notes.md': NOTES } });
  const bare = path.join(f.remotes, f.owner, 'site.git');
  const developer = await f.tokenFor(capsOf('developer') as string[]);
  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 1280, height: 820 } });
  cleanups.push(() => context.close());
  await context.addInitScript(fakeOfflineApp);
  /** Someone else saves the file meanwhile, through Files. */
  const theyWrite = async (text: string) => {
    const now = await (await f.get('site/notes.md', developer)).json();
    const response = await fetch(`${f.server.url}/api/projects/${f.project.id}/files/changes`, { method: 'POST',
      headers: { authorization: `Bearer ${developer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [{ op: 'write', path: 'site/notes.md', text, expect: now.version }] }) });
    expect(response.status).toBe(200);
  };
  const offline = () => page.route('**/files/changes**', (route) => route.abort('internetdisconnected'));
  const online = async () => {
    await page.unroute('**/files/changes**');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
  };
  const queued = () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('fake-offline-edits') || '{}')).length);
  const show = (file: string) => sh(bare, 'show', `main:${file}`);
  const listed = () => sh(bare, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n');
  const pin = async () => {
    await page.goto(`${f.server.url}/personal/site-builder/files/site`);
    const row = page.locator('#files-body .files-row', { hasText: 'notes.md' }).first();
    await row.hover();
    await row.locator('.files-more').click();
    await page.locator('.files-menu [role="menuitemcheckbox"]', { hasText: 'Available offline' }).click();
    await row.locator('.offline-mark[data-state="current"]').waitFor();
  };
  const edit = async (text: string) => {
    await page.locator('#files-edit').click();
    await page.locator('#files-edit-area').fill(text);
    await page.keyboard.press(`${mod}+s`);
  };
  return { ...f, page, errors, step, theyWrite, offline, online, queued, show, listed, pin, edit };
}

it('saves an edit on the device while tavya is out of reach, keeps it through a reload, and merges it when back', async () => {
  const f = await setup();
  await f.step('pin the file, then save an edit with no network: kept on this device', async () => {
    await f.pin();
    await f.page.goto(`${f.server.url}/personal/site-builder/files/site/notes.md`);
    await f.page.locator('#files-edit').waitFor();
    await f.offline();
    await f.edit('one\ntwo\nthree\nfour\nFIVE (from the phone)\n');
    await f.page.locator('.toast', { hasText: 'Saved on this device' }).waitFor();
    await f.page.locator('#offline-edit-bar .offline-edit-chip', { hasText: 'Edited offline' }).waitFor();
    expect(await f.queued()).toBe(1);
    await shoot(f.page, 'edit-queued');
  });

  await f.step('a reload (the app restarted) keeps it; its row says so; the device’s copy shows the edit', async () => {
    await f.page.reload();
    await f.page.locator('#offline-edit-bar .offline-edit-chip').waitFor();
    await f.page.goto(`${f.server.url}/personal/site-builder/files/site`);
    await f.page.locator('#files-body .files-row', { hasText: 'notes.md' }).locator('.offline-edit-chip', { hasText: 'Edited offline' }).waitFor();
    await f.page.goto(`${f.server.url}/personal/site-builder/files?offline`);
    await f.page.locator('.offline-view .files-row', { hasText: 'notes.md' }).locator('.offline-edit-chip').waitFor();
    await f.page.locator('.offline-view .files-link', { hasText: 'notes.md' }).click();
    await f.page.locator('.files-content', { hasText: 'FIVE (from the phone)' }).waitFor();
    expect(await f.queued()).toBe(1);
    expect(f.show('notes.md')).toBe(NOTES);
  });

  await f.step('someone changes another line meanwhile; back online, the two are merged and said once', async () => {
    await f.theyWrite('ONE (theirs)\ntwo\nthree\nfour\nfive\n');
    await f.page.goto(`${f.server.url}/personal/site-builder/files/site`);
    await f.page.locator('#files-body .files-row', { hasText: 'notes.md' }).first().waitFor();
    await f.online();
    await f.page.locator('.toast', { hasText: 'Merged with newer changes' }).waitFor({ timeout: 15_000 });
    expect(f.show('notes.md')).toBe('ONE (theirs)\ntwo\nthree\nfour\nFIVE (from the phone)\n');
    expect(f.listed().filter((file) => file.includes('offline edit'))).toEqual([]);
    expect(await f.queued()).toBe(0);
    await f.page.locator('#files-body .files-row', { hasText: 'notes.md' }).locator('.offline-edit-chip').waitFor({ state: 'detached' });
    await shoot(f.page, 'edit-merged');
  });
  expect(f.errors).toEqual([]);
});

it('edits in the Offline view, and keeps both files when the change conflicts', async () => {
  const f = await setup();
  await f.step('in the Offline view, the device’s copy is edited and kept', async () => {
    await f.pin();
    await f.page.goto(`${f.server.url}/personal/site-builder/files?offline`);
    await f.page.locator('.offline-view .files-link', { hasText: 'notes.md' }).click();
    await f.page.locator('.files-content', { hasText: 'three' }).waitFor();
    await f.offline();
    await f.edit('one\ntwo (mine)\nthree\nfour\nfive\n');
    await f.page.locator('.files-content', { hasText: 'two (mine)' }).waitFor();
    await f.page.locator('#offline-edit-bar .offline-edit-chip').waitFor();
    expect(await f.queued()).toBe(1);
    await shoot(f.page, 'edit-offline-view');
  });

  await f.step('the same line changed on tavya: back online, both are kept, the edit under a name saying whose', async () => {
    await f.theyWrite('one\ntwo (theirs)\nthree\nfour\nfive\n');
    await f.online();
    const toast = f.page.locator('.toast', { hasText: 'Kept both' });
    await toast.waitFor({ timeout: 15_000 });
    const copy = f.listed().find((file) => file.startsWith('notes (offline edit, Android '));
    expect(copy).toMatch(/^notes \(offline edit, Android \d{4}-\d\d-\d\d \d\d\.\d\d\)\.md$/);
    expect(await toast.innerText()).toContain(copy);
    expect(f.show('notes.md')).toBe('one\ntwo (theirs)\nthree\nfour\nfive\n');
    expect(f.show(copy!)).toBe('one\ntwo (mine)\nthree\nfour\nfive\n');
    expect(await f.queued()).toBe(0);
    await shoot(f.page, 'edit-kept-both');
  });
  expect(f.errors).toEqual([]);
});

it('keeps an edit tavya refuses, across reloads, until it is saved as a copy or discarded', async () => {
  const f = await setup();
  const refuse = () => f.page.route('**/files/changes**', (route) => route.fulfill({ status: 403, contentType: 'application/json',
    body: JSON.stringify({ error: 'Changing main needs permission to land work on it (merge-into:main).' }) }));
  await f.step('an edit saved offline, then refused once tavya answers: it stays, with what can be done', async () => {
    await f.pin();
    await f.page.goto(`${f.server.url}/personal/site-builder/files/site/notes.md`);
    await f.page.locator('#files-edit').waitFor();
    await f.offline();
    await f.edit('one\ntwo\nthree (refused)\nfour\nfive\n');
    await f.page.locator('#offline-edit-bar').waitFor();
    await f.page.unroute('**/files/changes**');
    await refuse();
    await f.page.reload();
    const bar = f.page.locator('#offline-edit-bar');
    await bar.locator('.offline-edit-why', { hasText: 'You can’t change this file' }).waitFor({ timeout: 15_000 });
    expect(await bar.locator('button').allInnerTexts()).toEqual(['Save a copy…', 'Open in…', 'Discard']);
    await shoot(f.page, 'edit-refused');
    // Open in… hands the edit itself to another app.
    await bar.locator('button', { hasText: 'Open in…' }).click();
    expect(await f.page.evaluate(() => window.__offline.opened)).toEqual({ edit: expect.stringContaining('site/notes.md'), name: 'notes.md' });
    await f.page.reload();
    await bar.locator('.offline-edit-why').waitFor({ timeout: 15_000 });
    expect(await f.queued()).toBe(1);
  });

  await f.step('Save a copy writes it as a new file where one may write, and only then lets it go', async () => {
    await f.page.unroute('**/files/changes**');
    await f.page.locator('#offline-edit-bar button', { hasText: 'Save a copy…' }).click();
    const prompt = f.page.locator('dialog.text-prompt');
    await prompt.locator('input').fill('site/notes, mine.md');
    await prompt.locator('button', { hasText: 'Continue' }).click();
    await f.page.locator('.toast', { hasText: 'Saved notes, mine.md' }).waitFor();
    expect(f.show('notes, mine.md')).toBe('one\ntwo\nthree (refused)\nfour\nfive\n');
    expect(f.show('notes.md')).toBe(NOTES);
    expect(await f.queued()).toBe(0);
  });

  await f.step('Discard (asked first) throws an edit away', async () => {
    await f.page.goto(`${f.server.url}/personal/site-builder/files/site/notes.md`);
    await f.page.locator('#files-edit').waitFor();
    await refuse();
    await f.offline();
    await f.edit('thrown away\n');
    await f.page.locator('#offline-edit-bar button', { hasText: 'Discard' }).click();
    await f.page.locator('#offline-edit-bar').waitFor({ state: 'detached' });
    expect(await f.queued()).toBe(0);
    expect(f.show('notes.md')).toBe(NOTES);
  });
  expect(f.errors).toEqual([]);
});
