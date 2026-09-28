import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * The real console scripts in a real browser, with a scripted `/api`. For UI
 * tests that would otherwise read web/app.js and assert on its text: render
 * the component with the console's own functions, then click, type and read
 * the DOM and the requests it made. The page holds `#main` and `#modal-root`
 * and every console global (`S`, `api`, render functions); `boot()` does not
 * run, so a test sets up exactly the state it needs.
 *
 *   const ui = await consolePage({ api: ({ method, path }) => ... });
 *   await ui.run("renderSomething(document.getElementById('main'))");
 *   await ui.page.getByRole('button', { name: 'Save' }).click();
 *   expect(ui.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/...' }));
 *
 * One Chromium serves every page of a file; call `closeConsoleBrowser()` in
 * that file's afterAll.
 */

export interface ApiCall { method: string; path: string; body?: any }
/** A reply: a JSON value (200), `{ status, json }`, or undefined for 404. */
export type ApiReply = unknown | { status: number; json?: unknown };
export type ApiHandler = (call: ApiCall) => ApiReply | Promise<ApiReply>;

const WEB = path.resolve('web');
const scripts = ['totp-qr.js', 'markdown.js', 'app.js'];
let browser: Promise<Browser> | undefined;

export async function closeConsoleBrowser(): Promise<void> {
  const open = browser;
  browser = undefined;
  await (await open?.catch(() => undefined))?.close();
}

export async function consolePage(options: { api?: ApiHandler; viewport?: { width: number; height: number };
  /** The page's location; the console routes by it. */ path?: string } = {}) {
  browser ??= chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const context = await (await browser).newContext({ serviceWorkers: 'block', viewport: options.viewport ?? { width: 1280, height: 900 } });
  const calls: ApiCall[] = [];
  const errors: string[] = [];
  await context.route('http://console.test/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      const file = path.join(WEB, url.pathname);
      if (url.pathname.startsWith('/fonts/') && fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) });
      return route.fulfill({ contentType: 'text/html',
        body: '<!doctype html><html><body><div id="app"><main id="main"></main></div><div id="overlay-root"></div><div id="modal-root"></div><div id="toasts"></div><div id="action-progress"></div></body></html>' });
    }
    const raw = request.postData();
    const call: ApiCall = { method: request.method(), path: `${url.pathname}${url.search}`,
      ...(raw ? { body: safeJson(raw) } : {}) };
    calls.push(call);
    const reply = await options.api?.(call);
    if (reply === undefined) return route.fulfill({ status: 404, json: { error: `unscripted ${call.method} ${call.path}` } });
    if (reply && typeof reply === 'object' && 'status' in reply && typeof (reply as any).status === 'number')
      return route.fulfill({ status: (reply as any).status, json: (reply as any).json ?? {} });
    return route.fulfill({ json: reply });
  });
  const page = await context.newPage();
  // Fail a missing element within a test's budget instead of Playwright's 30 s default.
  page.setDefaultTimeout(8_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://console.test${options.path ?? '/'}`);
  await page.addStyleTag({ content: fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8') });
  for (const script of scripts) {
    let source = fs.readFileSync(path.join(WEB, script), 'utf8');
    if (script === 'app.js') source = source.replace(/^boot\(\)\.catch\(.*$/m, '');
    await page.addScriptTag({ content: source });
  }
  return {
    page, calls, errors,
    /** Evaluate console code in the page, where its globals are in scope. */
    run: <T = unknown>(source: string) => page.evaluate((code) => (0, eval)(code), source) as Promise<T>,
    /** Toast messages shown so far. */
    toasts: () => page.locator('.toast span').allTextContents(),
    close: () => context.close(),
  };
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * The replies a signed-in console needs to boot: by default one organization
 * (`org`) with one project (`/org/workspace`). `signedIn(overrides)` answers
 * those and defers everything else to `overrides`, which is asked first.
 * Mirrors the fixture in web/console-journeys.browser.test.cjs.
 */
export function signedIn(overrides: ApiHandler = () => undefined, fixture: {
  projects?: Array<Record<string, unknown>>; organizations?: Array<Record<string, unknown>>; meta?: Record<string, unknown>;
} = {}): ApiHandler {
  const projects = fixture.projects ?? [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }];
  const organizations = fixture.organizations ?? [{ id: 'o', name: 'Organization', slug: 'org' }];
  return async (call) => {
    const override = await overrides(call);
    if (override !== undefined) return override;
    if (call.method !== 'GET') return undefined;
    const pathname = call.path.split('?')[0]!;
    const replies: Record<string, unknown> = {
      '/api/meta': { siteName: 'Fixture', hostLocal: true, consoleRevision: 'one', agent: { provider: 'mock' },
        worldProviders: [], ...fixture.meta },
      '/api/launch': {},
      '/api/session': { authenticated: true, user: { id: 'u', name: 'Tester' } },
      '/api/settings/installation': { canManage: false },
      '/api/organizations': organizations,
      '/api/user/default-organization': { organizationId: organizations[0]!.id },
      '/api/projects': projects,
      '/api/schema': [],
      '/api/contributions': { slots: [], commands: [], events: [] },
      '/api/models': { providers: [] },
      '/api/inbox': [],
    };
    for (const project of projects) {
      replies[`/api/projects/${project.id}`] = project;
      for (const list of ['tasks', 'tags', 'views']) replies[`/api/projects/${project.id}/${list}`] = [];
    }
    if (pathname in replies) return replies[pathname];
    if (pathname.endsWith('/defaults')) return { effective: {}, inherited: {} };
    return undefined;
  };
}

/**
 * Every settings section loading with nothing configured yet, and the caller
 * holding every settings authority. Chain it after a test's own replies.
 */
export const emptySettings: ApiHandler = ({ method, path: route }) => {
  if (method !== 'GET') return undefined;
  const pathname = route.split('?')[0]!;
  if (pathname === '/api/settings/access') return { project: true, projectDelete: true, projectTransfer: true, organization: true };
  if (/\/(repositories|members|git-connections|resources|storage|runner-pools|world-providers|teams|invitations)$/.test(pathname)) return [];
  if (pathname.endsWith('/roles')) return { profiles: [], capabilityGroups: [], creatableCapabilities: [], canCreate: false };
  if (pathname.endsWith('/github/app')) return { configured: false };
  if (pathname.endsWith('/secrets')) return { secrets: [], suggestions: [] };
  if (pathname.endsWith('/services')) return { services: [] };
  if (pathname.endsWith('/environment')) return { spec: {}, builds: [] };
  if (pathname === '/api/users') return [];
  return undefined;
};
