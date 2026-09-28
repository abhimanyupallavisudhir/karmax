import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Store } from '../../src/store/db.js';
import { Gateway, type GatewayDeps } from '../../src/gateway/server.js';
import { KarmaxApi } from '../../src/platform/api.js';
import { TokenAuthority } from '../../src/platform/tokens.js';
import { AuthorizationService } from '../../src/platform/authorization.js';
import { KarmaxBus } from '../../src/contrib/bus.js';
import { ContributionRegistry } from '../../src/contrib/registry.js';
import { WorldRegistry } from '../../src/world/registry.js';
import { Overlays } from '../../src/store/overlays.js';
import { IdentityService } from '../../src/auth/identity.js';
import { findFreePortFrom } from '../../src/util/ports.js';
import type { EmailMessage } from '../../src/autonomy/email.js';

// Reusable fixtures for browser journeys that drive the shipped console
// (web/) against a real Gateway. Each journey still owns its assertions; these
// own the parts every journey otherwise re-implemented inline: the browser,
// page-error capture, a signed-in context, a hosted gateway, and email.

export const launchChromium = (options: { args?: string[] } = {}): Promise<Browser> => chromium.launch({ headless: true,
  args: ['--no-sandbox', ...(options.args ?? [])], executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });

export interface ConsolePage {
  context: BrowserContext;
  page: Page;
  /** Uncaught page errors so far; a journey ends by asserting there were none. */
  errors: string[];
  /** Wraps a step so a timeout reports what the page actually showed. */
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
}

/** A fresh browser context (own cookies, no service worker) and one page.
 *  `ip` gives the context its own client address: Better Auth's in-memory rate
 *  limiter is process-wide, so every sign-in from 127.0.0.1 would share a bucket. */
export async function openConsole(browser: Browser, options: { ip?: string; viewport?: { width: number; height: number } } = {}): Promise<ConsolePage> {
  const context = await browser.newContext({ serviceWorkers: 'block', ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.ip ? { extraHTTPHeaders: { 'x-forwarded-for': options.ip } } : {}) });
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  return { context, page, errors, async step(name, run) {
    try { return await run(); } catch (error: any) {
      const body = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '(unreadable)');
      throw new Error(`${name}: ${error?.message ?? error}\nURL: ${page.url()}\nPage: ${body.slice(0, 3000)}\nErrors: ${errors.join('; ')}`);
    }
  } };
}

/** Signs a context in over the real Better Auth endpoint, as the login form does. */
export async function signIn(context: BrowserContext, baseUrl: string, email: string, password: string): Promise<void> {
  const response = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
    headers: { origin: baseUrl }, data: { email, password } });
  if (response.status() !== 200) throw new Error(`sign-in ${email}: HTTP ${response.status()} ${await response.text()}`);
}

/** Calls the gateway as the console does for this context's session (its
 *  cookie, or the bearer token /api/session hands a self-hosted console), so
 *  state a journey sets up gets the same grants as the console's own writes —
 *  a project inserted into the store directly stays invisible to a session
 *  whose capabilities were already resolved. */
export async function consoleRequest<T = any>(context: BrowserContext, baseUrl: string, method: string, path: string, body?: unknown): Promise<T> {
  const session = await (await context.request.get(`${baseUrl}/api/session`)).json();
  const response = await context.request.fetch(`${baseUrl}${path}`, { method, data: body,
    headers: { origin: baseUrl, ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) } });
  if (!response.ok()) throw new Error(`${method} ${path}: HTTP ${response.status()} ${await response.text()}`);
  return response.json();
}

/** The installation mailer, capturing instead of sending. Structurally the
 *  part of EmailService the gateway and identity service call. */
export class CapturingMailer {
  readonly sent: EmailMessage[] = [];
  async configured() { return true; }
  async send(message: EmailMessage) { this.sent.push(message); }
  /** The first link in the newest message to `to` whose URL contains `includes`. */
  linkTo(to: string, includes: string): string | undefined {
    for (const message of [...this.sent].reverse()) {
      if (message.to !== to) continue;
      const link = `${message.text ?? ''} ${message.html ?? ''}`.match(/https?:\/\/[^\s"'<>]+/g)?.find((url) => url.includes(includes));
      if (link) return link.replace(/&amp;/g, '&');
    }
    return undefined;
  }
}

export interface HostedGateway {
  url: string;
  store: Store;
  identity: IdentityService;
  tokens: TokenAuthority;
  authorization: AuthorizationService;
  mailer: CapturingMailer;
  directory: string;
  close(): Promise<void>;
}

/** A hosted (multi-tenant) gateway with real identity, authorization and a
 *  capturing mailer. There is no Temporal behind it: the journeys that use it
 *  (accounts, organizations, billing) never start a workflow, and a stub client
 *  answers the few read-only queries the console makes. */
export async function hostedGateway(extra: (fixture: { store: Store; directory: string; url: string }) =>
  Promise<Partial<GatewayDeps>> | Partial<GatewayDeps> = () => ({})): Promise<HostedGateway> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-hosted-journey-'));
  const port = await findFreePortFrom(48900);
  const url = `http://127.0.0.1:${port}`;
  const store = await Store.create(':memory:', { hosted: true });
  const mailer = new CapturingMailer();
  const identity = await IdentityService.open(':memory:', { baseURL: url });
  identity.mailer = mailer as any;
  identity.connectOrganizationNames(async () => store.organizationNameReservations());
  store.connectUserNames(async () => identity.listUsers());
  const tokens = new TokenAuthority(store), worlds = new WorldRegistry();
  const authorization = await AuthorizationService.create(store);
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory, authorization, hosted: true });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, identity, hosted: true,
    email: mailer as any, taskQueue: 'test', staticDir: path.resolve('web'), bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(),
    agentInfo: { provider: 'mock', reason: 'hosted browser journey' }, ...(await extra({ store, directory, url })) });
  const server = await gateway.listen(port);
  return { url: server.url, store, identity, tokens, authorization, mailer, directory, async close() {
    await server.close(); await identity.close(); await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}
