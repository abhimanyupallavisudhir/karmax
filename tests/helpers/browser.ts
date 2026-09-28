import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
import { CredentialBroker } from '../../src/autonomy/broker.js';
import { Vault } from '../../src/autonomy/vault.js';
import { policyVersions } from '../../src/launch/legal.js';
import { hostedOnboardingKey } from '../../src/gateway/hosted-onboarding.js';
import type { EmailMessage } from '../../src/autonomy/email.js';
import type { Organization } from '../../src/domain/types.js';

// Reusable fixtures for browser journeys that drive the shipped console
// (web/) against a real Gateway. Each journey still owns its assertions; these
// own the parts every journey otherwise re-implemented inline: the browser,
// page-error capture, a signed-in context, a hosted gateway, and email.

export const launchChromium = (options: { args?: string[]; env?: Record<string, string | undefined> } = {}): Promise<Browser> => chromium.launch({ headless: true,
  args: ['--no-sandbox', ...(options.args ?? [])], executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  ...(options.env ? { env: options.env } : {}) });

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
  broker: CredentialBroker;
  mailer: CapturingMailer;
  directory: string;
  /** An existing account owning a fresh organization, as signup or an
   *  operator would have left it (signup policies accepted, setup guide closed). */
  owner(input: { name: string; email: string; password: string; organization: string }): Promise<{ user: { id: string; email: string }; organization: Organization }>;
  close(): Promise<void>;
}

/** A hosted (multi-tenant) gateway with real identity, authorization and a
 *  capturing mailer. There is no Temporal behind it: the journeys that use it
 *  (accounts, organizations, billing) never start a workflow, and a stub client
 *  answers the few read-only queries the console makes. */
export async function hostedGateway(extra: (fixture: { store: Store; broker: CredentialBroker; directory: string; url: string }) =>
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
  const broker = new CredentialBroker(new Vault(path.join(directory, 'vault')));
  const authorization = await AuthorizationService.create(store);
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory, authorization, hosted: true });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, identity, hosted: true,
    broker, email: mailer as any, taskQueue: 'test', staticDir: path.resolve('web'), bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(),
    agentInfo: { provider: 'mock', reason: 'hosted browser journey' }, ...(await extra({ store, broker, directory, url })) });
  const server = await gateway.listen(port);
  return { url: server.url, store, identity, tokens, authorization, broker, mailer, directory, async owner(input) {
    const user = await identity.createUser({ name: input.name, email: input.email, password: input.password });
    const organization = await store.createOrganization({ name: input.organization, ownerUserId: user.id });
    await authorization.bootstrapOrganizationOwner('system:test', user.id, organization.id);
    await store.recordPolicyAcceptance({ userId: user.id, context: 'signup', versions: policyVersions('signup') });
    // An established owner has put the setup guide away.
    await store.kvSet(hostedOnboardingKey(user.id, organization.id), JSON.stringify({ display: 'closed' }));
    return { user, organization };
  }, async close() {
    await server.close(); await identity.close(); await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

export interface AppProcess {
  url: string;
  /** Ctrl-C: the app exits and, as with `npm start`, the home's persistent
   *  Temporal server keeps running for the next boot. */
  stop(): Promise<void>;
}

/** The installed app itself — src/main.ts with its gateway, worker and
 *  embedded Temporal on `home`, as `npm start` runs it — with the mock agent. */
export async function launchApp(home: string): Promise<AppProcess> {
  const port = await findFreePortFrom(48950);
  const url = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(home, 'main.log'), 'a');
  const app = spawn(process.execPath, ['--import', 'tsx', '--max-old-space-size=512', 'src/main.ts'], {
    cwd: path.resolve('.'), stdio: ['ignore', log, log],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, KARMAX_HOME: home, KARMAX_HOST: '127.0.0.1', KARMAX_PORT: String(port),
      KARMAX_AGENT_PROVIDER: 'mock', KARMAX_AGENT_MIN_FREE_MB: '0', KARMAX_AGENT_MAX_LOAD_FACTOR: '0',
      ...(process.env.TEMPORAL_CLI ? { TEMPORAL_CLI: process.env.TEMPORAL_CLI } : {}) },
  });
  const exited = new Promise<void>((resolve) => app.once('exit', () => resolve()));
  const stop = async () => { if (app.exitCode === null && app.signalCode === null) app.kill('SIGTERM'); await exited; fs.closeSync(log); };
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (app.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`the app did not become ready:\n${fs.readFileSync(path.join(home, 'main.log'), 'utf8').slice(-6000)}`);
    }
    const ready = await fetch(`${url}/api/health/ready`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
    if (ready) return { url, stop };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Stops the persistent Temporal server a launched app left on `home`. */
export async function stopEmbeddedTemporal(home: string): Promise<void> {
  let pid: number | undefined;
  try { pid = JSON.parse(fs.readFileSync(path.join(home, 'temporal', 'dev-server.json'), 'utf8')).pid; } catch { return; }
  // A pidfile outlives its process; never signal a recycled pid.
  const isTemporal = () => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('temporal'); } catch { return false; } };
  if (!pid || !isTemporal()) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let waited = 0; waited < 10_000; waited += 100) {
    if (!isTemporal()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isTemporal()) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}
