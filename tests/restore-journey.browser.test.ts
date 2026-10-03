import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { consoleRequest, launchApp, launchChromium, openConsole, stopEmbeddedTemporal, type AppProcess } from './helpers/browser.js';
import { createBackup, restoreBackup } from '../src/ops/backup.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';

const PASSWORD = 'long-restore-password';

// Backup and restore as an operator runs them, on the installed app itself:
// src/main.ts with its embedded Temporal, the mock agent, and the console.
let browser: Browser;
let root: string;
let app: AppProcess | undefined;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-restore-journey-'));
  browser = await launchChromium();
});
afterAll(async () => {
  await app?.stop();
  await stopEmbeddedTemporal(path.join(root, 'home'));
  await browser?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it('restores a backup over lost state, and the console carries the restored task through to merge (CI-38x)', async () => {
  const home = path.join(root, 'home'), repo = path.join(root, 'repo');
  fs.mkdirSync(home);
  await gitOrThrow(root, ['init', '-q', '-b', 'main', repo]);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# restore\n');
  await gitOrThrow(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);

  app = await launchApp(home);
  let operator = await openConsole(browser);
  await operator.step('create the administrator on the fresh install', async () => {
    await operator.page.goto(app!.url);
    await operator.page.getByLabel('Name').fill('Rita Restorer');
    await operator.page.getByLabel('Email').fill('rita@example.test');
    await operator.page.getByLabel('Password (10+ characters)').fill(PASSWORD);
    await operator.page.locator('#setup-btn').click();
    await operator.page.locator('#new-project').waitFor();
  });
  const project = await consoleRequest(operator.context, app.url, 'POST', '/api/projects', { name: 'Restorable',
    config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } });
  await consoleRequest(operator.context, app.url, 'POST', '/api/vault/items', { type: 'login', label: 'Restorable login',
    domains: 'restore.example.test', username: 'restorer', secrets: { password: 'kept-in-the-vault' } });
  await operator.step('open the project', () => operator.page.goto(`${app!.url}/personal/restorable`));
  await operator.page.locator('#new-task').fill('@write restored.txt :: survived the restore');
  await operator.page.locator('#new-task').press('Control+Enter');
  const reviewed = async () => (await consoleRequest(operator.context, app!.url, 'GET', `/api/projects/${project.id}/tasks`))
    .find((task: any) => task.title.includes('@write restored.txt'))?.lastView?.stage;
  await operator.step('the agent reaches Review', () => expect.poll(reviewed, { timeout: 30_000 }).toBe('review'));
  expect(operator.errors).toEqual([]);
  await operator.context.close();
  await app.stop();

  await createBackup({ home, destination: path.join(root, 'backup') });
  // Backups never carry the vault key (SS-2): the operator keeps a copy off-host.
  const keptKey = path.join(root, 'vault.key');
  fs.copyFileSync(path.join(home, 'vault', 'vault.key'), keptKey);
  // The disk holding karmax's metadata and vault is lost; task worlds and the
  // persistent Temporal server survive, as they would on another volume.
  fs.rmSync(path.join(home, 'state'), { recursive: true });
  fs.rmSync(path.join(home, 'vault'), { recursive: true });
  const manifest = await restoreBackup(path.join(root, 'backup'), { home, vaultKeyFile: keptKey });
  expect(manifest.temporal).toBe('embedded');

  app = await launchApp(home);
  operator = await openConsole(browser);
  const { page, step, errors } = operator;
  await step('sign in with the restored account', async () => {
    await page.goto(`${app!.url}/login`);
    await page.getByLabel('Email').fill('rita@example.test');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.locator('#login-btn').click();
    await page.locator('#new-project').waitFor();
  });
  await step('open the restored project', () => page.goto(`${app!.url}/personal/restorable`));
  const row = page.locator('.task-row').filter({ hasText: '@write restored.txt' });
  await step('the restored task is listed', () => row.waitFor());
  await row.locator('.row-link').click();
  const confirm = page.locator('#tp-foot [data-act="confirm"]:not([disabled])');
  await step('its restored workflow is still waiting in Review', () => confirm.waitFor({ timeout: 30_000 }));
  await confirm.click();
  await step('it lands on main', () => expect.poll(async () => (await git(repo, ['show', 'main:restored.txt'])).stdout,
    { timeout: 30_000 }).toContain('survived the restore'));
  await step('open Passwords & payments', () => page.goto(`${app!.url}/personal/settings#settings-payments`));
  await step('the restored vault item is listed', async () => {
    await page.locator('#vault-manage-open').getByText('1 item').waitFor();
    await page.locator('#vault-manage-open').click();
    await page.getByText('Restorable login').first().waitFor();
  });
  expect(errors).toEqual([]);
  await operator.context.close();
}, 180_000);
