import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

// Bodies passed to page.evaluate run in the page; this file has no DOM lib.
declare const document: any, getComputedStyle: any;

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
  it('names the installation in its title, header, film and footer', async () => {
    const ui = await landing();
    const { page } = ui;
    expect(await page.title()).toBe('tavya — the agentic to-do list that finishes itself');
    expect(await page.locator('.landing-nav .landing-brand span').textContent()).toBe('tavya');
    expect(await page.locator('#lv-film').getAttribute('aria-label')).toMatch(/^tavya’s launch film, 0:59/);
    expect((await page.locator('.lv-end .landing-start').innerText()).replace(/\s+/g, ' ')).toBe('Get started with tavya →');
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
      // Sign in and create account are one page; its title names what was asked for.
      const shown = await ui.run<string>(`document.querySelector('#landing-main') ? 'landing'
        : document.querySelector('#auth-signin #login-btn') && document.querySelector('#auth-signup #signup-btn') ? document.title.split(' · ')[0]
          : document.getElementById('app').innerText.slice(0, 80)`);
      await ui.close();
      return shown;
    };
    expect(await screen('/')).toBe('landing');
    expect(await screen('/login')).toBe('Sign in');
    expect(await screen('/signup')).toBe('Create account');
    expect(await screen('/invite?token=invitation')).toBe('Sign in');
    expect(await screen('/?error=access_denied')).toBe('Sign in');
  });

  it('signs in and creates accounts on one page, with the social buttons for both', async () => {
    const api = ({ method, path }: { method: string; path: string }) => path === '/api/session'
      ? { authRequired: true, authenticated: false, google: true, github: true }
      : method === 'POST' && path === '/api/signup' ? { status: 422, json: { message: 'User already exists. Use another email.' } }
        : method === 'POST' && path === '/api/legal/preaccept' ? { ok: true }
          : method === 'POST' && path === '/api/auth/sign-in/social' ? { status: 500, json: { error: 'stop here' } }
            : signedOut({ path });
    const ui = await consolePage({ path: '/signup', api, viewport: { width: 390, height: 844 } });
    const { page } = ui;
    await ui.run('boot()');
    const signIn = page.getByRole('form', { name: 'Sign in' });
    const signUp = page.getByRole('form', { name: 'Create account' });
    await signUp.waitFor();
    // A phone stacks them, the short sign-in first, under the social buttons.
    const tops = await page.evaluate(() => ['.auth-social', '#auth-signin', '#auth-signup']
      .map((selector) => document.querySelector(selector).getBoundingClientRect().top));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(await page.locator('#signup-open, #signup-back').count()).toBe(0);

    // A social button records the policies only when the sign-up box is ticked.
    await page.locator('#google-btn').click();
    await page.locator('#social-err').getByText('stop here').waitFor();
    expect(ui.calls.some((call) => call.path === '/api/legal/preaccept')).toBe(false);
    await page.locator('#signup-policy-acceptance').check();
    await page.locator('#github-btn').click();
    await expect.poll(() => ui.calls.filter((call) => call.path === '/api/legal/preaccept').length).toBe(1);

    // An address that already has an account is handed to the sign-in form.
    await signUp.getByLabel('Name').fill('Ann');
    await signUp.getByLabel('Email').fill('ann@example.test');
    await signUp.getByLabel('Password (10+ characters)').fill('long-enough-password');
    await signUp.getByLabel('Password (10+ characters)').press('Enter');
    await signUp.getByText('An account with that email already exists. Sign in instead.').waitFor();
    expect(await signIn.getByLabel('Email').inputValue()).toBe('ann@example.test');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('pw');
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('opens on the launch film, right under its headline', async () => {
    const ui = await landing({ viewport: { width: 1440, height: 900 } });
    const { page } = ui;
    expect(await page.locator('#landing-title').innerText()).toBe('The agentic to-do list that finishes itself.');
    expect(await page.locator('#landing-title .lv-gold').innerText()).toBe('finishes itself.');
    const film = page.locator('#lv-film');
    expect(await film.getAttribute('src')).toBe('/media/tavya-launch.mp4');
    expect(await film.getAttribute('poster')).toBe('/media/tavya-launch-poster.jpg');
    const state = await film.evaluate((video: any) => ({ muted: video.muted, loop: video.loop, inline: video.playsInline, controls: video.controls }));
    expect(state).toEqual({ muted: true, loop: true, inline: true, controls: false });
    // It is the first thing after the headline, and starts on the first screen.
    const order = await page.evaluate(() => [...document.querySelectorAll('#landing-title, #lv-film, .lv-chapter')].map((el) => el.id || el.className.split(' ')[0]));
    expect(order.slice(0, 3)).toEqual(['landing-title', 'lv-film', 'lv-chapter']);
    expect((await film.boundingBox())!.y).toBeLessThan(900 / 2);
    // Watch with sound: from the top, with sound and the player's controls.
    await page.locator('#lv-sound').click();
    const watching = await film.evaluate((video: any) => ({ muted: video.muted, loop: video.loop, controls: video.controls, at: video.currentTime }));
    expect(watching).toMatchObject({ muted: false, loop: false, controls: true });
    expect(watching.at, 'from the top').toBeLessThan(1);
    expect(await page.locator('#lv-sound').isVisible()).toBe(false);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('tells the film\'s chapters in its order, each pictured by a still from it', async () => {
    const ui = await landing();
    const { page } = ui;
    const titles = await page.locator('.lv-chapter h2, .lv-card h2, .lv-pocket h2, .lv-end h2').allInnerTexts();
    expect(titles.map((title) => title.replace(/\s+/g, ' '))).toEqual(['Every project. One list.', 'Say what needs doing.',
      'Agents work on their own computers.', 'Big jobs fan out.', 'Review the result, not the process.', 'Not just code.',
      'Give agents accounts, keys and a card.', 'Work that starts itself.', 'Any model. Your subscription.', 'In your pocket, too.', 'Just do things.']);
    // Each headline's one golden phrase, as in the film.
    expect(await page.locator('.lv-chapter .lv-gold').allInnerTexts()).toEqual(['One list.', 'needs doing.', 'their own computers.', 'fan out.', 'result,', 'code.']);
    expect(await page.locator('.lv-boxes li').allInnerTexts()).toEqual(['Agents can start, manage and approve tasks',
      'Tasks can be triggered by webhooks and events', 'Tasks can run on schedules, or after other tasks']);
    expect(await page.locator('.lv-chips li').allInnerTexts()).toEqual(['Project wiki & skills', 'Sub-tasks', 'Teams & Avatārs',
      'MCP for any agent', 'tavya CLI', 'Your own cloud accounts']);
    // Every still loads, is described, and keeps its space before it does.
    const stills = page.locator('.lv-shot img, .lv-phones');
    expect(await stills.count()).toBe(10);
    for (const still of await stills.all()) {
      await still.scrollIntoViewIfNeeded();
      expect(await still.getAttribute('alt')).toBeTruthy();
      expect(await still.getAttribute('width')).toBeTruthy();
      await expect.poll(() => still.evaluate((img: any) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    }
    for (const retired of ['vscode was a fancy text editor.', 'Leave the permanent underclass today.', 'As human-in-the-loop'])
      expect(await page.locator('.landing-page').innerText()).not.toContain(retired);
    await ui.close();
  });

  it('is dark like the film, with its gold call to action, whatever the theme or look', async () => {
    for (const [scheme, theme, skin] of [['light', '', ''], ['dark', '', ''], ['dark', 'light', 'classic']] as const) {
      const ui = await landing();
      await ui.page.emulateMedia({ colorScheme: scheme });
      await ui.run(`${theme ? `document.documentElement.dataset.theme = ${JSON.stringify(theme)};` : ''} applySkin(${JSON.stringify(skin)})`);
      const look = await ui.page.evaluate(() => ({
        page: getComputedStyle(document.querySelector('.landing-page')).backgroundColor,
        start: getComputedStyle(document.querySelector('#landing-start')).backgroundImage,
        ink: getComputedStyle(document.querySelector('#landing-start')).color,
      }));
      expect(look.page, `${scheme} ${theme} ${skin}`).toBe('rgb(13, 12, 19)');
      expect(look.start).toContain('rgb(255, 215, 126)');
      expect(look.ink).toBe('rgb(27, 20, 8)');
      await ui.close();
    }
  });

  it('sets its type in the console\'s Inter, with its default glyphs', async () => {
    const ui = await landing();
    const type = await ui.page.evaluate(() => [...document.querySelectorAll('.landing-page, .landing-page h1, .landing-page h2, .lv-lede')]
      .map((element) => {
        const style = getComputedStyle(element);
        const tracking = style.letterSpacing === 'normal' ? 0 : parseFloat(style.letterSpacing) / parseFloat(style.fontSize);
        return { family: style.fontFamily, features: style.fontFeatureSettings, tracking };
      }));
    const consoleFamily = await ui.page.evaluate(() => getComputedStyle(document.body).fontFamily);
    for (const { family, features, tracking } of type) {
      expect(family).toBe(consoleFamily);
      expect(features).toBe('normal');
      expect(tracking).toBeGreaterThanOrEqual(-.036);
    }
    await ui.close();
  });

  it('paints its first screen in Inter, never the fallback face swapped a moment later', async () => {
    const ui = await consolePage({ path: '/', api: signedOut });
    // A slow font: the page waits for it (a little) instead of showing another face first.
    await ui.page.route('**/fonts/**', async (route) => { await new Promise((resolve) => setTimeout(resolve, 600)); await route.fallback(); });
    await ui.run(`window.__firstFace = new Promise((resolve) => new MutationObserver((_, observer) => {
      if (!document.querySelector('#landing-title')) return;
      observer.disconnect();
      resolve([...document.fonts].some((face) => face.family.replace(/"/g, '') === 'Inter' && face.status === 'loaded'));
    }).observe(document.getElementById('app'), { childList: true, subtree: true })); boot()`);
    expect(await ui.run('window.__firstFace')).toBe(true);
    await ui.close();
  });

  it('closes on the brand mark and "Just do things."', async () => {
    const ui = await landing();
    const mark = ui.page.locator('.lv-end-mark .mark');
    expect(await mark.count()).toBe(1);
    expect((await mark.boundingBox())!.width).toBeGreaterThanOrEqual(60);
    expect(await ui.page.locator('#lv-end-title').innerText()).toBe('Just do things.');
    await ui.close();
  });

  it('is keyboard-visible, responsive, and respects reduced motion', async () => {
    const ui = await landing({ viewport: { width: 1280, height: 900 } });
    const { page } = ui;
    const skip = page.getByRole('link', { name: 'Skip to content' });
    const top = () => skip.evaluate((element) => element.getBoundingClientRect().bottom);
    expect(await top()).toBeLessThanOrEqual(0); // hidden above the page until focused
    await page.keyboard.press('Tab');
    expect(await skip.evaluate((element) => element === (globalThis as any).document.activeElement)).toBe(true);
    await expect.poll(top).toBeGreaterThan(0);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)).toBe('solid');
    const navHeight = () => page.locator('.landing-nav-inner').evaluate((element) => element.getBoundingClientRect().height);
    expect(await navHeight()).toBe(64);
    for (const width of [1100, 800, 600, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${width}px`).toBe(true);
    }
    expect(await navHeight()).toBe(58);
    // Chapters rise into view; with reduced motion they are simply there, and the film waits to be played.
    expect(await page.locator('.landing-page.lv-animate').count()).toBe(1);
    await ui.close();
    const still = await consolePage({ viewport: { width: 1280, height: 900 } });
    await still.page.emulateMedia({ reducedMotion: 'reduce' });
    await still.run(`S.meta = { siteName: 'tavya' }; renderLanding()`);
    expect(await still.page.locator('.landing-page.lv-animate').count()).toBe(0);
    expect(await still.page.locator('.lv-chapter').first().evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    expect(await still.page.locator('#lv-film').evaluate((video: any) => video.paused)).toBe(true);
    await still.close();
  });

  it('sends public GitHub links to the issue tracker, never the private repository', async () => {
    const ui = await landing();
    const github = (await ui.page.locator('a[href*="github.com"]').evaluateAll((links) => links.map((link) => link.getAttribute('href'))));
    expect(github).toEqual(['https://github.com/abhimanyupallavisudhir/krmax-issues/issues',
      'https://github.com/abhimanyupallavisudhir/krmax-issues/issues']);
    await ui.close();
  });
});
