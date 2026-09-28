import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/** The public landing page, rendered by the console in a real browser. */
async function landing(options: { viewport?: { width: number; height: number } } = {}) {
  const ui = await consolePage(options);
  await ui.run(`S.meta = { siteName: 'tavya' }; renderLanding()`);
  return ui;
}

const signedOut = ({ path }: { path: string }) => path === '/api/meta' ? { siteName: 'tavya' }
  : path === '/api/launch' ? {} : path === '/api/session' ? { authRequired: true, authenticated: false } : undefined;

describe('public landing page', () => {
  it('renders the installation\'s name in the homepage and representative screenshot, including its address bar', async () => {
    const ui = await landing();
    const { page } = ui;
    expect(await page.title()).toBe('tavya — the to-do list for agents');
    expect(await page.locator('.product-browserbar span').textContent()).toBe('console.test / tavya');
    expect(await page.locator('.product-wordmark strong').textContent()).toBe('tavya');
    expect(await page.locator('.product-project.active').textContent()).toBe('◇ tavya');
    // The issue-tracker URL is a repository identifier, not branding.
    expect(await page.locator('.landing-page').innerText()).not.toMatch(/krmax/i);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('is the signed-out root while direct auth and invitation routes stay direct', async () => {
    const screen = async (path: string) => {
      const ui = await consolePage({ path, api: signedOut });
      await ui.run('boot()');
      await ui.page.locator('#app > *').first().waitFor();
      const shown = await ui.page.evaluate(() => document.querySelector('#landing-main') ? 'landing'
        : document.querySelector('#signup-btn') ? 'signup'
          : document.querySelector('#login-btn') ? 'login' : document.getElementById('app')!.innerText.slice(0, 80));
      await ui.close();
      return shown;
    };
    expect(await screen('/')).toBe('landing');
    expect(await screen('/login')).toBe('login');
    expect(await screen('/signup')).toBe('signup');
    expect(await screen('/invite?token=invitation')).toBe('login');
    expect(await screen('/?error=access_denied')).toBe('login');
  });

  it('carries the product thesis and each promised capability', async () => {
    const ui = await landing();
    const text = (await ui.page.locator('.landing-page').innerText()).replace(/\s+/g, ' ');
    for (const claim of ['vscode was a fancy text editor.', 'tavya is a fancy to-do list.',
      'The interface for the era of managing agents rather than manually coding/working.',
      'Agents work parallelly in isolated cloud worlds.', 'Yes, gitignored files are handled correctly.',
      'secrets, databases, big files', 'Bring your own key or OpenAI/Claude subscription',
      'tavya MCP lets agents access and manage your tavya projects',
      'Connect your apps and a payment card, and let agents Just Do Things.',
      'buy me a website and deploy to it', 'run the experiment on vast.ai', 'As human-in-the-loop as you like.',
      'robust authorization system', 'Leave the permanent underclass today.'])
      expect(text).toContain(claim);
    expect(text.match(/Just do things\./g)).toHaveLength(2);
    for (const retired of ['password vault and a payment card', 'Everything is a to-do list.', 'No new AI subscription',
      'The whole idea', 'Human in the loop', 'Your Integrated Management Environment'])
      expect(text).not.toContain(retired);
    expect(await ui.page.locator('.landing-page em').allInnerTexts()).toEqual(['one place', 'you']);
    await ui.close();
  });

  it('uses a faithful, installation-branded task list to advertise implemented features', async () => {
    const ui = await landing();
    const { page } = ui;
    expect(await page.getByRole('figure', { name: 'tavya task list showing agents working in parallel' }).count()).toBe(1);
    expect(await page.locator('.product-task strong').allInnerTexts()).toEqual([
      'Support e2b cloud environments for agents',
      'Support Github auto-merge, merge queues in addition to native merge queue',
      'Password vault: implement git-backed unix pass importer',
      'Let agents create accounts with agentmail.to',
      'Add spending limits for agents',
      'MathJaX support in agent conversations',
      'Wiki-based agent memory',
    ]);
    expect(await page.locator('.product-task .product-stage.done').count()).toBe(7);
    expect(await page.locator('.product-topline').innerText()).toMatch(/Queues\s+Wiki\s+Settings/);
    await ui.close();
  });

  it('lists capabilities as a checklist, so an item without detail is just a shorter row', async () => {
    const ui = await landing();
    const items = ui.page.locator('.landing-checklist > li');
    expect(await items.count()).toBe(5);
    expect(await ui.page.locator('.landing-checklist > li > .landing-tick').count()).toBe(5);
    expect(await ui.page.locator('.landing-checklist article').count()).toBe(0);
    const heights = await items.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    // "Agents work parallelly…" has no detail line; the gitignore item has one.
    expect(heights[0]).toBeLessThan(heights[1]!);
    await ui.close();
  });

  it('follows the system theme until the visitor pins one, sharing the console preference', async () => {
    const ui = await landing();
    const { page } = ui;
    const background = () => page.locator('.landing-page').evaluate((element) => getComputedStyle(element).backgroundColor);
    const toggle = page.locator('#landing-theme');
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await background();
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await background();
    expect(light).not.toBe(dark); // unpinned, it follows the system
    await ui.run('labelLandingTheme(document.getElementById("landing-theme"))');
    expect(await toggle.getAttribute('aria-label')).toBe('Switch to light theme');
    await toggle.click();
    expect(await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('karmax-theme')]))
      .toEqual(['light', 'light']);
    expect(await toggle.getAttribute('aria-label')).toBe('Switch to dark theme');
    expect(await background()).toBe(light); // pinned light overrides the dark system theme
    await page.emulateMedia({ colorScheme: 'light' });
    await toggle.click();
    expect(await page.evaluate(() => localStorage.getItem('karmax-theme'))).toBe('dark');
    expect(await background()).toBe(dark);
    await ui.close();
  });

  it('is keyboard-visible, responsive, and respects reduced motion', async () => {
    const ui = await landing({ viewport: { width: 1280, height: 900 } });
    const { page } = ui;
    const skip = page.getByRole('link', { name: 'Skip to content' });
    const top = () => skip.evaluate((element) => element.getBoundingClientRect().bottom);
    expect(await top()).toBeLessThanOrEqual(0); // hidden above the page until focused
    await page.keyboard.press('Tab');
    expect(await skip.evaluate((element) => element === document.activeElement)).toBe(true);
    await expect.poll(top).toBeGreaterThan(0);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('solid');

    const navHeight = () => page.locator('.landing-nav-inner').evaluate((element) => element.getBoundingClientRect().height);
    const wide = await navHeight();
    await page.setViewportSize({ width: 600, height: 900 });
    expect(await navHeight()).toBe(58);
    expect(wide).not.toBe(58);

    const animation = () => page.locator('.product-task').first().evaluate((element) => getComputedStyle(element).animationName);
    expect(await animation()).not.toBe('none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await animation()).toBe('none');
    expect(await page.locator('.product-stage.working').first().isVisible()).toBe(false);
    await ui.close();
  });

  it('sends public GitHub links to the issue tracker, never the private repository', async () => {
    const ui = await landing();
    const github = (await ui.page.locator('a[href*="github.com"]').evaluateAll((links) => links.map((link) => link.getAttribute('href'))));
    expect(github).toEqual(['https://github.com/abhimanyupallavisudhir/krmax-issues/issues',
      'https://github.com/abhimanyupallavisudhir/krmax-issues/issues']);
    await ui.close();
  });
});
