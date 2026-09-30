import fs from 'node:fs';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';

const evaluate = (page: Page, source: string) => page.evaluate(source => (globalThis as any).eval(source), source);

it('discovers and saves install commands per repository in Project Settings → Environment', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const saved: any[] = [];
    await page.route('http://environment.test/**', route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${pathname}`) });
      if (pathname === '/api/projects/project/environment/proposal') return route.fulfill({ json: {
        spec: { install: { web: ['npm ci', 'npx playwright install --with-deps chromium'] } },
        evidence: ['web: "npm ci" (package-lock.json)'], composeFiles: [] } });
      if (pathname === '/api/projects/project/environment' && request.method() === 'PUT') {
        saved.push(request.postDataJSON());
        return route.fulfill({ json: { spec: {}, digest: 'd' } });
      }
      if (pathname === '/api/projects/project/environment') return route.fulfill({ json: {
        spec: { setup: ['sudo apt-get install -y jq'], install: { api: ['uv sync'] } }, digest: 'd', builds: [],
        repositories: ['web', 'api'] } });
      return route.fulfill({ contentType: 'text/html', body: '<main class="card" style="max-width:720px"><div id="project-environment-box"></div></main>' });
    });
    await page.goto('http://environment.test/');
    await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '') });
    // The panel renders only for the project that is open, so a late answer
    // for another project cannot fill in this one's form.
    await evaluate(page, `toast = () => {}; S.projectId = 'project'; hydrateProjectEnvironment({ id: 'project', organizationId: 'org' })`);

    const install = (name: string) => page.locator(`[data-environment-install="${name}"]`);
    await expect.poll(() => install('api').inputValue()).toBe('uv sync');
    expect(await install('web').inputValue()).toBe('');
    await page.click('#environment-propose');
    await expect.poll(() => install('web').inputValue()).toBe('npm ci\nnpx playwright install --with-deps chromium');
    expect(await install('api').inputValue()).toBe('uv sync');
    if (process.env.KARMAX_SCREENSHOT) await page.screenshot({ path: process.env.KARMAX_SCREENSHOT, fullPage: true });

    await page.click('#environment-save');
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({
      setup: ['sudo apt-get install -y jq'], boot: [],
      install: { web: ['npm ci', 'npx playwright install --with-deps chromium'], api: ['uv sync'] },
    });
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});
