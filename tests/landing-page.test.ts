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

/** Screenshots each look shows: three steps, the autonomous project form and four features (the automations are drawn). */
const LANDING_SHOTS = 3 + 1 + 4;

const signedOut = ({ path }: { path: string }) => path === '/api/meta' ? { siteName: 'tavya' }
  : path === '/api/launch' ? {} : path === '/api/session' ? { authRequired: true, authenticated: false } : undefined;

describe('public landing page', () => {
  it('names the installation in its title, header, film and footer', async () => {
    const ui = await landing();
    const { page } = ui;
    expect(await page.title()).toBe('tavya — do anything with agents');
    expect(await page.locator('.landing-nav .landing-brand span').textContent()).toBe('tavya');
    expect(await page.locator('#lp-film').getAttribute('aria-label')).toBe('tavya’s launch film, 1:02');
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

  it('opens on its line, then the launch film, playing silently on the first screen', async () => {
    const ui = await landing({ viewport: { width: 1440, height: 900 } });
    const { page } = ui;
    expect(await page.locator('#landing-title').innerText()).toBe('Do anything with agents.');
    expect(await page.locator('#landing-title em').innerText()).toBe('anything');
    expect(await page.locator('.lp-lede').innerText()).toBe('Write it down. An agent does it.');
    expect(await page.locator('.lp-hero .landing-start').innerText()).toBe('Get started');
    const film = page.locator('#lp-film');
    expect(await film.getAttribute('src')).toBe('/media/tavya-launch.mp4');
    expect(await film.getAttribute('poster')).toBe('/media/tavya-launch-poster.jpg');
    expect(await film.evaluate((video: any) => ({ muted: video.muted, loop: video.loop, inline: video.playsInline, controls: video.controls })))
      .toEqual({ muted: true, loop: true, inline: true, controls: false });
    // It is the hero's picture: right under the line and its button, starting on the first screen.
    const order = await page.evaluate(() => [...document.querySelectorAll('#landing-title, .lp-hero .landing-start, #lp-film, .lp-steps')].map((el) => el.id || el.className.split(' ')[0]));
    expect(order).toEqual(['landing-title', 'landing-hero-start', 'lp-film', 'lp-steps']);
    expect((await film.boundingBox())!.y).toBeLessThan(900 * 0.75);
    expect(await page.locator('.lp-list, dialog').count()).toBe(0);
    // Watch with sound: from the top, with sound and the player's controls.
    await page.locator('#lp-sound').click();
    expect(await film.evaluate((video: any) => ({ muted: video.muted, loop: video.loop, controls: video.controls, early: video.currentTime < 1 })))
      .toEqual({ muted: false, loop: false, controls: true, early: true });
    expect(await page.locator('#lp-sound').isVisible()).toBe(false);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('tells how a task goes, then what surrounds it, each pictured in the visitor\'s look', async () => {
    const ui = await landing();
    const { page } = ui;
    expect(await page.locator('main h2').allInnerTexts()).toEqual(['How a task goes', 'Build the autonomous company', 'Everything a task needs', 'Just do things.']);
    expect(await page.locator('.lp-step h3').allInnerTexts()).toEqual(['Write it down', 'An agent does it', 'Review and approve']);
    // The autonomous company has the page's one band, between how a task goes and the rest.
    expect(await page.locator('.lp-auto-card h3').allInnerTexts()).toEqual(['Agents create, manage and approve tasks', 'Work starts itself']);
    // Each automation says when it runs: an event, another task, a schedule.
    expect(await page.locator('.lp-automations span').allInnerTexts()).toEqual(['when the server reports an error', 'when a dependency releases',
      'after the release task lands', 'every Monday', 'every night at 3:00']);
    expect(await page.locator('.lp-feature h3').allInnerTexts()).toEqual(['Big jobs fan out', 'Accounts, keys and a card',
      'Any model, your subscription', 'Not just code']);
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
    for (const retired of ['vscode was a fancy text editor.', 'Leave the permanent underclass today.'])
      expect(await page.locator('.landing-page').innerText()).not.toContain(retired);
    await ui.close();
  });

  it('says what people say, before the end', async () => {
    const ui = await landing();
    const { page } = ui;
    const quotes = await page.locator('.lp-quote').evaluateAll((items) => items.map((item: any) =>
      [item.querySelector('blockquote').textContent, item.querySelector('figcaption').textContent]));
    expect(quotes).toEqual([['Every man a CEO, and no one has a moat.', 'N.H.'],
      ['tavya is such an addictive toy man… it has replaced my evening PS-5 sessions for me.', 'D.A.'],
      ['I can really just do anything now.', 'R.S.']]);
    expect(await page.locator('.lp-quote').nth(2).locator('blockquote em').textContent()).toBe('anything');
    // After everything a task needs, right before the end.
    const order = await page.evaluate(() => [...document.querySelectorAll('.lp-features, .lp-quotes, .lp-end')].map((el) => el.className.split(' ')[0]));
    expect(order).toEqual(['lp-features', 'lp-quotes', 'lp-end']);
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
    // With reduced motion the film waits to be played.
    const still = await consolePage({ viewport: { width: 1280, height: 900 } });
    await still.page.emulateMedia({ reducedMotion: 'reduce' });
    await still.run(`S.meta = { siteName: 'tavya' }; renderLanding()`);
    await still.page.waitForTimeout(600);
    expect(await still.page.locator('#lp-film').evaluate((video: any) => video.paused)).toBe(true);
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
