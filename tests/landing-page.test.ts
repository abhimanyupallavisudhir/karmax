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
  it('names the installation in its title, brand and calls to action', async () => {
    const ui = await landing();
    const { page } = ui;
    expect(await page.title()).toBe('tavya — the agentic to-do list that completes itself');
    expect(await page.locator('.landing-nav .landing-brand').innerText()).toBe('tavya');
    expect(await page.locator('#landing-start').innerText()).toBe('Get started');
    expect(await page.locator('#landing-sign-in').innerText()).toBe('Sign in');
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

  // The page is the launch film slowed to reading speed: its tagline, then the
  // film itself, then each of its scenes with the film's own caption and a
  // still from that moment (design/landing/film-assets.sh).
  it('opens on the tagline and the launch film, which plays with sound only when asked', async () => {
    const ui = await landing();
    const { page } = ui;
    expect((await page.locator('#landing-title').innerText()).replace(/\s+/g, ' ')).toBe('The agentic to-do list that completes itself.');
    expect(await page.locator('#landing-title .gold').innerText()).toBe('completes itself.');
    const video = page.locator('#landing-film video');
    expect(await video.evaluate((v: any) => ({ src: v.querySelector('source').getAttribute('src'), type: v.querySelector('source').type,
      poster: v.getAttribute('poster'), preload: v.preload, autoplay: v.autoplay, controls: v.controls, inline: v.playsInline })))
      .toEqual({ src: '/landing/film.mp4', type: 'video/mp4', poster: '/landing/poster.webp', preload: 'none', autoplay: false, controls: false, inline: true });
    // The film is the first thing below the tagline, above the fold on a laptop.
    const box = (await page.locator('#landing-film').boundingBox())!;
    expect(box.y).toBeLessThan(900 * .55);
    expect(box.width / box.height).toBeCloseTo(16 / 9, 1);
    // Play starts it with sound and hands over the browser's own controls.
    await page.evaluate(() => { (globalThis as any).HTMLMediaElement.prototype.play = function () { (globalThis as any).played = { muted: this.muted }; return Promise.resolve(); }; });
    const play = page.getByRole('button', { name: 'Play the launch film 1:40' });
    await play.click();
    expect(await page.evaluate(() => (globalThis as any).played)).toEqual({ muted: false });
    expect(await video.evaluate((v: any) => v.controls)).toBe(true);
    expect(await play.isVisible()).toBe(false);
    // "Watch the film" in the hero does the same, from anywhere on the page.
    expect(await page.locator('#landing-watch').getAttribute('href')).toBe('#landing-film');
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('tells the film\'s story in its own captions, each with a still from that scene', async () => {
    const ui = await landing();
    const { page } = ui;
    const chapters = await page.locator('.landing-chapter').evaluateAll((sections) => sections.map((section: any) => ({
      title: section.querySelector('h2').innerText.replace(/\s+/g, ' '),
      gold: [...section.querySelectorAll('h2 .gold')].map((el: any) => el.innerText.replace(/\s+/g, ' ')),
      stills: [...section.querySelectorAll('img')].map((img: any) => img.getAttribute('src')),
    })));
    expect(chapters.map((c) => c.title)).toEqual([
      'Every project. One list.', 'Say what needs doing.', 'Agents work on their own computers.',
      'Give agents accounts, keys and a card…', 'Big jobs fan out.', 'Review the result, not the process.',
      'The autonomous company:', 'Not just code.', 'Dump all your files in…', '…and let it run your life.',
      'Any model. Your subscription.', 'In your pocket, too.']);
    expect(chapters.map((c) => c.gold)).toEqual([['One list.'], ['what needs doing.'], ['their own computers.'],
      ['accounts, keys and a card…'], ['fan out.'], ['result,'], [], ['code.'], ['your files'], ['run your life.'], ['Your subscription.'], []]);
    expect(chapters.flatMap((c) => c.stills)).toEqual(['list', 'new-task', 'working', 'vault', 'website', 'google-play', 'groceries', 'fan-out', 'review',
      'ai-review', 'agents-manage', 'starts-itself', 'not-just-code', 'photos', 'flight', 'any-model', 'pocket'].map((name) => `/landing/${name}.webp`));
    const text = (await page.locator('.landing-page').innerText()).replace(/\s+/g, ' ');
    for (const caption of ['Code, research papers, grocery shopping, your CV.', 'In plain words. Pick the agent and model, or keep your defaults.',
      'Your repos, a terminal, a browser — in parallel, while you do something else.', 'They sign up, sign in and pay — only with what you allow.',
      'One codebase review became 25 sub-tasks, each with its own agent.', 'Agents attach screenshots, reports and commands to check. You approve; it lands.',
      'Experiments, figures, papers, websites — from the same list.', 'Photos, documents, notes: pushed from your laptop, sorted by an agent, pulled back.',
      'It reads your documents, uses your logins and pays, with your OK.', 'Claude, Codex or OpenCode — on your Claude or ChatGPT plan, or an API key.',
      'A new project, one sentence, and an agent on it.'])
      expect(text).toContain(caption);
    // Every still is described, lazy below the fold, and sized before it loads (no layout shift).
    const images = await page.locator('.landing-chapter img').evaluateAll((imgs) => imgs.map((img: any) => ({
      alt: img.alt, loading: img.loading, width: img.getAttribute('width'), height: img.getAttribute('height') })));
    for (const image of images) {
      expect(image.alt.length).toBeGreaterThan(10);
      expect(image).toMatchObject({ loading: 'lazy', width: '1216', height: '712' });
    }
    await ui.close();
  });

  // The film's signature: the gold phrase swaps, and its screen with it.
  it('swaps the gold phrase and its still like the film, by itself or by choice', async () => {
    const ui = await landing();
    const { page } = ui;
    const swap = page.locator('.landing-swap').first();
    const state = () => swap.evaluate((el: any) => ({
      phrase: el.querySelector('.swap-phrase.on').innerText.replace(/\s+/g, ' '),
      caption: el.querySelector('.swap-caption.on').innerText,
      still: el.querySelector('.swap-still.on').getAttribute('src'),
      pressed: [...el.querySelectorAll('[role=tab]')].map((tab: any) => tab.getAttribute('aria-selected')),
    }));
    expect(await state()).toEqual({ phrase: 'buy you a website, and deploy to it.', caption: 'A domain on its $25 budget, a login saved to the vault, a deploy on every push.',
      still: '/landing/website.webp', pressed: ['true', 'false', 'false'] });
    await swap.getByRole('tab', { name: 'order your groceries' }).click();
    expect(await state()).toEqual({ phrase: 'order your groceries.', caption: 'Your login, your card, your budget. It never sees the password.',
      still: '/landing/groceries.webp', pressed: ['false', 'false', 'true'] });
    // Left alone, it moves on (a chosen phrase holds a while first; never under the pointer).
    await page.mouse.move(0, 0);
    await expect.poll(async () => (await state()).phrase, { timeout: 12_000 }).toBe('buy you a website, and deploy to it.');
    const company = page.locator('.landing-swap').nth(1);
    expect(await company.locator('[role=tab]').allInnerTexts()).toEqual(['let AI agents review tasks', 'agents can create and manage tasks', 'work that starts itself']);
    // Only what is shown is announced; the others are hidden from assistive tech.
    expect(await swap.locator('.swap-phrase:not(.on)').first().getAttribute('aria-hidden')).toBe('true');
    await ui.close();
  });

  it('is night, like the film, whatever the visitor\'s theme or the installation\'s look', async () => {
    const backgrounds: string[] = [];
    for (const scheme of ['light', 'dark'] as const) for (const skin of ['', 'classic']) {
      const ui = await landing();
      await ui.page.emulateMedia({ colorScheme: scheme });
      await ui.run(`applySkin(${JSON.stringify(skin)})`);
      backgrounds.push(await ui.page.locator('.landing-page').evaluate((el) => getComputedStyle(el).backgroundColor));
      const start = await ui.page.locator('#landing-start').evaluate((el) => getComputedStyle(el).backgroundImage);
      expect(start, 'the film\'s gold pill').toMatch(/gradient/);
      expect(await ui.page.locator('#landing-theme').count()).toBe(0);
      await ui.close();
    }
    expect(new Set(backgrounds).size).toBe(1);
    expect(backgrounds[0]).toBe('rgb(14, 13, 21)');
  });

  it('ends like the film: the mark, "Your turn.", and a way in', async () => {
    const ui = await landing();
    const { page } = ui;
    const mark = page.locator('.landing-final .mark');
    expect(await mark.count()).toBe(1);
    expect((await mark.boundingBox())!.width).toBeGreaterThanOrEqual(64);
    expect((await page.locator('#final-title').innerText()).replace(/\s+/g, ' ')).toBe('Your turn.');
    expect(await page.locator('#landing-final-start').innerText()).toMatch(/^Get started/);
    await ui.close();
  });

  // The landing used to paint in a fallback face and switch to Inter a moment
  // later. The font is preloaded with the page, and a public page waits for it
  // (briefly) before its first paint.
  it('never paints in a fallback font', async () => {
    const html = (await import('node:fs')).readFileSync('web/index.html', 'utf8');
    expect(html).toContain('<link rel="preload" href="/fonts/inter/InterVariable.woff2" as="font" type="font/woff2" crossorigin />');
    const ui = await consolePage({ path: '/', api: signedOut });
    const { page } = ui;
    await page.route('**/fonts/inter/InterVariable.woff2', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({ body: (await import('node:fs')).readFileSync('web/fonts/inter/InterVariable.woff2'), contentType: 'font/woff2' });
    });
    await page.evaluate(() => {
      const w = globalThis as any;
      new w.MutationObserver((_: unknown, observer: any) => {
        if (!w.document.querySelector('.landing-page')) return;
        w.firstPaintFont = w.document.fonts.check('700 40px Inter') && w.document.fonts.check('400 16px Inter');
        observer.disconnect();
      }).observe(w.document.getElementById('app'), { childList: true, subtree: true });
    });
    await ui.run('boot()');
    await page.locator('.landing-page').waitFor();
    expect(await page.evaluate(() => (globalThis as any).firstPaintFont)).toBe(true);
    await ui.close();
  });

  it('is keyboard-visible, fits every width, and holds still for reduced motion', async () => {
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
    for (const width of [1440, 1100, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${width}px`).toBe(true);
    }
    // Reduced motion: no swapping by itself, no reveal motion; the tabs still work.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await ui.run('renderLanding()');
    const phrase = () => page.locator('.landing-swap').first().locator('.swap-phrase.on').innerText();
    const first = await phrase();
    await page.waitForTimeout(6000);
    expect(await phrase()).toBe(first);
    await page.locator('.landing-swap').first().getByRole('tab', { name: 'order your groceries' }).click();
    expect(await phrase()).toBe('order your groceries.');
    await ui.close();
  });

  it('sends public GitHub links to the issue tracker, never the private repository', async () => {
    const ui = await landing();
    const github = (await ui.page.locator('a[href*="github.com"]').evaluateAll((links) => links.map((link) => link.getAttribute('href'))));
    expect(github.length).toBeGreaterThan(0);
    for (const href of github) expect(href).toBe('https://github.com/abhimanyupallavisudhir/krmax-issues/issues');
    await ui.close();
  });
});
