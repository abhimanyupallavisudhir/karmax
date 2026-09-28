import { afterAll, describe, expect, it } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeConsoleBrowser, consolePage, type ApiCall, type ApiHandler } from './helpers/console-page.js';

/**
 * "Select all → Import" from a `pass` store looked like a dead button: one
 * blocking request decrypted ~600 entries (ten minutes of GPG on a real store)
 * with no feedback, and a single unreadable entry threw the whole batch away.
 * The client now imports in batches and reports progress.
 */
afterAll(closeConsoleBrowser);
const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');

function importFromConnector() {
  const source = app.match(/async function importFromConnector\([\s\S]*?\n}/)?.[0];
  expect(source, 'importFromConnector() should exist in web/app.js').toBeTruthy();
  return new Function(`${source}; return importFromConnector;`)() as (
    sync: (batch: string[]) => Promise<any>,
    externalIds: string[],
    onProgress?: (p: any) => void,
    batchSize?: number,
  ) => Promise<{ imported: number; skipped: number; failures: any[]; done: number; total: number }>;
}

describe('connector import (web)', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `sites/${i}.com`);

  it('splits the selection into batches and reports progress as they land', async () => {
    const batches: string[][] = [];
    const progress: Array<{ done: number; total: number }> = [];
    const result = await importFromConnector()(
      async (batch) => { batches.push(batch); return { count: batch.length, skipped: 0, failures: [] }; },
      ids,
      (p) => progress.push({ done: p.done, total: p.total }),
      10,
    );
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(progress.map((p) => p.done)).toEqual([0, 10, 20, 25]);
    expect(progress.every((p) => p.total === 25)).toBe(true);
    expect(result.imported).toBe(25);
  });

  it('accumulates what landed, what was unchanged, and what failed', async () => {
    const result = await importFromConnector()(
      async (batch) => batch[0] === 'sites/0.com'
        ? { count: 9, skipped: 1, failures: [{ externalId: 'sites/3.com', error: 'gpg: no secret key' }] }
        : { count: batch.length, skipped: 0, failures: [] },
      ids,
      undefined,
      10,
    );
    expect(result).toMatchObject({ imported: 24, skipped: 1, done: 25, total: 25 });
    expect(result.failures).toEqual([{ externalId: 'sites/3.com', error: 'gpg: no secret key' }]);
  });

  it('stops on a systemic failure so the reason reaches the user', async () => {
    let calls = 0;
    await expect(importFromConnector()(
      async () => { calls++; throw new Error('your GPG key is locked'); },
      ids, undefined, 10,
    )).rejects.toThrow(/GPG key is locked/);
    expect(calls).toBe(1);
  });

  const passGit = { name: 'pass-git', label: 'pass (Git)', setup: 'git-pass', available: true, detail: 'git@github.com:me/store.git',
    canPush: true, config: {} };
  const entries = [
    { externalId: 'web/a.com', label: 'a.com', type: 'login', folder: 'web' },
    { externalId: 'web/b.com', label: 'b.com', type: 'login', folder: 'web' },
    { externalId: 'mail', label: 'mail', type: 'login' },
  ];

  /** The organization's Passwords card, wired to a scripted vault. */
  async function passwords(api: ApiHandler = () => undefined) {
    const ui = await consolePage({ api: async (call: ApiCall) => {
      const reply = await api(call);
      if (reply !== undefined) return reply;
      const pathname = call.path.split('?')[0]!;
      if (pathname === '/api/vault/items' || pathname === '/api/vault/requests') return [];
      if (pathname === '/api/vault/connectors') return [passGit];
      if (pathname === '/api/organizations/o/git-profiles') return { profiles: [{ name: 'work', userName: 'Work Bot' }], defaultProfile: 'personal' };
      if (pathname === '/api/vault/connectors/pass-git/catalog') return { items: entries, failures: [] };
      return undefined;
    } });
    await ui.run(`document.getElementById('main').innerHTML = passwordsCard(); wireVaultCards('o')`);
    await ui.page.locator('#vault-card [data-conn="pass-git"]').waitFor();
    return ui;
  }
  const sent = (ui: Awaited<ReturnType<typeof consolePage>>, suffix: string) =>
    ui.calls.filter((call) => call.method === 'POST' && call.path.split('?')[0]!.endsWith(suffix)).map((call) => call.body);

  it('disables and relabels the Import button while the import runs', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ui = await passwords(async ({ path }) => path.startsWith('/api/vault/connectors/pass-git/sync')
      ? held.then(() => ({ count: 3, skipped: 0, failures: [] })) : path.startsWith('/api/vault/connectors/pass-git/config') ? {} : undefined);
    await ui.page.locator('[data-conn="pass-git"] [data-conn-import]').click();
    await ui.page.locator('.imp-all').check();
    const go = ui.page.locator('[data-imp-go]');
    await go.click();
    await expect.poll(() => go.textContent()).toBe('Importing 0/3…');
    // Disabled itself, not only marked busy by the console's generic click feedback.
    expect(await go.evaluate((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    release();
    // Success closes the panel; the summary reaches the user.
    await expect.poll(() => ui.toasts()).toContain('Imported 3 item(s)');
    await ui.close();
  });

  it('re-enables Import after a failure so the user can retry', async () => {
    const ui = await passwords(({ path }) => path.startsWith('/api/vault/connectors/pass-git/sync')
      ? { status: 500, json: { error: 'your GPG key is locked' } } : undefined);
    await ui.page.locator('[data-conn="pass-git"] [data-conn-import]').click();
    await ui.page.locator('.imp-pick').first().check();
    const go = ui.page.locator('[data-imp-go]');
    await go.click();
    await expect.poll(() => ui.toasts()).toContain('your GPG key is locked');
    expect(await go.evaluate((button) => (button as HTMLButtonElement).disabled)).toBe(false);
    expect(await go.textContent()).toBe('Import');
    await ui.close();
  });

  it('offers a bounded browser import for a Bitwarden JSON export', async () => {
    const ui = await passwords(({ method, path }) => method === 'POST' && path === '/api/vault/import/bitwarden?organizationId=o'
      ? { count: 2, created: 1, updated: 1, skipped: [] } : undefined);
    const row = ui.page.locator('.bitwarden-file-import');
    expect(await row.textContent()).toContain('one-way import');
    expect(await row.textContent()).toContain('Export your Bitwarden to a JSON file and import it here (no write-back).');
    expect(await row.locator('input[type="file"]').getAttribute('accept')).toBe('.json,application/json');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-bitwarden-'));
    const pick = async (contents: Buffer) => {
      const file = path.join(dir, `export-${contents.length}.json`);
      fs.writeFileSync(file, contents);
      const chooser = ui.page.waitForEvent('filechooser');
      await row.getByRole('button', { name: 'Import JSON…' }).click();
      await (await chooser).setFiles(file);
    };

    await pick(Buffer.from(JSON.stringify({ items: [{ name: 'a' }] })));
    await expect.poll(() => ui.toasts()).toContain('Imported 2 items · 1 new · 1 updated. Delete the plaintext export from your device.');
    expect(sent(ui, '/api/vault/import/bitwarden')).toEqual([{ export: { items: [{ name: 'a' }] } }]);

    await pick(Buffer.from('not json'));
    await expect.poll(() => ui.toasts()).toContain('Select a valid Bitwarden JSON export');
    // Anything over 50 MB is refused in the browser, before it is read or sent.
    await pick(Buffer.alloc(50 * 1024 * 1024 + 1, 32));
    await expect.poll(() => ui.toasts()).toContain('Bitwarden export is larger than 50 MB');
    expect(sent(ui, '/api/vault/import/bitwarden')).toHaveLength(1);
    expect(await row.getByRole('button', { name: 'Import JSON…' }).isEnabled()).toBe(true);
    await ui.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('offers hosted Git-backed pass setup with Git-profile and GPG inputs', async () => {
    const ui = await passwords(({ path }) => path.startsWith('/api/vault/connectors/pass-git/connect')
      ? { connector: { checks: [{ store: 'root', read: 'verified', encryption: true, push: true }] } } : undefined);
    await ui.page.locator('[data-conn="pass-git"] [data-git-pass-connect]').click();
    const dialog = ui.page.getByRole('dialog', { name: 'Connect unix pass through Git' });
    await dialog.waitFor();
    expect(await dialog.locator('.git-pass-profile option').allTextContents())
      .toEqual(['Organization default — personal', 'work · Work Bot']);
    await dialog.locator('.git-pass-repo').fill('git@github.com:me/store.git');
    await dialog.locator('.git-pass-path').fill('pass');
    await dialog.locator('.git-pass-profile').selectOption('work');
    await dialog.locator('.git-pass-key').fill('-----BEGIN PGP PRIVATE KEY BLOCK-----');
    await dialog.locator('.git-pass-passphrase').fill('secret');
    await dialog.getByRole('button', { name: 'Replace connection' }).click();
    await expect.poll(() => sent(ui, '/api/vault/connectors/pass-git/connect')).toHaveLength(1);
    expect(JSON.parse(sent(ui, '/api/vault/connectors/pass-git/connect')[0].secret)).toEqual({
      repositoryUrl: 'git@github.com:me/store.git', crypto: 'gpg', storePath: 'pass', gitProfile: 'work',
      gpgPrivateKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----', gpgPassphrase: 'secret', mounts: [],
    });
    await expect.poll(() => dialog.count()).toBe(0);
    await ui.close();
  });

  it('offers selective automatic updates and makes automatic discovery select everything', async () => {
    const ui = await passwords(({ path }) => path.startsWith('/api/vault/connectors/pass-git/sync') ? { count: 1, skipped: 0, failures: [] }
      : path.startsWith('/api/vault/connectors/pass-git/config') ? {} : undefined);
    await ui.page.locator('[data-conn="pass-git"] [data-conn-import]').click();
    const keep = ui.page.getByLabel('Keep selected credentials updated');
    const importNew = ui.page.getByLabel('Import new credentials automatically');
    const picks = ui.page.locator('.imp-pick');
    await picks.first().waitFor();
    await importNew.check();
    // Discovering new entries implies keeping every entry, so the choice is taken away.
    expect(await picks.evaluateAll((boxes) => boxes.map((box) => [(box as HTMLInputElement).checked, (box as HTMLInputElement).disabled])))
      .toEqual([[true, true], [true, true], [true, true]]);
    expect([await keep.isChecked(), await keep.isDisabled()]).toEqual([true, true]);
    await importNew.uncheck();
    expect(await picks.first().isEnabled()).toBe(true);
    await ui.page.locator('.imp-all').uncheck();
    await picks.nth(1).check(); // entries outside a folder come first
    await ui.page.locator('[data-imp-go]').click();
    await expect.poll(() => sent(ui, '/api/vault/connectors/pass-git/config')).toHaveLength(1);
    expect(sent(ui, '/api/vault/connectors/pass-git/config')[0]).toMatchObject({
      autoSync: { keepUpdated: true, importNew: false, externalIds: ['web/a.com'] } });
    await ui.close();
  });
});
