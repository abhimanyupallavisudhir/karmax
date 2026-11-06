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

/** Screenshots each look shows: three steps, five features (the phones are two). */
const LANDING_SHOTS = 3 + 5 + 2;

const signedOut = ({ path }: { path: string }) => path === '/api/meta' ? { siteName: 'tavya' }
  : path === '/api/launch' ? {} : path === '/api/session' ? { authRequired: true, authenticated: false } : undefined;

describe('public landing page', () => {
  it('names the installation in its title, header, film and footer', async () => {
    const ui = await landing();
    const { page } = ui;
    expect(await page.title()).toBe('tavya — the agentic to-do list that finishes itself');
    expect(await page.locator('.landing-nav .landing-brand span').textContent()).toBe('tavya');
    expect(await page.locator('#lp-film').getAttribute('aria-label')).toBe('tavya’s launch film, 0:59');
    expect((await page.locator('.lp-end .landing-start').innerText()).replace(/\s+/g, ' ')).toBe('Get started with tavya');
    expect(await page.locator('.landing-footer .landing-brand span').textContent()).toBe('tavya');
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

  it('opens on its line and a task list drawn with the console\'s parts', async () => {
    const ui = await landing({ viewport: { width: 1440, height: 900 } });
    const { page } = ui;
    expect(await page.locator('#landing-title').innerText()).toBe('The agentic to-do list that finishes itself.');
    expect(await page.locator('.lp-lede').innerText()).toBe('Write down what needs doing. Agents do it on their own computers, in parallel, and you review the result.');
    // The list holds every kind of work, each with its agent's status, as the console's rows do.
    const rows = await page.locator('.lp-row').evaluateAll((items) => items.map((item: any) => [item.querySelector('code').textContent, item.querySelector('.lp-chip').textContent]));
    expect(rows).toEqual([['personal-website', 'Done'], ['tavya', 'Working'], ['takehomev2', 'Working'], ['admin_docs', 'Needs input'], ['legibench3', 'In review']]);
    // It starts on the first screen, under the line and its buttons.
    expect((await page.locator('.lp-list').boundingBox())!.y).toBeLessThan(900);
    expect(await page.locator('.lp-hero .landing-start').innerText()).toBe('Get started');
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('plays the film only when asked, with sound, and stops it when closed', async () => {
    const ui = await landing();
    const { page } = ui;
    const film = page.locator('#lp-film video');
    expect(await film.getAttribute('src')).toBe('/media/tavya-launch.mp4');
    expect(await film.getAttribute('poster')).toBe('/media/tavya-launch-poster.jpg');
    expect(await film.evaluate((video: any) => ({ preload: video.preload, paused: video.paused, controls: video.controls, muted: video.muted })))
      .toEqual({ preload: 'none', paused: true, controls: true, muted: false });
    expect(await page.locator('#lp-film').isVisible()).toBe(false);
    await page.locator('#lp-film-open').click();
    expect(await page.locator('#lp-film').isVisible()).toBe(true);
    await page.locator('.lp-film-close').click();
    expect(await page.locator('#lp-film').isVisible()).toBe(false);
    expect(await film.evaluate((video: any) => video.paused)).toBe(true);
    await ui.close();
  });

  it('tells how a task goes, then what surrounds it, each pictured in the visitor\'s look', async () => {
    const ui = await landing();
    const { page } = ui;
    expect(await page.locator('main h2').allInnerTexts()).toEqual(['How a task goes', 'Everything a task needs', 'Just do things.']);
    expect(await page.locator('.lp-step h3').allInnerTexts()).toEqual(['Write it down', 'An agent does it', 'You review the result']);
    expect(await page.locator('.lp-feature h3').allInnerTexts()).toEqual(['Big jobs fan out', 'Accounts, keys and a card',
      'The autonomous company', 'Any model, your subscription', 'Not just code', 'On your phone']);
    expect(await page.locator('.lp-feature li').allInnerTexts()).toEqual(['Agents can start, manage and approve tasks',
      'Tasks can be triggered by webhooks and events', 'Tasks can run on schedules, or after other tasks']);
    // Each screenshot comes in the light and the dark look; the page shows the one it wears.
    for (const [scheme, shown] of [['light', 'lp-light'], ['dark', 'lp-dark']] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const visible = page.locator(`.lp-shot img.${shown}`);
      expect(await visible.count()).toBe(LANDING_SHOTS);
      for (const image of await visible.all()) {
        await image.scrollIntoViewIfNeeded();
        expect(await image.isVisible(), scheme).toBe(true);
        await expect.poll(() => image.evaluate((img: any) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
      }
      expect(await page.locator(`.lp-shot img:not(.${shown})`).evaluateAll((images) => images.filter((img: any) => img.checkVisibility()).length)).toBe(0);
    }
    // Pictures are described once (the dark copy is hidden from assistive technology).
    expect(await page.locator('.lp-step img.lp-light').evaluateAll((images) => images.every((img: any) => img.alt.length > 10))).toBe(true);
    expect(await page.locator('.lp-shot img.lp-dark').evaluateAll((images) => images.every((img: any) => img.getAttribute('aria-hidden') === 'true'))).toBe(true);
    for (const retired of ['vscode was a fancy text editor.', 'Leave the permanent underclass today.', 'Watch with sound'])
      expect(await page.locator('.landing-page').innerText()).not.toContain(retired);
    await ui.close();
  });

  it('wears the console\'s look, light or dark, default or classic', async () => {
    for (const [scheme, theme, skin] of [['light', '', ''], ['dark', '', ''], ['dark', 'light', 'classic']] as const) {
      const ui = await landing();
      await ui.page.emulateMedia({ colorScheme: scheme });
      await ui.run(`${theme ? `document.documentElement.dataset.theme = ${JSON.stringify(theme)};` : ''} applySkin(${JSON.stringify(skin)})`);
      // The console eases colours between looks: read them once they have settled.
      const read = () => ui.page.evaluate(() => {
        const token = (name: string) => { const probe = document.createElement('i'); probe.style.color = `var(${name})`; document.body.appendChild(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; };
        return {
          page: getComputedStyle(document.querySelector('.landing-page')).backgroundColor, paper: token('--paper'),
          start: getComputedStyle(document.querySelector('#landing-start')).backgroundColor, primary: token('--primary'),
          ink: getComputedStyle(document.querySelector('.landing-page')).color, consoleInk: token('--ink'),
        };
      });
      const label = `${scheme} ${theme} ${skin}`;
      await expect.poll(async () => { const look = await read(); return [look.page, look.start, look.ink]; }, { message: label })
        .toEqual(await read().then((look) => [look.paper, look.primary, look.consoleInk]));
      await ui.close();
    }
  });

  it('sets its type in the console\'s Inter, with its default glyphs', async () => {
    const ui = await landing();
    const type = await ui.page.evaluate(() => [...document.querySelectorAll('.landing-page, .landing-page h1, .landing-page h2, .lp-lede')]
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
    const mark = ui.page.locator('.lp-end-mark .mark');
    expect(await mark.count()).toBe(1);
    expect((await mark.boundingBox())!.width).toBeGreaterThanOrEqual(60);
    expect(await ui.page.locator('#lp-end-title').innerText()).toBe('Just do things.');
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
    await ui.close();
    // Nothing moves on its own: the film waits to be asked for, with or without reduced motion.
    const still = await consolePage({ viewport: { width: 1280, height: 900 } });
    await still.page.emulateMedia({ reducedMotion: 'reduce' });
    await still.run(`S.meta = { siteName: 'tavya' }; renderLanding()`);
    expect(await still.page.locator('#lp-film video').evaluate((video: any) => video.paused)).toBe(true);
    expect(await still.page.locator('.lp-list').evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
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
